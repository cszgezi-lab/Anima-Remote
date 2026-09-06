const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  asIdList,
  assertStatus,
  assertSuccess,
  bestEffortClearSetting,
  bestEffortDeleteBm25,
  containsValue,
  getBlackboxConfig,
  hasBlackboxEnvironment,
  randomPrefix,
  request,
  settingEndpoint,
  validateBlackboxConfig,
} = require("./helpers.js");

const skipReason = hasBlackboxEnvironment()
  ? ""
  : "未提供完整 ANIMA_TEST_URL、ANIMA_TEST_TOKEN_A、ANIMA_TEST_TOKEN_B，跳过真实黑盒（静态测试仍会运行）";

function blackbox(name, callback) {
  const options = skipReason ? { skip: skipReason } : {};
  test(name, options, async () => {
    const config = getBlackboxConfig();
    validateBlackboxConfig(config);
    await callback(config);
  });
}

function requireObjectBody(result, label) {
  assert.ok(result.body && typeof result.body === "object" && !Array.isArray(result.body), label);
  return result.body;
}

function assertSecretAbsent(value, secret, label) {
  assert.equal(containsValue(value, secret), false, label);
}

async function importBm25Knowledge(config, token, fileName, marker) {
  return request(config, "/v1/anima/import_knowledge", {
    method: "POST",
    token,
    body: {
      fileName,
      fileContent: `验收测试 ${marker}`,
      settings: { delimiter: "", chunk_size: 500 },
      bm25Config: { enabled: true, dictionary: [] },
      vectorConfig: { enabled: false },
    },
  });
}

async function queryBm25Knowledge(config, token, logicalId, marker) {
  return request(config, "/v1/anima/query", {
    method: "POST",
    token,
    body: {
      searchText: "",
      bm25SearchText: marker,
      kbContext: {
        ids: [logicalId],
        strategy: { bm25_top_k: 3 },
      },
      bm25Configs: {
        chat: [],
        kb: [{ dbId: logicalId, dictionary: [] }],
      },
    },
  });
}

blackbox("healthz is unauthenticated and exposes only liveness", async (config) => {
  const result = await request(config, "/healthz");
  assertStatus(result, 200, "healthz should be available without a token");
  const body = requireObjectBody(result, "healthz response must be JSON object");
  assert.equal(body.ok, true, "healthz should report ok=true");
});

blackbox("me rejects missing authentication with 401", async (config) => {
  const result = await request(config, "/v1/me");
  assertStatus(result, 401, "missing bearer token must be rejected");
});

blackbox("me accepts a valid token without echoing the token", async (config) => {
  const result = await request(config, "/v1/me", { token: config.tokenA });
  assertStatus(result, 200, "valid bearer token should authenticate");
  const body = requireObjectBody(result, "me response must be JSON object");
  assertSecretAbsent(body, config.tokenA, "me must not echo the bearer token");
  assert.ok(
    Object.prototype.hasOwnProperty.call(body, "apiVersion") ||
      Object.prototype.hasOwnProperty.call(body, "capabilities") ||
      Object.prototype.hasOwnProperty.call(body, "user"),
    "me should expose API metadata or a non-secret user label",
  );
});

blackbox("OPTIONS responds with CORS headers for authenticated browser calls", async (config) => {
  const origin = "https://anima-remote-integration.invalid";
  const result = await request(config, "/v1/me", {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "authorization,content-type",
    },
  });
  assert.ok(result.status >= 200 && result.status < 300, "CORS preflight should succeed");

  const allowOrigin = result.headers.get("access-control-allow-origin");
  assert.ok(allowOrigin === "*" || allowOrigin === origin, "CORS must allow the requesting origin");
  assert.match(
    result.headers.get("access-control-allow-headers") || "",
    /authorization/i,
    "CORS must allow Authorization",
  );
  assert.match(
    result.headers.get("access-control-allow-headers") || "",
    /content-type/i,
    "CORS must allow Content-Type",
  );
});

