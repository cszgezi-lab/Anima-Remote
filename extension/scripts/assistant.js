import { generateText, getAnimaConfig } from "./api.js";
import {
  getSummarySettings,
  saveSummarySettings,
} from "./summary_logic.js";
import { getRagSettings, saveRagSettings } from "./rag.js";
import {
  getStatusSettings,
  saveStatusSettings,
  syncStatusToWorldBook,
} from "./status_logic.js";
import {
  DEFAULT_KB_SETTINGS,
  getCharKbSettings,
  getGlobalKbSettingsFull,
  saveCharKbSettings,
} from "./knowledge.js";
import { uploadKnowledgeBase } from "./knowledge_logic.js";
import { requestAnima, scheduleAnimaSettingsSync } from "./transport.js";
import { escapeHtml, extractJsonResult } from "./utils.js";
import {
  ANIMA_SKILL_NAME,
  ANIMA_SKILL_TEXT,
  ASSISTANT_PLAN_SCHEMA,
} from "../config/assistant_skill.js";

const MODULE_NAME = "anima_memory_system";

const CATEGORY_OPTIONS = [
  { value: "Relationship", label: "关系、承诺与共同习惯" },
  { value: "Persona", label: "角色变化、信念与目标" },
  { value: "World", label: "世界观、地点与长期设定" },
  { value: "Skill", label: "技能、成长与能力变化" },
  { value: "Combat", label: "战斗、伤势与关键行动" },
];

const EXCLUSION_RULES = [
  {
    type: "exclude",
    regex: "/<konatan_planning~>[\\s\\S]*?<\\/konatan_planning~>/gs",
  },
  {
    type: "exclude",
    regex: "/<UpdateVariable>[\\s\\S]*?<\\/UpdateVariable>/gs",
  },
  { type: "exclude", regex: "/<tucao>[\\s\\S]*?<\\/tucao>/gs" },
  { type: "exclude", regex: "/<!--[\\s\\S]*?-->/gs" },
  { type: "exclude", regex: "/<StatusPlaceHolderImpl\\s*\\/?>/gs" },
];

const DEFAULT_STATE = {
  goal: "",
  categories: ["Relationship", "Persona"],
  triggerInterval: 10,
  autoRun: true,
  knowledgeAnswer: "no",
  knowledgePurpose: "原作与世界观设定",
  files: [],
  externalVariables: null,
  animaState: false,
  keepUserMessages: true,
};

let assistantState = null;
let skillAssistantState = null;

const SECRET_FIELD_RE = /(?:^|[_-])(?:key|token|secret|password|cookie|authorization|bearer|transport|access[_-]?token|refresh[_-]?token|api[_-]?key)(?:$|[_-])|(?:key|token|secret|password|cookie|authorization|bearer|transport)$/i;
const UNSAFE_PATCH_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SKILL_API_TYPES = ["llm", "status", "rag", "rerank"];

function getContext() {
  return window.SillyTavern?.getContext?.() || null;
}

function notify(message, kind = "info") {
  const fn = window.toastr?.[kind];
  if (typeof fn === "function") fn(message, "Anima 配置助手");
  else console.log(`[Anima Assistant] ${message}`);
}

function safeFileName(fileName) {
  return String(fileName || "")
    .replace(/\.[^/.]+$/, "")
    .replace(/[^a-zA-Z0-9@\-._\u4e00-\u9fa5]/g, "_");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function mergeObject(existing, patch) {
  return { ...(existing || {}), ...(patch || {}) };
}

function deepMergeSettings(existing, patch) {
  if (!patch || typeof patch !== "object") return structuredClone(existing);
  if (Array.isArray(patch)) return structuredClone(patch);
  const output =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? structuredClone(existing)
      : {};
  for (const [key, value] of Object.entries(patch)) {
    if (UNSAFE_PATCH_KEYS.has(key)) continue;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      output[key] = deepMergeSettings(output[key], value);
    } else {
      output[key] = structuredClone(value);
    }
  }
  return output;
}

/**
 * Remove fields which the model must never be allowed to see or write.
 * Unknown non-secret fields are intentionally preserved so newer Anima fields
 * can be configured before this assistant is updated again.
 */
export function sanitizeAssistantPatch(value, parentKey = "") {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAssistantPatch(item, parentKey));
  }
  if (!value || typeof value !== "object") return value;

  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (UNSAFE_PATCH_KEYS.has(key) || SECRET_FIELD_RE.test(key)) continue;
    result[key] = sanitizeAssistantPatch(child, key);
  }
  return result;
}

function isSecretField(key) {
  const normalized = String(key || "").replace(/[-_]/g, "").toLowerCase();
  return [
    "key",
    "apikey",
    "token",
    "accesstoken",
    "refreshtoken",
    "secret",
    "password",
    "cookie",
    "authorization",
    "bearer",
    "transport",
  ].some((name) => normalized === name || normalized.endsWith(name));
}

export function findAssistantSecretPaths(value, path = "") {
  const found = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...findAssistantSecretPaths(item, `${path}[${index}]`)));
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (isSecretField(key) || SECRET_FIELD_RE.test(key)) found.push(childPath);
    found.push(...findAssistantSecretPaths(child, childPath));
  }
  return found;
}

function redactUrlSecrets(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/([?&](?:key|token|auth|signature|secret|password|access_token|api_key)=)[^&#]*/gi, "$1[已隐藏]")
    .replace(/(https?:\/\/)([^/@\s]+)@/gi, "$1[已隐藏]@");
}

function redactRuntimeValue(value, parentKey = "") {
  if (Array.isArray(value)) return value.map((item) => redactRuntimeValue(item, parentKey));
  if (!value || typeof value !== "object") return value;

  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD_RE.test(key) || isSecretField(key)) {
      result[key] = child ? "[已配置，未读取]" : "";
    } else if (/^https?:\/\//i.test(String(child || ""))) {
      result[key] = redactUrlSecrets(child);
    } else {
      result[key] = redactRuntimeValue(child, key);
    }
  }
  return result;
}

