import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  AnimaTransportError,
  ajaxAnima,
  isAllowedRemoteUrl,
  mergeSettingsScopes,
  normalizeRemoteBaseUrl,
  requestAnima,
  resolveAnimaUrl,
  sanitizeSettingsForSync,
  syncAnimaSettings,
} from "../scripts/transport.js";

const localBackendRoute = ["/api", "plugins", "anima-rag"].join("/");
const remoteAnimaRoute = ["/v1", "anima"].join("/");

test("remote URL policy allows HTTPS and loopback HTTP only", () => {
  assert.equal(isAllowedRemoteUrl("https://anima.example"), true);
  assert.equal(isAllowedRemoteUrl("https://100.64.0.2"), true);
  assert.equal(isAllowedRemoteUrl("http://localhost:8787"), true);
  assert.equal(isAllowedRemoteUrl("http://127.0.0.1:8787"), true);
  assert.equal(isAllowedRemoteUrl("http://[::1]:8787"), true);
  assert.equal(isAllowedRemoteUrl("http://100.64.0.2:8787"), false);
  assert.equal(isAllowedRemoteUrl("http://192.168.1.20:8787"), false);
  assert.equal(isAllowedRemoteUrl("https://user:password@anima.example"), false);
});

test("remote base URL is normalized without duplicating API prefixes", () => {
  assert.equal(
    normalizeRemoteBaseUrl(
      ` https://anima.example/team${remoteAnimaRoute}/?x=1#fragment `,
    ),
    "https://anima.example/team",
  );
  assert.equal(
    resolveAnimaUrl("/query", {
      mode: "remote",
      baseUrl: "https://anima.example/team",
    }),
    `https://anima.example/team${remoteAnimaRoute}/query`,
  );
  assert.equal(
    resolveAnimaUrl("/settings/global/default", {
      mode: "remote",
      baseUrl: "https://anima.example/team",
    }),
    "https://anima.example/team/v1/settings/global/default",
  );
  assert.equal(
    resolveAnimaUrl("/me", {
      mode: "remote",
      baseUrl: "https://anima.example/team",
    }),
    "https://anima.example/team/v1/me",
  );
});

