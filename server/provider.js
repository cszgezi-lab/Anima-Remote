function normalizeProviderBaseUrl(rawUrl) {
    const value = String(rawUrl || "").trim().replace(/\/+$/, "");
    if (!value) return "";

    // A bare host (including host:port) uses the conventional OpenAI
    // compatible /v1 base. Explicit paths remain exactly as entered.
    if (/^https?:\/\/[^/]+$/i.test(value)) return `${value}/v1`;
    return value;
}

function createProviderHeaders(config, extra = {}) {
    const headers = { ...extra };
    const key = typeof config?.key === "string" ? config.key.trim() : "";
    if (key) headers.Authorization = `Bearer ${key}`;
    return headers;
}

module.exports = {
    createProviderHeaders,
    normalizeProviderBaseUrl,
};