function redactUserInput(text) {
  return String(text || "")
    .replace(/((?:api[_ -]?key|token|password|secret|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[本地敏感值已隐藏]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[本地敏感值已隐藏]");
}

function getRuntimeSnapshot() {
  const context = getContext();
  const config = getAnimaConfig();
  let status = {};
  try {
    status = getStatusSettings();
  } catch (error) {
    console.warn("[Anima Assistant] status snapshot unavailable", error);
  }

  const bm25 = context ? getBm25Settings(context) : {};
  const snapshot = {
    extensionVersion: document.querySelector('script[src*="index.js"]')?.src || "unknown",
    characterId: context?.characterId ?? null,
    chatId: context?.chatId ?? null,
    characterName: context?.characters?.[context?.characterId]?.name || "",
    hasMvu: typeof window.Mvu !== "undefined",
    hasTavernHelper: typeof window.TavernHelper !== "undefined",
    filesSelectedInThisSession: skillAssistantState?.files?.map((file) => file.name) || [],
    api: redactRuntimeValue(config.api || {}),
    summary: redactRuntimeValue(getSummarySettings()),
    rag: redactRuntimeValue(getRagSettings()),
    bm25: redactRuntimeValue(bm25),
    knowledge: redactRuntimeValue(getGlobalKbSettingsFull()),
    characterKnowledge: redactRuntimeValue(getCharKbSettings()),
    status: redactRuntimeValue(status),
  };
  return snapshot;
}

function makeDiscoveryId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `discovery-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getApiReadiness(config) {
  const api = config?.api || {};
  const result = {};
  for (const type of SKILL_API_TYPES) {
    const item = api[type] || {};
    result[type === "rag" ? "embedding" : type] = {
      configured: Boolean(item.model && (item.url || item.source)),
      credential_present: Boolean(item.key),
      source: item.source || "",
      url: redactUrlSecrets(item.url || ""),
      model: item.model || "",
      stream: item.stream,
      temperature: item.temperature,
      context_limit: item.context_limit,
      max_output: item.max_output,
      top_k: item.top_k,
      threshold: item.threshold,
      timeout: item.timeout,
      current_channel: item.current_channel || null,
      health: "unknown",
    };
  }
  return result;
}

function detectExternalStateSystems(context) {
  const extensions = context?.characters?.[context?.characterId]?.data?.extensions || {};
  const extensionKeys = Object.keys(extensions);
  const mvuDetected = typeof window.Mvu !== "undefined" || extensionKeys.some((key) => /mvu/i.test(key));
  const ejsDetected = extensionKeys.some((key) => /ejs/i.test(key));
  return {
    mvu: {
      detected: mvuDetected,
      confidence: mvuDetected ? "high" : "low",
      evidence: mvuDetected ? [typeof window.Mvu !== "undefined" ? "window.Mvu" : "character extension key"] : [],
    },
    ejs: {
      detected: ejsDetected,
      confidence: ejsDetected ? "medium" : "low",
      evidence: ejsDetected ? ["character extension key"] : [],
    },
    other: [],
  };
}

export async function discoverAssistantContext() {
  const context = getContext();
  const config = getAnimaConfig();
  const character = context?.characters?.[context?.characterId];
  const extensions = character?.data?.extensions || {};
  const root = context?.extensionSettings?.[MODULE_NAME] || {};
  const chat = context?.chatMetadata || {};
  let backendReachable = false;
  try {
    await requestAnima("/healthz", { method: "GET" });
    backendReachable = true;
  } catch (error) {
    console.warn("[Anima Assistant] backend discovery failed", error?.message || "unknown");
  }

  const stateDetection = detectExternalStateSystems(context);
  const globalConfig = redactRuntimeValue(root);
  const characterConfig = redactRuntimeValue(
    Object.fromEntries(Object.entries(extensions).filter(([key]) => key.toLowerCase().startsWith("anima_"))),
  );
  const chatConfig = redactRuntimeValue(
    Object.fromEntries(Object.entries(chat).filter(([key]) => key.toLowerCase().startsWith("anima_"))),
  );
  const effective = redactRuntimeValue({
    summary: getSummarySettings(),
    rag: getRagSettings(),
    bm25: getBm25Settings(context),
    knowledge: getGlobalKbSettingsFull(),
    status: (() => {
      try { return getStatusSettings(); } catch { return {}; }
    })(),
  });

  return {
    discovery_id: makeDiscoveryId(),
    extension: { name: "Anima Remote", version: null, git_revision: null },
    backend: { reachable: backendReachable, version: null, capabilities: {} },
    scope: {
      global_available: Boolean(context?.extensionSettings),
      character_available: Boolean(character && context?.writeExtensionField),
      chat_available: Boolean(context?.chatId && context?.chatMetadata),
      current_character_present: Boolean(character),
      current_chat_present: Boolean(context?.chatId),
    },
    character: {
      id: context?.characterId ?? null,
      name: character?.name || character?.data?.name || "",
      extension_keys: Object.keys(extensions).filter((key) => key.toLowerCase().startsWith("anima_")),
      state_system_detection: stateDetection,
    },
    api_readiness: getApiReadiness(config),
    scoped_config: { global: globalConfig, character: characterConfig, chat: chatConfig, effective },
    selected_files: skillAssistantState?.files?.map((file) => ({ name: file.name, type: file.type, size: file.size })) || [],
    capabilities: {
      writable_paths: ["global", "character", ...(context?.chatMetadata ? ["chat"] : [])],
      supports_chat_rag_override_write: Boolean(context?.chatMetadata),
      supports_status_zod: true,
      supports_kb_import: backendReachable,
      supports_bm25_rebuild: backendReachable,
    },
  };
}

export function buildSkillSystemPrompt(snapshot = {}) {
  return buildSkillAgentSystemPrompt(snapshot);
  return `你是“${ANIMA_SKILL_NAME}”的实际配置代理，不是教程讲解员。\n\n${ANIMA_SKILL_TEXT}\n\n当前运行时快照（敏感字段已脱敏，不能要求用户把密钥发给你）：\n${JSON.stringify(snapshot, null, 2)}\n\n你必须先根据快照和用户回答做 Discover/Diagnose，再逐步提问。每次只问一个基础问题，问题要能由新手直接回答。不要要求用户填写 base_count、candidate_multiplier 等技术字段；你根据目标和当前配置决定它们。\n\n每次回复只能是以下两种 RAW JSON object 之一，不要 Markdown 代码块：\n1. 提问：{"type":"QUESTION","question":"一个问题","why":"为什么需要知道"}\n2. 可应用方案：符合下面 schema 的 CONFIG_PLAN。方案必须包含 changes 中实际需要改的完整嵌套字段，尤其不能漏掉 rag.strategy_settings、injection_settings、rerank、BM25 和知识库属性。未知字段不删除，敏感字段不输出。\n\nCONFIG_PLAN schema：\n${JSON.stringify(ASSISTANT_PLAN_SCHEMA, null, 2)}\n\n输出 CONFIG_PLAN 前，必须确认：记忆目标、是否有外部原作文件、是否有 MVU/EJS/其他变量系统、是否保留 User、召回预算偏好，以及是否需要知识库。若有文件，使用文件名判断用途；不要把文件内容当作已发生剧情。若有 MVU/EJS，status.status_enabled 必须为 false，除非用户明确要求双状态并说明同步方式。应用方案应遵守全局 < 角色 < 聊天作用域，不要伪造已经写入。`;
}

export function parseSkillAssistantResponse(text) {
  const extracted = extractJsonResult(String(text || ""));
  const parsed = Array.isArray(extracted) && extracted.length === 1
    ? extracted[0]
    : extracted;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("配置助手没有返回可识别的 JSON 结果，请重试一次。");
  }
  if (parsed.type === "QUESTION") {
    if (!parsed.question) throw new Error("配置助手返回了空问题，请重试一次。");
    return { type: "QUESTION", question: String(parsed.question), why: String(parsed.why || "") };
  }
  if (parsed.type === "CONFIG_PLAN" || parsed.changes) {
    if (!parsed.changes || typeof parsed.changes !== "object") {
      throw new Error("配置助手返回的方案缺少 changes，未应用任何修改。");
    }
    return {
      type: "CONFIG_PLAN",
      assistant_message: String(parsed.assistant_message || "配置方案已生成，请确认后应用。"),
      scope_summary: String(parsed.scope_summary || "当前 Anima 配置"),
      changes: sanitizeAssistantPatch(parsed.changes),
    };
  }
  throw new Error("配置助手返回的 JSON 既不是问题，也不是配置方案。");
}

function buildSkillAgentSystemPrompt(snapshot = {}) {
  return `你是“${ANIMA_SKILL_NAME}”的实际配置规划代理，不是教程讲解员，也不是直接持有存储权限的自由执行器。\n\n${ANIMA_SKILL_TEXT}\n\n当前脱敏 DISCOVERY_CONTEXT：\n${JSON.stringify(snapshot, null, 2)}\n\n必须遵守 Discover → Interview → Plan → Validate → Diff → Confirm → Apply → Readback → Rollback/Report。你只能读取 DISCOVERY_CONTEXT 并生成 JSON，不能声称已经保存。每次只问一个新手能回答的问题，不要让用户填写技术数字，不要让用户粘贴密钥。\n\n每次只能返回一个 RAW JSON object，不要 Markdown 代码块：\n1. 继续提问：{"response_type":"question","user_message":"给用户看的问题","question":{"id":"memory_style","kind":"single_choice","choices":[{"value":"conservative","label":"少而准，省 token"},{"value":"enhanced","label":"多想起一些旧事"},{"value":"auto","label":"帮我自动判断"}]},"config_plan":null}\n2. 需要本地动作：{"response_type":"local_action","user_message":"请先选择文件","local_action":{"type":"open_file_picker","accept":[".txt",".md",".json"]},"config_plan":null}\n3. 生成方案：{"response_type":"plan","user_message":"方案已生成，请先查看差异","config_plan":{...完整 CONFIG_PLAN...}}\n4. 错误：{"response_type":"error","user_message":"发生了什么","error":{"code":"...","recoverable":true},"config_plan":null}\n\nCONFIG_PLAN 示例结构（必须完整满足字段要求，实际 patch 只放需要改的字段）：\n${JSON.stringify(ASSISTANT_PLAN_SCHEMA, null, 2)}\n\n生成方案前必须确认记忆目标、User 是否作为长期证据、外部资料、状态权威、召回档位和 API 依赖。Summary 标签和分布式检索必须联动；Promise/First/RoutineFormed 等 Summary special 若强制召回必须进入 important.labels，不能错误放入 runtime special.labels。important.labels 按最坏情况逐标签乘 count 计算预算。若 discovery 显示 MVU/EJS，status_enabled=false，除非用户明确给出完整双状态同步契约。`;
}

export function parseSkillAgentResponse(text) {
  const extracted = extractJsonResult(String(text || ""));
  const parsed = Array.isArray(extracted) && extracted.length === 1 ? extracted[0] : extracted;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("配置助手没有返回可识别的 JSON 结果，请重试一次。");
  }
  const secretPaths = findAssistantSecretPaths(parsed);
  if (secretPaths.length > 0) {
    throw new Error(`配置方案包含敏感字段（${secretPaths.join(", ")}），已拒绝，密钥没有被写入。`);
  }
  if (parsed.response_type === "question") {
    if (!parsed.user_message) throw new Error("配置助手返回了空问题，请重试一次。");
    return { type: "QUESTION", responseType: "question", question: String(parsed.user_message), why: String(parsed.question?.why || ""), questionSpec: parsed.question || null };
  }
  if (parsed.response_type === "local_action") {
    return { type: "LOCAL_ACTION", responseType: "local_action", message: String(parsed.user_message || "需要你先完成一个本地操作。"), localAction: parsed.local_action || null };
  }
  if (parsed.response_type === "error") {
    return { type: "ERROR", responseType: "error", message: String(parsed.user_message || "配置助手遇到错误。"), error: parsed.error || null };
  }
  if (parsed.response_type === "plan") {
    if (!parsed.config_plan || typeof parsed.config_plan !== "object") throw new Error("配置助手返回的方案缺少 config_plan，未应用任何修改。");
    return { type: "CONFIG_PLAN", responseType: "plan", assistant_message: String(parsed.user_message || "配置方案已生成，请确认后应用。"), scope_summary: String(parsed.config_plan.scope_policy?.notes || "当前 Anima 配置"), configPlan: parsed.config_plan };
  }
  throw new Error("配置助手返回的 JSON 不是 question、local_action、plan 或 error。");
}

function createSummaryPrompt(state, focus) {
  const goal = state.goal || "保留长期连续性所需的高价值历史证据";
  const focusText = focus.join("、");
  return `你是 Anima 的长期 RP 历史总结器。你的任务是把已经发生的剧情整理成可检索的历史证据，而不是决定角色当前应该怎么演。

用户希望重点记住：${goal}
重点类别：${focusText}

严格遵守：
1. 只总结真正发生的剧情、明确可见的事实和长期连续性证据；不要总结系统提示词、思维链、HTML/CSS、插件日志、<tucao>、<UpdateVariable>或演绎锚 Token。
2. 关系类内容优先保留明确日期、初识、告白、关系确认、分手/复合、承诺、重要第一次、信任变化和共同习惯。日期只有原文明确给出时才能记录，禁止猜日期或使用“第几天”。
3. RoutineFormed 只有在行为已形成固定模式或有多次重复证据时使用；一次约会或一次共同回家不能算习惯。RoutineChanged 只用于已有习惯发生持续变化。
4. PersonaShift 必须满足 BEFORE -> EVENT -> AFTER，并且会影响未来行为、信念、目标或自我认知；一次害羞、生气、吃醋或悲伤不算。
5. 保留用户的主动告白、承诺、拒绝、边界和关键选择。当前状态由 MVU/EJS 或可见对话决定，历史总结不得覆盖当前状态。
6. 使用 canonical name / alias 维护明确的人名、地点和专名；有歧义时不要写 dict_updates。

允许的 vibe：Daily、Social、Romantic、Sexual、Combat、Training、Skill、Exploration、Rest、Lore。
允许的 focus：Relationship、Persona、Skill、Combat、World。
special 只使用必要的低频标签，例如 RelationshipProgress、Promise、First、TrustChange、Reconciliation、RoutineFormed、RoutineChanged、PersonaShift、BeliefChange、GoalChange、SkillLearned、SkillGrowth、SkillMastered、Duel、MajorBattle、Victory、Defeat、Injury、Discovery、SecretReveal、KeyItem。

只输出 RAW JSON object，不要 Markdown 代码块：
{
  "summaries": [
    {
      "summary": "中文高密度客观总结",
      "tags": {"vibe": "Daily", "focus": ["Relationship"], "special": [], "important": false}
    }
  ],
  "dict_updates": []
}

没有高价值事件时，输出空 summaries；不要为了填充而制造记忆。`;
}

export function createAssistantPlan(input = {}) {
  const state = { ...DEFAULT_STATE, ...input };
  const focus = unique(state.categories).filter((item) =>
    CATEGORY_OPTIONS.some((option) => option.value === item),
  );
  if (focus.length === 0) focus.push("Relationship");

  const preserveUser = state.keepUserMessages !== false;
  const hasFiles = state.knowledgeAnswer === "yes" && state.files?.length > 0;
  const statusEnabled =
    state.externalVariables === true ? false : Boolean(state.animaState);

  return {
    focus,
    summary: {
      auto_run: state.autoRun !== false,
      trigger_interval: Math.max(5, Number(state.triggerInterval) || 10),
      hide_skip_count: 5,
      skip_layer_zero: true,
      regex_skip_user: !preserveUser,
      exclude_user: !preserveUser,
      regex_strings: structuredClone(EXCLUSION_RULES),
      summary_messages: [
        { type: "char_info", role: "system", enabled: true },
        { type: "user_info", role: "system", enabled: true },
        { type: "prev_summaries", role: "system", count: 2 },
        {
          role: "system",
          title: "Anima 长期记忆规则",
          content: createSummaryPrompt(state, focus),
        },
        { role: "user", content: "{{context}}" },
      ],
    },
    rag: {
      rag_enabled: true,
      auto_vectorize: true,
      distributed_retrieval: true,
      base_count: 3,
      min_score: 0.2,
      echo_max_count: 10,
      rerank_count: 30,
      injection_settings: {
        strategy: "constant",
        recent_count: 2,
      },
      strategy_settings: {
        candidate_multiplier: 2,
        important: { labels: unique(["Important", ...focus]).slice(0, 4), count: 1 },
        special: { count: 1 },
        period: { count: 1 },
        status: { labels: [], count: 1, rules: [] },
        diversity: { count: 2 },
      },
    },
    bm25: {
      bm25_enabled: true,
      auto_build: true,
      search_top_k: 3,
      content_settings: {
        reuse_rag_regex: true,
        regex_list: structuredClone(EXCLUSION_RULES),
        skip_layer_zero: true,
        regex_skip_user: !preserveUser,
        exclude_user: !preserveUser,
        prompt_items: [{ type: "core", id: "floor_content", count: 2 }],
      },
    },
    knowledge: {
      enabled: hasFiles,
      purpose: state.knowledgePurpose || "原作与世界观设定",
      files: state.files || [],
      settings: {
        ...structuredClone(DEFAULT_KB_SETTINGS),
        kb_enabled: hasFiles,
        knowledge_base: {
          ...structuredClone(DEFAULT_KB_SETTINGS.knowledge_base),
          chunk_size: 500,
          write_vector: true,
          write_bm25: true,
          dictionary: "default_dict",
          search_top_k: 3,
          bm25_top_k: 3,
        },
        knowledge_injection: {
          ...structuredClone(DEFAULT_KB_SETTINGS.knowledge_injection),
          strategy: "selective",
          template: `以下是${state.knowledgePurpose || "原作与世界观设定"}的参考资料。它们用于补充设定证据，不代表当前聊天已经发生的事实：\n{{knowledge}}`,
        },
      },
    },
    status: {
      enabled: statusEnabled,
      reason:
        state.externalVariables === true
          ? "检测到/用户确认使用外部变量系统，关闭 Anima 状态变量以避免双重状态源。"
          : statusEnabled
            ? "用户选择使用 Anima 状态变量。"
            : "用户选择不启用 Anima 状态变量。",
    },
  };
}

function renderAssistantCard() {
  const container = document.getElementById("tab-api");
  if (!container || document.getElementById("anima-assistant-card")) return;
  container.insertAdjacentHTML(
    "afterbegin",
    `<div class="anima-card" id="anima-assistant-card" style="border-left:4px solid #a855f7; margin-bottom:18px;">
      <div style="display:flex; justify-content:space-between; gap:12px; align-items:center; flex-wrap:wrap;">
        <div>
          <div class="anima-card-title" style="font-size:1.2em;"><i class="fa-solid fa-wand-magic-sparkles" style="color:#c084fc;"></i> Anima 配置助手</div>
          <div class="anima-desc-inline">告诉我你想记住什么，我会按长期 RP / MVU 规则配置总结、向量、BM25、知识库和状态变量。</div>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end;">
          <button id="anima-open-assistant" class="anima-btn secondary"><i class="fa-solid fa-route"></i> 普通向导</button>
          <button id="anima-open-skill-assistant" class="anima-btn primary"><i class="fa-solid fa-wand-magic-sparkles"></i> 按 SKILL 新手版配置</button>
        </div>
      </div>
      <div style="margin-top:10px; color:#a1a1aa; font-size:12px;">普通向导适合快速套用默认值；SKILL 新手版会调用你已配置的 LLM，一次问一个问题，并在确认后自动写入全部相关属性。</div>
    </div>`,
  );
  document
    .getElementById("anima-open-assistant")
    ?.addEventListener("click", openAssistant);
  document
    .getElementById("anima-open-skill-assistant")
    ?.addEventListener("click", openSkillAssistant);
}

function ensureAssistantModal() {
  if (document.getElementById("anima-assistant-modal")) return;
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div id="anima-assistant-modal" class="anima-modal hidden" style="z-index:100001;">
      <div class="anima-modal-content" style="max-width:900px; width:94%;">
        <div class="anima-modal-header">
          <h3><i class="fa-solid fa-wand-magic-sparkles"></i> Anima 配置助手</h3>
          <span id="anima-assistant-close" style="cursor:pointer; font-size:20px;">&times;</span>
        </div>
        <div id="anima-assistant-body" class="anima-modal-body"></div>
      </div>
    </div>`,
  );
  document
    .getElementById("anima-assistant-close")
    ?.addEventListener("click", closeAssistant);
}

function radio(name, value, label, checked = false) {
  return `<label style="display:flex; gap:8px; align-items:flex-start; margin:8px 0; cursor:pointer;">
    <input type="radio" name="${name}" value="${value}" ${checked ? "checked" : ""}>
    <span>${label}</span>
  </label>`;
}

function renderStepShell(title, description, content, step) {
  const steps = ["目标", "知识库", "状态变量", "确认"];
  return `<div>
    <div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:16px;">
      ${steps
        .map(
          (item, index) =>
            `<span style="padding:4px 9px; border-radius:999px; font-size:12px; background:${index === step ? "rgba(168,85,247,.25)" : "rgba(255,255,255,.06)"}; color:${index === step ? "#e9d5ff" : "#9ca3af"};">${index + 1}. ${item}</span>`,
        )
        .join("")}
    </div>
    <h3 style="margin:0 0 6px;">${title}</h3>
    <div style="color:#a1a1aa; font-size:13px; margin-bottom:16px;">${description}</div>
    ${content}
    <div style="display:flex; justify-content:space-between; gap:10px; margin-top:20px;">
      <button id="anima-assistant-back" class="anima-btn secondary" ${step === 0 ? "disabled" : ""}>上一步</button>
      ${step < 3 ? `<button id="anima-assistant-next" class="anima-btn primary">下一步</button>` : `<button id="anima-assistant-apply" class="anima-btn primary"><i class="fa-solid fa-check"></i> 应用这套配置</button>`}
    </div>
  </div>`;
}

function renderStep() {
  const body = document.getElementById("anima-assistant-body");
  if (!body || !assistantState) return;
  const step = assistantState.step;
  let html = "";

  if (step === 0) {
    html = renderStepShell(
      "你想让 Anima 记住什么？",
      "不用理解所有技术选项。用一句话描述目标，再选择最重要的记忆类型。",
      `<label class="anima-label-text" for="anima-assistant-goal">记忆目标</label>
       <textarea id="anima-assistant-goal" class="anima-textarea" rows="4" placeholder="例如：我主要玩长期恋爱 RP，希望记住承诺、关系变化、共同生活习惯和重要第一次。">${escapeHtml(assistantState.goal)}</textarea>
       <div class="anima-label-text" style="margin:12px 0 6px;">重点类别</div>
       <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:8px;">
         ${CATEGORY_OPTIONS.map(
           (option) =>
             `<label style="display:flex; gap:8px; align-items:center; padding:9px; background:rgba(255,255,255,.04); border-radius:6px; cursor:pointer;"><input type="checkbox" class="anima-assistant-category" value="${option.value}" ${assistantState.categories.includes(option.value) ? "checked" : ""}>${option.label}</label>`,
         ).join("")}
       </div>
       <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:14px;">
         <div><label class="anima-label-text" for="anima-assistant-interval">总结频率</label><select id="anima-assistant-interval" class="anima-select"><option value="6" ${assistantState.triggerInterval === 6 ? "selected" : ""}>每 6 楼（更及时）</option><option value="10" ${assistantState.triggerInterval === 10 ? "selected" : ""}>每 10 楼（推荐）</option><option value="20" ${assistantState.triggerInterval === 20 ? "selected" : ""}>每 20 楼（更省请求）</option></select></div>
         <div><label class="anima-label-text">后台自动总结</label>${radio("anima-assistant-auto", "yes", "开启", assistantState.autoRun)}${radio("anima-assistant-auto", "no", "关闭，之后手动总结", !assistantState.autoRun)}</div>
       </div>`,
      step,
    );
  } else if (step === 1) {
    html = renderStepShell(
      "要不要导入原作或设定资料？",
      "知识库只保存外部设定证据，不把原作内容当成当前聊天已经发生的剧情。每个文件会构建成一个独立知识库。",
      `<div>${radio("anima-assistant-kb", "yes", "有，我要导入 TXT / MD / JSON", assistantState.knowledgeAnswer === "yes")}${radio("anima-assistant-kb", "no", "没有，关闭知识库功能", assistantState.knowledgeAnswer === "no")}</div>
       <div id="anima-assistant-kb-options" style="display:${assistantState.knowledgeAnswer === "yes" ? "block" : "none"}; margin-top:14px; padding:12px; background:rgba(168,85,247,.08); border:1px solid rgba(168,85,247,.25); border-radius:8px;">
         <label class="anima-label-text" for="anima-assistant-kb-purpose">资料类型</label>
         <select id="anima-assistant-kb-purpose" class="anima-select"><option ${assistantState.knowledgePurpose === "原作与世界观设定" ? "selected" : ""}>原作与世界观设定</option><option ${assistantState.knowledgePurpose === "角色与人物设定" ? "selected" : ""}>角色与人物设定</option><option ${assistantState.knowledgePurpose === "术语与资料" ? "selected" : ""}>术语与资料</option></select>
         <label class="anima-label-text" for="anima-assistant-files" style="display:block; margin-top:12px;">选择文件</label>
         <input id="anima-assistant-files" type="file" accept=".txt,.md,.json" multiple class="anima-input">
         <div id="anima-assistant-file-list" style="margin-top:8px; color:#c4b5fd; font-size:12px;">${assistantState.files.length ? assistantState.files.map((file) => escapeHtml(file.name)).join("、") : "尚未选择文件"}</div>
       </div>`,
      step,
    );
  } else if (step === 2) {
    const detected = typeof window.Mvu !== "undefined";
    html = renderStepShell(
      "这张卡有自己的变量系统吗？",
      `${detected ? "检测到当前环境存在 MVU 接口，但仍以你的回答为准。" : "没有自动检测到 MVU 接口，但 EJS/其他变量脚本仍可能存在。"} 如果有 MVU/EJS/其他状态栏系统，建议关闭 Anima 状态变量，避免两个系统互相覆盖。`,
      `<div>${radio("anima-assistant-external", "yes", "有（MVU / EJS / 其他变量或状态栏）", assistantState.externalVariables === true)}${radio("anima-assistant-external", "no", "没有", assistantState.externalVariables === false)}</div>
       <div id="anima-assistant-anima-state" style="display:${assistantState.externalVariables === false ? "block" : "none"}; margin-top:14px; padding:12px; background:rgba(255,255,255,.04); border-radius:8px;">
         <div class="anima-label-text">那要不要启用 Anima 自己的状态变量？</div>
         ${radio("anima-assistant-state", "yes", "启用，用于短期状态追踪", assistantState.animaState)}
         ${radio("anima-assistant-state", "no", "不启用，只使用历史总结和检索", !assistantState.animaState)}
       </div>
       <div style="margin-top:14px;">${radio("anima-assistant-user-memory", "yes", "保留我的 User 消息（推荐长期恋爱 RP，能记住我的承诺、边界和主动选择）", assistantState.keepUserMessages)}${radio("anima-assistant-user-memory", "no", "跳过 User 消息（更干净，但会丢失我的主动行为）", !assistantState.keepUserMessages)}</div>`,
      step,
    );
  } else {
    const plan = createAssistantPlan(assistantState);
    const categoryLabels = plan.focus
      .map((value) => CATEGORY_OPTIONS.find((item) => item.value === value)?.label || value)
      .join("、");
    html = renderStepShell(
      "确认配置方案",
      "确认后才会写入当前 Anima 配置。API Key 不会被助手读取或上传；知识库文件只会按你已经连接的 Anima 后端进行构建。",
      `<div style="display:grid; gap:10px;">
        <div class="anima-card" style="margin:0; padding:12px;"><b>总结：</b>后台${plan.summary.auto_run ? "自动" : "不自动"}运行，每 ${plan.summary.trigger_interval} 楼；前文总结 ${plan.summary.summary_messages.find((item) => item.type === "prev_summaries")?.count || 0} 条；重点为 ${categoryLabels}。</div>
        <div class="anima-card" style="margin:0; padding:12px;"><b>检索：</b>开启向量检索、分布式检索和 BM25；保留 User 消息：${assistantState.keepUserMessages ? "是" : "否"}。</div>
        <div class="anima-card" style="margin:0; padding:12px;"><b>知识库：</b>${plan.knowledge.enabled ? `导入 ${plan.knowledge.files.length} 个文件，类型为“${escapeHtml(plan.knowledge.purpose)}”。` : "关闭，不导入文件。"}</div>
        <div class="anima-card" style="margin:0; padding:12px;"><b>状态变量：</b>${plan.status.enabled ? "启用 Anima 状态变量。" : `关闭。${plan.status.reason}`}</div>
      </div>
      <div style="margin-top:12px; color:#fbbf24; font-size:12px;">作用范围：总结/API/BM25为全局或当前聊天设置；检索策略、知识库绑定和部分状态提示词可能写入当前角色卡。助手只修改上述相关字段，不删除已有数据库。</div>`,
      step,
    );
  }

  body.innerHTML = html;
  bindStepEvents();
}

function collectStep() {
  const step = assistantState.step;
  if (step === 0) {
    assistantState.goal = document.getElementById("anima-assistant-goal")?.value.trim() || "";
    assistantState.categories = [...document.querySelectorAll(".anima-assistant-category:checked")].map((input) => input.value);
    assistantState.triggerInterval = Number(document.getElementById("anima-assistant-interval")?.value || 10);
    assistantState.autoRun = document.querySelector('input[name="anima-assistant-auto"]:checked')?.value !== "no";
    if (!assistantState.goal && assistantState.categories.length === 0) {
      notify("请至少写一句记忆目标，或选择一个重点类别。", "warning");
      return false;
    }
  }
  if (step === 1) {
    assistantState.knowledgeAnswer = document.querySelector('input[name="anima-assistant-kb"]:checked')?.value || "no";
    assistantState.knowledgePurpose = document.getElementById("anima-assistant-kb-purpose")?.value || "原作与世界观设定";
    const files = document.getElementById("anima-assistant-files")?.files;
    if (files && files.length > 0) assistantState.files = Array.from(files);
    if (assistantState.knowledgeAnswer === "yes" && assistantState.files.length === 0) {
      notify("你选择了导入知识库，请先选择至少一个 TXT、MD 或 JSON 文件。", "warning");
      return false;
    }
  }
  if (step === 2) {
    const external = document.querySelector('input[name="anima-assistant-external"]:checked')?.value;
    if (!external) {
      notify("请先回答这张卡是否使用变量系统。", "warning");
      return false;
    }
    assistantState.externalVariables = external === "yes";
    if (assistantState.externalVariables) {
      assistantState.animaState = false;
    } else {
      assistantState.animaState = document.querySelector('input[name="anima-assistant-state"]:checked')?.value === "yes";
    }
    assistantState.keepUserMessages = document.querySelector('input[name="anima-assistant-user-memory"]:checked')?.value !== "no";
  }
  return true;
}

function bindStepEvents() {
  document.getElementById("anima-assistant-back")?.addEventListener("click", () => {
    if (assistantState.step > 0) {
      assistantState.step -= 1;
      renderStep();
    }
  });
  document.getElementById("anima-assistant-next")?.addEventListener("click", () => {
    if (!collectStep()) return;
    assistantState.step += 1;
    renderStep();
  });
  document.getElementById("anima-assistant-apply")?.addEventListener("click", async () => {
    const button = document.getElementById("anima-assistant-apply");
    button.disabled = true;
    button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 应用中...';
    try {
      const result = await applyAssistantPlan(assistantState);
      closeAssistant();
      notify(
        result.uploaded.length
          ? `配置完成，并已构建 ${result.uploaded.length} 个知识库。`
          : "配置完成。",
        "success",
      );
    } catch (error) {
      button.disabled = false;
      button.innerHTML = '<i class="fa-solid fa-check"></i> 应用这套配置';
      console.error("[Anima Assistant] apply failed:", error);
      notify(error?.message || "配置应用失败，请检查 API 设置和当前角色卡。", "error");
    }
  });

  document.querySelectorAll('input[name="anima-assistant-kb"]').forEach((input) => {
    input.addEventListener("change", () => {
      const visible = input.value === "yes" && input.checked;
      const options = document.getElementById("anima-assistant-kb-options");
      if (options) options.style.display = visible ? "block" : "none";
    });
  });
  document.querySelectorAll('input[name="anima-assistant-external"]').forEach((input) => {
    input.addEventListener("change", () => {
      const options = document.getElementById("anima-assistant-anima-state");
      if (options) options.style.display = input.value === "no" && input.checked ? "block" : "none";
    });
  });
  document.getElementById("anima-assistant-files")?.addEventListener("change", (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length > 0) assistantState.files = files;
    const list = document.getElementById("anima-assistant-file-list");
    if (list) list.textContent = assistantState.files.length ? assistantState.files.map((file) => file.name).join("、") : "尚未选择文件";
  });
}

function renderSkillMessage(text) {
  return escapeHtml(String(text || "")).replace(/\n/g, "<br>");
}

function flattenPlanDiff(value, prefix = "", output = []) {
  if (!isObject(value)) {
    output.push([prefix, value]);
    return output;
  }
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isObject(child)) flattenPlanDiff(child, path, output);
    else output.push([path, child]);
  }
  return output;
}

function getSafePath(value, path) {
  return String(path || "").split(".").reduce((current, key) => current?.[key], value);
}

function renderSkillDiff(configPlan) {
  const rows = [];
  for (const scope of ["global", "character", "chat"]) {
    const patch = configPlan?.patches?.[scope] || {};
    const source = skillAssistantState?.discovery?.scoped_config?.[scope] || {};
    for (const [path, nextValue] of flattenPlanDiff(patch)) {
      const oldValue = getSafePath(source, path);
      if (JSON.stringify(oldValue) === JSON.stringify(nextValue)) continue;
      rows.push(`${scope}.${path}\n  ${JSON.stringify(oldValue)} → ${JSON.stringify(nextValue)}`);
    }
  }
  for (const action of configPlan?.knowledge_files || []) rows.push(`knowledge_file: ${action.action} ${action.source?.name || action.source?.file_name || ""}`);
  for (const action of configPlan?.database_actions || []) if (action.type !== "none") rows.push(`database: ${action.type} → ${action.target || ""}`);
  return rows.length ? rows.join("\n") : "没有检测到需要写入的字段。";
}

function renderSkillAssistant() {
  const modal = document.getElementById("anima-assistant-modal");
  const body = document.getElementById("anima-assistant-body");
  if (!modal || !body || !skillAssistantState) return;

  const header = modal.querySelector(".anima-modal-header h3");
  if (header) header.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 按 SKILL 新手版配置';

  const messages = skillAssistantState.uiMessages
    .map(
      (item) => `<div style="display:flex; justify-content:${item.role === "user" ? "flex-end" : "flex-start"}; margin:8px 0;">
        <div style="max-width:86%; padding:10px 12px; border-radius:10px; background:${item.role === "user" ? "rgba(59,130,246,.18)" : "rgba(168,85,247,.12)"}; border:1px solid ${item.role === "user" ? "rgba(96,165,250,.25)" : "rgba(192,132,252,.22)"}; line-height:1.55;">${renderSkillMessage(item.display)}</div>
      </div>`,
    )
    .join("");

  const fileNames = skillAssistantState.files.length
    ? skillAssistantState.files.map((file) => escapeHtml(file.name)).join("、")
    : "未选择文件";
  const plan = skillAssistantState.plan;
  const configPlan = plan?.configPlan || null;
  const error = skillAssistantState.error
    ? `<div style="margin-top:10px; color:#fca5a5;">${renderSkillMessage(skillAssistantState.error)}</div>`
    : "";

  body.innerHTML = `<div>
    <div style="padding:10px 12px; border:1px solid rgba(192,132,252,.25); border-radius:8px; background:rgba(168,85,247,.08); font-size:12px; color:#ddd6fe;">
      这是内置的“${ANIMA_SKILL_NAME}”。AI 会读取当前配置并逐步询问你；它负责实际写入设置，不会把 API Key、Token 或 Cookie 发给模型。
    </div>
    <div id="anima-skill-chat" style="margin-top:12px; max-height:390px; overflow:auto; padding:4px 6px;">${messages || '<div style="color:#a1a1aa; padding:16px 0;">正在读取当前配置并准备第一个问题…</div>'}${skillAssistantState.busy ? '<div style="color:#c4b5fd; padding:8px 0;"><i class="fa-solid fa-spinner fa-spin"></i> 配置助手正在分析…</div>' : ""}</div>
    <div style="margin-top:10px; padding:10px; border-radius:8px; background:rgba(255,255,255,.04);">
      <label class="anima-label-text" for="anima-skill-files">原作/世界观文件（可选，TXT / MD / JSON）</label>
      <input id="anima-skill-files" type="file" accept=".txt,.md,.json" multiple class="anima-input">
      <div style="margin-top:6px; color:#c4b5fd; font-size:12px;">${fileNames}</div>
    </div>
    ${plan ? `<div class="anima-card" style="margin-top:12px; padding:12px; border-left:3px solid #22c55e;">
      <div style="color:#bbf7d0;"><i class="fa-solid fa-clipboard-check"></i> ${renderSkillMessage(plan.assistant_message)}</div>
      <div style="margin-top:6px; color:#d4d4d8; font-size:12px;">作用范围：${escapeHtml(plan.scope_summary)}</div>
      <details open style="margin-top:8px;"><summary style="cursor:pointer; color:#c4b5fd;">查看修改差异</summary><pre style="max-height:220px; overflow:auto; white-space:pre-wrap; font-size:11px; color:#d4d4d8;">${escapeHtml(renderSkillDiff(configPlan))}</pre></details>
      <details style="margin-top:8px;"><summary style="cursor:pointer; color:#c4b5fd;">查看将要写入的完整字段</summary><pre style="max-height:260px; overflow:auto; white-space:pre-wrap; font-size:11px; color:#d4d4d8;">${escapeHtml(JSON.stringify(configPlan, null, 2))}</pre></details>
      ${configPlan?.status === "ready" ? '<button id="anima-skill-apply" class="anima-btn primary" style="margin-top:10px;"><i class="fa-solid fa-check"></i> 确认并应用全部配置</button>' : '<div style="margin-top:10px; color:#fbbf24;">当前方案状态为 blocked/needs_input，不能应用；请先按提示补充条件。</div>'}
    </div>` : `<div style="display:flex; gap:8px; margin-top:10px;">
      <textarea id="anima-skill-input" class="anima-textarea" rows="2" placeholder="直接回答上面的问题，例如：这是 MVU 卡，主要想记住承诺和共同习惯。" ${skillAssistantState.busy ? "disabled" : ""}></textarea>
      <button id="anima-skill-send" class="anima-btn primary" style="align-self:flex-end;" ${skillAssistantState.busy ? "disabled" : ""}><i class="fa-solid fa-paper-plane"></i> 发送</button>
    </div>`}
    ${error}
    <div style="margin-top:10px; color:#a1a1aa; font-size:11px;">AI 只能决定非敏感配置字段。API 地址、模型名和端口以你在 API 设置中的输入为准；API Key 可以留空，是否需要鉴权由你使用的服务决定。助手不会替你猜测、回显或索要密钥。</div>
  </div>`;

  const chat = document.getElementById("anima-skill-chat");
  if (chat) chat.scrollTop = chat.scrollHeight;

  document.getElementById("anima-skill-files")?.addEventListener("change", (event) => {
    skillAssistantState.files = Array.from(event.target.files || []);
    renderSkillAssistant();
  });
  const send = () => {
    const input = document.getElementById("anima-skill-input");
    const text = input?.value.trim();
    if (!text || skillAssistantState.busy) return;
    void runSkillAssistantTurn(text);
  };
  document.getElementById("anima-skill-send")?.addEventListener("click", send);
  document.getElementById("anima-skill-input")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });
  document.getElementById("anima-skill-apply")?.addEventListener("click", async () => {
    const button = document.getElementById("anima-skill-apply");
    if (!button || !skillAssistantState.plan) return;
    button.disabled = true;
    button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 应用中...';
    try {
      const result = await applySkillAgentConfigPlan(
        skillAssistantState.plan.configPlan,
        skillAssistantState.discovery,
        skillAssistantState.files,
      );
      closeAssistant();
      notify(
        result.uploaded.length
          ? `SKILL 配置完成，并已构建 ${result.uploaded.length} 个知识库。`
          : "SKILL 配置完成，全部相关设置已写入。",
        "success",
      );
    } catch (error) {
      button.disabled = false;
      button.innerHTML = '<i class="fa-solid fa-check"></i> 确认并应用全部配置';
      skillAssistantState.error = error?.message || "配置应用失败";
      renderSkillAssistant();
    }
  });
}

async function runSkillAssistantTurn(userText) {
  if (!skillAssistantState || skillAssistantState.busy) return;
  const safeText = redactUserInput(userText);
  const files = skillAssistantState.files.map((file) => file.name);
  const prompt = files.length
    ? `${safeText}\n\n本次界面已选择文件：${files.join("、")}。只把它们视为待导入外部资料，不要把其内容当成已发生剧情。`
    : safeText;

  skillAssistantState.error = "";
  skillAssistantState.busy = true;
  skillAssistantState.messages.push({ role: "user", content: prompt });
  skillAssistantState.uiMessages.push({ role: "user", display: userText });
  renderSkillAssistant();

  try {
    const raw = await generateText(skillAssistantState.messages, "llm");
    const result = parseSkillAgentResponse(raw);
    skillAssistantState.messages.push({ role: "assistant", content: raw });
    skillAssistantState.uiMessages.push({
      role: "assistant",
      display: result.type === "QUESTION"
        ? `${result.question}${result.why ? `\n\n为什么问：${result.why}` : ""}`
        : result.message || result.assistant_message,
    });
    if (result.type === "CONFIG_PLAN") skillAssistantState.plan = result;
  } catch (error) {
    skillAssistantState.error = error?.message || "配置助手请求失败";
  } finally {
    skillAssistantState.busy = false;
    renderSkillAssistant();
  }
}

async function openSkillAssistant() {
  ensureAssistantModal();
  skillAssistantState = {
    messages: [],
    uiMessages: [],
    files: [],
    busy: false,
    plan: null,
    error: "",
  };
  document.getElementById("anima-assistant-modal")?.classList.remove("hidden");
  renderSkillAssistant();
  try {
    const snapshot = await discoverAssistantContext();
    skillAssistantState.discovery = snapshot;
    skillAssistantState.messages.push({ role: "system", content: buildSkillAgentSystemPrompt(snapshot) });
    skillAssistantState.messages.push({
      role: "system",
      content: "额外执行规则：不要让用户在对话中填写或猜测 API 地址、端口、模型名或任何技术数字。API 字段以用户已经在设置面板填写的内容为准；如果缺少，只提示用户自行打开 API 设置。API Key 可以为空，不要索要、回显或生成密钥。",
    });
    await runSkillAssistantTurn("我是新手，请按 SKILL 新手版开始配置。请一次只问我一个最基础的问题。" );
  } catch (error) {
    skillAssistantState.error = error?.message || "读取当前配置失败，无法启动 SKILL 配置助手。";
    renderSkillAssistant();
  }
}

function openAssistant() {
  skillAssistantState = null;
  assistantState = structuredClone(DEFAULT_STATE);
  ensureAssistantModal();
  renderStep();
  document.getElementById("anima-assistant-modal")?.classList.remove("hidden");
}

function closeAssistant() {
  document.getElementById("anima-assistant-modal")?.classList.add("hidden");
  assistantState = null;
  skillAssistantState = null;
}

function getBm25Settings(context) {
  const root = context.extensionSettings[MODULE_NAME] || (context.extensionSettings[MODULE_NAME] = {});
  return root.bm25 || (root.bm25 = {});
}

const CHARACTER_RAG_SETTING_KEYS = new Set([
  "distributed_retrieval",
  "virtual_time_mode",
  "strategy_settings",
  "holidays",
  "period_config",
]);

const SUMMARY_LOCAL_KEYS = new Set(["auto_run", "exclude_user"]);
const STATUS_CHARACTER_FIELDS = {
  zod_settings: "anima_zod_config",
  prompt_rules: "anima_prompt_config",
  gc_settings: "anima_gc_settings",
  beautify_settings: "anima_beautify_template",
  greeting_presets: "anima_greeting_presets",
  gc_prompts: "anima_gc_prompts",
};

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function objectKeys(value) {
  return isObject(value) ? Object.keys(value) : [];
}

function clone(value) {
  return structuredClone(value);
}

function getPlanScope(plan, scope) {
  return isObject(plan?.patches?.[scope]) ? plan.patches[scope] : {};
}

function compileSummaryPatch(patch = {}) {
  const result = clone(patch);
  const promptSpec = result.prompt_spec;
  delete result.prompt_spec;
  if (promptSpec && isObject(promptSpec)) {
    const item = (value, type, fallbackRole = "system") => ({
      ...(isObject(value) ? clone(value) : {}),
      type,
      role: value?.role || fallbackRole,
    });
    const messages = [
      item(promptSpec.char_info, "char_info"),
      item(promptSpec.user_info, "user_info"),
      item(promptSpec.prev_summaries, "prev_summaries"),
      item(promptSpec.summary_prompt, "summary_prompt"),
      { role: "user", content: "{{context}}" },
    ];
    const contract = promptSpec.output_contract;
    if (contract) {
      messages[3].content = `${messages[3].content || ""}\n\n输出必须是 RAW JSON object，根键只能是 summaries 和 dict_updates；不要 Markdown 代码块。`;
    }
    result.summary_messages = messages;
  }
  return result;
}

function normalizeRagPatch(patch = {}) {
  const result = clone(patch);
  const strategy = isObject(result.strategy_settings) ? result.strategy_settings : {};
  for (const key of ["important", "special", "period", "status", "diversity"]) {
    if (result[key] !== undefined) {
      strategy[key] = deepMergeSettings(strategy[key], result[key]);
      delete result[key];
    }
  }
  if (result.candidate_multiplier !== undefined) {
    strategy.candidate_multiplier = result.candidate_multiplier;
    delete result.candidate_multiplier;
  }
  const injection = isObject(result.injection_settings) ? result.injection_settings : {};
  for (const key of ["strategy", "position", "role", "depth", "order", "recent_count", "template"]) {
    if (result[key] !== undefined) {
      injection[key] = result[key];
      delete result[key];
    }
  }
  if (Object.keys(injection).length > 0) result.injection_settings = injection;
  if (Object.keys(strategy).length > 0) result.strategy_settings = strategy;
  return result;
}

function normalizeKnowledgePatch(patch = {}) {
  const result = clone(patch);
  const base = isObject(result.knowledge_base) ? result.knowledge_base : {};
  for (const key of ["delimiter", "chunk_size", "write_vector", "write_bm25", "dictionary", "scan_floors", "search_top_k", "min_score", "bm25_top_k"]) {
    if (result[key] !== undefined) {
      base[key] = result[key];
      delete result[key];
    }
  }
  const injection = isObject(result.knowledge_injection) ? result.knowledge_injection : {};
  for (const key of ["strategy", "position", "role", "depth", "order", "template"]) {
    if (result[key] !== undefined) {
      injection[key] = result[key];
      delete result[key];
    }
  }
  if (Object.keys(base).length > 0) result.knowledge_base = base;
  if (Object.keys(injection).length > 0) result.knowledge_injection = injection;
  return result;
}

function normalizeBm25Patch(patch = {}) {
  const result = clone(patch);
  const content = isObject(result.content_settings) ? result.content_settings : {};
  for (const key of ["reuse_rag_regex", "regex_list", "skip_layer_zero", "regex_skip_user", "exclude_user", "prompt_items"]) {
    if (result[key] !== undefined) {
      content[key] = result[key];
      delete result[key];
    }
  }
  if (Object.keys(content).length > 0) result.content_settings = content;
  return result;
}

function hasMeaningfulPatch(value) {
  return isObject(value) && Object.keys(value).length > 0;
}

function hasMeaningfulScopePatch(scope) {
  return isObject(scope) && ["api", "summary", "rag", "bm25", "knowledge", "status"].some((module) => hasMeaningfulPatch(scope[module]));
}

function getEffectivePlanRag(plan) {
  for (const scope of ["chat", "character", "global"]) {
    const rag = getPlanScope(plan, scope).rag;
    if (hasMeaningfulPatch(rag)) return normalizeRagPatch(rag);
  }
  return {};
}

function getPlanModulePatches(plan, module) {
  return ["global", "character", "chat"]
    .map((scope) => getPlanScope(plan, scope)[module])
    .filter((patch) => hasMeaningfulPatch(patch));
}

function validateDictionaryPatch(patch, errors) {
  const dictionaries = patch?.custom_dicts;
  if (!isObject(dictionaries)) return;
  const knownNames = new Set(Object.keys(dictionaries));
  for (const [dictName, dictionary] of Object.entries(dictionaries)) {
    if (!isObject(dictionary) || !Array.isArray(dictionary.words)) {
      errors.push(`BM25 词典格式错误：${dictName}`);
      continue;
    }
    const canonicalNames = new Set();
    const aliases = new Map();
    for (const word of dictionary.words) {
      if (!isObject(word) || !String(word.index || "").trim()) {
        errors.push(`BM25 词条缺少 canonical index：${dictName}`);
        continue;
      }
      const canonical = String(word.index).trim();
      if (canonicalNames.has(canonical)) errors.push(`BM25 canonical 重复：${canonical}`);
      canonicalNames.add(canonical);
      for (const alias of String(word.trigger || "").split(",").map((item) => item.trim()).filter(Boolean)) {
        const previous = aliases.get(alias);
        if (previous && previous !== canonical) errors.push(`BM25 alias 冲突：${alias}`);
        aliases.set(alias, canonical);
      }
    }
  }
  void knownNames;
}

export function calculateSkillRetrievalBudget(plan) {
  const rag = getEffectivePlanRag(plan);
  const strategy = rag.strategy_settings || {};
  const important = strategy.important || {};
  const status = strategy.status || {};
  const period = strategy.period || {};
  const special = strategy.special || {};
  const diversity = strategy.diversity || {};
  const importantLabels = Array.isArray(important.labels) ? important.labels : [];
  const importantCount = Number(important.count || 0);
  const baseSlots = Number(rag.base_count || 0);
  const importantSlots = importantLabels.length * importantCount;
  const statusSlots = (Array.isArray(status.labels) ? status.labels.length : 0) * Number(status.count || 0);
  const periodSlots = (Array.isArray(period.labels) ? period.labels.length : 0) * Number(period.count || 0);
  const holidaySlots = Number(special.count || 0);
  const diversitySlots = Number(diversity.count || 0);
  const preRerank = baseSlots + importantSlots + statusSlots + periodSlots + holidaySlots + diversitySlots;
  const multiplier = Number(strategy.candidate_multiplier ?? rag.candidate_multiplier ?? 2);
  return {
    baseSlots,
    importantLabelCount: importantLabels.length,
    importantCountPerLabel: importantCount,
    importantWorstCaseSlots: importantSlots,
    statusWorstCaseSlots: statusSlots,
    periodWorstCaseSlots: periodSlots,
    holidayWorstCaseSlots: holidaySlots,
    diversitySlots,
    recentHistorySlots: Number(rag.injection_settings?.recent_count || 0),
    echoMaxCount: Number(rag.echo_max_count || 0),
    candidateMultiplier: multiplier,
    estimatedPreRerankSlots: preRerank,
    estimatedCandidateSlots: Math.ceil(preRerank * multiplier),
  };
}

export function validateSkillConfigPlan(plan, discovery = {}, files = []) {
  const errors = [];
  const warnings = [];
  if (!isObject(plan)) errors.push("CONFIG_PLAN 不是 object");
  const required = ["schema_version", "plan_id", "mode", "status", "intent", "discovery_ref", "scope_policy", "patches", "knowledge_files", "database_actions", "retrieval_budget", "summary_tag_contract", "tag_retrieval_map", "preconditions", "validation", "explanations", "risk_flags", "requires_confirmation"];
  for (const key of required) if (!Object.hasOwn(plan || {}, key)) errors.push(`缺少字段：${key}`);
  if (plan?.schema_version !== "anima-config-plan/1.0") errors.push("schema_version 不匹配");
  if (!['skill_newbie', 'skill_advanced'].includes(plan?.mode)) errors.push("mode 不合法");
  if (plan?.status !== "ready") errors.push(`方案状态为 ${plan?.status || "unknown"}，不能应用`);
  if (plan?.requires_confirmation !== true) errors.push("方案没有要求用户确认");
  if (plan?.discovery_ref && discovery?.discovery_id && plan.discovery_ref !== discovery.discovery_id) errors.push("DISCOVERY_CONTEXT 已过期");
  for (const precondition of plan?.preconditions || []) {
    if (precondition?.required && precondition.satisfied !== true) errors.push(`前置条件未满足：${precondition.message || precondition.id || "unknown"}`);
  }
  for (const [name, value] of Object.entries(plan?.validation || {})) {
    if (value === false) errors.push(`计划自带校验未通过：${name}`);
  }

  const secretPaths = findAssistantSecretPaths(plan);
  if (secretPaths.length > 0) errors.push(`方案包含敏感字段：${secretPaths.join(", ")}`);

  const patches = plan?.patches || {};
  if (hasMeaningfulScopePatch(patches.character) && !discovery?.scope?.current_character_present) errors.push("没有当前角色卡，不能应用角色作用域");
  if (hasMeaningfulScopePatch(patches.chat) && !discovery?.scope?.current_chat_present) errors.push("没有当前聊天，不能应用聊天作用域");
  if (hasMeaningfulScopePatch(patches.chat) && discovery?.capabilities?.supports_chat_rag_override_write !== true) errors.push("当前版本没有聊天作用域写入器");
  if (hasMeaningfulPatch(patches.character?.api) || hasMeaningfulPatch(patches.character?.summary)) errors.push("API 和 Summary 当前版本不支持角色作用域写入");
  if (hasMeaningfulPatch(patches.chat?.api) || hasMeaningfulPatch(patches.chat?.bm25) || hasMeaningfulPatch(patches.chat?.knowledge) || hasMeaningfulPatch(patches.chat?.status)) errors.push("该模块没有聊天作用域写入器，不能降级写到全局");

  const summaryContract = plan?.summary_tag_contract || {};
  const rag = getEffectivePlanRag(plan);
  const importantLabels = rag.strategy_settings?.important?.labels || [];
  const allowedSummaryLabels = new Set([...(summaryContract.focus || []), ...(summaryContract.special || []), "Important"]);
  for (const label of importantLabels) if (!allowedSummaryLabels.has(label)) errors.push(`分布式 Important 标签未出现在 Summary 合同：${label}`);
  const runtimeSpecialLabels = rag.strategy_settings?.special?.labels || [];
  if (runtimeSpecialLabels.some((label) => (summaryContract.special || []).includes(label))) errors.push("Summary special 标签错误放入 runtime special.labels");

  const budget = plan?.retrieval_budget || {};
  const calculated = calculateSkillRetrievalBudget(plan);
  if (budget.safe === false) errors.push(`检索预算不安全：${(budget.violations || []).join("、")}`);
  if (importantLabels.length > 6) errors.push("important.labels 超过新手模式上限 6");
  if (Number(rag.strategy_settings?.important?.count || 0) > 1 && importantLabels.length > 3) errors.push("important.count 与标签数量组合会造成召回爆炸");
  if (Number(calculated.candidateMultiplier) > 3) errors.push("candidate_multiplier 超过新手模式上限 3");
  if (calculated.recentHistorySlots > 3) errors.push("recent_history 超过新手模式上限 3");
  if (calculated.echoMaxCount > 15) errors.push("echo_max_count 超过新手模式上限 15");
  if (budget.important_worst_case_slots !== undefined && Number(budget.important_worst_case_slots) !== calculated.importantWorstCaseSlots) warnings.push("retrieval_budget 与按当前 patch 重算的 worst-case 不一致");

  const stateDetection = discovery?.character?.state_system_detection || {};
  const externalState = stateDetection.mvu?.detected || stateDetection.ejs?.detected;
  const statusEnabled = ["global", "character", "chat"].some((scope) => patches?.[scope]?.status?.status_enabled === true);
  const stateAuthority = plan?.intent?.state_authority;
  if (externalState && statusEnabled && stateAuthority !== "dual_explicit_sync") errors.push("检测到 MVU/EJS，但没有完整双状态同步契约");
  if (externalState && statusEnabled && String(plan?.intent?.notes || "").length < 20) errors.push("双状态同步规则说明不足");

  for (const summaryPatch of getPlanModulePatches(plan, "summary")) {
    if (plan.intent?.keep_user_messages === "yes" && summaryPatch.exclude_user === true) errors.push("用户选择保留 User 消息，但 Summary patch 将其排除");
    if (plan.intent?.keep_user_messages === "no" && summaryPatch.exclude_user === false) errors.push("用户选择 Clean Mode，但 Summary patch 保留了 User 消息");
  }
  for (const bm25Patch of getPlanModulePatches(plan, "bm25")) validateDictionaryPatch(normalizeBm25Patch(bm25Patch), errors);
  for (const knowledgePatch of getPlanModulePatches(plan, "knowledge")) {
    const normalized = normalizeKnowledgePatch(knowledgePatch);
    const enabled = normalized.kb_enabled === true;
    const template = normalized.knowledge_injection?.template;
    if (enabled && template && !/(外部|原作|设定|已发生|当前聊天|当前状态)/.test(template)) errors.push("知识库注入模板没有说明“外部设定不等于当前已发生剧情”");
  }
  for (const ragPatch of getPlanModulePatches(plan, "rag")) {
    const template = normalizeRagPatch(ragPatch).injection_settings?.template;
    if (template && !/(past|historical|过去|历史|当前状态|MVU|EJS)/i.test(template)) warnings.push("历史注入模板未明确区分过去记忆与当前状态");
  }

  const api = discovery?.api_readiness || {};
  const embeddingNeeded = rag.rag_enabled === true || rag.auto_vectorize === true || ["global", "character", "chat"].some((scope) => patches?.[scope]?.knowledge?.knowledge_base?.write_vector === true || patches?.[scope]?.knowledge?.write_vector === true);
  // API keys are optional: keyless/self-hosted endpoints are valid. The
  // endpoint and model still must be configured before an action can run.
  if (embeddingNeeded && !api.embedding?.configured) errors.push("向量/知识库需要 Embedding 地址和模型，但当前未就绪");
  if (rag.rerank_enabled === true && !api.rerank?.configured) errors.push("Rerank 已开启但 Rerank 地址和模型未就绪");
  if (statusEnabled && !api.status?.configured) errors.push("Status 已开启但 Status 地址和模型未就绪");
  if (!discovery?.backend?.reachable && (plan?.knowledge_files?.some((item) => item.action === "import_and_bind") || (plan?.database_actions || []).some((item) => item.type !== "none" && item.type !== "rebind_only"))) errors.push("后端不可用，不能执行后端依赖动作");

  for (const action of plan?.database_actions || []) {
    if (!['none', 'rebind_only', 'mark_bm25_dirty'].includes(action.type)) errors.push(`数据库动作暂未由前端执行器支持：${action.type}`);
    if (action.destructive === true) errors.push(`禁止自动执行破坏性数据库动作：${action.type}`);
  }
  const selectedNames = new Set(files.map((file) => file.name));
  for (const action of plan?.knowledge_files || []) {
    if (["import_and_bind", "bind_existing", "unbind_existing"].includes(action.action) && action.bind_to_current_character !== false && !discovery?.scope?.current_character_present) {
      errors.push("知识库绑定动作要求当前角色卡，但当前没有角色卡");
    }
    if (action.action === "import_and_bind") {
      const name = action.source?.name || action.source?.file_name || action.source?.local_id;
      if (name && !selectedNames.has(name)) errors.push(`知识库文件未在本地选择：${name}`);
    }
  }
  return { ok: errors.length === 0, errors, warnings, budget: calculated };
}

function getCharacterExtensions(context) {
  const character = context?.characters?.[context?.characterId];
  return character?.data?.extensions || {};
}

function getKnowledgePatchFromPlan(plan) {
  for (const scope of ["character", "global", "chat"]) {
    const patch = getPlanScope(plan, scope).knowledge;
    if (hasMeaningfulPatch(patch)) return normalizeKnowledgePatch(patch);
  }
  return {};
}

function getLibraryName(file, action = {}) {
  return action.target_library_name || `kb_${safeFileName(file?.name || action.source?.name || "knowledge")}`;
}

async function stageSkillKnowledgeImports(plan, files, context) {
  const actions = Array.isArray(plan.knowledge_files) ? plan.knowledge_files : [];
  const imports = actions.filter((action) => action.action === "import_and_bind");
  if (imports.length === 0) return { bindings: [], uploaded: [] };

  const knowledgePatch = getKnowledgePatchFromPlan(plan);
  const currentKb = getGlobalKbSettingsFull();
  const kb = deepMergeSettings(currentKb, knowledgePatch);
  const kbConfig = kb.knowledge_base || {};
  const apiConfig = getAnimaConfig().api?.rag || {};
  if (kbConfig.write_vector !== false && (!apiConfig.url || !apiConfig.model)) {
    throw new Error("知识库导入需要本机先配置 Embedding API；配置助手不会接收或猜测 API Key。");
  }
  const bm25 = getBm25Settings(context);
  const dictName = kbConfig.dictionary || "default_dict";
  const dictContent = bm25.custom_dicts?.[dictName]?.words || bm25.custom_dicts?.default_dict?.words || [];
  const bindings = [];
  const uploaded = [];
  for (const action of imports) {
    const name = action.source?.name || action.source?.file_name || action.source?.local_id;
    const file = files.find((candidate) => candidate.name === name) || (files.length === 1 ? files[0] : null);
    if (!file) throw new Error(`找不到待导入的本地文件：${name || "未命名文件"}`);
    await uploadKnowledgeBase(file, {
      delimiter: kbConfig.delimiter || "",
      chunk_size: Number(kbConfig.chunk_size) || 500,
      write_vector: action.write_vector ?? kbConfig.write_vector !== false,
      write_bm25: action.write_bm25 ?? kbConfig.write_bm25 !== false,
      dictName: action.dictionary || dictName,
      dictContent,
    });
    const libraryName = getLibraryName(file, action);
    if (action.bind_to_current_character !== false) {
      bindings.push({
        name: libraryName,
        vector_enabled: action.write_vector ?? kbConfig.write_vector !== false,
        bm25_enabled: action.write_bm25 ?? kbConfig.write_bm25 !== false,
      });
    }
    uploaded.push(file.name);
  }
  return { bindings, uploaded };
}

function applyRootScopePatch(root, scopePatch = {}) {
  const next = root || {};
  if (hasMeaningfulPatch(scopePatch.api)) next.api = deepMergeSettings(next.api, scopePatch.api);
  if (hasMeaningfulPatch(scopePatch.summary)) {
    const summary = compileSummaryPatch(scopePatch.summary);
    for (const key of SUMMARY_LOCAL_KEYS) delete summary[key];
    next.summary = deepMergeSettings(next.summary, summary);
  }
  if (hasMeaningfulPatch(scopePatch.rag)) {
    const rag = normalizeRagPatch(scopePatch.rag);
    next.rag = deepMergeSettings(next.rag, rag);
    if (rag.strategy_settings?.candidate_multiplier !== undefined) {
      next.rag.candidate_multiplier = rag.strategy_settings.candidate_multiplier;
    }
  }
  if (hasMeaningfulPatch(scopePatch.bm25)) {
    const bm25 = normalizeBm25Patch(scopePatch.bm25);
    for (const key of ["libs", "bound_dict", "current_dict"]) delete bm25[key];
    next.bm25 = deepMergeSettings(next.bm25, bm25);
  }
  if (hasMeaningfulPatch(scopePatch.knowledge) || knowledgeActions.some((action) => ["bind_existing", "unbind_existing"].includes(action.action))) {
    const knowledge = normalizeKnowledgePatch(scopePatch.knowledge);
    const { libs, dict_mapping: dictMapping, ...settings } = knowledge;
    next.kb_settings = deepMergeSettings(next.kb_settings, settings);
    if (dictMapping) next.kb = deepMergeSettings(next.kb, { dict_mapping: dictMapping });
  }
  if (hasMeaningfulPatch(scopePatch.status)) next.status = deepMergeSettings(next.status, scopePatch.status);
  return next;
}

function applyCharacterScopePatch(extensions, scopePatch = {}, stagedKnowledge = [], knowledgeActions = []) {
  const next = extensions || {};
  if (hasMeaningfulPatch(scopePatch.rag)) {
    const rag = normalizeRagPatch(scopePatch.rag);
    delete rag.candidate_multiplier;
    if (rag.strategy_settings) delete rag.strategy_settings.candidate_multiplier;
    next.anima_rag_settings = deepMergeSettings(next.anima_rag_settings, rag);
  }
  if (hasMeaningfulPatch(scopePatch.bm25)) {
    const bm25 = normalizeBm25Patch(scopePatch.bm25);
    const bindings = {};
    for (const key of ["libs", "bound_dict", "current_dict"]) if (bm25[key] !== undefined) bindings[key] = bm25[key];
    if (Object.keys(bindings).length > 0) next.anima_bm25_settings = deepMergeSettings(next.anima_bm25_settings, bindings);
  }
  if (hasMeaningfulPatch(scopePatch.knowledge)) {
    const knowledge = normalizeKnowledgePatch(scopePatch.knowledge);
    const current = next.anima_kb_settings || { libs: [] };
    const libs = Array.isArray(knowledge.libs) ? knowledge.libs : current.libs || [];
    const mergedLibs = [...libs];
    for (const binding of stagedKnowledge) {
      const existing = mergedLibs.find((item) => item.name === binding.name);
      if (existing) Object.assign(existing, binding);
      else mergedLibs.push(binding);
    }
    for (const action of knowledgeActions) {
      if (!["bind_existing", "unbind_existing"].includes(action.action)) continue;
      const name = action.target_library_name || action.source?.name || action.source?.file_name;
      if (!name) continue;
      const existing = mergedLibs.find((item) => item.name === name);
      if (action.action === "unbind_existing") {
        if (existing) {
          existing.vector_enabled = false;
          existing.bm25_enabled = false;
        }
      } else if (existing) {
        existing.vector_enabled = action.write_vector !== false;
        existing.bm25_enabled = action.write_bm25 !== false;
      } else {
        mergedLibs.push({
          name,
          vector_enabled: action.write_vector !== false,
          bm25_enabled: action.write_bm25 !== false,
        });
      }
    }
    next.anima_kb_settings = deepMergeSettings(current, { libs: mergedLibs });
  } else if (stagedKnowledge.length > 0) {
    const current = next.anima_kb_settings || { libs: [] };
    const libs = [...(current.libs || [])];
    for (const binding of stagedKnowledge) {
      const existing = libs.find((item) => item.name === binding.name);
      if (existing) Object.assign(existing, binding);
      else libs.push(binding);
    }
    next.anima_kb_settings = { ...current, libs };
  }
  if (hasMeaningfulPatch(scopePatch.status)) {
    for (const [field, extensionKey] of Object.entries(STATUS_CHARACTER_FIELDS)) {
      if (scopePatch.status[field] !== undefined) next[extensionKey] = clone(scopePatch.status[field]);
    }
  }
  return next;
}

function applyChatScopePatch(chatMetadata, scopePatch = {}) {
  const next = chatMetadata || {};
  if (hasMeaningfulPatch(scopePatch.summary)) {
    const summary = compileSummaryPatch(scopePatch.summary);
    const local = {};
    for (const key of SUMMARY_LOCAL_KEYS) if (summary[key] !== undefined) local[key] = summary[key];
    next.anima_config = deepMergeSettings(next.anima_config, local);
  }
  if (hasMeaningfulPatch(scopePatch.rag)) next.anima_rag_settings = deepMergeSettings(next.anima_rag_settings, normalizeRagPatch(scopePatch.rag));
  return next;
}

function captureAssistantTransactionSnapshot(context) {
  return {
    global: clone(context.extensionSettings?.[MODULE_NAME] || {}),
    character: clone(getCharacterExtensions(context)),
    chat: clone(context.chatMetadata || {}),
    characterId: context.characterId,
    chatId: context.chatId,
  };
}

async function restoreAssistantTransactionSnapshot(context, snapshot, touchedCharacterKeys = []) {
  context.extensionSettings[MODULE_NAME] = clone(snapshot.global);
  if (context.chatMetadata) {
    for (const key of Object.keys(context.chatMetadata)) delete context.chatMetadata[key];
    Object.assign(context.chatMetadata, clone(snapshot.chat));
  }
  const character = context.characters?.[context.characterId];
  if (character?.data) {
    character.data.extensions = clone(snapshot.character);
    for (const key of touchedCharacterKeys) {
      if (context.writeExtensionField) {
        if (snapshot.character[key] !== undefined) await context.writeExtensionField(context.characterId, key, clone(snapshot.character[key]));
        else if (character.data.extensions) delete character.data.extensions[key];
      }
    }
  }
  context.saveSettingsDebounced?.();
  await context.saveMetadata?.();
  try {
    if (snapshot.global?.status) await syncStatusToWorldBook(getStatusSettings());
  } catch (error) {
    console.warn("[Anima Assistant] status rollback sync failed", error?.message || "unknown");
  }
}

function assertPatchReadback(actual, expected, path = "") {
  if (!isObject(expected)) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Readback 不一致：${path}`);
    return;
  }
  for (const [key, value] of Object.entries(expected)) {
    if (value && typeof value === "object" && !Array.isArray(value)) assertPatchReadback(actual?.[key], value, path ? `${path}.${key}` : key);
    else if (JSON.stringify(actual?.[key]) !== JSON.stringify(value)) throw new Error(`Readback 不一致：${path ? `${path}.` : ""}${key}`);
  }
}

