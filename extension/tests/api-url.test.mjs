import test from "node:test";
import assert from "node:assert/strict";

import { processApiUrl } from "../scripts/api.js";

test("host-only provider URLs do not get an inferred /v1 path", () => {
  assert.equal(
    processApiUrl("http://127.0.0.1:8050", "openai"),
    "http://127.0.0.1:8050",
  );
  assert.equal(
    processApiUrl("https://api.example.test", "openai"),
    "https://api.example.test",
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
