import { getAnimaConfig } from "./api.js";
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
import { scheduleAnimaSettingsSync } from "./transport.js";
import { escapeHtml } from "./utils.js";

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
        <button id="anima-open-assistant" class="anima-btn primary"><i class="fa-solid fa-route"></i> 开始配置助手</button>
      </div>
      <div style="margin-top:10px; color:#a1a1aa; font-size:12px;">它会先询问目标、原作 TXT/MD、变量系统和 User 消息取舍；应用前会展示变更预览。</div>
    </div>`,
  );
  document
    .getElementById("anima-open-assistant")
    ?.addEventListener("click", openAssistant);
}

function ensureAssistantModal() {
  if (document.getElementById("anima-assistant-modal")) return;
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div id="anima-assistant-modal" class="anima-modal hidden" style="z-index:100001;">
      <div class="anima-modal-content" style="max-width:720px; width:94%;">
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

function openAssistant() {
  assistantState = structuredClone(DEFAULT_STATE);
  ensureAssistantModal();
  renderStep();
  document.getElementById("anima-assistant-modal")?.classList.remove("hidden");
}

function closeAssistant() {
  document.getElementById("anima-assistant-modal")?.classList.add("hidden");
}

function getBm25Settings(context) {
  const root = context.extensionSettings[MODULE_NAME] || (context.extensionSettings[MODULE_NAME] = {});
  return root.bm25 || (root.bm25 = {});
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
    if (!apiConfig.key || !apiConfig.model) {
      throw new Error("知识库导入需要先在 API 设置中配置向量模型和 API Key；其他配置已保存。");
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

export function initAssistant() {
  renderAssistantCard();
}