function verifySkillPlanReadback(plan, context) {
  const root = context.extensionSettings?.[MODULE_NAME] || {};
  const character = getCharacterExtensions(context);
  const chat = context.chatMetadata || {};
  const global = getPlanScope(plan, "global");
  if (hasMeaningfulPatch(global.api)) assertPatchReadback(root.api, global.api, "global.api");
  if (hasMeaningfulPatch(global.summary)) {
    const summary = compileSummaryPatch(global.summary);
    for (const key of SUMMARY_LOCAL_KEYS) delete summary[key];
    assertPatchReadback(root.summary, summary, "global.summary");
  }
  if (hasMeaningfulPatch(global.rag)) assertPatchReadback(root.rag, normalizeRagPatch(global.rag), "global.rag");
  if (hasMeaningfulPatch(global.bm25)) {
    const bm25 = normalizeBm25Patch(global.bm25);
    delete bm25.libs;
    delete bm25.bound_dict;
    delete bm25.current_dict;
    assertPatchReadback(root.bm25, bm25, "global.bm25");
  }
  if (hasMeaningfulPatch(global.knowledge)) {
    const knowledge = normalizeKnowledgePatch(global.knowledge);
    delete knowledge.libs;
    delete knowledge.dict_mapping;
    assertPatchReadback(root.kb_settings, knowledge, "global.kb_settings");
  }
  if (hasMeaningfulPatch(global.status)) assertPatchReadback(root.status, global.status, "global.status");
  const characterPatch = getPlanScope(plan, "character");
  if (hasMeaningfulPatch(characterPatch.rag)) {
    const rag = normalizeRagPatch(characterPatch.rag);
    delete rag.candidate_multiplier;
    if (rag.strategy_settings) delete rag.strategy_settings.candidate_multiplier;
    assertPatchReadback(character.anima_rag_settings, rag, "character.rag");
  }
  const chatPatch = getPlanScope(plan, "chat");
  if (hasMeaningfulPatch(chatPatch.rag)) assertPatchReadback(chat.anima_rag_settings, normalizeRagPatch(chatPatch.rag), "chat.rag");
  return true;
}

