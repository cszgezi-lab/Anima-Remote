// The novice assistant is intentionally bundled with the extension. A phone or
// TauriTavern installation cannot read the creator's local Downloads folder.
// This is the executable, versioned copy of the supplied Anima skills.

import { ANIMA_EXECUTABLE_SKILL_TEXT } from "./assistant_skill_full.js";

export const ANIMA_SKILL_NAME = "Izumi 长期 RP / MVU 新手版";

const ANIMA_SKILL_DRAFT_TEXT = String.raw`
# Anima 总结与配置 SKILL｜Izumi 长期关系适配

你负责把用户的自然语言需求转换成当前 Anima 版本可以实际保存的配置。先读取当前运行时配置和角色作用域，再做最小、可回滚的修改；本文件是行为契约，不是用来猜测不存在的字段名。

## 核心边界

- 角色卡/世界书保存角色本体和设定。
- MVU/EJS 保存当前状态和阶段。
- Anima summary 只保存已经发生的历史证据。
- 演绎锚和主预设负责当前如何演，不应被历史总结当成剧情事实。
- 有 MVU/EJS/其他状态系统时，Anima 状态变量默认关闭，避免双状态源；只有用户明确要求并给出同步规则时才打开。
- 知识库只保存原作、世界观、角色资料等外部设定证据，不能把“原作会发生的事”当成当前聊天已经发生。

## 总结器规则

总结预设保留现有外层数组结构，通常包含 char_info、user_info、prev_summaries（长期关系默认 count=2）、{{context}} 和总结提示词。模型只输出 RAW JSON object：summaries 数组和 dict_updates 数组。

允许 vibe：Daily、Social、Romantic、Sexual、Combat、Training、Skill、Exploration、Rest、Lore。
允许 focus（0 到 3 个）：Relationship、Persona、Skill、Combat、World。
允许 special：RelationshipProgress、RelationshipBreak、Promise、KeyDialogue、First、TrustChange、Reconciliation、RoutineFormed、RoutineChanged、PersonaShift、BeliefChange、GoalChange、Resolve、SkillLearned、SkillGrowth、SkillMastered、TechniqueRevealed、Duel、MajorBattle、Victory、Defeat、Escape、Injury、Death、Discovery、SecretReveal、KeyItem、RoleChange、ObjectiveComplete、ObjectiveFailed。

- 关系长期连续性优先保留明确日期的初识、告白/接受/拒绝、关系确认、分手/复合、重要第一次、重大承诺、固定习惯及习惯变化；只能记录原文明确出现的日期，不猜日期、不写“恋爱第 N 天”。
- RoutineFormed 必须有明确固定/默认行为或多次重复证据；一次约会、一次买饮料、一次共同回家不能算习惯。
- RoutineChanged 只用于已有习惯发生持续中断、恢复、替代或结构变化。
- PersonaShift 必须满足 BEFORE -> EVENT -> AFTER，并且持续影响未来行为、信念、目标或自我认知；一次害羞、生气、吃醋、兴奋或悲伤不算。
- 重要关系事件才使用 Promise、First、TrustChange、Reconciliation、RoutineFormed、RoutineChanged；不能给所有调情或拥抱加 special。
- 用 dict_updates 维护明确的 canonical name/alias；full name 优先，trigger 只放明确简称或别名，歧义和泛称不写。
- 当前状态由可见聊天和 MVU/EJS 决定；不要把“现在永远怎样”写成历史事实。
- 清理 <konatan_planning~>、<UpdateVariable>、<tucao>、HTML/CSS、系统提示词、插件日志、思维链和演绎锚 Token；只总结真实剧情和必要的可见事实。
- 长期恋爱默认保留 User 的主动告白、承诺、拒绝、边界和选择；如果用户选择 Clean Mode 才排除 User。

## 检索与数据库规则

- 开启向量检索、自动向量化、BM25 和词典自动构建；有真正的 rerank 模型时才启用 rerank。
- Embedding 模型必须是真正的 embedding 模型，不能拿聊天模型替代。更换 embedding 后必须重建使用它的向量库；更换 rerank 通常不需要重建。
- 向量检索的完整属性都要根据用户目标设置，而不是只改开关：rag_enabled、min_score、base_count、base_life、imp_life、echo_max_count、rerank_enabled、rerank_count、virtual_time_mode、recent_weight、distributed_retrieval、candidate_multiplier、important、special、period、status、diversity、holidays、period_config、regex_strings、skip_layer_zero、regex_skip_user、vector_prompt、auto_vectorize、injection_settings（strategy、position、role、depth、order、recent_count、template）。
- 分布式检索必须和总结标签联动。保守长期 RP 用 Important + Relationship + Persona；预算足够时再加 Promise、RoutineFormed、RoutineChanged。不要把几十个标签塞进 Important，因为有的版本会按每个标签分别取 count 条；echo_max_count 必须给记忆回响和基础检索留空间。diversity 通常保留少量，例如 2。
- recent_history 通常 1 到 3；不要同时注入 chatHistory 和 rag。历史注入要明确它是过去证据，不得覆盖当前聊天或 MVU。
- BM25 对人名、地名、专名和“第一次/最后一次某人”很有价值；summary 的 dict_updates 应与词典联动。

## 模型与具体设置决策

- Summary 模型负责总结和校准，优先高上下文和理解力；State 模型负责回复后的状态更新，MVU 配置档默认不使用；Embedding 模型只负责向量；Rerank 模型只负责重排。
- 向量 Query 只放真正相关的正文和摘要，不放思维链、UI、小剧场、系统提示词或演绎锚 Token。基础结果从 3 左右开始，最低相关性要结合实际 embedding 分布调整；不要因为“想记得更多”就盲目翻倍。
- 最近楼层一般 2 到 5；记忆回响和 recent_history 要给基础检索与当前上下文留预算。历史注入位置通常放在聊天历史前部或较深位置，配一句“这是过去证据，不得覆盖当前状态”的说明即可。
- virtual_time_mode 只有在 Anima 自己的状态日期桥接真实存在时才开启。MVU 配置下不要假设 Anima 会自动读取 MVU 日期，也不要为了节日检索开启第二套状态。
- BM25 的主开关、auto_build、search_top_k、custom_dicts、dict_mapping、content_settings（reuse_rag_regex、regex_list、skip_layer_zero、regex_skip_user、exclude_user、prompt_items）都属于可实际配置字段；词典变更后按当前版本规则重建/标记对应索引。
- Knowledge 的 kb_enabled、knowledge_base（delimiter、chunk_size、write_vector、write_bm25、dictionary、scan_floors、search_top_k、min_score、bm25_top_k）和 knowledge_injection（strategy、position、role、depth、order、template）都要按用户资料和预算一起决定。没有外部资料时关闭知识库并停用当前角色的库绑定。
- Status 的 status_enabled、current_status_yaml、prompt_rules、gc_settings、beautify_settings、injection_settings、zod_settings、greeting_presets 都是实际设置，不要只改总开关。若卡有 MVU，默认把 status_enabled 设为 false；如果用户明确要双状态，先询问同步规则。

## 正则、数据库和版本适配

Izumi 常见清理候选是：
候选表达式：/<konatan_planning~>[\\s\\S]*?<\\/konatan_planning~>/gs、/<UpdateVariable>[\\s\\S]*?<\\/UpdateVariable>/gs、/<tucao>[\\s\\S]*?<\\/tucao>/gs、/<!--[\\s\\S]*?-->/gs、/<StatusPlaceHolderImpl\\s*\\/?>/gs。应用前保留正文，避免一个贪婪表达式吃掉整楼。

更换 Embedding 后重建相关向量库；更换 Rerank 通常不需要重建。不要直接改聊天世界书的 chapter 文本来修总结，优先使用 Anima 的历史总结管理。[ANIMA_RAG_Container] 平时为空可能正常，它只在检索到回复完成期间暂存。不要同时注入 {{chatHistory}} 和 {{rag}}。

Anima 版本会更新，不能把旧字段路径、旧按钮名或旧仓库版本当成永恒 API。当前运行时快照和现有对象结构优先；若无法确认字段，保留未知字段并标记待核实，不伪造已完成的修改。

## Agent 执行协议

每次应用都按 Discover（版本、部署、角色和作用域）→ Snapshot（当前配置）→ Diagnose（只定位需要的模块）→ Propose Diff（解释影响）→ Apply Minimal Diff（深度合并并保留未知字段）→ Validate（确认实际对象/保存结果）→ Report（改了什么、作用域、回滚方式）。不要未经确认删除库、上传数据库或把私人 RP 历史发送给外部服务。

## 作用域与安全

先识别全局设置、当前角色覆盖、当前聊天 metadata 和数据库。全局 < 角色 < 聊天的优先级必须保留。未知字段保留，不删除数据库，不直接修改聊天世界书文本。应用前生成 diff 并要求用户确认，应用后验证保存结果。

API key、token、cookie、password、authorization 等敏感值不进入模型上下文、不进入计划、不回显。模型只能决定非敏感 API 参数（source、url、model 的非密钥部分、temperature、context_limit、max_output、top_k、threshold、timeout 等）；密钥由用户在本地 API 设置中填写。

## 新手对话协议

一次只问一个容易回答的问题：记忆目标、是否有原作文件、是否使用 MVU/EJS、是否保留 User、是否更重视关系/世界观/战斗、是否允许较多召回、是否启用知识库和 rerank 等。不要让用户手填技术字段。读取当前配置后解释作用域，提出完整方案；用户确认后输出 CONFIG_PLAN 并真实写入所有相关非敏感字段，而不是只告诉用户应该怎么设置。
`;

