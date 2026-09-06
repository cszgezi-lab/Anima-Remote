function normalizeProviderBaseUrl(rawUrl) {
    const value = String(rawUrl || "").trim().replace(/\/+$/, "");
    if (!value) return "";

    // The configured path is authoritative. Some providers use /v1 while
    // others expose /embeddings or another API directly at the host root.
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
