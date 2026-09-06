const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const {
    TokenStore,
    encodeHash,
    verifyHash,
} = require("../auth");
const {
    createTenantNamespace,
    scopeRequestBody,
    unscopeResponse,
} = require("../namespace");
const {
    SettingsStore,
    sanitizeSecrets,
} = require("../settings_store");
const {
    OutboundPolicyError,
    createOutboundPolicy,
    createSafeLookup,
    isPrivateIp,
    sanitizeProxyHeaders,
    validateOutboundTarget,
} = require("../outbound_policy");
const bm25Engine = require("../bm25_engine");

function temporaryDirectory(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("verifyHash parses and verifies encoded scrypt hashes", () => {
    const token = "anima_test_token_for_verify_hash";
    const encoded = encodeHash(token);

    assert.equal(verifyHash(token, encoded), true);
    assert.equal(verifyHash(`${token}-wrong`, encoded), false);
    assert.equal(verifyHash(null, encoded), false);
    assert.equal(verifyHash(token, "scrypt$16384$8$1$broken"), false);

    const parts = encoded.split("$");
    parts[1] = "not-a-cost";
    assert.equal(verifyHash(token, parts.join("$")), false);
});

test("token store authenticates, lists without raw tokens, and revokes", async () => {
    const root = temporaryDirectory("anima-auth-");
    try {
        const store = new TokenStore(path.join(root, "tokens.json"));
        const created = await store.create("Alice's phone");

        assert.equal(typeof created.token, "string");
        assert.deepEqual(store.list().map(({ token, ...record }) => record), [
            {
                id: created.id,
                label: "Alice's phone",
                createdAt: created.createdAt,
                revokedAt: null,
                status: "active",
            },
        ]);
        assert.equal(JSON.stringify(store.list()).includes(created.token), false);
        assert.equal(fs.readFileSync(path.join(root, "tokens.json"), "utf8").includes(created.token), false);

        const user = store.authenticate(created.token);
        assert.equal(user.label, "Alice's phone");
        assert.match(user.tenantId, /^tenant_[0-9a-f]{32}$/);

        const revoked = await store.revoke({ id: created.id });
        assert.equal(revoked.id, created.id);
        assert.equal(store.authenticate(created.token), null);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("token lookup verifies one modern candidate and refreshes after external writes", async () => {
    const root = temporaryDirectory("anima-auth-scale-");
    try {
        const tokenFile = path.join(root, "tokens.json");
        let verificationCount = 0;
        const countingStore = new TokenStore(tokenFile, {
            verifyToken(token, hash) {
                verificationCount += 1;
                return verifyHash(token, hash);
            },
        });
        const created = [];
        for (let index = 0; index < 20; index += 1) {
            created.push(await countingStore.create(`user-${index}`));
        }

        assert.equal(countingStore.authenticate(created[13].token).label, "user-13");
        assert.equal(verificationCount, 1, "modern lookup must select one scrypt candidate");
        assert.equal(countingStore.authenticate("anima_invalid_but_long_enough_token"), null);
        assert.equal(verificationCount, 1, "unknown modern token must not trigger a full scrypt scan");

        const externalStore = new TokenStore(tokenFile);
        const external = await externalStore.create("external-cli-user");
        assert.equal(
            countingStore.authenticate(external.token).label,
            "external-cli-user",
            "mtime cache must refresh after another CLI/process atomically replaces the token file",
        );
        assert.equal(verificationCount, 2);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("tenant namespace is reversible and avoids normalization collisions", () => {
    const namespace = createTenantNamespace("tenant-user-1");
    const first = "library/a?one\u4e2d文";
    const second = "library_a_one\u4e2d文";
    const firstPhysical = namespace.scopeId(first);
    const secondPhysical = namespace.scopeId(second);

    assert.notEqual(firstPhysical, secondPhysical);
    assert.equal(namespace.stripId(firstPhysical), first);
    assert.equal(namespace.stripId(secondPhysical), second);
    assert.notEqual(namespace.scopeId(firstPhysical), firstPhysical);
    assert.equal(namespace.isOwnedPhysicalId(firstPhysical), true);
    assert.equal(namespace.isOwnedPhysicalId(secondPhysical), true);
    assert.equal(namespace.isOwnedPhysicalId("tenant_other__id_YQ"), false);
    assert.match(firstPhysical, /^tenant_[0-9a-f]{32}__id_[A-Za-z0-9_-]+$/);

    const body = scopeRequestBody(
        {
            collectionId: first,
            collectionIds: [first, second],
            sessionId: "chat/one",
            chatContext: { ids: [first], strategy: { current_session_id: "chat/one" } },
            tenantId: "attacker-controlled",
        },
        namespace,
    );
    assert.equal(body.tenantId, undefined);
    assert.equal(body.collectionId, firstPhysical);
    assert.deepEqual(body.collectionIds, [firstPhysical, secondPhysical]);
    assert.equal(body.chatContext.ids[0], firstPhysical);
    assert.equal(body.chatContext.strategy.current_session_id, namespace.scopeId("chat/one"));

    const response = unscopeResponse(
        {
            collectionId: firstPhysical,
            collectionIds: [firstPhysical, "tenant_other__id_YQ"],
            nested: { sessionId: namespace.scopeId("chat/one") },
        },
        namespace,
    );
    assert.deepEqual(response, {
        collectionId: first,
        collectionIds: [first],
        nested: { sessionId: "chat/one" },
    });
});

test("custom BM25 dictionaries do not mutate the process-global tokenizer", () => {
    const sample = "跨租户词典隔离测试专名";
    const before = bm25Engine._tokenize(sample);
    const count = bm25Engine._syncJieba([
        { trigger: sample, index: "tenant-a-private-index-word" },
    ]);
    const after = bm25Engine._tokenize(sample);

    assert.equal(count, 1);
    assert.deepEqual(after, before);
});

test("settings revisions are isolated and secrets are never stored", async () => {
    const root = temporaryDirectory("anima-settings-");
    try {
        const store = new SettingsStore(root);
        const alice = "tenant_alice";
        const bob = "tenant_bob";

        const revisionOne = await store.put(alice, "global", "default", {
            baseRevision: 0,
            deviceId: "phone",
            value: {
                theme: "anima",
                apiKey: "do-not-store",
                nested: { api_key: "also-do-not-store", keep: true },
            },
        });
        assert.equal(revisionOne.revision, 1);
        assert.deepEqual(revisionOne.value, {
            theme: "anima",
            nested: { keep: true },
        });

        await assert.rejects(
            () =>
                store.put(alice, "global", "default", {
                    baseRevision: 0,
                    value: { stale: true },
                }),
            (error) => error.code === "revision_conflict" && error.current.revision === 1,
        );

        const revisionTwo = await store.put(alice, "global", "default", {
            baseRevision: 1,
            deviceId: "desktop",
            value: { theme: "anima-dark", authorization: "secret" },
        });
        assert.equal(revisionTwo.revision, 2);
        assert.deepEqual((await store.history(alice, "global", "default")).history.map((item) => item.revision), [1]);
        assert.deepEqual(await store.get(bob, "global", "default"), {
            scope: "global",
            key: "default",
            revision: 0,
            updatedAt: null,
            deviceId: null,
            value: {},
        });
        assert.deepEqual(sanitizeSecrets({ api_key: "x", ok: [{ token: "y", keep: 1 }] }), { ok: [{ keep: 1 }] });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("outbound policy blocks credentials/private targets and sanitizes headers", async () => {
    assert.equal(isPrivateIp("10.1.2.3"), true);
    assert.equal(isPrivateIp("172.31.255.254"), true);
    assert.equal(isPrivateIp("192.168.1.10"), true);
    assert.equal(isPrivateIp("198.19.0.1"), true);
    assert.equal(isPrivateIp("203.0.113.10"), true);
    assert.equal(isPrivateIp("::1"), true);
    assert.equal(isPrivateIp("fc00::1"), true);
    assert.equal(isPrivateIp("fe80::1"), true);
    assert.equal(isPrivateIp("::ffff:192.168.1.1"), true);
    assert.equal(isPrivateIp("93.184.216.34"), false);

    const policy = createOutboundPolicy({
        allowedHosts: ["93.184.216.34"],
        allowedProtocols: ["https:"],
        resolveDns: false,
    });

    await assert.doesNotReject(() =>
        validateOutboundTarget("https://93.184.216.34/embeddings", policy),
    );
    await assert.rejects(
        () => validateOutboundTarget("http://93.184.216.34/", policy),
        (error) => error instanceof OutboundPolicyError && error.code === "outbound_protocol_denied",
    );
    await assert.rejects(
        () => validateOutboundTarget("https://user:pass@93.184.216.34/", policy),
        (error) => error.code === "outbound_credentials_denied",
    );
    await assert.rejects(
        () => validateOutboundTarget("https://127.0.0.1/", createOutboundPolicy({
            allowedHosts: ["127.0.0.1"],
            resolveDns: false,
        })),
        (error) => error.code === "private_outbound_denied",
    );
    await assert.rejects(
        () => validateOutboundTarget("https://93.184.216.34/", createOutboundPolicy({ resolveDns: false })),
        (error) => error.code === "outbound_host_denied",
    );

    assert.deepEqual(
        sanitizeProxyHeaders(
            {
                Authorization: "Bearer provider-token",
                Host: "attacker.example",
                "Proxy-Authorization": "bad",
                "X-Trace": "ok",
            },
            policy,
        ),
        {
            authorization: "Bearer provider-token",
            "x-trace": "ok",
        },
    );
    assert.throws(
        () => sanitizeProxyHeaders({ "X-Bad": "line\nfeed" }, policy),
        (error) => error.code === "invalid_proxy_header",
    );
});

test("connection-time DNS lookup rejects a rebinding to a private address", async () => {
    const policy = createOutboundPolicy({
        allowedHosts: ["provider.example"],
        allowedProtocols: ["https:"],
    });
    const safeLookup = createSafeLookup(
        policy,
        (hostname, options, callback) =>
            callback(null, [{ address: "127.0.0.1", family: 4 }]),
    );

    const error = await new Promise((resolve) => {
        safeLookup("provider.example", { family: 0 }, (lookupError) =>
            resolve(lookupError),
        );
    });
    assert.equal(error?.code, "private_outbound_denied");
});

function httpJson(server, options = {}) {
    const address = server.address();
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    return new Promise((resolve, reject) => {
        const request = http.request(
            {
                host: address.address,
                port: address.port,
                path: options.path,
                method: options.method || "GET",
                headers: {
                    ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
                    ...(options.headers || {}),
                },
            },
            (response) => {
                const chunks = [];
                response.on("data", (chunk) => chunks.push(chunk));
                response.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    let json = null;
                    try {
                        json = text ? JSON.parse(text) : null;
                    } catch {}
                    resolve({
                        status: response.statusCode,
                        headers: response.headers,
                        text,
                        json,
                    });
                });
            },
        );
        request.on("error", reject);
        if (body) request.write(body);
        request.end();
    });
}

test("standalone HTTP runtime authenticates, isolates tenants, and rejects redirects", async () => {
    const root = temporaryDirectory("anima-runtime-");
    const provider = http.createServer((request, response) => {
        if (request.url === "/redirect") {
            response.writeHead(302, { Location: "http://127.0.0.1/final" });
            response.end();
            return;
        }
        if (request.url === "/embeddings") {
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
            return;
        }
        response.writeHead(404);
        response.end();
    });

    let runtime;
    try {
        await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
        const providerAddress = provider.address();
        const { createApp } = require("../standalone");
        runtime = await require("../standalone").startServer({
            dataRoot: root,
            host: "127.0.0.1",
            port: 0,
            corsOrigins: ["https://tauri.localhost"],
            outboundPolicy: createOutboundPolicy({
                allowedHosts: ["127.0.0.1"],
                allowedProtocols: ["http:"],
                allowPrivate: true,
                resolveDns: false,
            }),
        });
        assert.equal(typeof createApp, "function");

        const alice = await runtime.tokenStore.create("Alice");
        const bob = await runtime.tokenStore.create("Bob");
        const auth = (token) => ({ Authorization: `Bearer ${token}` });

        assert.equal((await httpJson(runtime.server, { path: "/healthz" })).status, 200);
        const preflight = await httpJson(runtime.server, {
            method: "OPTIONS",
            path: "/v1/anima/query",
            headers: {
                Origin: "https://tauri.localhost",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization,content-type",
            },
        });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers["access-control-allow-origin"], "https://tauri.localhost");
        assert.match(preflight.headers["access-control-allow-headers"], /Authorization/i);
        assert.equal((await httpJson(runtime.server, { path: "/v1/me" })).status, 401);
        const me = await httpJson(runtime.server, { path: "/v1/me", headers: auth(alice.token) });
        assert.equal(me.status, 200);
        assert.equal(me.json.user.label, "Alice");

        const put = await httpJson(runtime.server, {
            method: "PUT",
            path: "/v1/settings/global/default",
            headers: auth(alice.token),
            body: { baseRevision: 0, value: { mode: "remote", apiKey: "secret" } },
        });
        assert.equal(put.status, 200);
        assert.deepEqual(put.json.value, { mode: "remote" });

        const bobSettings = await httpJson(runtime.server, {
            path: "/v1/settings/global/default",
            headers: auth(bob.token),
        });
        assert.equal(bobSettings.json.revision, 0);

        const insert = await httpJson(runtime.server, {
            method: "POST",
            path: "/v1/anima/insert",
            headers: auth(alice.token),
            body: {
                collectionId: "same/a?b",
                text: "Alice-only memory",
                tags: [],
                timestamp: Date.now(),
                index: "1_1",
                batch_id: 1,
                apiConfig: {
                    url: `http://127.0.0.1:${providerAddress.port}`,
                    key: "provider-key",
                    model: "test",
                },
            },
        });
        assert.equal(insert.status, 200, insert.text);

        const aliceLibraries = await httpJson(runtime.server, {
            path: "/v1/anima/list",
            headers: auth(alice.token),
        });
        const bobLibraries = await httpJson(runtime.server, {
            path: "/v1/anima/list",
            headers: auth(bob.token),
        });
        assert.deepEqual(aliceLibraries.json, ["same/a?b"]);
        assert.deepEqual(bobLibraries.json, []);

        const redirect = await httpJson(runtime.server, {
            method: "POST",
            path: "/v1/anima/proxy/forward",
            headers: auth(alice.token),
            body: {
                targetUrl: `http://127.0.0.1:${providerAddress.port}/redirect`,
                method: "GET",
            },
        });
        assert.equal(redirect.status, 502);
        assert.equal(redirect.json.error, "proxy_redirect_denied");
    } finally {
        if (runtime?.server) await new Promise((resolve) => runtime.server.close(resolve));
        await new Promise((resolve) => provider.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
});