test("remote requests attach Bearer and JSON headers", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const value = await requestAnima("/query", {
      method: "POST",
      body: { text: "hello" },
      transportConfig: {
        mode: "remote",
        baseUrl: "https://anima.example",
        token: "test-token",
        timeoutMs: 1000,
      },
    });
    assert.deepEqual(value, { ok: true });
    assert.equal(request.url, `https://anima.example${remoteAnimaRoute}/query`);
    assert.equal(request.options.headers.Authorization, "Bearer test-token");
    assert.equal(request.options.headers["Content-Type"], "application/json");
    assert.equal(request.options.body, JSON.stringify({ text: "hello" }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("remote errors expose stable code, status, and detail", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "revision_conflict", message: "stale" }), {
      status: 409,
      headers: { "content-type": "application/json" },
    });

  try {
    await assert.rejects(
      requestAnima("/settings/global/default", {
        method: "GET",
        transportConfig: {
          mode: "remote",
          baseUrl: "https://anima.example",
          token: "test-token",
        },
      }),
      (error) => {
        assert.equal(error instanceof AnimaTransportError, true);
        assert.equal(error.code, "revision_conflict");
        assert.equal(error.status, 409);
        assert.equal(error.message, "stale");
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AJAX compatibility adapter keeps callback callers on the shared transport", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  let callbackValue;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const value = await ajaxAnima({
      url: "/list",
      type: "POST",
      contentType: "application/json",
      data: JSON.stringify({ hello: "world" }),
      transportConfig: {
        mode: "remote",
        baseUrl: "https://anima.example",
        token: "adapter-token",
      },
      success(data) {
        callbackValue = data;
      },
    });
    assert.deepEqual(value, { success: true });
    assert.deepEqual(callbackValue, value);
    assert.equal(request.url, `https://anima.example${remoteAnimaRoute}/list`);
    assert.equal(request.options.headers.Authorization, "Bearer adapter-token");
    assert.equal(request.options.headers["Content-Type"], "application/json");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("settings sanitizer recursively removes secrets but keeps non-secret values", () => {
  const sanitized = sanitizeSettingsForSync({
    model: "embedding-model",
    apiKey: "secret-1",
    nested: {
      key: "secret-2",
      access_token: "secret-3",
      cookie: "secret-4",
      prompt: ["keep this"],
    },
    transport: { mode: "remote", token: "secret-5" },
  });
  assert.deepEqual(sanitized, {
    model: "embedding-model",
    nested: { prompt: ["keep this"] },
  });
});

test("settings precedence is global < character < chat and arrays replace", () => {
  assert.deepEqual(
    mergeSettingsScopes(
      { nested: { global: true, shared: "global" }, prompt: ["g"] },
      { nested: { character: true, shared: "character" }, prompt: ["c"] },
      { nested: { chat: true, shared: "chat" }, prompt: ["h"] },
    ),
    {
      nested: { global: true, character: true, chat: true, shared: "chat" },
      prompt: ["h"],
    },
  );
});

test("settings sync uploads sanitized global/character/chat scopes", async () => {
  const originalFetch = globalThis.fetch;
  const originalSt = globalThis.SillyTavern;
  const putRequests = [];
  const context = {
    extensionSettings: {
      anima_memory_system: {
        api: { llm: { model: "local-model", key: "do-not-upload" } },
        transport: {
          mode: "remote",
          baseUrl: "https://anima.example",
          token: "transport-token",
          sync: { deviceId: "device-test", scopes: {}, conflicts: [] },
        },
      },
      anima_bm25_system: { enabled: true },
    },
    characterId: 0,
    characters: [{ avatar: "alice.png", data: { extensions: { anima_rag_settings: { top_k: 3 } } } }],
    chatId: "chat-1",
    chatMetadata: { anima_config: { enabled: true } },
    saveSettingsDebounced() {},
    saveMetadata() {},
  };
  globalThis.SillyTavern = { getContext: () => context };
  globalThis.fetch = async (url, options) => {
    if (options.method === "PUT") {
      putRequests.push({ url, options, body: JSON.parse(options.body) });
      return new Response(
        JSON.stringify({ revision: putRequests.length, value: JSON.parse(options.body).value }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ revision: 0, value: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const result = await syncAnimaSettings();
    assert.equal(result.skipped, false);
    assert.equal(putRequests.length, 3);
    for (const item of putRequests) {
      assert.equal(item.options.headers.Authorization, "Bearer transport-token");
      const serialized = JSON.stringify(item.body.value);
      assert.equal(serialized.includes("do-not-upload"), false);
      assert.equal(serialized.includes("transport-token"), false);
    }
    assert.equal(context.extensionSettings.anima_memory_system.api.llm.key, "do-not-upload");
    assert.equal(
      putRequests.some((item) => item.url.includes(encodeURIComponent("character:alice.png"))),
      true,
      "character scope must use a stable card identity instead of the local array index",
    );

    await syncAnimaSettings();
    assert.equal(putRequests.length, 3, "unchanged settings must not be uploaded again");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.SillyTavern = originalSt;
  }
});

test("settings sync keeps a remote winner and a sanitized local recovery copy on conflict", async () => {
  const originalFetch = globalThis.fetch;
  const originalSt = globalThis.SillyTavern;
  const context = {
    extensionSettings: {
      anima_memory_system: {
        api: { llm: { model: "local-model", key: "local-secret" } },
        transport: {
          mode: "remote",
          baseUrl: "https://anima.example",
          token: "transport-token",
          sync: {
            deviceId: "device-test",
            scopes: { global: { default: { revision: 1, snapshot: "{}" } } },
            conflicts: [],
          },
        },
      },
    },
    characters: [],
    characterId: null,
    chatId: null,
    chatMetadata: null,
    saveSettingsDebounced() {},
  };
  globalThis.SillyTavern = { getContext: () => context };
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        revision: 3,
        value: { anima_memory_system: { api: { llm: { model: "remote-model" } } } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  try {
    await syncAnimaSettings();
    const syncState = context.extensionSettings.anima_memory_system.transport.sync;
    assert.equal(syncState.conflicts.length, 1);
    assert.equal(syncState.conflicts[0].remoteRevision, 3);
    assert.equal(JSON.stringify(syncState.conflicts[0].localValue).includes("local-secret"), false);
    assert.equal(context.extensionSettings.anima_memory_system.api.llm.model, "remote-model");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.SillyTavern = originalSt;
  }
});

test("Anima plugin routes are centralized in transport", async () => {
  const extensionRoot = join(import.meta.dirname, "..");
  const files = [];
  async function visit(directory) {
    const entries = await (await import("node:fs/promises")).readdir(directory, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "tests") {
        await visit(fullPath);
      } else if (entry.isFile() && /\.(?:js|json)$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
  }
  await visit(extensionRoot);

  for (const file of files) {
    if (file.endsWith(join("scripts", "transport.js"))) continue;
    const source = await readFile(file, "utf8");
    assert.equal(source.includes(localBackendRoute), false, file);
    assert.equal(source.includes(remoteAnimaRoute), false, file);
  }
});