export async function applySkillAgentConfigPlan(plan, discovery, files = []) {
  const context = getContext();
  if (!context?.extensionSettings) throw new Error("无法读取 TauriTavern 当前配置");
  const validation = validateSkillConfigPlan(plan, discovery, files);
  if (!validation.ok) throw new Error(`配置方案未通过应用前校验：${validation.errors.join("；")}`);
  if (discovery?.character?.id !== undefined && discovery.character.id !== null && context.characterId !== discovery.character.id) throw new Error("应用前检测到角色已切换，请重新运行配置助手。");
  if (discovery?.chatId && context.chatId !== discovery.chatId) throw new Error("应用前检测到聊天已切换，请重新运行配置助手。");

  const snapshot = captureAssistantTransactionSnapshot(context);
  const touchedCharacterKeys = new Set();
  let stagedKnowledge = { bindings: [], uploaded: [] };
  try {
    stagedKnowledge = await stageSkillKnowledgeImports(plan, files, context);
    const nextRoot = applyRootScopePatch(clone(snapshot.global), getPlanScope(plan, "global"));
    const nextCharacter = applyCharacterScopePatch(
      clone(snapshot.character),
      getPlanScope(plan, "character"),
      stagedKnowledge.bindings,
      (plan.knowledge_files || []).filter((action) => action.bind_to_current_character !== false),
    );
    const nextChat = applyChatScopePatch(clone(snapshot.chat), getPlanScope(plan, "chat"));

    context.extensionSettings[MODULE_NAME] = nextRoot;
    if (context.chatMetadata && hasMeaningfulScopePatch(getPlanScope(plan, "chat"))) {
      for (const key of Object.keys(context.chatMetadata)) delete context.chatMetadata[key];
      Object.assign(context.chatMetadata, nextChat);
    }
    const touchedKeys = new Set(Object.keys(nextCharacter).filter((key) => key.toLowerCase().startsWith("anima_")));
    for (const key of touchedKeys) {
      if (JSON.stringify(nextCharacter[key]) === JSON.stringify(snapshot.character[key])) continue;
      touchedCharacterKeys.add(key);
      await context.writeExtensionField(context.characterId, key, clone(nextCharacter[key]));
    }
    context.saveSettingsDebounced?.();
    if (hasMeaningfulScopePatch(getPlanScope(plan, "chat"))) await context.saveMetadata?.();
    if (hasMeaningfulPatch(getPlanScope(plan, "global").status)) await syncStatusToWorldBook(getStatusSettings());
    verifySkillPlanReadback(plan, context);
    void scheduleAnimaSettingsSync({ reason: "skill_agent_applied" }).catch((error) => console.warn("[Anima Assistant] remote settings sync failed", error?.message || "unknown"));
    return { uploaded: stagedKnowledge.uploaded, warnings: validation.warnings, readback: "passed" };
  } catch (error) {
    try {
      await restoreAssistantTransactionSnapshot(context, snapshot, [...touchedCharacterKeys]);
    } catch (rollbackError) {
      throw new Error(`${error?.message || "配置应用失败"}；回滚也失败：${rollbackError?.message || "unknown"}`);
    }
    throw new Error(`${error?.message || "配置应用失败"}；设置已回滚，新上传但未绑定的知识库不会自动删除。`);
  }
}

