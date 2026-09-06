#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { TokenStore } = require("../server/auth");
const { startServer } = require("../server/standalone");

async function main() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anima-remote-blackbox-"));
  let runtime;
  try {
    const tokenStore = new TokenStore(path.join(dataRoot, "tokens.json"));
    const userA = await tokenStore.create("blackbox-a");
    const userB = await tokenStore.create("blackbox-b");
    runtime = await startServer({
      dataRoot,
      host: "127.0.0.1",
      port: 0,
      tokenStore,
      corsOrigins: ["*"],
      // Allow the literal host through the allowlist so this test exercises
      // the separate private-address rejection rather than fail-closed host
      // policy.  No outbound connection is made.
      allowedHosts: ["127.0.0.1"],
      allowHttp: true,
    });
    const address = runtime.server.address();
    if (!address || typeof address !== "object") {
      throw new Error("local test server did not expose a TCP address");
    }

    const child = spawn(
      process.execPath,
      ["--test", "tests/blackbox.test.js", "tests/static-contract.test.js"],
      {
      cwd: __dirname,
      env: {
        ...process.env,
        ANIMA_TEST_URL: `http://127.0.0.1:${address.port}`,
        ANIMA_TEST_TOKEN_A: userA.token,
        ANIMA_TEST_TOKEN_B: userB.token,
      },
        stdio: "inherit",
      },
    );
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (signal) reject(new Error(`test runner stopped by ${signal}`));
        else resolve(code ?? 1);
      });
    });
    if (exitCode !== 0) process.exitCode = exitCode;
  } finally {
    if (runtime?.server) {
      await new Promise((resolve) => runtime.server.close(resolve));
    }
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("Local black-box runner failed:", error.message);
  process.exitCode = 1;
});
