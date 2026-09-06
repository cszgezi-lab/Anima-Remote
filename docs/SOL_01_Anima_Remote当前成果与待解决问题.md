# Anima Remote 当前成果与待解决问题

这份文件提供给 SOL 模型，作为理解项目现状的事实摘要。请结合它和用户另外提供的三份 Anima/Izumi SKILL 文件一起分析；不要把本文件中的“待解决”误认为已经实现。

## 1. 项目身份

- 项目：`Anima-Remote`
- Git 仓库：<https://github.com/cszgezi-lab/Anima-Remote.git>
- 默认分支：`main`
- 目标客户端：TauriTavern 的 Anima 扩展
- 目标后端：部署在 Ubuntu Docker 上的 Anima Remote 服务
- 用户访问方式：Tailscale HTTPS/MagicDNS；每个用户使用独立的 Anima bearer token
- 本地仓库结构：
  - `extension/`：TauriTavern 前端扩展
  - `server/`：带 token 鉴权、租户隔离、RAG/BM25/设置同步的后端
  - `deploy/`：Docker Compose 和部署文件
  - `docs/`：用户指南、威胁模型、可执行配置 SKILL 等

## 2. 已经实现的远程能力

1. 扩展可以把 Anima 的 RAG、BM25、知识库和设置请求发送到远程 Anima 后端。
2. 后端按 bearer token 派生租户命名空间，不接受客户端自行提交 tenant ID。
3. 不同 token 的用户数据、知识库、聊天记忆和 BM25 数据隔离。
4. 全局、角色、聊天三层设置保持原有优先级：

   `global < character < chat`

5. API 设置保留原 Anima 的总结、状态、Embedding、Rerank 四类配置。
6. API Key 可以为空；用户填写的 API 地址和模型名应该原样作为用户配置使用。
7. 当前 URL 兼容规则已经修复为：不擅自给用户填写的地址补 `/v1`；需要时只处理聊天接口的 `/chat/completions` 兼容路径。不要重新引入自动补 `/v1`。
8. 用户的 provider API Key 不进入远程设置同步、服务端设置文件、普通日志或 AI 配置助手上下文。
9. 朋友使用时只需：加入管理员允许的 Tailnet、安装 TauriTavern/TavernHelper/扩展、填写服务器 HTTPS 地址和管理员单独创建的 token；不能使用 owner token。

## 3. 当前配置助手

扩展 API 设置顶部有两个入口：

- “普通向导”：固定流程，适合快速套用默认方案。
- “按 SKILL 新手版配置”：调用用户已经配置的 LLM，读取脱敏的当前配置，然后按照内置可执行 SKILL 工作。

当前 SKILL 助手的目标不是教程，而是本地可执行配置代理。大致流程是：

`Discover → Interview → Plan → Validate → Diff → Confirm → Apply → Readback → Rollback/Report`

当前实现已经包含以下行为：

1. 宿主先构造脱敏 `DISCOVERY_CONTEXT`，包括当前扩展、后端、作用域、角色/聊天、API readiness、当前有效设置和能力。
2. AI 不应看到 API Key、token、cookie、password、authorization 等秘密。
3. AI 根据用户目标决定总结、Summary prompt、RAG、分布式检索、BM25、Rerank、知识库、状态变量和作用域。
4. 向量检索的嵌套配置不能只改开关；必须能够处理 `strategy_settings`、`injection_settings`、候选倍数、各标签 count/diversity、状态/时间/节日策略、BM25 和重排等字段。
5. 如果检测到 MVU/EJS/其他外部变量系统，默认关闭 Anima 状态变量，避免两个状态源互相覆盖；已有配置不删除。
6. 如果没有外部原作资料，AI 应能关闭知识库并解除当前角色的知识库绑定；如果用户选择文件，则由本地文件选择器交给本地执行器导入，不把原作全文粘贴给 AI。
7. AI 返回严格 JSON 的 QUESTION 或 CONFIG_PLAN，前端解析、做安全/Schema/预算/作用域校验，展示 Diff，等用户确认后才写入。
8. 应用前会创建本地快照；保存或 Readback 失败时回滚可回滚设置；新建但未绑定的数据库不能擅自删除，只能报告。
9. 配置助手请求已改成非流式，并使用较长的 120 秒客户端超时，以降低移动端 `BodyStreamBuffer was aborted`。