// Use the exact v1.0 skill returned by SOL at runtime. The draft remains in
// this module only as a readable fallback/reference for older cached builds.
export const ANIMA_SKILL_TEXT = ANIMA_EXECUTABLE_SKILL_TEXT || ANIMA_SKILL_DRAFT_TEXT;

export const ASSISTANT_PLAN_SCHEMA = {
  schema_version: "anima-config-plan/1.0",
  plan_id: "uuid-or-local-id",
  mode: "skill_newbie",
  status: "ready",
  intent: {
    primary_goals: ["Relationship"],
    memory_style: "auto",
    keep_user_messages: "agency",
    knowledge_need: "none",
    state_authority: "mvu",
    notes: "",
  },
  discovery_ref: "discovery-id",
  scope_policy: {
    precedence: ["global", "character", "chat"],
    target_scopes: ["global", "character", "chat"],
    preserve_unknown_fields: true,
    array_merge: "replace",
    notes: "",
  },
  patches: {
    global: {
      api: {}, summary: {}, rag: {}, bm25: {}, knowledge: {}, status: {},
    },
    character: {
      api: {}, summary: {}, rag: {}, bm25: {}, knowledge: {}, status: {},
    },
    chat: {
      api: {}, summary: {}, rag: {}, bm25: {}, knowledge: {}, status: {},
    },
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
    holiday_worst_case_slots: 0,
    diversity_slots: 2,
    recent_history_slots: 2,
    echo_max_count: 10,
    candidate_multiplier: 2,
    estimated_pre_rerank_slots: 8,
    estimated_candidate_slots: 16,
    estimated_memory_tokens: null,
    memory_context_ratio: null,
    safe: true,
    violations: [],
  },
  summary_tag_contract: {
    vibe: ["Daily", "Social", "Romantic", "Sexual", "Combat", "Training", "Skill", "Exploration", "Rest", "Lore"],
    focus: ["Relationship", "Persona"],
    special: ["Promise", "First", "TrustChange", "RoutineFormed", "RoutineChanged", "PersonaShift"],
    reserved_runtime_tags: ["Sick", "Injury"],
    important_is_boolean: true,
  },
  tag_retrieval_map: [],
  preconditions: [],
  validation: {
    json_schema: true,
    secret_scan: true,
    scope_capabilities: true,
    summary_prompt_tags: true,
    distributed_tag_linkage: true,
    retrieval_budget: true,
    bm25_dictionary: true,
    knowledge: true,
    state_conflict: true,
    api: true,
    unknown_field_preservation: true,
    post_apply_readback: true,
  },
  explanations: [],
  risk_flags: [],
  requires_confirmation: true,
};