blackbox("settings revisions, conflict response, history, and secret filtering work per tenant", async (config) => {
  const prefix = randomPrefix();
  const key = `${prefix}-settings`;
  const secret = `${prefix}-runtime-secret-${randomPrefix()}`;
  const markerA = `${prefix}-owner-a`;
  const markerB = `${prefix}-owner-b`;

  try {
    const first = await request(config, settingEndpoint("global", key), {
      method: "PUT",
      token: config.tokenA,
      body: {
        baseRevision: 0,
        deviceId: `${prefix}-device-a`,
        value: {
          marker: markerA,
          nested: {
            keep: "safe",
            apiKey: secret,
            deeper: { PASSWORD: secret, secret },
          },
        },
      },
    });
    assertSuccess(first, "first settings write should succeed");
    assertSecretAbsent(first.body, secret, "write response must filter nested secret fields");

    const readA = await request(config, settingEndpoint("global", key), { token: config.tokenA });
    assertStatus(readA, 200, "owner should read its settings");
    const readABody = requireObjectBody(readA, "settings response must be JSON object");
    assert.equal(readABody.revision, 1, "first settings write should create revision 1");
    assert.equal(readABody.value?.marker, markerA, "owner value should be retained");
    assertSecretAbsent(readA.body, secret, "settings download must not contain secrets");

    const stale = await request(config, settingEndpoint("global", key), {
      method: "PUT",
      token: config.tokenA,
      body: {
        baseRevision: 0,
        deviceId: `${prefix}-stale-device`,
        value: { marker: `${prefix}-stale` },
      },
    });
    assertStatus(stale, 409, "stale settings revision should conflict");
    assert.equal(stale.body?.error, "revision_conflict", "conflict should have a stable machine code");
    assertSecretAbsent(stale.body, secret, "conflict response must not contain secrets");

    const historySeed = await request(config, settingEndpoint("global", key), {
      method: "PUT",
      token: config.tokenA,
      body: {
        baseRevision: 1,
        deviceId: `${prefix}-device-a-2`,
        value: { marker: `${prefix}-owner-a-2` },
      },
    });
    assertSuccess(historySeed, "second settings write should succeed");
    assert.equal(historySeed.body?.revision, 2, "second settings write should create revision 2");

    const history = await request(config, `${settingEndpoint("global", key)}/history`, { token: config.tokenA });
    assertStatus(history, 200, "settings history should be readable");
    assert.ok(Array.isArray(history.body?.history), "history response should contain an array");
    assertSecretAbsent(history.body, secret, "settings history must not contain secrets");

    const readB = await request(config, settingEndpoint("global", key), { token: config.tokenB });
    assertStatus(readB, 200, "second tenant should receive an empty settings document");
    assert.equal(readB.body?.revision, 0, "second tenant must not see tenant A revision");
    assert.equal(containsValue(readB.body, markerA), false, "second tenant must not see tenant A value");

    const writeB = await request(config, settingEndpoint("global", key), {
      method: "PUT",
      token: config.tokenB,
      body: {
        baseRevision: 0,
        deviceId: `${prefix}-device-b`,
        value: { marker: markerB },
      },
    });
    assertSuccess(writeB, "second tenant should write its own revision 1");
    assert.equal(writeB.body?.revision, 1, "tenant B revision should start at 1");

    const readAAfterB = await request(config, settingEndpoint("global", key), { token: config.tokenA });
    assertStatus(readAAfterB, 200, "tenant A settings should remain readable");
    assert.equal(readAAfterB.body?.value?.marker, `${prefix}-owner-a-2`, "tenant B write must not modify tenant A");
  } finally {
    await bestEffortClearSetting(config, config.tokenA, "global", key);
    await bestEffortClearSetting(config, config.tokenB, "global", key);
  }
});

