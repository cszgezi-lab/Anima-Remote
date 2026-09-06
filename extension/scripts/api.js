// 1. 定义插件的唯一 ID (非常重要，不要和别的插件重复)
const MODULE_NAME = "anima_memory_system";

import {
  fetchAnima,
  getTransportConfig,
  initAnimaTransport,
  normalizeRemoteBaseUrl,
  requestAnima,
  saveTransportSettings,
  scheduleAnimaSettingsSync,
  testAnimaConnection,
} from "./transport.js";

// 2. 定义默认配置结构
const defaultSettings = {
  api: {
    llm: {
      source: "openai",
      url: "",
      key: "",
      model: "",
      stream: false,
      temperature: 1.0,
      context_limit: 1000000,
      max_output: 8192,
      current_channel: "默认渠道",
    },
    status: {
      source: "openai",
      url: "",
      key: "",
      model: "",
      stream: false,
      temperature: 0.5,
      context_limit: 1000000,
      max_output: 8192,
      current_channel: "默认渠道",
    },
    rag: {
      source: "openai",
      url: "",
      key: "",
      model: "",
      top_k: 5,
      threshold: 0.4,
      current_channel: "默认渠道",
    },
    rerank: {
      url: "",
      key: "",
      model: "",
      timeout: 15,
      current_channel: "默认渠道",
    },
  },
  // 🟢 新增：渠道预设仓库
  api_profiles: {
    llm: { 默认渠道: {} },
    status: { 默认渠道: {} },
    rag: { 默认渠道: {} },
    rerank: { 默认渠道: {} },
  },
};

/**
 * 核心：获取 SillyTavern 的扩展上下文
 * 这里包含了 settings 对象和保存函数
 */
function getStContext() {
  // @ts-ignore
  return window.SillyTavern.getContext();
}

