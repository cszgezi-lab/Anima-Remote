import test from "node:test";
import assert from "node:assert/strict";

const context = {
  extensionSettings: {},
  chatMetadata: {},
  saveSettingsDebounced() {},
  saveMetadata() {},
};

globalThis.window = {
  SillyTavern: { getContext: () => context },
};
globalThis.SillyTavern = globalThis.window.SillyTavern;

const { createAssistantPlan } = await import("../scripts/assistant.js");

test("assistant disables Anima state when an external variable system is selected", () => {
  const plan = createAssistantPlan({
    goal: "记住长期关系中的承诺和共同习惯",
    categories: ["Relationship"],
    externalVariables: true,
    animaState: true,
    knowledgeAnswer: "no",
  });

  assert.equal(plan.status.enabled, false);
  assert.equal(plan.knowledge.enabled, false);
  assert.equal(plan.summary.summary_messages.find((item) => item.type === "prev_summaries").count, 2);
  assert.equal(plan.summary.exclude_user, false);
  assert.match(plan.summary.summary_messages[3].content, /承诺和共同习惯/);
});

test("assistant prepares a knowledge import and category-aware retrieval plan", () => {
  const plan = createAssistantPlan({
    goal: "补充原作世界观和人物设定",
    categories: ["World", "Persona"],
    externalVariables: false,
    animaState: true,
    knowledgeAnswer: "yes",
    knowledgePurpose: "原作与世界观设定",
    files: [{ name: "原作.txt" }],
  });

  assert.equal(plan.status.enabled, true);
  assert.equal(plan.knowledge.enabled, true);
  assert.equal(plan.knowledge.files.length, 1);
  assert.deepEqual(plan.rag.strategy_settings.important.labels, ["Important", "World", "Persona"]);
  assert.equal(plan.bm25.bm25_enabled, true);
});