async function applyAssistantPlan(input) {
  const context = getContext();
  if (!context?.extensionSettings) throw new Error("无法读取 TauriTavern 当前配置");
  const plan = createAssistantPlan(input);

  const summary = getSummarySettings();
  Object.assign(summary, plan.summary);
  saveSummarySettings(summary);

  const rag = getRagSettings();
  const oldInjection = rag.injection_settings;
  const oldStrategy = rag.strategy_settings;
  Object.assign(rag, plan.rag, {
    injection_settings: mergeObject(oldInjection, plan.rag.injection_settings),
    strategy_settings: mergeObject(oldStrategy, plan.rag.strategy_settings),
  });
  rag.strategy_settings.important = mergeObject(
    oldStrategy?.important,
    plan.rag.strategy_settings.important,
  );
  rag.strategy_settings.special = mergeObject(
    oldStrategy?.special,
    plan.rag.strategy_settings.special,
  );
  rag.strategy_settings.period = mergeObject(
    oldStrategy?.period,
    plan.rag.strategy_settings.period,
  );
  rag.strategy_settings.status = mergeObject(
    oldStrategy?.status,
    plan.rag.strategy_settings.status,
  );
  rag.strategy_settings.diversity = mergeObject(
    oldStrategy?.diversity,
    plan.rag.strategy_settings.diversity,
  );
  rag.rerank_enabled = Boolean(getAnimaConfig().api?.rerank?.key && getAnimaConfig().api?.rerank?.model);
  await saveRagSettings(rag);

  const bm25 = getBm25Settings(context);
  const oldBm25Content = bm25.content_settings;
  Object.assign(bm25, plan.bm25, {
    content_settings: mergeObject(oldBm25Content, plan.bm25.content_settings),
  });
  context.saveSettingsDebounced();

  const status = getStatusSettings();
  status.status_enabled = plan.status.enabled;
  saveStatusSettings(status);
  await syncStatusToWorldBook(status);

  const kbSettings = getGlobalKbSettingsFull();
  const oldKbBase = kbSettings.knowledge_base;
  const oldKbInjection = kbSettings.knowledge_injection;
  Object.assign(kbSettings, plan.knowledge.settings, {
    knowledge_base: mergeObject(oldKbBase, plan.knowledge.settings.knowledge_base),
    knowledge_injection: mergeObject(oldKbInjection, plan.knowledge.settings.knowledge_injection),
  });
  kbSettings.kb_enabled = false;

  const uploaded = [];
  if (plan.knowledge.files.length > 0) {
    const apiConfig = getAnimaConfig().api?.rag || {};
    if (!apiConfig.url || !apiConfig.model) {
      throw new Error("知识库导入需要先在 API 设置中配置向量地址和模型；其他配置已保存。");
    }

    const dictRoot = getBm25Settings(context);
    const dictContent = dictRoot.custom_dicts?.default_dict?.words || dictRoot.custom_dicts?.default?.words || [];
    for (const file of plan.knowledge.files) {
      await uploadKnowledgeBase(file, {
        delimiter: plan.knowledge.settings.knowledge_base.delimiter,
        chunk_size: plan.knowledge.settings.knowledge_base.chunk_size,
        write_vector: true,
        write_bm25: true,
        dictName: "default_dict",
        dictContent,
      });
      uploaded.push(file.name);
    }

    const root = context.extensionSettings[MODULE_NAME];
    root.kb = root.kb || { dict_mapping: {} };
    root.kb.dict_mapping = root.kb.dict_mapping || {};
    const current = getCharKbSettings();
    const libs = [...(current.libs || [])];
    for (const file of plan.knowledge.files) {
      const name = `kb_${safeFileName(file.name)}`;
      const existing = libs.find((item) => item.name === name);
      if (existing) {
        existing.vector_enabled = true;
        existing.bm25_enabled = true;
      } else {
        libs.push({ name, vector_enabled: true, bm25_enabled: true });
      }
      root.kb.dict_mapping[name] = { dict: "default_dict", dirty: false };
    }
    await saveCharKbSettings(libs);
    kbSettings.kb_enabled = true;
  }

  context.saveSettingsDebounced();
  void scheduleAnimaSettingsSync({ reason: "assistant_applied" }).catch((error) => {
    console.warn("[Anima Assistant] remote settings sync failed:", error?.message || "unknown");
  });
  return { uploaded, plan };
}

