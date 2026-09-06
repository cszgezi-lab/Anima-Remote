/**
 * Shared Anima transport.
 *
 * The extension deliberately keeps the local SillyTavern route and the
 * remote API route behind this module.  Callers use logical endpoint names
 * such as `/query` or `/bm25/list`; they must not construct plugin URLs.
 */

const MODULE_NAME = "anima_memory_system";
const LOCAL_PLUGIN_PATH = "/api/plugins/anima-rag";
const REMOTE_ANIMA_PATH = "/v1/anima";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SYNC_DELAY_MS = 800;
const MAX_CONFLICTS = 10;

const SECRET_FIELD_NAMES = new Set([
  "key",
  "apikey",
  "token",
  "cookie",
  "password",
  "secret",
  "authorization",
  "credential",
  "credentials",
  "privatekey",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
]);

let fallbackTransportState = null;
let startupPromise = null;
let syncPromise = null;
let syncTimer = null;
let syncWaiters = [];
let syncListenersInstalled = false;

// SillyTavern exposes a debounced settings writer.  Wrapping it lets the
// remote client notice changes made by the original Anima panels without
// changing every individual save call in those panels.
const SYNC_WRAPPED_FLAG = "__animaRemoteSyncWrapped";
const ORIGINAL_SAVE_FIELD = "__animaOriginalSaveSettings";
const ORIGINAL_METADATA_SAVE_FIELD = "__animaOriginalSaveMetadata";

function getHost() {
  return typeof window !== "undefined" ? window : globalThis;
}

function getStContext() {
  const host = getHost();
  const st = host?.SillyTavern || globalThis.SillyTavern;
  if (!st || typeof st.getContext !== "function") return null;
  try {
    return st.getContext() || null;
  } catch (error) {
    return null;
  }
}

function cloneValue(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch (error) {
      // Fall through for objects containing browser-only values.
    }
  }

  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => cloneValue(item));

  const result = {};
  Object.entries(value).forEach(([key, item]) => {
    const cloned = cloneValue(item);
    if (cloned !== undefined) result[key] = cloned;
  });
  return result;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ensureRootSettings(context) {
  if (!context) return null;
  if (!context.extensionSettings || typeof context.extensionSettings !== "object") {
    context.extensionSettings = {};
  }
  if (!context.extensionSettings[MODULE_NAME]) {
    context.extensionSettings[MODULE_NAME] = {};
  }
  return context.extensionSettings[MODULE_NAME];
}