## 4. 近期已解决的兼容问题

- 不再把用户地址自动改成 `/v1`，因为有些 OpenAI 兼容端点没有 `/v1`。
- API Key 允许为空，不因空 key 破坏请求。
- 只在兼容聊天请求的必要位置处理 `/chat/completions`；不能把 Embedding、Rerank 或用户自定义完整路径错误地拼成聊天路径。
- SKILL 配置请求不再继承流式输出，避免 JSON 方案尚未完整返回时被移动 WebView 中断。

## 5. 用户刚刚发现的历史记录问题

原先配置助手只在运行时内存中保存对话，关闭模态框后再打开会丢失。第一次修复尝试只依赖浏览器 `localStorage`，但在实际 TauriTavern/移动 WebView 中仍然没有可靠恢复。

当前应改为：

1. 把 SKILL 配置助手的脱敏对话记录保存到当前 Tavern 聊天的 `chatMetadata`，并调用 `saveMetadata()`。
2. 使用不会被 Anima Remote 设置同步采集的私有键，例如 `__anima_skill_assistant_history_v1`，避免把配置助手聊天同步到后端。
3. 浏览器本地存储只能作为无聊天上下文时的备用方案，不能作为主存储。
4. 记录要按当前角色/聊天隔离，关闭模态框、切换页面或重载后仍可恢复。
5. 记录只保存脱敏模型消息、UI 消息、方案、发现快照和文件名；不保存文件内容、API Key、token 或 cookie。
6. 增加“删除本地记录”按钮，删除当前角色/聊天的记录，同时调用 `saveMetadata()`；删除后重新打开应从空白状态开始。
7. 重新打开时，如果历史中记录了待导入文件，只能显示文件名并提示重新选择文件，不能假装浏览器仍持有 File 对象。

## 6. 希望 SOL 重点帮助设计的功能

用户不希望新手必须逐个回答很多问题。希望增加一种“**一次性配置**”方式：用户可以一次性描述自己的 RP 类型、记忆目标、是否导入原作、是否使用 MVU/EJS、是否保留 User 消息、希望的召回强度、知识库和状态变量偏好；AI 读取当前脱敏配置后，直接生成完整 CONFIG_PLAN，一次性展示差异并等待确认。

这个一次性模式仍必须：

- 覆盖全部可由 AI 设置的非敏感属性，而不是只给用户教程；
- 包括 Summary、标签分类、User 记忆策略、向量检索、分布式检索策略、候选预算、BM25、Rerank、知识库、状态变量、作用域和必要数据库动作；
- API 地址、端口、模型名、API Key 不由 AI 猜测或生成，以当前 API 设置为准；
- 如果缺少真正会改变方案的关键事实，最多指出缺失项并让用户补充，不能静默编造；
- 最终仍然生成 CONFIG_PLAN，显示 Diff，等用户确认后本地 Apply；
- 不把配置助手对话历史发到 Anima 后端。

## 7. 请 SOL 输出的内容

请基于以上项目事实和用户提供的三份 SKILL 文件，输出：

1. 一次性配置模式的完整产品/交互设计；
2. 用户可以直接粘贴给配置助手的一段单次输入模板；
3. 一次性输入如何映射到完整 CONFIG_PLAN 的规则；
4. 仍然缺少关键信息时的最小追问规则；
5. 对现有 SKILL prompt、解析器、前端状态机、历史记录持久化和测试的具体修改建议；
6. 不能把建议写成“请用户自己去设置某参数”，必须让 AI 生成并由本地执行器应用所有非敏感配置。

