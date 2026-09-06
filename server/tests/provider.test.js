const test = require("node:test");
const assert = require("node:assert/strict");

const {
    createProviderHeaders,
    normalizeProviderBaseUrl,
} = require("../provider");

test("provider base URL preserves a bare host without inferring /v1", () => {
    assert.equal(
        normalizeProviderBaseUrl("http://127.0.0.1:8050"),
        "http://127.0.0.1:8050",
    );
    assert.equal(
        normalizeProviderBaseUrl("http://127.0.0.1:8050/custom"),
        "http://127.0.0.1:8050/custom",
    );
});

test("provider authorization is omitted when the key is empty", () => {
    assert.deepEqual(createProviderHeaders({ key: "" }, { "Content-Type": "application/json" }), {
        "Content-Type": "application/json",
    });
    assert.equal(
        createProviderHeaders({ key: "provider-secret" }).Authorization,
        "Bearer provider-secret",
    );
});