blackbox("two tenants isolate identical logical BM25 IDs across list/query/modify/export/delete", async (config) => {
  const prefix = randomPrefix();
  const fileName = `${prefix}.txt`;
  const logicalId = `kb_${prefix}`;
  const markerA = `${prefix}-data-a`;
  const markerB = `${prefix}-data-b`;

  try {
    const importedA = await importBm25Knowledge(config, config.tokenA, fileName, markerA);
    assertSuccess(importedA, "tenant A knowledge import should succeed");

    const listA = await request(config, "/v1/anima/bm25/list", { token: config.tokenA });
    assertStatus(listA, 200, "tenant A BM25 list should succeed");
    assert.ok(asIdList(listA.body).includes(logicalId), "tenant A should see its logical library");

    const listB = await request(config, "/v1/anima/bm25/list", { token: config.tokenB });
    assertStatus(listB, 200, "tenant B BM25 list should succeed");
    assert.equal(asIdList(listB.body).includes(logicalId), false, "tenant B must not list tenant A library");

    const exportB = await request(config, "/v1/anima/bm25/export_single", {
      method: "POST",
      token: config.tokenB,
      body: { libName: logicalId },
    });
    assert.ok([403, 404].includes(exportB.status), "tenant B must not export tenant A library");

    const importedB = await importBm25Knowledge(config, config.tokenB, fileName, markerB);
    assertSuccess(importedB, "tenant B should be able to create the same logical library in its own tenant");

    const queryA = await queryBm25Knowledge(config, config.tokenA, logicalId, markerA);
    assertStatus(queryA, 200, "tenant A query should succeed");
    assert.equal(containsValue(queryA.body, markerA), true, "tenant A query should return tenant A data");
    assert.equal(containsValue(queryA.body, markerB), false, "tenant A query must not return tenant B data");

    const queryB = await queryBm25Knowledge(config, config.tokenB, logicalId, markerB);
    assertStatus(queryB, 200, "tenant B query should succeed");
    assert.equal(containsValue(queryB.body, markerB), true, "tenant B query should return tenant B data");
    assert.equal(containsValue(queryB.body, markerA), false, "tenant B query must not return tenant A data");

    const deleteB = await request(config, "/v1/anima/bm25/delete_single", {
      method: "POST",
      token: config.tokenB,
      body: { libName: logicalId },
    });
    assert.ok(
      [200, 204, 403, 404].includes(deleteB.status),
      "tenant B delete must be handled without touching tenant A",
    );

    const exportAAfterBDelete = await request(config, "/v1/anima/bm25/export_single", {
      method: "POST",
      token: config.tokenA,
      body: { libName: logicalId },
    });
    assertStatus(exportAAfterBDelete, 200, "tenant B delete must not remove tenant A library");
    assert.equal(containsValue(exportAAfterBDelete.body, markerA), true, "tenant A export should retain tenant A data");
  } finally {
    await bestEffortDeleteBm25(config, config.tokenA, logicalId);
    await bestEffortDeleteBm25(config, config.tokenB, logicalId);
  }
});

blackbox("proxy rejects loopback private targets before outbound fetch", async (config) => {
  const result = await request(config, "/v1/anima/proxy/forward", {
    method: "POST",
    token: config.tokenA,
    body: {
      targetUrl: "https://127.0.0.1:9/anima-remote-private-test",
      method: "GET",
      headers: {},
      isStream: false,
    },
  });
  assertStatus(result, 403, "private proxy target must be denied");
  assert.equal(result.body?.error, "private_outbound_denied", "proxy denial should have stable machine code");
});

blackbox("query embedding cannot bypass outbound target policy", async (config) => {
  const result = await request(config, "/v1/anima/query", {
    method: "POST",
    token: config.tokenA,
    body: {
      searchText: "policy test",
      bm25SearchText: "",
      apiConfig: {
        url: "http://127.0.0.1:9/v1",
        key: "blackbox-placeholder",
        model: "embedding-test",
      },
      chatContext: { ids: [], strategy: null },
      kbContext: { ids: [], strategy: null },
    },
  });
  assertStatus(result, 403, "embedding target must use the same outbound policy as proxy calls");
  assert.equal(result.body?.error, "private_outbound_denied");
});