function hasOwn(value, key) {
  return Boolean(value && Object.hasOwn(value, key));
}

/**
 * Apply a model-produced plan against the same runtime setting objects used by
 * the normal Anima panels. This deliberately deep-merges instead of replacing
 * sections, so newer/unknown fields and existing user choices survive.
 */
export async function applySkillAssistantPlan(plan, files = []) {
  const context = getContext();
  if (!context?.extensionSettings) throw new Error("无法读取 TauriTavern 当前配置");
  if (!plan || plan.type !== "CONFIG_PLAN" || !plan.changes) {
    throw new Error("没有可应用的 SKILL 配置方案");
  }

  const changes = sanitizeAssistantPatch(plan.changes);
  const uploaded = [];

  if (changes.api && typeof changes.api === "object") {
    const config = getAnimaConfig();
    config.api = config.api || {};
    for (const type of SKILL_API_TYPES) {
      if (!changes.api[type] || typeof changes.api[type] !== "object") continue;
      config.api[type] = deepMergeSettings(config.api[type], changes.api[type]);
    }
  }

  if (changes.summary && typeof changes.summary === "object") {
    saveSummarySettings(deepMergeSettings(getSummarySettings(), changes.summary));
  }

  if (changes.rag && typeof changes.rag === "object") {
    const ragPatch = deepMergeSettings({}, changes.rag);
    await saveRagSettings(deepMergeSettings(getRagSettings(), ragPatch));
  }

  if (changes.bm25 && typeof changes.bm25 === "object") {
    const bm25 = getBm25Settings(context);
    context.extensionSettings[MODULE_NAME].bm25 = deepMergeSettings(bm25, changes.bm25);
  }

  if (changes.status && typeof changes.status === "object") {
    const statusPatch = deepMergeSettings({}, changes.status);
    if (hasOwn(statusPatch, "enabled") && !hasOwn(statusPatch, "status_enabled")) {
      statusPatch.status_enabled = statusPatch.enabled;
      delete statusPatch.enabled;
    }
    const status = deepMergeSettings(getStatusSettings(), statusPatch);
    saveStatusSettings(status);
    await syncStatusToWorldBook(status);
  }

  if (changes.knowledge && typeof changes.knowledge === "object") {
    const knowledgePatch = deepMergeSettings({}, changes.knowledge);
    if (hasOwn(knowledgePatch, "enabled") && !hasOwn(knowledgePatch, "kb_enabled")) {
      knowledgePatch.kb_enabled = knowledgePatch.enabled;
      delete knowledgePatch.enabled;
    }
    const disableExistingLibraries = knowledgePatch.disable_existing_libraries === true;
    delete knowledgePatch.disable_existing_libraries;
    const requestedLibraries = Array.isArray(knowledgePatch.libraries)
      ? knowledgePatch.libraries
      : null;
    delete knowledgePatch.libraries;

    const kbSettings = getGlobalKbSettingsFull();
    const mergedKbSettings = deepMergeSettings(kbSettings, knowledgePatch);
    context.extensionSettings[MODULE_NAME].kb_settings = mergedKbSettings;

    const currentCharKb = getCharKbSettings();
    let libs = Array.isArray(currentCharKb.libs) ? structuredClone(currentCharKb.libs) : [];
    if (requestedLibraries && requestedLibraries.every((item) => item && typeof item === "object")) {
      libs = requestedLibraries;
    }

    if (mergedKbSettings.kb_enabled === false || disableExistingLibraries) {
      libs = libs.map((item) => ({ ...item, vector_enabled: false, bm25_enabled: false }));
    }

    const shouldImport = mergedKbSettings.kb_enabled === true && files.length > 0;
    if (shouldImport) {
      const apiConfig = getAnimaConfig().api?.rag || {};
      if (!apiConfig.url || !apiConfig.model) {
        throw new Error("知识库导入需要先在 API 设置中配置向量地址和模型；其他配置已保存。");
      }

      const bm25 = getBm25Settings(context);
      const dictName = mergedKbSettings.knowledge_base?.dictionary || "default_dict";
      const dictContent = bm25.custom_dicts?.[dictName]?.words ||
        bm25.custom_dicts?.default_dict?.words ||
        bm25.custom_dicts?.default?.words || [];
      const kbConfig = mergedKbSettings.knowledge_base || {};
      for (const file of files) {
        await uploadKnowledgeBase(file, {
          delimiter: kbConfig.delimiter || "",
          chunk_size: Number(kbConfig.chunk_size) || 500,
          write_vector: kbConfig.write_vector !== false,
          write_bm25: kbConfig.write_bm25 !== false,
          dictName,
          dictContent,
        });
        uploaded.push(file.name);
        const name = `kb_${safeFileName(file.name)}`;
        const existing = libs.find((item) => item.name === name);
        if (existing) {
          existing.vector_enabled = kbConfig.write_vector !== false;
          existing.bm25_enabled = kbConfig.write_bm25 !== false;
        } else {
          libs.push({
            name,
            vector_enabled: kbConfig.write_vector !== false,
            bm25_enabled: kbConfig.write_bm25 !== false,
          });
        }
      }
    }

    if (requestedLibraries || shouldImport || mergedKbSettings.kb_enabled === false || disableExistingLibraries) {
      await saveCharKbSettings(libs);
    }
  }

  context.saveSettingsDebounced();
  void scheduleAnimaSettingsSync({ reason: "skill_assistant_applied" }).catch((error) => {
    console.warn("[Anima Assistant] remote settings sync failed:", error?.message || "unknown");
  });
  return { uploaded, plan: { ...plan, changes } };
}

export function initAssistant() {
  renderAssistantCard();
}
