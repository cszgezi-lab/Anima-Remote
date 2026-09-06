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

const {
  buildImportedSkillInstruction,
  buildSkillSystemPrompt,
  calculateSkillRetrievalBudget,
  createAssistantPlan,
  markdownToPlainText,
  parseSkillAgentResponse,
  parseSkillAssistantResponse,
  sanitizeAssistantPatch,
  validateSkillConfigPlan,
} = await import("../scripts/assistant.js");

test("imported SKILL.md is treated as bounded configuration guidance", () => {
  const prompt = buildImportedSkillInstruction(
    "Izumi_SKILL.md",
    "请重点保留承诺和共同习惯。\napi_key: should-not-be-forwarded",
    "direct",
  );

  assert.match(prompt, /Izumi_SKILL\.md/);
  assert.match(prompt, /承诺和共同习惯/);
  assert.match(prompt, /宿主的安全规则/);
  assert.match(prompt, /\[本地敏感值已隐藏\]/);
  assert.match(prompt, /已解析为普通文字/);
});

test("markdown skill is parsed to plain text before it enters the model prompt", () => {
  const text = markdownToPlainText(
    "# 配置规则\n\n- **保留承诺** [参考](https://example.com)\n\n```json\n{\"enabled\": true}\n```",
  );

  assert.match(text, /配置规则/);
  assert.match(text, /保留承诺/);
  assert.match(text, /参考/);
  assert.match(text, /\{\"enabled\": true\}/);
  assert.doesNotMatch(text, /(^|\n)#/);
  assert.doesNotMatch(text, /```/);
});

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

test("skill assistant prompt includes the bundled novice skill and full distributed retrieval fields", () => {
  const prompt = buildSkillSystemPrompt({ api: { llm: { key: "[已配置，未读取]" } } });

  assert.match(prompt, /Izumi 长期 RP \/ MVU 新手版/);
  assert.match(prompt, /candidate_multiplier/);
  assert.match(prompt, /strategy_settings/);
  assert.match(prompt, /API Key、Token、Cookie/);
});

test("skill assistant parser keeps nested retrieval settings but strips secrets", () => {
  const parsed = parseSkillAssistantResponse(`
    下面是方案：
    {"type":"CONFIG_PLAN","changes":{"api":{"llm":{"key":"do-not-write","model":"model-x"}},"rag":{"distributed_retrieval":true,"strategy_settings":{"important":{"labels":["Important","Relationship"],"count":2},"diversity":{"count":2}},"injection_settings":{"recent_count":3}}}}
  `);

  assert.equal(parsed.type, "CONFIG_PLAN");
  assert.equal(parsed.changes.api.llm.key, undefined);
  assert.equal(parsed.changes.api.llm.model, "model-x");
  assert.deepEqual(parsed.changes.rag.strategy_settings.important.labels, ["Important", "Relationship"]);
  assert.equal(parsed.changes.rag.injection_settings.recent_count, 3);
});

test("skill assistant accepts one-question responses", () => {
  const parsed = parseSkillAssistantResponse(
    '{"type":"QUESTION","question":"这张卡是否使用 MVU 或 EJS？","why":"避免两套状态变量互相覆盖"}',
  );

  assert.equal(parsed.type, "QUESTION");
  assert.match(parsed.question, /MVU/);
  assert.match(parsed.why, /状态/);
});

test("sanitizer removes secret fields recursively without dropping ordinary fields", () => {
  const result = sanitizeAssistantPatch({
    rag: { strategy_settings: { status: { rules: [{ tag: "Injury" }] } } },
    api: { rag: { apiKey: "secret", model: "embedding-x" } },
    constructor: { polluted: true },
  });

  assert.equal(result.api.rag.apiKey, undefined);
  assert.equal(result.api.rag.model, "embedding-x");
  assert.deepEqual(result.rag.strategy_settings.status.rules, [{ tag: "Injury" }]);
  assert.equal(Object.hasOwn(result, "constructor"), false);
});

test("formal skill response rejects a plan containing a credential field", () => {
  assert.throws(
    () => parseSkillAgentResponse('{"response_type":"plan","config_plan":{"schema_version":"anima-config-plan/1.0","api":{"key":"secret"}}}'),
    /敏感字段/,
  );
});

test("formal skill plan validates distributed retrieval worst-case budget", () => {
  const plan = {
    schema_version: "anima-config-plan/1.0",
    plan_id: "test-plan",
    mode: "skill_newbie",
    status: "ready",
    intent: {
      primary_goals: ["Relationship"],
      memory_style: "conservative",
      keep_user_messages: "yes",
      knowledge_need: "no",
      state_authority: "none",
      notes: "",
    },
    discovery_ref: "d-1",
    scope_policy: {
      precedence: ["global", "character", "chat"],
      target_scopes: ["global"],
      preserve_unknown_fields: true,
      array_merge: "replace",
      notes: "全局默认配置",
    },
    patches: {
      global: {
        api: {},
        summary: {},
        rag: {
          rag_enabled: true,
          base_count: 3,
          distributed_retrieval: true,
          strategy_settings: {
            candidate_multiplier: 2,
            important: { labels: ["Important", "Relationship", "Persona"], count: 1 },
            special: { count: 1 },
            period: { count: 1 },
            status: { labels: [], count: 1, rules: [] },
            diversity: { count: 2 },
          },
        },
        bm25: {},
        knowledge: {},
        status: {},
      },
      character: { api: {}, summary: {}, rag: {}, bm25: {}, knowledge: {}, status: {} },
      chat: { api: {}, summary: {}, rag: {}, bm25: {}, knowledge: {}, status: {} },
    },
    knowledge_files: [],
    database_actions: [],
    retrieval_budget: {
      profile: "conservative",
      context_limit_known: false,
      estimated_context_limit: null,
      base_slots: 3,
      important_label_count: 3,
      important_count_per_label: 1,
      important_worst_case_slots: 3,
      status_worst_case_slots: 0,
      period_worst_case_slots: 0,
      holiday_worst_case_slots: 1,
      diversity_slots: 2,
      recent_history_slots: 2,
      echo_max_count: 10,
      candidate_multiplier: 2,
      estimated_pre_rerank_slots: 9,
      estimated_candidate_slots: 18,
      estimated_memory_tokens: null,
      memory_context_ratio: null,
      safe: true,
      violations: [],
    },
    summary_tag_contract: {
      vibe: ["Daily"],
      focus: ["Relationship", "Persona"],
      special: ["Promise", "RoutineFormed"],
      reserved_runtime_tags: ["Sick", "Injury"],
      important_is_boolean: true,
    },
    tag_retrieval_map: [],
    preconditions: [],
    validation: {},
    explanations: [],
    risk_flags: [],
    requires_confirmation: true,
  };
  const discovery = {
    discovery_id: "d-1",
    scope: { current_character_present: false, current_chat_present: false },
    capabilities: { supports_chat_rag_override_write: false },
    backend: { reachable: true },
    character: { state_system_detection: {} },
    api_readiness: {
      embedding: { configured: true, credential_present: true },
      status: { configured: false, credential_present: false },
      rerank: { configured: false, credential_present: false },
    },
  };
  assert.deepEqual(calculateSkillRetrievalBudget(plan).importantWorstCaseSlots, 3);
  assert.equal(validateSkillConfigPlan(plan, discovery).ok, true);
});
