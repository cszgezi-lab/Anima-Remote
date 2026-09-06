const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
    findAffectedDocuments,
    getDictionaryAffectedTerms,
} = require("../dictionary_reindex");

let bm25Engine = null;
try {
    bm25Engine = require("../bm25_engine");
} catch {}

test("dictionary diff returns terms only from added, removed, or changed rules", () => {
    const oldDictionary = [
        { triggers: ["狐狸"], indexWords: ["动物"] },
        { triggers: ["旧称呼"], indexWords: ["关系"] },
    ];
    const newDictionary = [
        { triggers: ["狐狸"], indexWords: ["动物"] },
        { triggers: ["新称呼"], indexWords: ["亲密关系"] },
    ];

    assert.deepEqual(
        new Set(getDictionaryAffectedTerms(oldDictionary, newDictionary)),
        new Set(["旧称呼", "关系", "新称呼", "亲密关系"]),
    );
});

test("dictionary diff ignores rule ordering and duplicate terms", () => {
    const oldDictionary = [
        { triggers: ["小狐狸", "狐狸"], indexWords: ["称呼"] },
    ];
    const newDictionary = [
        { triggers: ["狐狸", "小狐狸", "狐狸"], indexWords: ["称呼"] },
    ];

    assert.deepEqual(
        getDictionaryAffectedTerms(oldDictionary, newDictionary),
        [],
    );
});

test("affected document scan matches raw text across multiple libraries", () => {
    const storedFields = {
        a: { id: "1_1", text: "这里没有相关内容" },
        b: { id: "2_1", text: "她叫他小狐狸。" },
        c: { id: "3_1", text: "新的亲密关系已经形成。" },
    };

    assert.deepEqual(
        findAffectedDocuments(storedFields, ["小狐狸", "亲密关系"]).map(
            (doc) => doc.id,
        ),
        ["2_1", "3_1"],
    );
});

test(
    "targeted rebuild updates only matching documents and preserves IDs",
    { skip: !bm25Engine },
    async () => {
    const suffix = `${process.pid}_${Date.now()}`;
    const dbOne = `dictionary_reindex_one_${suffix}`;
    const dbTwo = `dictionary_reindex_two_${suffix}`;
    const newDictionary = [
        {
            triggers: ["小狐狸"],
            indexWords: ["亲密称呼"],
        },
    ];
    const affectedTerms = getDictionaryAffectedTerms([], newDictionary);

    try {
        await bm25Engine.buildIndex(
            dbOne,
            [
                {
                    id: "doc_1_1",
                    index: "1_1",
                    text: "这里没有相关内容。",
                },
                {
                    id: "doc_2_1",
                    index: "2_1",
                    text: "她叫他小狐狸。",
                },
            ],
            [],
            "chat",
        );
        await bm25Engine.buildIndex(
            dbTwo,
            [
                {
                    id: "doc_3_1",
                    index: "3_1",
                    text: "另一个库也出现了小狐狸。",
                },
            ],
            [],
            "chat",
        );

        const resultOne = await bm25Engine.rebuildAffectedDocuments(
            dbOne,
            affectedTerms,
            newDictionary,
        );
        const resultTwo = await bm25Engine.rebuildAffectedDocuments(
            dbTwo,
            affectedTerms,
            newDictionary,
        );

        assert.deepEqual(
            {
                scanned: resultOne.scanned,
                matched: resultOne.matched,
                rebuilt: resultOne.rebuilt,
            },
            { scanned: 2, matched: 1, rebuilt: 1 },
        );
        assert.deepEqual(
            {
                scanned: resultTwo.scanned,
                matched: resultTwo.matched,
                rebuilt: resultTwo.rebuilt,
            },
            { scanned: 1, matched: 1, rebuilt: 1 },
        );

        const indexPath = path.join(
            __dirname,
            "..",
            "data",
            "bm25_indexes",
            `${dbOne}.json`,
        );
        const storedFields = Object.values(
            JSON.parse(fs.readFileSync(indexPath, "utf8")).storedFields || {},
        );
        const untouched = storedFields.find((doc) => doc.id === "doc_1_1");
        const rebuilt = storedFields.find((doc) => doc.id === "doc_2_1");

        assert.deepEqual(untouched.tags, []);
        assert.deepEqual(rebuilt.tags, ["亲密称呼"]);
        assert.equal(rebuilt.id, "doc_2_1");
    } finally {
        await bm25Engine.deleteIndex(dbOne);
        await bm25Engine.deleteIndex(dbTwo);
    }
    },
);