function createAbortError() {
  if (typeof DOMException !== "undefined") {
    return new DOMException("请求已取消", "AbortError");
  }

  const error = new Error("请求已取消");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function attachAbortHandler(signal, onAbort) {
  if (!signal) return () => {};

  if (signal.aborted) {
    onAbort();
    return () => {};
  }

  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/**
 * Forward provider traffic through the shared Anima transport.  The local
 * mode keeps SillyTavern's CSRF-aware jQuery path; remote mode targets the
 * authenticated Anima proxy route.
 */
async function proxyFetch(targetUrl, options = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    isStream = false,
    signal,
  } = options;
  throwIfAborted(signal);
  return fetchAnima("/proxy/forward", {
    method: "POST",
    body: { targetUrl, method, headers, body, isStream },
    isStream,
    signal,
    timeoutMs: getTransportConfig().timeoutMs,
  });
}

/**
 * 获取当前插件的配置（对外暴露的辅助函数）
 * 如果没有配置，会自动初始化默认值
 */
export function getAnimaConfig() {
  const { extensionSettings } = getStContext();
  if (!extensionSettings[MODULE_NAME]) {
    extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
  }
  const settings = extensionSettings[MODULE_NAME];

  if (!settings.api) settings.api = structuredClone(defaultSettings.api);

  // 🟢 确保 api_profiles 存在
  if (!settings.api_profiles) {
    settings.api_profiles = structuredClone(defaultSettings.api_profiles);
  }

  // 🟢 遍历 defaultSettings.api 来补全缺失字段
  for (const key of Object.keys(defaultSettings.api)) {
    // @ts-ignore
    if (!Object.hasOwn(settings.api, key)) {
      // @ts-ignore
      settings.api[key] = defaultSettings.api[key];
    }
  }

  return settings;
}

/**
 * 将 API 错误响应整理成适合弹窗显示的纯文本。
 * @param {unknown} rawError - 原始报错内容
 * @returns {string}
 */
function cleanErrorMessage(rawError) {
  const message = extractErrorReason(rawError) || "未知错误";
  return limitErrorLength(message);
}

/**
 * @param {number | string} status
 * @param {unknown} rawError
 * @param {string} [fallbackReason]
 * @returns {string}
 */
function formatApiError(status, rawError, fallbackReason = "") {
  const reason = cleanErrorMessage(rawError || fallbackReason);
  const statusText = status || "未知";
  return `错误码 ${statusText}: ${reason}`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function extractErrorReason(value) {
  if (value == null) return "";

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";

    const parsed = parseJsonLike(trimmed);
    if (parsed !== null) {
      const parsedReason = extractErrorReason(parsed);
      if (parsedReason) return parsedReason;
    }

    return cleanPlainText(trimmed);
  }

  if (value instanceof Error) {
    return extractErrorReason(value.message);
  }

  if (typeof value !== "object") {
    return String(value);
  }

  const data = /** @type {Record<string, any>} */ (value);
  const nestedError = data.error;

  if (nestedError) {
    if (typeof nestedError === "string") return extractErrorReason(nestedError);
    const nestedReason = extractErrorReason(nestedError);
    if (nestedReason) return nestedReason;
  }

  const directReason =
    data.message ||
    data.detail ||
    data.reason ||
    data.error_description ||
    data.statusText;
  const code = data.code || data.status || data.type;

  if (directReason && code) {
    return `${code}: ${extractErrorReason(directReason)}`;
  }
  if (directReason) return extractErrorReason(directReason);
  if (code) return String(code);

  const primitives = Object.entries(data)
    .filter(([, item]) => item == null || typeof item !== "object")
    .slice(0, 4)
    .map(([key, item]) => `${key}: ${String(item)}`);

  return primitives.join("; ");
}

/**
 * @param {string} text
 * @returns {unknown | null}
 */
function parseJsonLike(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function cleanPlainText(text) {
  const trimmed = decodeHtmlEntities(text).trim();
  const lower = trimmed.toLowerCase();

  if (lower.startsWith("<!doctype") || lower.startsWith("<html")) {
    const title = getHtmlTagText(trimmed, "title");
    if (title) return `网关或路由错误: ${title}`;

    const heading = getHtmlTagText(trimmed, "h1");
    if (heading) return `网关或路由错误: ${heading}`;

    return "服务器返回了 HTML 错误页面，请检查 API URL 或后端路由";
  }

  return trimmed
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} html
 * @param {string} tag
 * @returns {string}
 */
function getHtmlTagText(html, tag) {
  const match = html.match(
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"),
  );
  return match ? cleanPlainText(match[1]) : "";
}

/**
 * @param {string} text
 * @returns {string}
 */
function decodeHtmlEntities(text) {
  if (typeof document !== "undefined") {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = text;
    return textarea.value;
  }

  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * @param {string} text
 * @returns {string}
 */
function limitErrorLength(text) {
  return text.length > 300 ? text.substring(0, 300) + "..." : text;
}

function redactUrlSecrets(value) {
  return String(value || "").replace(
    /([?&](?:key|api[_-]?key|token|access[_-]?token|secret|password)=)[^&]*/gi,
    "$1[redacted]",
  );
}

function redactApiConfig(config) {
  if (!config || typeof config !== "object") return config;
  return {
    ...config,
    key: config.key ? "[redacted]" : "",
    token: config.token ? "[redacted]" : "",
    url: redactUrlSecrets(config.url),
  };
}

/**
 * URL 清洗函数
 * @param {string} url - 原始 URL
 * @param {string} provider - API 提供商 (例如 "google", "openai")
 * @returns {string}
 */
export function processApiUrl(url, provider) {
  if (!url) return "";
  url = url.trim().replace(/\/+$/, "");
  url = url.replace(/0\.0\.0\.0/g, "127.0.0.1");

  // Keep an explicitly entered path untouched.  For a bare host (including
  // host:port), use the conventional OpenAI-compatible /v1 base at request
  // time without rewriting the value saved in the settings UI.
  if (provider !== "google" && /^https?:\/\/[^/]+$/i.test(url)) {
    url = `${url}/v1`;
  }
  return url;
}

function getTransportCardHtml() {
  return `
    <div class="anima-card anima-transport-card" id="anima-transport-card">
      <div class="anima-card-title" style="font-size:1.15em; margin-bottom:8px;">后端连接</div>
      <div class="anima-row" style="align-items:end;">
        <div class="anima-col" style="flex:0 1 150px; min-width:120px;">
          <label for="anima-transport-mode">模式</label>
          <select class="anima-select" id="anima-transport-mode">
            <option value="local">本地 SillyTavern</option>
            <option value="remote">远程 HTTPS</option>
          </select>
        </div>
        <div class="anima-col anima-transport-remote-field" style="flex:1 1 280px; min-width:220px;">
          <label for="anima-transport-url">服务器 URL</label>
          <input class="anima-input" id="anima-transport-url" type="url" placeholder="https://your-tailnet-host.example">
        </div>
        <div class="anima-col anima-transport-remote-field" style="flex:1 1 220px; min-width:180px;">
          <label for="anima-transport-token">Bearer token</label>
          <input class="anima-input" id="anima-transport-token" type="password" autocomplete="new-password" placeholder="输入个人 token；已保存则留空">
        </div>
      </div>
      <div class="anima-card-actions" style="align-items:center;">
        <span id="anima-transport-status" class="anima-transport-status" aria-live="polite"></span>
        <button class="anima-btn" id="btn-test-transport"><i class="fa-solid fa-vial"></i> 测试连接</button>
        <button class="anima-btn primary" id="btn-save-transport"><i class="fa-solid fa-save"></i> 保存连接</button>
      </div>
      <div class="anima-transport-hint">远程模式仅接受 HTTPS；HTTP 只允许 localhost、127.0.0.1 或 ::1 测试。</div>
    </div>
  `;
}

function setTransportStatus(message, kind = "") {
  const element = document.getElementById("anima-transport-status");
  if (!element) return;
  element.textContent = message || "";
  element.dataset.state = kind;
}

function refreshTransportFields() {
  const mode = /** @type {HTMLSelectElement | null} */ (
    document.getElementById("anima-transport-mode")
  );
  const isRemote = mode?.value === "remote";
  document.querySelectorAll(".anima-transport-remote-field").forEach((element) => {
    element.classList.toggle("anima-hidden", !isRemote);
  });
}

function loadTransportToUI() {
  const config = getTransportConfig();
  const mode = document.getElementById("anima-transport-mode");
  const url = document.getElementById("anima-transport-url");
  const token = document.getElementById("anima-transport-token");
  if (mode) mode.value = config.mode;
  if (url) url.value = config.baseUrl;
  if (token) {
    // Never put the stored credential back into the DOM.  A blank field means
    // “keep the current token” when the user saves the connection card.
    token.value = "";
    token.placeholder = config.token
      ? "已保存（留空保持不变）"
      : "输入个人 Bearer token";
  }
  setTransportStatus(
    config.mode === "remote"
      ? config.token
        ? "远程配置已保存（token 已隐藏，请先测试连接）"
        : "远程模式尚未配置 token"
      : "本地 SillyTavern 模式",
    config.mode === "remote" && !config.token ? "error" : "",
  );
  refreshTransportFields();
}

function bindTransportUI() {
  const mode = /** @type {HTMLSelectElement | null} */ (
    document.getElementById("anima-transport-mode")
  );
  const url = /** @type {HTMLInputElement | null} */ (
    document.getElementById("anima-transport-url")
  );
  const token = /** @type {HTMLInputElement | null} */ (
    document.getElementById("anima-transport-token")
  );
  const saveButton = /** @type {HTMLButtonElement | null} */ (
    document.getElementById("btn-save-transport")
  );
  const testButton = /** @type {HTMLButtonElement | null} */ (
    document.getElementById("btn-test-transport")
  );
  if (!mode || !url || !token || !saveButton || !testButton) return;

  mode.addEventListener("change", refreshTransportFields);

  saveButton.addEventListener("click", () => {
    try {
      const patch = { mode: mode.value, baseUrl: url.value };
      if (token.value.trim()) patch.token = token.value.trim();
      const saved = saveTransportSettings(patch);
      url.value = saved.baseUrl;
      token.value = "";
      token.placeholder = saved.token
        ? "已保存（留空保持不变）"
        : "输入个人 Bearer token";
      refreshTransportFields();
      setTransportStatus("连接设置已保存", "success");
      if (window.toastr) window.toastr.success("后端连接设置已保存", "Anima System");
      void scheduleAnimaSettingsSync({ reason: "connection_saved" }).catch((error) => {
        console.warn("[Anima] 保存后设置同步失败:", error?.message || "未知错误");
      });
    } catch (error) {
      setTransportStatus(error?.message || "连接设置无效", "error");
      if (window.toastr) window.toastr.error(error?.message || "连接设置无效", "Anima System");
    }
  });

  testButton.addEventListener("click", async () => {
    const originalText = testButton.innerHTML;
    testButton.disabled = true;
    testButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 测试中...';
    try {
      const current = getTransportConfig();
      const testConfig = {
        mode: mode.value,
        baseUrl: url.value,
        token: token.value.trim() || current.token,
        timeoutMs: current.timeoutMs,
      };
      if (testConfig.mode === "remote") {
        testConfig.baseUrl = normalizeRemoteBaseUrl(testConfig.baseUrl);
      }
      await testAnimaConnection(testConfig);
      setTransportStatus("连接成功", "success");
      if (window.toastr) window.toastr.success("Anima 后端连接成功", "Anima System");
    } catch (error) {
      const message = error?.message || "连接失败";
      setTransportStatus(`连接失败：${message}`, "error");
      if (window.toastr) window.toastr.error(`连接失败：${message}`, "Anima System");
    } finally {
      testButton.disabled = false;
      testButton.innerHTML = originalText;
    }
  });
}

/**
 * 初始化 API 面板逻辑
 */
export function initApiSettings() {
  const container = document.getElementById("tab-api");
  if (!container) return;

  // 1. 添加 CSS 样式
  const styles = `
    <style>
        .anima-transport-card { margin-bottom: 18px; }
        .anima-transport-status { flex: 1 1 auto; min-height: 1.4em; color: var(--smart-text-color, #ccc); }
        .anima-transport-status[data-state="success"] { color: #34d399; }
        .anima-transport-status[data-state="error"] { color: #f87171; }
        .anima-transport-hint { margin-top: 8px; color: #94a3b8; font-size: 0.8em; }
        .anima-card-title {
            font-size: 1.5em; 
            font-weight: bold;
            margin-bottom: 15px;
            color: var(--smart-text-color, #ccc);
            border-bottom: 2px solid var(--smart-border-color, #444);
            padding-bottom: 5px;
        }
        
        .anima-card-actions {
            display: flex;
            justify-content: flex-end;
            gap: 10px;
            margin-top: 15px;
        }

        /* 布局通用类 */
        .anima-row {
            display: flex;
            flex-wrap: wrap; /* 🟢 核心：允许子元素在空间不足时换行 */
            gap: 15px;
            align-items: flex-start;
            margin-bottom: 10px;
        }
        .anima-col {
            flex: 1 1 calc(25% - 15px); /* 桌面端：尽量占 1/4 */
            min-width: 130px; /* 📱 移动端核心：当屏幕变窄，每个框最小 130px，装不下 4 个就会自动变成 2 个一行 (2x2) */
            display: flex;
            flex-direction: column;
        }
        .anima-col label {
            font-size: 0.85em;
            margin-bottom: 5px; /* 统一 Label 和控件的间距 */
            opacity: 0.9;
            height: 1.2em; /* 强制 Label 占据相同高度，防止错位 */
            line-height: 1.2em;
        }
        .anima-col input.anima-input {
            width: 100%;
            height: 38px; /* 强制输入框高度 */
            box-sizing: border-box;
        }

        /* === 纵向间距优化 (拉开 API 类型、URL、Key 之间的距离) === */
        .anima-card > label {
            display: block;
            margin-top: 15px; /* 让 Label 距离上方的输入框远一点 */
            margin-bottom: 6px; /* 距离自己下方的输入框近一点，形成视觉绑定 */
        }
        
        .anima-card > select.anima-select,
        .anima-card > input.anima-input,
        .anima-card > .anima-input-group {
            margin-bottom: 12px; /* 增加所有输入框底部的留白 */
        }

        /* === 新增：大号开关样式 (匹配输入框高度) === */
        .anima-switch-large {
            /* 1. 容器设置：占据 38px 高度，与旁边的输入框保持一致 */
            height: 38px; 
            width: 70px;
            display: flex;         /* 🟢 使用 flex */
            align-items: center;   /* 🟢 核心：让内部的轨道在 38px 高度里垂直居中 */
            cursor: pointer;
            margin-top: 12px;
            position: relative;
        }

        .anima-switch-large input {
            display: none; /* 彻底隐藏 input，避免干扰布局 */
        }
        
        /* 轨道 */
       .anima-switch-large .anima-slider {
            position: relative; /* 改为 relative，由 flex 控制位置 */
            width: 100%;
            height: 34px;       /* 🟢 轨道高度：略小于容器(38px)，显得精致 */
            background-color: var(--anima-bg-input, #374151);
            transition: .4s;
            border-radius: 34px; /* 圆角等于高度，形成完美胶囊 */
            border: 1px solid var(--smart-border-color, #6b7280);
            box-sizing: border-box; /* 确保边框计算在内 */
        }
        
        /* 圆钮 (Knob) */
        .anima-switch-large .anima-slider:before {
            position: absolute;
            content: "";
            height: 26px;       /* 🟢 圆钮高度：34px(轨道) - 2px(边框) - 6px(间隙) = 26px */
            width: 26px;
            left: 3px;          /* 左侧间隙 */
            top: 50%;           /* 垂直居中 */
            transform: translateY(-50%); /* 修正偏移 */
            background-color: white;
            transition: .4s;
            border-radius: 50%;
            box-shadow: 0 2px 4px rgba(0,0,0,0.3);
            z-index: 2;
        }

        /* 激活状态：轨道变绿 */
        .anima-switch-large input:checked + .anima-slider {
            background-color: var(--anima-primary, #10b981);
            border-color: var(--anima-primary, #10b981);
        }
        
        /* 激活状态：圆钮移动 */
        .anima-switch-large input:checked + .anima-slider:before {
            /* 移动距离计算：
               轨道宽(70) - 边框(2) - 圆钮宽(26) - 左间隙(3) - 右预留(3) = 36px
            */
            transform: translate(36px, -50%); 
        }

        /* 弹窗等样式 */
        .anima-modal-overlay {
            position: fixed; inset: 0; width: 100vw; height: 100vh;
            background: rgba(0, 0, 0, 0.6);
            display: flex; justify-content: center; align-items: center;
            z-index: 20000; visibility: hidden; opacity: 0;
            transition: opacity 0.2s; backdrop-filter: blur(2px);
        }
        .anima-modal-overlay.active { visibility: visible; opacity: 1; }
        .anima-modal-box {
            background: var(--smart-background, #1f2937);
            border: 1px solid var(--smart-border-color, #444);
            padding: 20px; border-radius: 8px; width: 300px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.5); text-align: center;
        }
        .anima-btn {
            background-color: #982ac4; color: #ffffff; border: none;
            padding: 8px 16px; border-radius: 5px; cursor: pointer; transition: background 0.2s;
        }
        .anima-btn:hover { background-color: #6f218e; }
        .anima-btn.primary { background-color: #10b981; }
        .anima-btn.primary:hover { background-color: #059669; } 
    </style>
    `;

  // 2. 定义弹窗 HTML
  const modalHtml = `
    <div id="anima-model-modal" class="anima-modal-overlay">
        <div class="anima-modal-box">
            <h3>自定义模型名称</h3>
            <input type="text" id="anima-custom-model-input" class="anima-input" placeholder="输入模型ID (e.g. gpt-4)">
            <div style="display: flex; justify-content: flex-end; gap: 10px;">
                <button class="anima-btn" id="anima-modal-cancel">取消</button>
                <button class="anima-btn primary" id="anima-modal-confirm">确认</button>
            </div>
        </div>
    </div>
    `;

  // 3. 组合界面 (添加 status 卡片)
  container.innerHTML = `
        ${styles}
        <h2 class="anima-title">API 连接配置</h2>
        <p class="anima-subtitle">分别配置用于总结、状态更新和向量检索的模型服务。</p>
        
        ${getTransportCardHtml()}
        ${getApiCardHtml("llm", "🧠 总结模型")}
        ${getApiCardHtml("status", "📊 状态模型")}
        ${getApiCardHtml("rag", "📚 向量模型")}
        ${getApiCardHtml("rerank", "⚖️ 重排模型")}
        ${modalHtml} 
    `;

  // 初始化时加载配置
  loadTransportToUI();
  loadSettingsToUI();
  bindTransportUI();

  // Remote settings are reconciled after the cached UI is available so a
  // temporary network failure never prevents the original panels loading.
  void initAnimaTransport().then(() => {
    loadTransportToUI();
    loadSettingsToUI();
  });

  bindLogic("llm");
  bindLogic("status");
  bindLogic("rag");
  bindLogic("rerank");

  // 初始化弹窗逻辑
  initModalLogic();
}

/**
 * 获取 API 卡片的 HTML
 * @param {string} type - 卡片类型 (例如 "llm", "status", "rag")
 * @param {string} title - 卡片标题
 * @returns {string}
 */
function getApiCardHtml(type, title) {
  let extraSettingsHtml = "";

  // 默认的 API 类型选择 HTML
  let apiTypeHtml = `
    <label>API 类型</label>
    <select class="anima-select" id="anima-${type}-source">
        <option value="openai">自定义OpenAI</option>
        <option value="google">Google Gemini</option>
    </select>
  `;

  if (type === "llm" || type === "status") {
    extraSettingsHtml = `
        <div class="anima-row">
            <div class="anima-col">
                <label>温度</label>
                <input type="number" class="anima-input" id="anima-${type}-temperature" step="0.1" min="0" max="2" placeholder="${type === "status" ? "0.5" : "1.0"}">
            </div>
            <div class="anima-col">
                <label>上下文</label>
                <input type="number" class="anima-input" id="anima-${type}-context" step="1024" placeholder="32000">
            </div>
            <div class="anima-col">
                <label>最大输出</label>
                <input type="number" class="anima-input" id="anima-${type}-maxout" step="128" placeholder="4096">
            </div>
            <div class="anima-col">
                <label>流式</label>
                <label class="anima-switch-large">
                    <input type="checkbox" id="anima-${type}-stream">
                    <span class="anima-slider round"></span>
                </label>
            </div>
        </div>
        `;
  } else if (type === "rerank") {
    // ⚖️ 重排模型不需要选择 API 类型，隐藏掉
    apiTypeHtml = "";
    extraSettingsHtml = `
        <div class="anima-row">
            <div class="anima-col">
                <label>超时时间 (秒)</label>
                <input type="number" class="anima-input" id="anima-${type}-timeout" step="1" min="1" placeholder="15">
            </div>
        </div>
    `;
  }

  // 为 Rerank 提供更明确的 URL 提示
  let urlLabel =
    type === "rerank"
      ? "自定义端点 (需包含 /rerank 结尾)"
      : "自定义端点（基础 URL）";
  let urlPlaceholder =
    type === "rerank"
      ? "例如: https://api.siliconflow.cn/v1/rerank"
      : "https://api.openai.com/v1";

  return `
    <div class="anima-card" data-config-type="${type}">
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid var(--smart-border-color, #444); padding-bottom: 10px; margin-bottom: 15px;">
            <div style="font-size: 1.5em; font-weight: bold; color: var(--smart-text-color, #ccc);">
                ${title}
            </div>
            <div style="display: flex; gap: 5px; align-items: center;">
                <select class="anima-select" id="anima-${type}-channel" style="width: 120px; height: 30px; margin: 0 !important; padding: 0 8px !important; font-size: 0.85em; box-sizing: border-box; line-height: normal !important;"></select>
                <button class="anima-icon-btn" id="btn-add-channel-${type}" title="添加新渠道" style="height: 30px; width: 30px; margin: 0 !important; display: flex; align-items: center; justify-content: center; box-sizing: border-box;">
                    <i class="fa-solid fa-plus"></i>
                </button>
                <button class="anima-icon-btn" id="btn-del-channel-${type}" title="删除当前渠道" style="height: 30px; width: 30px; margin: 0 !important; color: #f87171; display: flex; align-items: center; justify-content: center; box-sizing: border-box;">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        </div>
        
        ${apiTypeHtml}
        
        <label>${urlLabel}</label>
        <div class="anima-input-group">
            <input type="text" class="anima-input" placeholder="${urlPlaceholder}" id="anima-${type}-url">
        </div>
        
        <label>API Key</label>
        <input type="password" class="anima-input" placeholder="sk-..." id="anima-${type}-key">
        
        <label>选择或输入模型</label>
        <div class="anima-input-group">
            <select class="anima-select" id="anima-${type}-model">
                <option value="" disabled selected>请先连接...</option>
            </select>
            <button class="anima-icon-btn" id="btn-edit-${type}" title="手动填写模型ID">
                <i class="fa-solid fa-plus"></i>
            </button>
        </div>

        ${extraSettingsHtml}

        <div class="anima-card-actions">
             <button class="anima-btn" id="btn-test-${type}" style="margin-right: auto;">
                <i class="fa-solid fa-vial"></i> 测试
             </button>
             <button class="anima-btn" id="btn-connect-${type}">
                <i class="fa-solid fa-plug"></i> 获取模型
            </button>
            <button class="anima-btn primary" id="btn-save-${type}">
                <i class="fa-solid fa-save"></i> 保存
            </button>
        </div>
    </div>
    `;
}

/**
 * 💾 保存逻辑 (升级版：存入 ST 后端)
 */
function saveSettingsFromUI() {
  const { extensionSettings, saveSettingsDebounced } = getStContext();

  const getVal = (id) => {
    const el = /** @type {HTMLInputElement} */ (document.getElementById(id));
    return el?.value || "";
  };
  const getCheck = (id) => {
    const el = /** @type {HTMLInputElement} */ (document.getElementById(id));
    return el?.checked || false;
  };
  // 辅助：转数字，如果为空或无效则返回 undefined
  const getNum = (id) => {
    const el = /** @type {HTMLInputElement} */ (document.getElementById(id));
    return el?.value ? Number(el.value) : undefined;
  };

  // 1. 从界面读取最新输入的值
  const newApiConfig = {
    llm: {
      source: getVal("anima-llm-source"),
      url: getVal("anima-llm-url"),
      key: getVal("anima-llm-key"),
      model: getVal("anima-llm-model"),
      stream: getCheck("anima-llm-stream"),
      temperature: getNum("anima-llm-temperature") ?? 1.0,
      context_limit: getNum("anima-llm-context") ?? 64000,
      max_output: getNum("anima-llm-maxout") ?? 8192,
    },
    status: {
      source: getVal("anima-status-source"),
      url: getVal("anima-status-url"),
      key: getVal("anima-status-key"),
      model: getVal("anima-status-model"),
      stream: getCheck("anima-status-stream"),
      temperature: getNum("anima-status-temperature") ?? 0.5,
      context_limit: getNum("anima-status-context") ?? 32000,
      max_output: getNum("anima-status-maxout") ?? 4096,
    },
    rag: {
      source: getVal("anima-rag-source"),
      url: getVal("anima-rag-url"),
      key: getVal("anima-rag-key"),
      model: getVal("anima-rag-model"),
      // 注意：从最新的 api.rag 中读取历史参数
      top_k: extensionSettings[MODULE_NAME]?.api?.rag?.top_k ?? 5,
      threshold: extensionSettings[MODULE_NAME]?.api?.rag?.threshold ?? 0.4,
    },
    rerank: {
      url: getVal("anima-rerank-url"),
      key: getVal("anima-rerank-key"),
      model: getVal("anima-rerank-model"),
      timeout: getNum("anima-rerank-timeout") ?? 15,
    },
  };

  // 确保基础的数据结构存在，防止报错
  if (!extensionSettings[MODULE_NAME].api) {
    extensionSettings[MODULE_NAME].api = {};
  }
  if (!extensionSettings[MODULE_NAME].api_profiles) {
    extensionSettings[MODULE_NAME].api_profiles = {};
  }

  // 2. 🟢 核心逻辑：遍历四个模块，保存到预设仓库，并更新当前激活配置
  const types = ["llm", "status", "rag", "rerank"];
  types.forEach((type) => {
    // 获取当前下拉框选中的渠道名，如果没有渲染出来则默认使用 "默认渠道"
    const channelName = getVal(`anima-${type}-channel`) || "默认渠道";
    newApiConfig[type].current_channel = channelName;

    // 确保该类型在预设仓库中存在对象
    if (!extensionSettings[MODULE_NAME].api_profiles[type]) {
      extensionSettings[MODULE_NAME].api_profiles[type] = {};
    }

    // A. 把界面上的最新数据，存入“预设仓库”对应的渠道名下
    extensionSettings[MODULE_NAME].api_profiles[type][channelName] =
      structuredClone(newApiConfig[type]);

    // B. 把界面上的最新数据，设为“当前激活配置”（给 rag_logic.js 等外部文件读取用）
    extensionSettings[MODULE_NAME].api[type] = newApiConfig[type];
  });

  saveSettingsDebounced();
  void scheduleAnimaSettingsSync({ reason: "api_settings_changed" }).catch((error) => {
    console.warn("[Anima] API 设置同步失败:", error?.message || "未知错误");
  });

  if (window.toastr) window.toastr.success("配置已保存", "Anima System");
}

/**
 * 📖 读取逻辑 (升级版：从 ST 后端读取)
 */
function loadSettingsToUI() {
  const rootConfig = getAnimaConfig();
  const config = rootConfig.api;
  const profiles = rootConfig.api_profiles;
  const setVal = (id, val) => {
    const el = /** @type {HTMLInputElement} */ (document.getElementById(id));
    if (el) el.value = val !== undefined ? val : "";
  };
  const setCheck = (id, val) => {
    const el = /** @type {HTMLInputElement} */ (document.getElementById(id));
    if (el) el.checked = !!val;
  };
  const setModel = (type, val) => {
    if (!val) return;
    const select = document.getElementById(`anima-${type}-model`);
    if (select)
      select.innerHTML = `<option value="${val}" selected>${val}</option>`;
  };

  const renderChannels = (type) => {
    const select = document.getElementById(`anima-${type}-channel`);
    if (!select) return;
    select.innerHTML = "";
    // 获取该类型所有的渠道名
    const channelNames = Object.keys(profiles[type] || { 默认渠道: {} });
    channelNames.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.innerText = name;
      select.appendChild(opt);
    });
    // 设置当前选中的渠道
    select.value = config[type]?.current_channel || "默认渠道";
  };

  // 渲染下拉框
  renderChannels("llm");
  renderChannels("status");
  renderChannels("rag");
  renderChannels("rerank");

  // LLM 加载
  if (config.llm) {
    setVal("anima-llm-source", config.llm.source);
    setVal("anima-llm-url", config.llm.url);
    setVal("anima-llm-key", config.llm.key);
    setModel("llm", config.llm.model);
    setCheck("anima-llm-stream", config.llm.stream);
    // 新增参数
    setVal("anima-llm-temperature", config.llm.temperature);
    setVal("anima-llm-context", config.llm.context_limit);
    setVal("anima-llm-maxout", config.llm.max_output);
  }
  if (config.status) {
    setVal("anima-status-source", config.status.source);
    setVal("anima-status-url", config.status.url);
    setVal("anima-status-key", config.status.key);
    setModel("status", config.status.model);
    setCheck("anima-status-stream", config.status.stream);
    setVal("anima-status-temperature", config.status.temperature);
    setVal("anima-status-context", config.status.context_limit);
    setVal("anima-status-maxout", config.status.max_output);
  }
  // RAG 加载
  if (config.rag) {
    setVal("anima-rag-source", config.rag.source);
    setVal("anima-rag-url", config.rag.url);
    setVal("anima-rag-key", config.rag.key);
    setModel("rag", config.rag.model);
  }
  if (config.rerank) {
    setVal("anima-rerank-url", config.rerank.url);
    setVal("anima-rerank-key", config.rerank.key);
    setModel("rerank", config.rerank.model);
    setVal("anima-rerank-timeout", config.rerank.timeout);
  }
}

/**
 * 绑定单个卡片的交互逻辑
 */
function bindLogic(type) {
  const btnConnect = /** @type {HTMLButtonElement} */ (
    document.getElementById(`btn-connect-${type}`)
  );
  const btnSave = document.getElementById(`btn-save-${type}`);
  const btnEdit = document.getElementById(`btn-edit-${type}`);
  const btnTest = /** @type {HTMLButtonElement} */ (
    document.getElementById(`btn-test-${type}`)
  );

  const selectModel = /** @type {HTMLSelectElement} */ (
    document.getElementById(`anima-${type}-model`)
  );
  const selectSource = /** @type {HTMLSelectElement} */ (
    document.getElementById(`anima-${type}-source`)
  );
  const inputUrl = /** @type {HTMLInputElement} */ (
    document.getElementById(`anima-${type}-url`)
  );
  const inputKey = /** @type {HTMLInputElement} */ (
    document.getElementById(`anima-${type}-key`)
  );

  // 1. 下拉框变动逻辑
  if (selectSource) {
    selectSource.addEventListener("change", () => {
      // 端点完全由用户决定；不要替用户填充供应商地址或端口。
      if (selectSource.value === "google") {
        return;
      }
    });
  }

  // 2. 自定义模型按钮
  if (btnEdit) {
    btnEdit.addEventListener("click", () => {
      openModelModal(type);
    });
  }

  // 3. 保存按钮
  if (btnSave) {
    btnSave.addEventListener("click", () => {
      saveSettingsFromUI();
    });
  }

  if (btnTest) {
    btnTest.addEventListener("click", async () => {
      const currentSource = selectSource ? selectSource.value : "openai";
      const currentUrl = inputUrl.value;
      const currentKey = inputKey.value;
      const currentModel = selectModel.value;

      const originalHtml = btnTest.innerHTML;
      btnTest.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 请求中...`;
      btnTest.disabled = true; // 🟢 VS Code 现在不会报错了

      try {
        // ============================
        // 🟢 分支 A: RAG 模型 (走后端测试)
        // ============================
        if (type === "rerank") {
          // 🟢 分支 C: Rerank 模型 (直接构造虚假切片进行打分测试)
          if (!currentUrl) throw new Error("请填写 Rerank 的 URL");
          const configPayload = {
            model: currentModel || "BAAI/bge-reranker-v2-m3",
            query: "苹果",
            documents: ["红富士", "香蕉", "汽车"], // 测试数据
          };

          const res = await proxyFetch(currentUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(currentKey ? { Authorization: `Bearer ${currentKey}` } : {}),
            },
            body: configPayload,
          });

          if (!res.ok) {
            const errText = await res.text();
            throw new Error(
              `Rerank 报错: ${formatApiError(res.status, errText)}`,
            );
          }

          const data = await res.json();
          // 如果返回结构里有 results 数组，说明完全跑通了标准格式
          const firstScore = data.results?.[0]?.relevance_score || "成功获取";
          if (window.toastr)
            window.toastr.success(
              `测试成功! 返回相关性首位得分: ${firstScore}`,
              "Rerank 系统",
            );
          console.log("[Anima] Rerank Test Result:", data);
        } else if (type === "rag") {
          const configPayload = {
            source: currentSource,
            url: currentUrl,
            key: currentKey,
            model: currentModel || "text-embedding-3-small",
          };

          const data = await requestAnima("/test_connection", {
            method: "POST",
            body: { apiConfig: configPayload },
          });

          // 成功后的处理逻辑保持不变
          if (window.toastr)
            window.toastr.success(data.message, "RAG 连接成功");
          console.log("[Anima] RAG Test Result:", data);
        }

        // ============================
        // 🟢 分支 B: LLM / Status 模型 (走 generateText)
        // ============================
        else {
          const tempConfig = {
            source: currentSource,
            url: currentUrl,
            key: currentKey,
            model: currentModel,
            stream: false,
            temperature: 0.5,
            max_output: 2000, // 测试只需要很少的字
          };

          const testPrompt = [{ role: "user", content: "Hi" }];

          // 调用 generateText
          const reply = await generateText(testPrompt, type, tempConfig);

          if (window.toastr) {
            const shortReply =
              reply.length > 30 ? reply.substring(0, 30) + "..." : reply;
            window.toastr.success(
              `连接成功！回复: ${shortReply}`,
              "Anima System",
            );
          }
        }
      } catch (e) {
        console.error(`[Anima] Test Failed: ${e.message}`);
        let errorMsg = cleanErrorMessage(e.message || "未知错误");
        // 简单美化一下常见错误
        if (errorMsg.includes("401")) errorMsg = "401 鉴权失败 (请检查 Key)";
        if (errorMsg.includes("404")) errorMsg = "404 路径错误 (请检查 URL)";
        if (errorMsg.includes("400"))
          errorMsg = "400 请求参数错误 (请检查模型名)";

        if (window.toastr)
          window.toastr.error(`连接失败: ${errorMsg}`, "Anima System");
      } finally {
        btnTest.innerHTML = originalHtml;
        btnTest.disabled = false;
      }
    });
  }

  // 4. 连接按钮逻辑 (已修复 Google 反代支持)
  if (btnConnect) {
    btnConnect.addEventListener("click", async () => {
      const source = selectSource ? selectSource.value : "openai";
      let url = inputUrl.value;
      const key = inputKey.value;

      const originalHtml = btnConnect.innerHTML;
      btnConnect.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> 连接中...`;
      btnConnect.disabled = true;

      try {
        let models = [];

        if (source === "google") {
          // === Google 连接逻辑 (支持反代) ===
          const isCustomUrl = url && !url.includes("googleapis.com");
          let fetchUrl;
          /** @type {Record<string, string>} */
          let headers = {};

          if (isCustomUrl) {
            // 反代模式：通常是 Bearer Token，路径需要适配
            // 尝试获取模型列表的通用路径
            let baseUrl = url.trim().replace(/\/+$/, "");
            // 如果用户填的是 /v1beta/models/... 这种深层路径，尝试截取
            // 这里做一个简单的假设：反代地址通常支持 /v1beta/models
            if (!baseUrl.endsWith("/models")) {
              baseUrl = `${baseUrl}/v1beta/models`;
            }
            fetchUrl = baseUrl;
            if (key) headers.Authorization = `Bearer ${key}`;
          } else {
            // 官方直连模式
            fetchUrl = "https://generativelanguage.googleapis.com/v1beta/models";
            if (key) fetchUrl += `?key=${encodeURIComponent(key)}`;
          }

          const res = await proxyFetch(fetchUrl, { headers });

          if (!res.ok) {
            const errText = await res.text();
            throw new Error(
              `Google 连接失败: ${formatApiError(res.status, errText)}`,
            );
          }

          const data = await res.json();
          if (data.models) {
            models = data.models.map((m) => m.name.replace("models/", ""));
          }
        } else {
          // === OpenAI/通用 连接逻辑 (严格模式：不使用保底列表) ===
          let modelsFetchUrl = url;
          if (type === "rerank") {
            // 针对 rerank：原 url 通常以 /rerank 结尾。为了获取模型列表，我们退回到 base URL
            // 例如 https://api.siliconflow.cn/v1/rerank -> https://api.siliconflow.cn/v1
            modelsFetchUrl =
              url.replace(/\/rerank\/?$/, "").replace(/\/v1\/?$/, "") + "/v1";
            // 注意：这里不要覆盖 inputUrl.value，保留用户输入的完整 rerank url 供保存
          } else {
            url = processApiUrl(url, source);
            modelsFetchUrl = url;
          }

          const modelHeaders = {
            "Content-Type": "application/json",
            ...(key ? { Authorization: `Bearer ${key}` } : {}),
          };
          const directResponse = await proxyFetch(`${modelsFetchUrl}/models`, {
            method: "GET",
            headers: modelHeaders,
          });

          if (directResponse.ok) {
            const data = await directResponse.json();
            if (data.data && Array.isArray(data.data)) {
              models = data.data.map((m) => m.id);
            } else if (Array.isArray(data)) {
              models = data.map((m) => m.id);
            }
          } else {
            const errText = await directResponse.text();
            throw new Error(
              `获取模型失败: ${formatApiError(directResponse.status, errText)}`,
            );
          }

          if (!models || models.length === 0) {
            throw new Error("连接失败：无法获取模型列表");
          }
        }

        if (models.length > 0) {
          if (window.toastr) window.toastr.success("连接成功");
          selectModel.innerHTML = "";
          models.forEach((m) => {
            const opt = document.createElement("option");
            opt.value = m;
            opt.innerText = m;
            selectModel.appendChild(opt);
          });
          selectModel.value = models[0];
        }
      } catch (/** @type {any} */ e) {
        console.error(`[Anima] Connect Error: ${e.message}`);
        let errorMsg = cleanErrorMessage(e.message || "未知错误");
        if (e.status === 403) errorMsg = "403 Forbidden: 检查 Key 或白名单";
        else if (e.responseText)
          errorMsg = formatApiError(e.status, e.responseText);
        if (window.toastr) window.toastr.error(errorMsg);
      } finally {
        btnConnect.innerHTML = originalHtml;
        btnConnect.disabled = false;
      }
    });
  }
  const channelSelect = document.getElementById(`anima-${type}-channel`);
  const btnAddChannel = document.getElementById(`btn-add-channel-${type}`);
  const btnDelChannel = document.getElementById(`btn-del-channel-${type}`);
  const { extensionSettings, saveSettingsDebounced } = getStContext();

  if (channelSelect && btnAddChannel && btnDelChannel) {
    // 1. 切换渠道事件
    channelSelect.addEventListener("change", () => {
      const selectedChannel = channelSelect.value;
      const profiles = extensionSettings[MODULE_NAME].api_profiles[type];

      if (profiles && profiles[selectedChannel]) {
        // 将预设数据覆盖到当前激活的配置中
        extensionSettings[MODULE_NAME].api[type] = structuredClone(
          profiles[selectedChannel],
        );
        extensionSettings[MODULE_NAME].api[type].current_channel =
          selectedChannel;
        saveSettingsDebounced();
        // 重新加载 UI
        loadSettingsToUI();
        if (window.toastr)
          window.toastr.info(`已切换至渠道: ${selectedChannel}`);
      }
    });

    // 2. 添加渠道事件
    btnAddChannel.addEventListener("click", () => {
      // 这里使用原生的 prompt，最简单直接，不需要写复杂的 HTML 弹窗
      const newName = prompt("请输入新渠道的名称：", "");
      if (!newName || !newName.trim()) return;

      const cleanName = newName.trim();
      const profiles = extensionSettings[MODULE_NAME].api_profiles[type];

      if (profiles[cleanName]) {
        if (window.toastr) window.toastr.warning("该渠道名称已存在！");
        return;
      }

      // 先执行一次保存，确保当前表单数据不会丢失
      saveSettingsFromUI();

      // 复制当前配置作为新渠道的起点
      const currentConfig = structuredClone(
        extensionSettings[MODULE_NAME].api[type],
      );
      currentConfig.current_channel = cleanName;

      profiles[cleanName] = currentConfig;
      extensionSettings[MODULE_NAME].api[type] = currentConfig;
      saveSettingsDebounced();

      loadSettingsToUI();
      if (window.toastr) window.toastr.success(`已创建新渠道: ${cleanName}`);
    });

    // 3. 删除渠道事件
    btnDelChannel.addEventListener("click", () => {
      const currentChannel = channelSelect.value;
      const profiles = extensionSettings[MODULE_NAME].api_profiles[type];

      if (Object.keys(profiles).length <= 1) {
        if (window.toastr) window.toastr.warning("必须保留至少一个渠道！");
        return;
      }

      if (confirm(`确定要删除渠道 "${currentChannel}" 吗？此操作不可逆。`)) {
        delete profiles[currentChannel];
        // 删除后，自动切换到列表里的第一个可用渠道
        const fallbackChannel = Object.keys(profiles)[0];
        extensionSettings[MODULE_NAME].api[type] = structuredClone(
          profiles[fallbackChannel],
        );
        extensionSettings[MODULE_NAME].api[type].current_channel =
          fallbackChannel;

        saveSettingsDebounced();
        loadSettingsToUI();
        if (window.toastr)
          window.toastr.success(`已删除渠道: ${currentChannel}`);
      }
    });
  }
}
let currentEditType = null; // 用于记录当前正在编辑哪个卡片(llm 或 rag)

function initModalLogic() {
  const overlay = document.getElementById("anima-model-modal");
  const input = /** @type {HTMLInputElement} */ (
    document.getElementById("anima-custom-model-input")
  );
  const btnCancel = document.getElementById("anima-modal-cancel");
  const btnConfirm = document.getElementById("anima-modal-confirm");

  if (!overlay) return;

  // 隐藏弹窗函数
  const closeModal = () => {
    overlay.classList.remove("active");
    if (input) input.value = "";
    currentEditType = null;
  };

  // 取消点击
  btnCancel.addEventListener("click", closeModal);

  // 点击背景关闭
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });

  // 确认点击
  btnConfirm.addEventListener("click", () => {
    const val = input.value.trim();
    if (val && currentEditType) {
      const selectModel = /** @type {HTMLSelectElement} */ (
        document.getElementById(`anima-${currentEditType}-model`)
      );
      if (selectModel) {
        // 添加选项并选中
        const opt = document.createElement("option");
        opt.value = val;
        opt.innerText = val + " (自定义)";
        opt.selected = true;
        selectModel.appendChild(opt);
        selectModel.value = val;
      }
    }
    closeModal();
  });
}

