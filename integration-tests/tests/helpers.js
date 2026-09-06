const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const INTEGRATION_ROOT = path.resolve(__dirname, "..");
const PROJECT_ROOT = path.resolve(INTEGRATION_ROOT, "..");
const EXTENSION_ROOT = path.join(PROJECT_ROOT, "extension");

function listFiles(rootDirectory) {
  const files = [];
  const pending = [rootDirectory];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      throw new Error(`无法读取测试目标目录: ${path.relative(PROJECT_ROOT, current)}`);
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  }
  return files.sort();
}

function isTextFile(filePath) {
  return /\.(?:cjs|css|d\.ts|html|js|json|mjs|ts|tsx|jsx)$/i.test(filePath);
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function randomPrefix() {
  return `anima-it-${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
}

function hasBlackboxEnvironment() {
  return Boolean(
    process.env.ANIMA_TEST_URL?.trim() &&
      process.env.ANIMA_TEST_TOKEN_A?.trim() &&
      process.env.ANIMA_TEST_TOKEN_B?.trim(),
  );
}

function normalizeHostname(hostname) {
  return String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
}

function isLocalhostHostname(hostname) {
  return new Set(["localhost", "127.0.0.1", "::1"]).has(
    normalizeHostname(hostname),
  );
}

function getBlackboxConfig() {
  const url = process.env.ANIMA_TEST_URL?.trim() || "";
  const tokenA = process.env.ANIMA_TEST_TOKEN_A?.trim() || "";
  const tokenB = process.env.ANIMA_TEST_TOKEN_B?.trim() || "";
  return {
    enabled: Boolean(url && tokenA && tokenB),
    url,
    tokenA,
    tokenB,
  };
}

function validateBlackboxConfig(config) {
  if (!config.enabled) {
    throw new Error(
      "黑盒配置不完整：需要 ANIMA_TEST_URL、ANIMA_TEST_TOKEN_A 和 ANIMA_TEST_TOKEN_B",
    );
  }
  if (config.tokenA === config.tokenB) {
    throw new Error("ANIMA_TEST_TOKEN_A 和 ANIMA_TEST_TOKEN_B 必须是两枚不同令牌");
  }

  let parsed;
  try {
    parsed = new URL(config.url);
  } catch (error) {
    throw new Error("ANIMA_TEST_URL 不是有效 URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error("ANIMA_TEST_URL 不得包含 URL 用户名或密码");
  }
  if (parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && isLocalhostHostname(parsed.hostname))) {
    throw new Error(
      "ANIMA_TEST_URL 必须使用 HTTPS；HTTP 仅允许 localhost、127.0.0.1 或 ::1",
    );
  }
  parsed.search = "";
  parsed.hash = "";
  let pathname = parsed.pathname.replace(/\/+$/, "");
  pathname = pathname.replace(/\/v1\/anima$/i, "");
  parsed.pathname = pathname || "/";
  return parsed.toString().replace(/\/$/, "");
}

function makeRequestUrl(baseUrl, endpoint) {
  const cleanEndpoint = String(endpoint || "").replace(/^\/+/, "");
  return new URL(cleanEndpoint, `${baseUrl}/`).toString();
}

async function request(config, endpoint, options = {}) {
  const baseUrl = validateBlackboxConfig(config);
  const method = options.method || "GET";
  const headers = {
    Accept: "application/json",
    ...(options.headers || {}),
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  let body;
  if (options.body !== undefined) {
    body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
      headers["Content-Type"] = "application/json";
    }
  }

  const timeoutMs = Number.isFinite(Number(process.env.ANIMA_TEST_TIMEOUT_MS))
    ? Math.max(1000, Number(process.env.ANIMA_TEST_TIMEOUT_MS))
    : 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(makeRequestUrl(baseUrl, endpoint), {
      method,
      headers,
      body,
      signal: controller.signal,
      redirect: "manual",
    });
  } catch (error) {
    const reason = error?.name === "AbortError" ? "请求超时" : "网络请求失败";
    throw new Error(`${reason}: ${method} ${endpoint}`);
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text();
  let parsedBody = raw;
  if (raw) {
    try {
      parsedBody = JSON.parse(raw);
    } catch (error) {
      // Keep non-JSON responses opaque to callers; never include them in errors.
    }
  }
  return {
    status: response.status,
    headers: response.headers,
    body: parsedBody,
  };
}

function assertStatus(result, expected, label) {
  assert.equal(result.status, expected, label);
}

function assertSuccess(result, label) {
  assert.ok(result.status >= 200 && result.status < 300, label);
}

function containsValue(value, needle) {
  if (typeof value === "string") return value.includes(needle);
  if (Array.isArray(value)) return value.some((item) => containsValue(item, needle));
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => containsValue(item, needle));
  }
  return false;
}

function asIdList(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  if (!value || typeof value !== "object") return [];
  for (const key of ["collections", "libraries", "libs", "items", "data"]) {
    if (Array.isArray(value[key])) {
      return value[key]
        .map((item) => (typeof item === "string" ? item : item?.id || item?.collectionId || item?.dbId))
        .filter((item) => typeof item === "string");
    }
  }
  return [];
}

function settingEndpoint(scope, key, suffix = "") {
  return `/v1/settings/${encodeURIComponent(scope)}/${encodeURIComponent(key)}${suffix}`;
}

async function bestEffortClearSetting(config, token, scope, key) {
  try {
    const current = await request(config, settingEndpoint(scope, key), { token });
    if (current.status !== 200 || !current.body || typeof current.body !== "object") return;
    const revision = Number.isInteger(current.body.revision) ? current.body.revision : 0;
    await request(config, settingEndpoint(scope, key), {
      method: "PUT",
      token,
      body: {
        baseRevision: revision,
        deviceId: "integration-test-cleanup",
        value: {},
      },
    });
  } catch (error) {
    // Cleanup is best effort and must not mask the assertion that failed first.
  }
}

async function bestEffortDeleteBm25(config, token, logicalId) {
  try {
    await request(config, "/v1/anima/bm25/delete_single", {
      method: "POST",
      token,
      body: { libName: logicalId },
    });
  } catch (error) {
    // Cleanup is best effort and must not mask the assertion that failed first.
  }
}

module.exports = {
  EXTENSION_ROOT,
  INTEGRATION_ROOT,
  PROJECT_ROOT,
  asIdList,
  assertStatus,
  assertSuccess,
  bestEffortClearSetting,
  bestEffortDeleteBm25,
  containsValue,
  getBlackboxConfig,
  hasBlackboxEnvironment,
  isLocalhostHostname,
  isTextFile,
  listFiles,
  randomPrefix,
  readText,
  request,
  settingEndpoint,
  validateBlackboxConfig,
};
