const test = require("node:test");
const assert = require("node:assert/strict");

const {
    buildScopedIgnoreFilter,
    isIgnoredSliceId,
    normalizeIgnoreIds,
} = require("../ignore_filter");

let ItemSelector = null;
try {
    ({ ItemSelector } = require("vectra/lib/ItemSelector"));
} catch {}

test("slice IDs are excluded by exact equality only", () => {
    const ignoreIds = ["13_1", "14_1", "56_3"];

    assert.equal(isIgnoredSliceId("13_1", ignoreIds), true);
    assert.equal(isIgnoredSliceId("14_1", ignoreIds), true);
    assert.equal(isIgnoredSliceId("56_3", ignoreIds), true);
    assert.equal(isIgnoredSliceId("3_1", ignoreIds), false);
    assert.equal(isIgnoredSliceId("4_1", ignoreIds), false);
    assert.equal(isIgnoredSliceId("6_3", ignoreIds), false);
});

test("ignore IDs are normalized and deduplicated", () => {
    assert.deepEqual(normalizeIgnoreIds(["13_1", 14, "13_1", "", null]), [
        "13_1",
        "14",
    ]);
});

test("ignore filter is applied only to the selected chat collection", () => {
    assert.deepEqual(
        buildScopedIgnoreFilter(
            { tags: { $in: ["Important"] } },
            "latest_chat",
            "latest_chat",
            ["13_1", "14_1"],
        ),
        {
            tags: { $in: ["Important"] },
            index: { $nin: ["13_1", "14_1"] },
        },
    );

    assert.deepEqual(
        buildScopedIgnoreFilter(
            { tags: { $in: ["Important"] } },
            "older_chat",
            "latest_chat",
            ["13_1", "14_1"],
        ),
        { tags: { $in: ["Important"] } },
    );
});

test(
    "installed Vectra applies $nin with exact slice ID equality",
    { skip: !ItemSelector },
    () => {
        const filter = {
            index: { $nin: ["13_1", "14_1", "56_3"] },
        };

        assert.equal(ItemSelector.select({ index: "13_1" }, filter), false);
        assert.equal(ItemSelector.select({ index: "14_1" }, filter), false);
        assert.equal(ItemSelector.select({ index: "56_3" }, filter), false);
        assert.equal(ItemSelector.select({ index: "3_1" }, filter), true);
        assert.equal(ItemSelector.select({ index: "4_1" }, filter), true);
        assert.equal(ItemSelector.select({ index: "6_3" }, filter), true);
    },
);