// 辅助函数：打开弹窗
function openModelModal(type) {
  currentEditType = type;
  const overlay = document.getElementById("anima-model-modal");
  if (overlay) overlay.classList.add("active");
  // 自动聚焦输入框
  setTimeout(
    () => document.getElementById("anima-custom-model-input")?.focus(),
    100,
  );
}

/**
 * 🚀 核心功能：发送请求生成文本 (最终修正版)
 * 遵循原则：
 * 1. 外部直连 (Google) -> 使用 fetch，支持反代，兼容多种返回格式
 * 2. 内部转发 (OpenAI/ST) -> 使用共享 transport，保留 CSRF 与流式兼容性
 */
export async function generateText(
  promptOrMessages,
  purpose = "llm",
  overrideConfig = null,
  requestOptions = {},
) {
  const { signal } = requestOptions || {};

  try {
    throwIfAborted(signal);

    // 🟢 1. 拦截空数据，防止 map 崩溃
    if (!promptOrMessages) {
      throw new Error(
        `[致命错误] ${purpose} 模块传给 generateText 的消息是空的 (undefined)`,
      );
    }

    const config = overrideConfig || getAnimaConfig().api[purpose];

    // 🟢 2. 打印看看当前到底读到了什么配置
    console.log(`[Anima Debug] 发起 ${purpose} 请求...`);
    console.log(`[Anima Debug] 读到的配置:`, redactApiConfig(config));

    if (!config) {
      throw new Error(`未配置 ${purpose.toUpperCase()} 的 API 设置`);
    }

    const { source, key, model, stream } = config;
    let { url } = config;
    if (key && /[^\x20-\x7E]/.test(key)) {
      throw new Error(
        "API Key 包含非法字符（如中文标点或全角空格），请重新检查！",
      );
    }
    if (url && /[^\x20-\x7E]/.test(url)) {
      throw new Error(
        "API URL 包含非法字符（如中文标点或全角空格），请重新检查！",
      );
    }
    // 获取高级参数 (赋予默认值以防万一)
    const temperature = Number(config.temperature ?? 1.0);
    const maxOutput = Number(config.max_output ?? 8192);

    // 🔥【关键修改 1】标准化数据格式
    // 无论传进来是字符串还是数组，统一转成数组处理
    let messages = [];
    if (typeof promptOrMessages === "string") {
      messages = [{ role: "user", content: promptOrMessages }];
    } else {
      messages = promptOrMessages; // 直接使用传入的数组
    }

    // ============================================================
    // 1. Google Gemini 处理逻辑
    // ============================================================
    if (source === "google") {
      let targetUrl;
      const headers = { "Content-Type": "application/json" };
      const isCustomUrl = url && !url.includes("googleapis.com");

      // 第一步：将所有角色映射为 user 或 model
      const rawGoogleContents = messages.map((msg) => {
        let gRole = "user";
        if (msg.role === "assistant") {
          gRole = "model"; // AI 回复映射为 model
        } else if (msg.role === "system") {
          gRole = "user"; // System 映射为 user
        } else {
          gRole = "user"; // User 保持 user
        }
        return {
          role: gRole,
          parts: [{ text: msg.content }],
        };
      });

      // 🔥【关键修改 2】第二步：强制合并相邻的同角色消息 (满足 Gemini 强制交替规则)
      const googleContents = [];
      rawGoogleContents.forEach((curr) => {
        if (
          googleContents.length > 0 &&
          googleContents[googleContents.length - 1].role === curr.role
        ) {
          // 如果当前角色和上一个角色相同，直接把文本用双换行拼接在一起
          googleContents[googleContents.length - 1].parts[0].text +=
            "\n\n" + curr.parts[0].text;
        } else {
          // 否则作为一个新的消息块推入数组
          googleContents.push(curr);
        }
      });

      // 构造请求体
      const requestBody = {
        contents: googleContents,
        safetySettings: [
          {
            category: "HARM_CATEGORY_HARASSMENT",
            threshold: "BLOCK_NONE",
          },
          {
            category: "HARM_CATEGORY_HATE_SPEECH",
            threshold: "BLOCK_NONE",
          },
          {
            category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
            threshold: "BLOCK_NONE",
          },
          {
            category: "HARM_CATEGORY_DANGEROUS_CONTENT",
            threshold: "BLOCK_NONE",
          },
          {
            category: "HARM_CATEGORY_CIVIC_INTEGRITY",
            threshold: "BLOCK_NONE",
          },
        ],
        generationConfig: {
          temperature: temperature, // ✅ 应用温度
          topP: 0.98,
          topK: 60,
          maxOutputTokens: maxOutput, // ✅ 应用最大输出
        },
      };

      // 确定 Endpoint：流式 vs 非流式
      const methodAction = stream ? "streamGenerateContent" : "generateContent";

      if (isCustomUrl) {
        let baseUrl = url.trim().replace(/\/+$/, "");
        if (
          !baseUrl.includes("/models") &&
          !baseUrl.includes("/generateContent")
        ) {
          baseUrl = `${baseUrl}/v1beta/models/${model}:${methodAction}`;
        } else {
          // 如果用户填了 ...:generateContent，我们尝试根据开关替换成 ...:streamGenerateContent
          if (stream)
            baseUrl = baseUrl.replace(
              ":generateContent",
              ":streamGenerateContent",
            );
          else
            baseUrl = baseUrl.replace(
              ":streamGenerateContent",
              ":generateContent",
            );
        }
        targetUrl = baseUrl;
        if (key) headers["Authorization"] = `Bearer ${key}`;
      } else {
        targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${methodAction}`;
        if (key) targetUrl += `?key=${encodeURIComponent(key)}`;
      }

      // 🔴 [DEBUG] 打印 Google 请求日志
      console.log(
        `[Anima Debug] Google Request:`,
        JSON.parse(
          JSON.stringify({ url: redactUrlSecrets(targetUrl), body: requestBody }),
        ),
      );

      try {
        throwIfAborted(signal);

        const response = await proxyFetch(targetUrl, {
          method: "POST",
          headers: headers,
          body: requestBody,
          isStream: stream,
          signal,
        });

        throwIfAborted(signal);

        if (!response.ok) {
          let rawError = response.statusText;
          try {
            // 兼容错误状态下的解析
            rawError = response.json
              ? await response.json()
              : await response.text();
          } catch (e) {}
          throw new Error(
            formatApiError(response.status, rawError, response.statusText),
          );
        }

        let text = "";

        if (!stream) {
          // 1. 非流式：直接调用 json()
          let data;
          try {
            throwIfAborted(signal);
            data = await response.json();
            throwIfAborted(signal);
          } catch (e) {
            if (e?.name === "AbortError") throw e;
            throw new Error("内容不完整或解析错误");
          }

          text = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) {
            text =
              data.choices?.[0]?.message?.content || data.choices?.[0]?.text;
          }
          if (!text) throw new Error("回复内容为空");
        } else {
          // 2. 流式：使用 Reader 消费流并按 SSE 格式 (Server-Sent Events) 解析
          const reader = response.body.getReader();
          const decoder = new TextDecoder("utf-8");
          let buffer = "";

          while (true) {
            throwIfAborted(signal);
            const { done, value } = await reader.read();
            throwIfAborted(signal);
            if (done) break;

            // 解码当前块并追加到缓冲区
            buffer += decoder.decode(value, { stream: true });

            // 按行分割处理，防止 JSON 被截断
            const lines = buffer.split("\n");
            // 弹出最后一行（可能是不完整的），留在 buffer 里等下一波数据拼接
            buffer = lines.pop();

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue; // 忽略空行

              // 检查是否是 SSE 格式的行
              if (trimmed.startsWith("data: ")) {
                const jsonStr = trimmed.slice(6); // 剥离 "data: "
                if (jsonStr === "[DONE]") continue; // 兼容部分网关会发出的结束符

                try {
                  const data = JSON.parse(jsonStr);

                  // 兼容可能被包成数组，也可能是单个对象的情况
                  if (Array.isArray(data)) {
                    data.forEach((chunk) => {
                      const chunkText =
                        chunk.candidates?.[0]?.content?.parts?.[0]?.text;
                      if (chunkText) text += chunkText;
                    });
                  } else {
                    const chunkText =
                      data.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (chunkText) text += chunkText;
                  }
                } catch (e) {
                  console.warn(
                    "[Anima Debug] 单行 JSON 解析失败:",
                    e,
                    "Line:",
                    trimmed,
                  );
                  throw new Error("内容不完整或解析错误");
                }
              }
              // 兼容非 SSE 格式（有些直连网关可能返回原生的数组流）
              else if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
                try {
                  const data = JSON.parse(trimmed);
                  const chunkText =
                    data.candidates?.[0]?.content?.parts?.[0]?.text;
                  if (chunkText) text += chunkText;
                } catch (e) {
                  throw new Error("内容不完整或解析错误");
                }
              }
            }
          }

          // 结束后，检查 buffer 中是否还有遗留的数据没处理
          const residual = buffer.trim();
          if (residual.startsWith("data: ")) {
            const jsonStr = residual.slice(6).trim();
            if (jsonStr === "[DONE]") {
              // 正常结束标记，不参与解析。
            } else if (jsonStr) {
              try {
                const data = JSON.parse(jsonStr);
                const chunkText =
                  data.candidates?.[0]?.content?.parts?.[0]?.text;
                if (chunkText) text += chunkText;
              } catch (e) {
                throw new Error("内容不完整或解析错误");
              }
            }
          } else if (residual.startsWith("[") || residual.startsWith("{")) {
            try {
              const data = JSON.parse(residual);
              const chunkText = data.candidates?.[0]?.content?.parts?.[0]?.text;
              if (chunkText) text += chunkText;
            } catch (e) {
              throw new Error("内容不完整或解析错误");
            }
          }
        }

        if (!text) throw new Error("回复内容为空");
        return text;
      } catch (error) {
        throw error;
      }
    }

    // ============================================================
    // 2. 通用/OpenAI Compatible (浏览器直连模式 - 彻底解决 Auth 问题)
    // ============================================================
    else {
      let conversationStarted = false;
      // 1. 消息格式清洗
      messages = messages.map((msg, index) => {
        if (msg.role === "user" || msg.role === "assistant") {
          conversationStarted = true;
        }
        if (msg.role === "system") {
          if (index > 0 || conversationStarted) {
            return { ...msg, role: "user" };
          }
        }
        return msg;
      });

      // 2. URL 构造
      // processApiUrl 会自动处理 /v1 后缀
      let targetUrl = processApiUrl(url, source);
      // 防御性清理：去掉末尾的 /chat/completions 或 /，我们下面手动加
      targetUrl = targetUrl
        .replace(/\/chat\/completions\/?$/, "")
        .replace(/\/+$/, "");

      const endpoint = `${targetUrl}/chat/completions`;

      // 3. 构造请求体
      const requestBody = {
        model: model,
        messages: messages,
        temperature: temperature,
        max_tokens: maxOutput, // OpenAI 标准参数
        top_p: 1,
        stream: !!stream, // 根据开关决定是否流式
      };

      // 4. 发起原生 Fetch 请求
      console.log(
        "[Anima Debug] Backend Proxy Fetch",
        { endpoint: redactUrlSecrets(endpoint), model },
      );

      try {
        throwIfAborted(signal);

        const providerHeaders = {
          "Content-Type": "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        };
        const response = await proxyFetch(endpoint, {
          method: "POST",
          headers: providerHeaders,
          body: requestBody,
          isStream: !!stream,
          signal,
        });

        throwIfAborted(signal);

        if (!response.ok) {
          const errText = await response.text();

          // 抛出带有状态码的错误，这样 toastr 就能显示 "401: Invalid Key"
          throw new Error(formatApiError(response.status, errText));
        }

        // ==========================================
        // 响应解析 (兼容流式和非流式)
        // ==========================================

        // A. 非流式
        if (!stream) {
          let data;
          try {
            throwIfAborted(signal);
            data = await response.json();
            throwIfAborted(signal);
          } catch (e) {
            if (e?.name === "AbortError") throw e;
            throw new Error("内容不完整或解析错误");
          }

          // 🔥【新增】优先检查厂商返回的错误信息
          // 很多中转站或 API 会返回 200 OK 但 body 里包含 error
          if (data.error) {
            console.error("[Anima] API Error Details:", data.error);
            const errorMsg = cleanErrorMessage(data.error);
            throw new Error(`API 业务错误: ${errorMsg}`);
          }

          const choice = data.choices?.[0];
          const message = choice?.message;

          // 优先取 content；如果为空，尝试取 reasoning_content（防止因 max_tokens 截断导致报错）；最后尝试 text
          const content =
            message?.content || message?.reasoning_content || choice?.text;

          // 🔥 2. HTTP 200 但内容为空的处理
          if (!content) {
            console.warn(
              "[Anima] Empty Content. Full Response:",
              JSON.stringify(data, null, 2),
            );

            // 交给调用方统一展示错误，避免同一个 API 错误弹出多次。
            throw new Error("回复内容为空");
          }
          return content;
        }

        // B. 流式解析 (SSE)
        // 即使是 summary 任务通常等待结果，我们也要正确消耗流
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let fullText = "";
        let buffer = "";

        while (true) {
          throwIfAborted(signal);
          const { done, value } = await reader.read();
          throwIfAborted(signal);
          if (done) break;

          // 解码当前块并追加到缓冲区
          buffer += decoder.decode(value, { stream: true });

          // 按行分割处理
          const lines = buffer.split("\n");
          // 数组最后一行可能不完整，留到下一次处理
          buffer = lines.pop();

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data: ")) {
              const jsonStr = trimmed.slice(6);
              if (jsonStr === "[DONE]") continue;
              try {
                const json = JSON.parse(jsonStr);
                const content =
                  json.choices?.[0]?.delta?.content ||
                  json.choices?.[0]?.text ||
                  json.content;
                if (content) fullText += content;
              } catch (e) {
                throw new Error("内容不完整或解析错误");
              }
            }
          }
        }

        const residual = buffer.trim();
        if (residual.startsWith("data: ")) {
          const jsonStr = residual.slice(6).trim();
          if (jsonStr && jsonStr !== "[DONE]") {
            try {
              const json = JSON.parse(jsonStr);
              const content =
                json.choices?.[0]?.delta?.content ||
                json.choices?.[0]?.text ||
                json.content;
              if (content) fullText += content;
            } catch (e) {
              throw new Error("内容不完整或解析错误");
            }
          }
        }

        if (!fullText) throw new Error("回复内容为空");
        return fullText;
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        console.error("[Anima] Direct API Error Details:", error);
        throw error;
      }
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      throw error;
    }

    // 🟢 3. 捕捉真正的错误原因并打印到 F12
    console.error(
      `[Anima 崩溃现场] generateText 在处理 ${purpose} 时炸了:`,
      error.message,
    );
    throw error; // 继续向上抛出
  }
}