function randomDeviceId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch (error) {
    // Use the compatibility fallback below.
  }
  return `anima-device-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function ensureTransportState(context = getStContext()) {
  const root = ensureRootSettings(context);
  if (!root) {
    if (!fallbackTransportState) {
      fallbackTransportState = {
        mode: "local",
        baseUrl: "",
        token: "",
        timeoutMs: DEFAULT_TIMEOUT_MS,
        sync: { deviceId: randomDeviceId(), scopes: {}, conflicts: [] },
      };
    }
    return fallbackTransportState;
  }

  if (!root.transport || typeof root.transport !== "object") {
    root.transport = {};
  }
  const state = root.transport;
  if (state.mode !== "remote") state.mode = "local";
  if (typeof state.baseUrl !== "string") state.baseUrl = "";
  if (typeof state.token !== "string") state.token = "";
  if (!Number.isFinite(Number(state.timeoutMs)) || Number(state.timeoutMs) <= 0) {
    state.timeoutMs = DEFAULT_TIMEOUT_MS;
  }
  if (!state.sync || typeof state.sync !== "object") state.sync = {};
  if (!state.sync.deviceId) state.sync.deviceId = randomDeviceId();
  if (!state.sync.scopes || typeof state.sync.scopes !== "object") {
    state.sync.scopes = {};
  }
  if (!Array.isArray(state.sync.conflicts)) state.sync.conflicts = [];
  installSettingsSyncHook(context);
  return state;
}

function persistLocalSettings(context = getStContext()) {
  const save = context?.saveSettingsDebounced;
  const originalSave = save?.[ORIGINAL_SAVE_FIELD] || save;
  if (typeof originalSave === "function") {
    try {
      // Applying a remote document must not recursively schedule another
      // upload.  The wrapped function remains available to normal UI saves.
      originalSave.call(context);
    } catch (error) {
      // SillyTavern can be unavailable while the extension is booting.
    }
  }
}

function persistLocalMetadata(context = getStContext()) {
  const save = context?.saveMetadata;
  const originalSave = save?.[ORIGINAL_METADATA_SAVE_FIELD] || save;
  if (typeof originalSave !== "function") return;
  try {
    // Do not call the wrapped method while reconciling a remote document, or
    // the reconciliation itself would enqueue another upload.
    void originalSave.call(context);
  } catch (error) {
    // Metadata may not be writable while a chat is being switched.
  }
}

function installSettingsSyncHook(context) {
  const save = context?.saveSettingsDebounced;
  if (typeof save === "function" && !save[SYNC_WRAPPED_FLAG]) {
    const wrappedSave = function (...args) {
      const result = save.apply(this, args);
      const current = ensureTransportState(context);
      if (current.mode === "remote") {
        // The local debounced write happens first; the actual network upload
        // is deliberately delayed and deduplicated by scheduleAnimaSettingsSync.
        void scheduleAnimaSettingsSync({ reason: "settings_saved" }).catch(
          (error) => {
            console.warn(
              "[Anima] 设置异步同步失败:",
              error?.message || "未知错误",
            );
          },
        );
      }
      return result;
    };

    try {
      Object.defineProperty(wrappedSave, SYNC_WRAPPED_FLAG, { value: true });
      Object.defineProperty(wrappedSave, ORIGINAL_SAVE_FIELD, { value: save });
      context.saveSettingsDebounced = wrappedSave;
    } catch (error) {
      // Some hosts expose a non-writable context.  Explicit UI save paths still
      // call scheduleAnimaSettingsSync, so failure to install this convenience
      // hook must not prevent the extension from starting.
    }
  }

  const saveMetadata = context?.saveMetadata;
  if (typeof saveMetadata !== "function" || saveMetadata[SYNC_WRAPPED_FLAG]) {
    return;
  }

  const wrappedMetadataSave = function (...args) {
    const result = saveMetadata.apply(this, args);
    const current = ensureTransportState(context);
    if (current.mode === "remote") {
      void scheduleAnimaSettingsSync({ reason: "metadata_saved" }).catch(
        (error) => {
          console.warn(
            "[Anima] 聊天设置异步同步失败:",
            error?.message || "未知错误",
          );
        },
      );
    }
    return result;
  };

  try {
    Object.defineProperty(wrappedMetadataSave, SYNC_WRAPPED_FLAG, { value: true });
    Object.defineProperty(wrappedMetadataSave, ORIGINAL_METADATA_SAVE_FIELD, {
      value: saveMetadata,
    });
    context.saveMetadata = wrappedMetadataSave;
  } catch (error) {
    // See the saveSettingsDebounced fallback above.
  }
}

function reportBackgroundSyncError(error) {
  console.warn("[Anima] 设置异步同步失败:", error?.message || "未知错误");
}

/**
 * Subscribe to the stable host event emitter instead of mutating getContext().
 * TauriTavern returns a fresh context facade on every call, so replacing a
 * method on that facade does not intercept later saves.  SETTINGS_UPDATED
 * covers ordinary global saves; character/chat changes reconcile their own
 * scopes.  Delegated UI changes cover Anima chat-metadata controls that save
 * without a host-wide settings event.
 */
export function installAnimaSettingsSyncListeners() {
  if (syncListenersInstalled) return;
  const context = getStContext();
  const source = context?.eventSource;
  const events = context?.eventTypes || context?.event_types;

  const schedule = (reason, delayMs = DEFAULT_SYNC_DELAY_MS) => {
    if (getTransportConfig().mode !== "remote") return;
    void scheduleAnimaSettingsSync({ reason, delayMs }).catch(
      reportBackgroundSyncError,
    );
  };

  if (source?.on && events) {
    if (events.SETTINGS_UPDATED) {
      source.on(events.SETTINGS_UPDATED, () => schedule("settings_updated"));
    }
    if (events.CHARACTER_EDITED) {
      source.on(events.CHARACTER_EDITED, () => schedule("character_edited"));
    }
    if (events.CHAT_CHANGED) {
      source.on(events.CHAT_CHANGED, () => schedule("chat_changed", 100));
    }
  }

  if (typeof document !== "undefined") {
    const onUiChange = (event) => {
      const target = event.target;
      if (target?.closest?.("#anima-overlay")) schedule("anima_ui_changed");
    };
    document.addEventListener("change", onUiChange, true);
    document.addEventListener("click", onUiChange, true);
  }

  syncListenersInstalled = true;
}

function normalizedHostname(hostname) {
  return String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
}

export function isLocalhostHostname(hostname) {
  return new Set(["localhost", "127.0.0.1", "::1"]).has(
    normalizedHostname(hostname),
  );
}

/**
 * Return true only for HTTPS, or HTTP loopback URLs used by local tests.
 * In particular, private/Tailscale IPs are not treated as cleartext-safe.
 */
export function isAllowedRemoteUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return false;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.username || parsed.password) return false;
    if (parsed.protocol === "https:") return true;
    return parsed.protocol === "http:" && isLocalhostHostname(parsed.hostname);
  } catch (error) {
    return false;
  }
}

/**
 * Normalize the server URL entered by the user.  The UI accepts either the
 * server root or a previously pasted `/v1/anima` URL and stores only the
 * server base; the transport adds the API version and route exactly once.
 */
export function normalizeRemoteBaseUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new AnimaTransportError(
      "invalid_url",
      "远程模式需要填写服务器 URL",
      400,
    );
  }

  const trimmed = rawUrl.trim();
  if (!isAllowedRemoteUrl(trimmed)) {
    throw new AnimaTransportError(
      "insecure_url",
      "远程服务器必须使用 HTTPS；HTTP 仅允许 localhost、127.0.0.1 或 ::1 测试",
      400,
    );
  }

  const parsed = new URL(trimmed);
  parsed.search = "";
  parsed.hash = "";
  let pathname = parsed.pathname.replace(/\/+$/, "");
  pathname = pathname.replace(/\/v1\/anima$/i, "");
  pathname = pathname.replace(/\/v1$/i, "");
  parsed.pathname = pathname || "/";
  return parsed.toString().replace(/\/$/, "");
}

export function getTransportConfig() {
  const state = ensureTransportState();
  return {
    mode: state.mode === "remote" ? "remote" : "local",
    baseUrl: state.baseUrl || "",
    token: state.token || "",
    timeoutMs: Math.max(1, Number(state.timeoutMs) || DEFAULT_TIMEOUT_MS),
  };
}

export function saveTransportSettings(patch = {}, options = {}) {
  const context = getStContext();
  const state = ensureTransportState(context);
  const nextMode = patch.mode === "remote" ? "remote" : "local";
  let nextBaseUrl = patch.baseUrl ?? state.baseUrl ?? "";

  if (nextMode === "remote") {
    nextBaseUrl = normalizeRemoteBaseUrl(nextBaseUrl);
  } else if (typeof nextBaseUrl !== "string") {
    nextBaseUrl = "";
  } else {
    nextBaseUrl = nextBaseUrl.trim().replace(/\/+$/, "");
  }

  state.mode = nextMode;
  state.baseUrl = nextBaseUrl;
  if (Object.hasOwn(patch, "timeoutMs")) {
    const timeoutMs = Number(patch.timeoutMs);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) state.timeoutMs = timeoutMs;
  }
  if (Object.hasOwn(patch, "token")) {
    state.token = String(patch.token || "").trim();
  }
  if (options.clearToken === true) state.token = "";

  persistLocalSettings(context);
  return getTransportConfig();
}

function cleanEndpoint(endpoint) {
  const value = String(endpoint || "").trim();
  if (!value) throw new AnimaTransportError("invalid_endpoint", "缺少后端接口", 400);
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("//")) {
    throw new AnimaTransportError("invalid_endpoint", "接口必须是 Anima 逻辑路径", 400);
  }
  return value.replace(/^\/+/, "").replace(/\/{2,}/g, "/");
}

export function resolveAnimaUrl(endpoint, config = getTransportConfig()) {
  const clean = cleanEndpoint(endpoint);
  if (config.mode === "remote") {
    const base = normalizeRemoteBaseUrl(config.baseUrl);
    if (clean === "healthz") return `${base}/healthz`;
    if (clean === "me" || clean.startsWith("me/")) return `${base}/v1/${clean}`;
    if (clean === "settings" || clean.startsWith("settings/")) {
      return `${base}/v1/${clean}`;
    }
    return `${base}${REMOTE_ANIMA_PATH}/${clean}`;
  }
  return `${LOCAL_PLUGIN_PATH}/${clean}`;
}

function createAbortError(message = "请求已取消") {
  if (typeof DOMException !== "undefined") {
    return new DOMException(message, "AbortError");
  }
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function createTimeoutError(timeoutMs) {
  const error = new AnimaTransportError(
    "timeout",
    `Anima 请求超时（${Math.round(timeoutMs / 1000)} 秒）`,
    408,
  );
  error.isTimeout = true;
  return error;
}

function composeSignal(signal, timeoutMs) {
  if (typeof AbortController === "undefined") {
    return { signal, cleanup: () => {}, didTimeout: () => false };
  }

  const controller = new AbortController();
  let timedOut = false;
  let timer = null;
  const onAbort = () => {
    try {
      controller.abort(signal?.reason);
    } catch (error) {
      controller.abort();
    }
  };

  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        controller.abort(createTimeoutError(timeoutMs));
      } catch (error) {
        controller.abort();
      }
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    },
  };
}

function encodeBody(body) {
  if (body === undefined || body === null) return undefined;
  if (
    typeof body === "string" ||
    (typeof Blob !== "undefined" && body instanceof Blob) ||
    (typeof FormData !== "undefined" && body instanceof FormData)
  ) {
    return body;
  }
  return JSON.stringify(body);
}

function responseHeadersToObject(headers) {
  const result = {};
  if (!headers) return result;
  try {
    headers.forEach((value, key) => {
      result[key] = value;
    });
  } catch (error) {
    // jQuery responses do not always expose iterable headers.
  }
  return result;
}

function makeBufferedResponse(status, statusText, data, headers = {}) {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    statusText: statusText || "",
    headers,
    body: null,
    json: async () => {
      if (
        data &&
        typeof data === "object" &&
        !(typeof Blob !== "undefined" && data instanceof Blob)
      )
        return data;
      const text = typeof data === "string" ? data : JSON.stringify(data ?? null);
      return JSON.parse(text || "null");
    },
    text: async () => {
      if (typeof data === "string") return data;
      if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
      return data == null ? "" : JSON.stringify(data);
    },
    blob: async () => {
      if (typeof Blob !== "undefined" && data instanceof Blob) return data;
      return new Blob([typeof data === "string" ? data : JSON.stringify(data ?? "")]);
    },
    arrayBuffer: async () => {
      if (typeof Blob !== "undefined" && data instanceof Blob) return data.arrayBuffer();
      return new TextEncoder().encode(
        typeof data === "string" ? data : JSON.stringify(data ?? ""),
      ).buffer;
    },
  };
}

function makeStreamResponse(response, cleanup) {
  if (!response.body || typeof ReadableStream === "undefined") {
    cleanup();
    return response;
  }

  const reader = response.body.getReader();
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          cleanup();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        cleanup();
        controller.error(error);
      }
    },
    async cancel(reason) {
      cleanup();
      try {
        await reader.cancel(reason);
      } catch (error) {
        // The consumer has already cancelled the stream.
      }
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function fetchRemote(url, options, config) {
  const method = options.method || "GET";
  const headers = { ...(options.headers || {}) };
  const body = encodeBody(options.body);
  if (body !== undefined && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
    headers["Content-Type"] = "application/json";
  }
  if (!config.token && options.requireAuth !== false && !url.endsWith("/healthz")) {
    throw new AnimaTransportError("missing_token", "远程模式需要 Bearer token", 401);
  }
  if (config.token && options.requireAuth !== false) {
    headers.Authorization = `Bearer ${config.token}`;
  }

  const composed = composeSignal(options.signal, options.timeoutMs ?? config.timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: composed.signal,
    });
    if (options.isStream) return makeStreamResponse(response, composed.cleanup);

    const responseType = options.responseType || "json";
    let data;
    if (responseType === "blob") data = await response.blob();
    else if (responseType === "arrayBuffer") data = await response.arrayBuffer();
    else data = await response.text();
    composed.cleanup();
    return makeBufferedResponse(
      response.status,
      response.statusText,
      data,
      responseHeadersToObject(response.headers),
    );
  } catch (error) {
    composed.cleanup();
    if (composed.didTimeout() && !options.signal?.aborted) {
      throw createTimeoutError(options.timeoutMs ?? config.timeoutMs);
    }
    if (options.signal?.aborted) throw createAbortError();
    if (error instanceof AnimaTransportError) throw error;
    throw new AnimaTransportError(
      "network_error",
      "无法连接到 Anima 后端，请检查服务器 URL、网络和 TLS 配置",
      0,
      { endpoint: url },
    );
  }
}

function fetchLocalWithJquery(url, options, config) {
  const host = getHost();
  const jquery = host?.$ || globalThis.$;
  if (!jquery?.ajax) return fetchLocalWithFetch(url, options, config);

  const method = options.method || "GET";
  const headers = { ...(options.headers || {}) };
  const body = encodeBody(options.body);
  const request = {
    url,
    type: method,
    headers,
    timeout: options.timeoutMs ?? config.timeoutMs,
  };
  if (body !== undefined) {
    request.data = body;
    if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
      request.contentType = "application/json";
    }
  }
  if (options.responseType === "blob") request.xhrFields = { responseType: "blob" };

  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (callback) => {
      if (finished) return;
      finished = true;
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      if (finished) return;
      jqXHR?.abort?.();
      finish(() => reject(createAbortError()));
    };
    if (options.signal?.aborted) return reject(createAbortError());
    if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });

    const jqXHR = jquery.ajax({
      ...request,
      success(data, textStatus, xhr) {
        finish(() =>
          resolve(
            makeBufferedResponse(
              xhr?.status || 200,
              xhr?.statusText || textStatus,
              data,
            ),
          ),
        );
      },
      error(xhr, textStatus) {
        if (textStatus === "abort" || options.signal?.aborted) {
          finish(() => reject(createAbortError()));
          return;
        }
        if (textStatus === "timeout") {
          finish(() =>
            reject(createTimeoutError(options.timeoutMs ?? config.timeoutMs)),
          );
          return;
        }
        finish(() =>
          resolve(
            makeBufferedResponse(
              xhr?.status || 0,
              xhr?.statusText || textStatus,
              xhr?.response ?? xhr?.responseText ?? "",
            ),
          ),
        );
      },
    });
  });
}

async function fetchLocalWithFetch(url, options, config) {
  const headers = { ...(options.headers || {}) };
  const body = encodeBody(options.body);
  const composed = composeSignal(options.signal, options.timeoutMs ?? config.timeoutMs);
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers,
      body,
      signal: composed.signal,
    });
    if (options.isStream) return makeStreamResponse(response, composed.cleanup);
    const responseType = options.responseType || "json";
    const data =
      responseType === "blob"
        ? await response.blob()
        : responseType === "arrayBuffer"
          ? await response.arrayBuffer()
          : await response.text();
    composed.cleanup();
    return makeBufferedResponse(response.status, response.statusText, data);
  } catch (error) {
    composed.cleanup();
    if (composed.didTimeout() && !options.signal?.aborted) {
      throw createTimeoutError(options.timeoutMs ?? config.timeoutMs);
    }
    if (options.signal?.aborted) throw createAbortError();
    if (error instanceof AnimaTransportError) throw error;
    throw new AnimaTransportError("network_error", "无法连接到 Anima 后端", 0, {
      endpoint: url,
    });
  }
}

function fetchLocalStreamWithJquery(url, options, config) {
  const host = getHost();
  const jquery = host?.$ || globalThis.$;
  if (!jquery?.ajax || typeof ReadableStream === "undefined") {
    return fetchLocalWithFetch(url, options, config);
  }

  return new Promise((resolve, reject) => {
    let receivedLength = 0;
    let streamController;
    let responseResolved = false;
    let finished = false;
    let jqXHR;
    const stream = new ReadableStream({
      start(controller) {
        streamController = controller;
      },
    });
    const cleanup = () => {
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
    };
    const finish = (callback) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (callback) callback();
    };
    const onAbort = () => {
      if (finished) return;
      const abortError = createAbortError();
      jqXHR?.abort?.();
      if (!responseResolved) finish(() => reject(abortError));
      else {
        streamController?.error(abortError);
        finish();
      }
    };
    if (options.signal?.aborted) return reject(createAbortError());
    if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });

    const headers = { ...(options.headers || {}) };
    const body = encodeBody(options.body);
    jqXHR = jquery.ajax({
      url,
      type: options.method || "GET",
      headers,
      contentType: body === undefined ? undefined : "application/json",
      data: body,
      timeout: options.timeoutMs ?? config.timeoutMs,
      xhr() {
        const xhr = new XMLHttpRequest();
        xhr.addEventListener("readystatechange", () => {
          if (xhr.readyState === 2 && !responseResolved) {
            if (xhr.status >= 200 && xhr.status < 300) {
              responseResolved = true;
              resolve(new Response(stream, { status: xhr.status, statusText: xhr.statusText }));
            }
          }
        });
        xhr.addEventListener("progress", () => {
          if (xhr.status < 200 || xhr.status >= 300 || !streamController) return;
          const text = xhr.responseText.substring(receivedLength);
          receivedLength = xhr.responseText.length;
          if (text) streamController.enqueue(new TextEncoder().encode(text));
        });
        return xhr;
      },
      success() {
        streamController?.close();
        finish();
      },
      error(xhr, textStatus) {
        if (textStatus === "abort" || options.signal?.aborted) {
          onAbort();
          return;
        }
        if (textStatus === "timeout" && !responseResolved) {
          finish(() =>
            reject(createTimeoutError(options.timeoutMs ?? config.timeoutMs)),
          );
          return;
        }
        if (!responseResolved) {
          finish(() =>
            resolve(
              makeBufferedResponse(xhr?.status || 0, xhr?.statusText || textStatus, xhr?.responseText || ""),
            ),
          );
        } else {
          streamController?.error(new Error("Stream terminated early"));
          finish();
        }
      },
    });
  });
}

/**
 * Fetch one logical Anima endpoint.  The returned object follows the subset
 * of the Fetch Response API used by the existing extension.
 */
export async function fetchAnima(endpoint, options = {}) {
  const config = {
    ...getTransportConfig(),
    ...(options.transportConfig || {}),
  };
  if (config.mode === "remote") {
    config.baseUrl = normalizeRemoteBaseUrl(config.baseUrl);
  }
  const url = resolveAnimaUrl(endpoint, config);
  if (config.mode === "remote") return fetchRemote(url, options, config);
  if (options.isStream) return fetchLocalStreamWithJquery(url, options, config);
  return fetchLocalWithJquery(url, options, config);
}

function parseResponseText(text) {
  if (typeof text !== "string") return text;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    return text;
  }
}

export class AnimaTransportError extends Error {
  constructor(code, message, status = 0, details = undefined) {
    super(message || code || "Anima 请求失败");
    this.name = "AnimaTransportError";
    this.code = code || "transport_error";
    this.status = Number(status) || 0;
    this.details = details;
    this.retriable = this.status === 0 || this.status >= 500 || this.status === 408;
  }
}

async function errorFromResponse(response, endpoint) {
  let raw = "";
  try {
    raw = await response.text();
  } catch (error) {
    raw = response.statusText || "";
  }
  const parsed = parseResponseText(raw);
  const data = parsed && typeof parsed === "object" ? parsed : {};
  const errorValue = data.error;
  const code =
    (typeof errorValue === "string" ? errorValue : data.code) ||
    (response.status === 401 ? "unauthorized" : "request_failed");
  const message =
    data.message ||
    (typeof errorValue === "object" ? errorValue.message : errorValue) ||
    (typeof parsed === "string" ? parsed : response.statusText) ||
    `Anima 请求失败（${response.status || "网络错误"}）`;
  return new AnimaTransportError(code, String(message), response.status, {
    endpoint,
    response: data,
  });
}

/** Request JSON/text/blob data and throw one structured error shape. */
export async function requestAnima(endpoint, options = {}) {
  const response = await fetchAnima(endpoint, options);
  if (!response.ok) throw await errorFromResponse(response, endpoint);
  if (options.responseType === "response") return response;
  if (options.responseType === "blob") return response.blob();
  if (options.responseType === "arrayBuffer") return response.arrayBuffer();
  if (options.responseType === "text") return response.text();
  const text = await response.text();
  return parseResponseText(text);
}

function getAjaxResponseType(options) {
  const xhrResponseType = options?.xhrFields?.responseType;
  if (xhrResponseType === "blob") return "blob";
  if (xhrResponseType === "arraybuffer") return "arrayBuffer";
  if (options?.dataType === "blob") return "blob";
  if (options?.dataType === "arraybuffer") return "arrayBuffer";
  if (options?.dataType === "text") return "text";
  return "json";
}

function makeJqueryCompatibleError(error) {
  const responseData = error?.details?.response;
  let responseText = "";
  if (typeof responseData === "string") responseText = responseData;
  else if (responseData !== undefined) {
    try {
      responseText = JSON.stringify(responseData);
    } catch (serializationError) {
      responseText = "";
    }
  }

  return {
    status: Number(error?.status) || 0,
    statusText: error?.message || "请求失败",
    responseText,
    responseJSON:
      responseData && typeof responseData === "object" ? responseData : undefined,
    response: responseData,
  };
}

/**
 * Compatibility adapter for the original Anima modules.
 *
 * The business code can keep its small `await ajaxAnima({...})` shape and
 * callback handlers, while only this module knows whether the request is a
 * same-origin SillyTavern call or an authenticated remote call.  `url` is a
 * logical Anima route; absolute URLs and plugin prefixes are rejected by
 * fetchAnima/resolveAnimaUrl.
 */
export function ajaxAnima(options = {}) {
  const endpoint = options.url ?? options.endpoint;
  const method = options.method || options.type || "GET";
  const headers = { ...(options.headers || {}) };
  const contentType = options.contentType;
  if (
    contentType &&
    !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")
  ) {
    headers["Content-Type"] = contentType;
  }

  const responseType = getAjaxResponseType(options);
  const requestPromise = fetchAnima(endpoint, {
    method,
    headers,
    body: options.data ?? options.body,
    responseType,
    timeoutMs: options.timeout,
    signal: options.signal,
    isStream: options.isStream === true,
    transportConfig: options.transportConfig,
  })
    .then(async (response) => {
      if (!response.ok) throw await errorFromResponse(response, endpoint);

      let data;
      if (options.isStream === true || responseType === "response") {
        data = response;
      } else if (responseType === "blob") {
        data = await response.blob();
      } else if (responseType === "arrayBuffer") {
        data = await response.arrayBuffer();
      } else if (responseType === "text") {
        data = await response.text();
      } else {
        data = parseResponseText(await response.text());
      }

      if (typeof options.success === "function") {
        try {
          options.success(data, "success", response);
        } catch (callbackError) {
          console.error("[Anima] 后端成功回调失败:", callbackError);
        }
      }
      return data;
    })
    .catch((error) => {
      const jqError = makeJqueryCompatibleError(error);
      if (typeof options.error === "function") {
        try {
          options.error(jqError, error?.code || "error", error?.message || "");
        } catch (callbackError) {
          console.error("[Anima] 后端错误回调失败:", callbackError);
        }
      }
      throw error;
    });

  // Callback-style callers intentionally ignore the returned promise, as
  // they did with jQuery's jqXHR.  Mark the rejection handled in that case;
  // callers that await/catch the original promise still receive the error.
  if (typeof options.success === "function" || typeof options.error === "function") {
    void requestPromise.catch(() => {});
  }
  return requestPromise;
}

export async function testAnimaConnection(configOverride = {}) {
  const config = { ...getTransportConfig(), ...configOverride };
  if (config.mode === "remote") {
    if (!config.token) {
      throw new AnimaTransportError("missing_token", "请填写远程 Bearer token", 401);
    }
    const data = await requestAnima("me", {
      method: "GET",
      transportConfig: config,
      timeoutMs: config.timeoutMs,
    });
    return { ok: true, data };
  }

  const data = await requestAnima("list", {
    method: "GET",
    transportConfig: config,
    timeoutMs: config.timeoutMs,
  });
  return { ok: true, data };
}

function normalizedFieldName(fieldName) {
  return String(fieldName || "")
    .replace(/[\s_\-]/g, "")
    .toLowerCase();
}

function isSecretField(fieldName) {
  const normalized = normalizedFieldName(fieldName);
  if (SECRET_FIELD_NAMES.has(normalized)) return true;
  return (
    normalized.endsWith("apikey") ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("password") ||
    normalized.endsWith("cookie") ||
    normalized.endsWith("authorization")
  );
}

/**
 * Recursively remove provider credentials and transport secrets before a
 * settings document is sent to the remote settings API.
 */
export function sanitizeSettingsForSync(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSettingsForSync(item));
  }
  if (!isPlainObject(value)) return value;

  const result = {};
  Object.entries(value).forEach(([key, item]) => {
    if (isSecretField(key)) return;
    if (key === "transport") return;
    const sanitized = sanitizeSettingsForSync(item);
    if (sanitized !== undefined) result[key] = sanitized;
  });
  return result;
}

function stableValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function mergeSettingsScopes(globalSettings = {}, characterSettings = {}, chatSettings = {}) {
  const merge = (base, override) => {
    if (override === undefined) return cloneValue(base);
    if (Array.isArray(override)) return cloneValue(override);
    if (isPlainObject(override)) {
      const result = isPlainObject(base) ? cloneValue(base) : {};
      Object.entries(override).forEach(([key, value]) => {
        result[key] = merge(result[key], value);
      });
      return result;
    }
    return cloneValue(override);
  };

  return merge(merge(merge({}, globalSettings), characterSettings), chatSettings);
}

function getGlobalSyncValue(context) {
  const extensions = context?.extensionSettings || {};
  const value = {};
  ["anima_memory_system", "anima_bm25_system"].forEach((key) => {
    if (extensions[key] !== undefined) value[key] = cloneValue(extensions[key]);
  });
  return sanitizeSettingsForSync(value);
}

function getCharacterSyncValue(context) {
  const characterId = context?.characterId;
  if (characterId === undefined || characterId === null) return null;
  const extensions = context?.characters?.[characterId]?.data?.extensions || {};
  const value = {};
  Object.entries(extensions).forEach(([key, item]) => {
    if (key.toLowerCase().startsWith("anima_")) value[key] = cloneValue(item);
  });
  return sanitizeSettingsForSync(value);
}

function getChatSyncValue(context) {
  if (!context?.chatId || !context.chatMetadata) return null;
  const value = {};
  Object.entries(context.chatMetadata).forEach(([key, item]) => {
    if (key.toLowerCase().startsWith("anima_")) value[key] = cloneValue(item);
  });
  return sanitizeSettingsForSync(value);
}

function getCharacterScopeKey(context) {
  if (context?.groupId !== undefined && context?.groupId !== null) {
    return `group:${context.groupId}`;
  }
  const character = context?.characters?.[context?.characterId];
  const stableIdentity =
    character?.avatar ||
    character?.data?.avatar ||
    character?.data?.name ||
    character?.name;
  return stableIdentity
    ? `character:${String(stableIdentity)}`
    : `character-index:${String(context?.characterId)}`;
}

export function collectAnimaSettings(context = getStContext()) {
  const scopes = [
    { scope: "global", key: "default", value: getGlobalSyncValue(context) },
  ];
  const characterValue = getCharacterSyncValue(context);
  if (characterValue !== null) {
    scopes.push({ scope: "character", key: getCharacterScopeKey(context), value: characterValue });
  }
  const chatValue = getChatSyncValue(context);
  if (chatValue !== null) {
    scopes.push({
      scope: "chat",
      key: `${getCharacterScopeKey(context)}:chat:${String(context.chatId)}`,
      value: chatValue,
    });
  }
  return scopes;
}

function getScopeState(state, scope, key) {
  if (!state.sync.scopes[scope] || typeof state.sync.scopes[scope] !== "object") {
    state.sync.scopes[scope] = {};
  }
  if (!state.sync.scopes[scope][key] || typeof state.sync.scopes[scope][key] !== "object") {
    state.sync.scopes[scope][key] = {};
  }
  return state.sync.scopes[scope][key];
}

function hasMeaningfulValue(value) {
  return isPlainObject(value) && Object.keys(value).length > 0;
}

function preserveLocalSecrets(localValue, remoteValue) {
  if (remoteValue === undefined) return cloneValue(localValue);
  if (Array.isArray(remoteValue)) {
    return remoteValue.map((value, index) =>
      preserveLocalSecrets(localValue?.[index], value),
    );
  }
  if (isPlainObject(remoteValue)) {
    const result = {};
    Object.entries(remoteValue).forEach(([key, value]) => {
      if (key === "transport" || isSecretField(key)) {
        if (isPlainObject(localValue) && Object.hasOwn(localValue, key)) {
          result[key] = cloneValue(localValue[key]);
        }
        return;
      }
      result[key] = preserveLocalSecrets(localValue?.[key], value);
    });

    // Sanitization omits secret fields entirely.  Carry those local values
    // forward even when the remote document has no corresponding property;
    // ordinary non-secret fields intentionally do not get this treatment.
    if (isPlainObject(localValue)) {
      Object.entries(localValue).forEach(([key, value]) => {
        if (
          (key === "transport" || isSecretField(key)) &&
          !Object.hasOwn(result, key)
        ) {
          result[key] = cloneValue(value);
        }
      });
    }
    return result;
  }
  return cloneValue(remoteValue);
}

function assignInPlace(target, source, preserveKeys = []) {
  if (!isPlainObject(target) || !isPlainObject(source)) return source;
  const preserved = Object.fromEntries(
    preserveKeys
      .filter((key) => Object.hasOwn(target, key))
      .map((key) => [key, target[key]]),
  );
  Object.keys(target).forEach((key) => delete target[key]);
  Object.assign(target, source);
  Object.assign(target, preserved);
  return target;
}

function applyScopeValue(context, scope, value) {
  if (!context || !value || typeof value !== "object") return;
  if (scope === "global") {
    Object.entries(value).forEach(([key, item]) => {
      if (key === "transport") return;
      const current = context.extensionSettings?.[key];
      const merged = preserveLocalSecrets(current, item);
      // Keep the root object identity: the sync state points into the same
      // Anima settings object and must survive reconciliation of global data.
      context.extensionSettings[key] = assignInPlace(
        current,
        merged,
        key === MODULE_NAME ? ["transport"] : [],
      );
    });
    return;
  }

  if (scope === "character") {
    const character = context.characters?.[context.characterId];
    if (!character) return;
    if (!character.data) character.data = {};
    if (!character.data.extensions) character.data.extensions = {};
    Object.entries(value).forEach(([key, item]) => {
      character.data.extensions[key] = preserveLocalSecrets(
        character.data.extensions[key],
        item,
      );
    });
    return;
  }

  if (scope === "chat" && context.chatMetadata) {
    Object.entries(value).forEach(([key, item]) => {
      context.chatMetadata[key] = preserveLocalSecrets(context.chatMetadata[key], item);
    });
  }
}

function settingEndpoint(scope, key, suffix = "") {
  return `settings/${encodeURIComponent(scope)}/${encodeURIComponent(key)}${suffix}`;
}

async function readRemoteScope(scopeInfo, config) {
  try {
    return await requestAnima(settingEndpoint(scopeInfo.scope, scopeInfo.key), {
      method: "GET",
      transportConfig: config,
      timeoutMs: config.timeoutMs,
    });
  } catch (error) {
    if (error?.status === 404) return { revision: 0, value: {} };
    throw error;
  }
}

function recordConflict(state, scopeInfo, localValue, remoteDocument) {
  state.sync.conflicts.push({
    scope: scopeInfo.scope,
    key: scopeInfo.key,
    createdAt: new Date().toISOString(),
    localValue: sanitizeSettingsForSync(localValue),
    remoteValue: sanitizeSettingsForSync(remoteDocument?.value || {}),
    remoteRevision: Number(remoteDocument?.revision) || 0,
  });
  state.sync.conflicts = state.sync.conflicts.slice(-MAX_CONFLICTS);
}

async function pushScope(context, state, scopeInfo, config, remoteDocument, localChanged) {
  const entry = getScopeState(state, scopeInfo.scope, scopeInfo.key);
  const remoteRevision = Number(remoteDocument?.revision) || 0;
  const localRevision = Number(entry.revision) || 0;
  const remoteValue = sanitizeSettingsForSync(remoteDocument?.value || {});
  if (!localChanged) return false;

  if (remoteRevision > localRevision && entry.snapshot) {
    recordConflict(state, scopeInfo, scopeInfo.value, remoteDocument);
    applyScopeValue(context, scopeInfo.scope, remoteValue);
    entry.revision = remoteRevision;
    entry.snapshot = stableValue(remoteValue);
    entry.updatedAt = remoteDocument.updatedAt || new Date().toISOString();
    return true;
  }

  const baseRevision = remoteRevision;
  try {
    const saved = await requestAnima(settingEndpoint(scopeInfo.scope, scopeInfo.key), {
      method: "PUT",
      transportConfig: config,
      timeoutMs: config.timeoutMs,
      body: {
        baseRevision,
        deviceId: state.sync.deviceId,
        value: sanitizeSettingsForSync(scopeInfo.value),
      },
    });
    const value = sanitizeSettingsForSync(saved?.value || scopeInfo.value);
    applyScopeValue(context, scopeInfo.scope, value);
    entry.revision = Number(saved?.revision) || baseRevision + 1;
    entry.updatedAt = saved?.updatedAt || new Date().toISOString();
    entry.snapshot = stableValue(sanitizeSettingsForSync(scopeInfo.value));
    return true;
  } catch (error) {
    if (error?.status === 409) {
      const current = error.details?.response?.current || error.details?.current;
      recordConflict(state, scopeInfo, scopeInfo.value, current || {});
      const currentValue = sanitizeSettingsForSync(current?.value || {});
      if (current?.value) applyScopeValue(context, scopeInfo.scope, currentValue);
      entry.revision = Number(current?.revision) || remoteRevision;
      entry.updatedAt = current?.updatedAt || new Date().toISOString();
      entry.snapshot = stableValue(currentValue);
      return true;
    }
    throw error;
  }
}

async function syncScope(context, state, scopeInfo, config) {
  const entry = getScopeState(state, scopeInfo.scope, scopeInfo.key);
  const sanitizedLocal = sanitizeSettingsForSync(scopeInfo.value);
  const localSnapshot = stableValue(sanitizedLocal);
  const localChanged = entry.snapshot !== undefined && entry.snapshot !== localSnapshot;
  const remoteDocument = await readRemoteScope(scopeInfo, config);
  const remoteRevision = Number(remoteDocument?.revision) || 0;
  const localRevision = Number(entry.revision) || 0;
  const remoteValue = sanitizeSettingsForSync(remoteDocument?.value || {});

  if (localChanged) {
    return pushScope(context, state, { ...scopeInfo, value: sanitizedLocal }, config, remoteDocument, true);
  }

  if (remoteRevision > 0 && remoteRevision >= localRevision) {
    if (localChanged && entry.snapshot) {
      recordConflict(state, scopeInfo, sanitizedLocal, remoteDocument);
    }
    applyScopeValue(context, scopeInfo.scope, remoteValue);
    entry.revision = remoteRevision;
    entry.updatedAt = remoteDocument.updatedAt || new Date().toISOString();
    entry.snapshot = stableValue(remoteValue);
    return true;
  }

  if (remoteRevision === 0 && localRevision === 0 && hasMeaningfulValue(sanitizedLocal)) {
    return pushScope(context, state, { ...scopeInfo, value: sanitizedLocal }, config, remoteDocument, true);
  }

  entry.revision = remoteRevision || localRevision;
  entry.updatedAt = remoteDocument.updatedAt || entry.updatedAt || new Date().toISOString();
  entry.snapshot = stableValue(sanitizedLocal);
  return false;
}

export async function syncAnimaSettings(options = {}) {
  const config = { ...getTransportConfig(), ...(options.transportConfig || {}) };
  if (config.mode !== "remote") return { skipped: true, reason: "local_mode" };
  config.baseUrl = normalizeRemoteBaseUrl(config.baseUrl);
  if (!config.token) return { skipped: true, reason: "missing_token" };
  if (syncPromise) return syncPromise;

  const context = getStContext();
  const state = ensureTransportState(context);
  syncPromise = (async () => {
    const scopes = collectAnimaSettings(context);
    let changed = false;
    for (const scopeInfo of scopes) {
      try {
        const scopeChanged = await syncScope(context, state, scopeInfo, config);
        changed = changed || scopeChanged;
      } catch (error) {
        // A failed remote sync must not overwrite the local cached settings.
        console.warn(`[Anima] 设置同步失败 (${scopeInfo.scope})`, error?.message || "未知错误");
      }
    }
    if (changed) persistLocalSettings(context);
    return { skipped: false, scopes: scopes.length };
  })();

  try {
    return await syncPromise;
  } finally {
    syncPromise = null;
  }
}

export function scheduleAnimaSettingsSync(options = {}) {
  if (getTransportConfig().mode !== "remote") return Promise.resolve({ skipped: true });
  if (syncTimer) clearTimeout(syncTimer);
  const promise = new Promise((resolve, reject) => syncWaiters.push({ resolve, reject }));
  syncTimer = setTimeout(async () => {
    syncTimer = null;
    try {
      const result = await syncAnimaSettings(options);
      syncWaiters.splice(0).forEach(({ resolve }) => resolve(result));
    } catch (error) {
      syncWaiters.splice(0).forEach(({ reject }) => reject(error));
    }
  }, options.delayMs ?? DEFAULT_SYNC_DELAY_MS);
  return promise;
}

/** Initialize once per extension load and reconcile remote settings on startup. */
export function initAnimaTransport() {
  if (startupPromise) return startupPromise;
  installAnimaSettingsSyncListeners();
  startupPromise = syncAnimaSettings({ reason: "startup" }).catch((error) => {
    console.warn("[Anima] 远程设置同步未完成:", error?.message || "未知错误");
    return { skipped: true, reason: "sync_error" };
  });
  return startupPromise;
}
