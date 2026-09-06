import test from "node:test";
import assert from "node:assert/strict";

import { processApiUrl } from "../scripts/api.js";

test("host-only OpenAI-compatible URLs get /v1 at request time", () => {
  assert.equal(
    processApiUrl("http://127.0.0.1:8050", "openai"),
    "http://127.0.0.1:8050/v1",
  );
  assert.equal(
    processApiUrl("https://api.example.test", "openai"),
    "https://api.example.test/v1",
  );
});

test("explicit provider paths are preserved", () => {
  assert.equal(
    processApiUrl("http://127.0.0.1:8050/custom", "openai"),
    "http://127.0.0.1:8050/custom",
  );
  assert.equal(
    processApiUrl("https://generativelanguage.googleapis.com", "google"),
    "https://generativelanguage.googleapis.com",
  );
});
