const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const {
  EXTENSION_ROOT,
  INTEGRATION_ROOT,
  isTextFile,
  listFiles,
  readText,
} = require("./helpers.js");

function relativePath(root, filePath) {
  return path.relative(root, filePath).replaceAll(path.sep, "/");
}

function isTransportOrTestFile(relative) {
  const normalized = relative.toLowerCase();
  return (
    normalized === "scripts/transport.js" ||
    normalized.includes("/transport/") ||
    normalized.startsWith("test/") ||
    normalized.startsWith("tests/") ||
    normalized.includes("/test/") ||
    normalized.includes("/tests/") ||
    normalized.endsWith(".test.js") ||
    normalized.endsWith(".test.mjs") ||
    normalized.endsWith(".spec.js") ||
    normalized.endsWith(".spec.mjs")
  );
}

async function loadTransportModule() {
  const source = readText(path.join(EXTENSION_ROOT, "scripts", "transport.js"));
  const encoded = Buffer.from(source, "utf8").toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

test("extension manifest points to existing install assets", () => {
  const manifestPath = path.join(EXTENSION_ROOT, "manifest.json");
  const manifest = JSON.parse(readText(manifestPath));

  assert.equal(typeof manifest.js, "string", "manifest.js is required");
  assert.equal(typeof manifest.css, "string", "manifest.css is required");
  assert.ok(fs.existsSync(path.join(EXTENSION_ROOT, manifest.js)), "manifest JS is missing");
  assert.ok(fs.existsSync(path.join(EXTENSION_ROOT, manifest.css)), "manifest CSS is missing");
});

test("repository root is directly installable as a TauriTavern extension", () => {
  const repositoryRoot = path.resolve(EXTENSION_ROOT, "..");
  const manifestPath = path.join(repositoryRoot, "manifest.json");
  assert.equal(fs.existsSync(manifestPath), true, "root manifest.json is required for Git installation");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(typeof manifest.js, "string");
  assert.equal(typeof manifest.css, "string");
  assert.equal(fs.existsSync(path.join(repositoryRoot, manifest.js)), true, "root manifest JS asset must exist");
  assert.equal(fs.existsSync(path.join(repositoryRoot, manifest.css)), true, "root manifest CSS asset must exist");
});

test("extension has no hard-coded backend routes outside transport or tests", () => {
  const routePatterns = [
    /\/api\/plugins\/anima-rag\b/g,
    /\/v1\/anima\b/g,
  ];
  const violations = [];

  for (const filePath of listFiles(EXTENSION_ROOT).filter(isTextFile)) {
    const relative = relativePath(EXTENSION_ROOT, filePath);
    if (isTransportOrTestFile(relative)) continue;

    const lines = readText(filePath).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (routePatterns.some((pattern) => pattern.test(line))) {
        routePatterns.forEach((pattern) => pattern.lastIndex = 0);
        violations.push(`${relative}:${index + 1}`);
      }
      routePatterns.forEach((pattern) => pattern.lastIndex = 0);
    });
  }

  assert.deepEqual(
    violations,
    [],
    `backend route literals must be centralized in scripts/transport.js (found: ${violations.join(", ")})`,
  );
});

test("remote URL policy rejects every non-localhost HTTP URL", async () => {
  const transport = await loadTransportModule();

  for (const url of [
    "http://100.96.176.24:8000",
    "http://10.0.0.8:8000",
    "http://192.168.1.20:8000",
    "http://anima.example.test",
  ]) {
    assert.equal(transport.isAllowedRemoteUrl(url), false, "non-local HTTP must be rejected");
    assert.throws(
      () => transport.normalizeRemoteBaseUrl(url),
      (error) => error?.code === "insecure_url",
      "normalization must reject non-local HTTP",
    );
  }

  for (const url of [
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "http://[::1]:8000",
    "https://100.96.176.24:8000",
    "https://anima.example.test",
  ]) {
    assert.equal(transport.isAllowedRemoteUrl(url), true, "HTTPS or loopback HTTP should be allowed");
  }

  assert.equal(
    transport.resolveAnimaUrl("/query", {
      mode: "remote",
      baseUrl: "https://anima.example.test",
      timeoutMs: 1000,
    }),
    "https://anima.example.test/v1/anima/query",
  );
  assert.equal(
    transport.resolveAnimaUrl("/me", {
      mode: "remote",
      baseUrl: "https://anima.example.test",
      timeoutMs: 1000,
    }),
    "https://anima.example.test/v1/me",
  );
});

test("extension has an actionable TavernHelper missing-dependency diagnostic", () => {
  const entrypoint = readText(path.join(EXTENSION_ROOT, "index.js"));
  assert.match(entrypoint, /TavernHelper/, "entrypoint must check TavernHelper");
  assert.match(entrypoint, /MAX_RETRIES/, "dependency wait must be bounded");
  assert.match(entrypoint, /toastr\.error[\s\S]*依赖缺失/, "missing dependency must produce one visible diagnostic");
});

test("test package contains no obvious literal bearer/API token", () => {
  const suspiciousPatterns = [
    /Bearer\s+[A-Za-z0-9][A-Za-z0-9._~-]{15,}/i,
    /(?:sk|pk|rk|ghp|xoxb|AIza)[-_A-Za-z0-9]{16,}/i,
  ];
  const violations = [];

  for (const filePath of listFiles(INTEGRATION_ROOT).filter(isTextFile)) {
    if (path.basename(filePath) === "static-contract.test.js") continue;
    const source = readText(filePath);
    if (suspiciousPatterns.some((pattern) => pattern.test(source))) {
      violations.push(relativePath(INTEGRATION_ROOT, filePath));
    }
  }

  assert.deepEqual(violations, [], "tokens must be supplied through environment variables, never fixtures/source literals");
});
