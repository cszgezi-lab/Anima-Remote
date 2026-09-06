const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const VALID_SCOPES = new Set(["global", "character", "chat"]);
const DEFAULT_HISTORY_LIMIT = 20;

function isSecretKey(key) {
    const normalized = String(key)
        .trim()
        .toLowerCase()
        .replace(/[-_\s]/g, "");
    if (!normalized) return false;

    return (
        normalized === "key" ||
        normalized === "apikey" ||
        normalized === "token" ||
        normalized === "accesstoken" ||
        normalized === "refreshtoken" ||
        normalized === "cookie" ||
        normalized === "password" ||
        normalized === "secret" ||
        normalized === "authorization" ||
        normalized === "credential" ||
        normalized === "credentials" ||
        normalized === "clientsecret" ||
        normalized === "privatekey" ||
        normalized.endsWith("apikey") ||
        normalized.endsWith("token") ||
        normalized.endsWith("secret") ||
        normalized.endsWith("password")
    );
}

function sanitizeSecrets(value) {
    if (Array.isArray(value)) return value.map((item) => sanitizeSecrets(item));
    if (!value || typeof value !== "object") return value;

    const result = {};
    for (const [key, child] of Object.entries(value)) {
        if (isSecretKey(key)) continue;
        result[key] = sanitizeSecrets(child);
    }
    return result;
}

function cloneJson(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function validateScope(scope) {
    if (!VALID_SCOPES.has(scope)) {
        const error = new Error("scope must be global, character, or chat");
        error.code = "invalid_scope";
        error.statusCode = 400;
        throw error;
    }
    return scope;
}

function validateKey(key) {
    if (typeof key !== "string" || !key.trim() || key.length > 512 || key.includes("\0")) {
        const error = new Error("settings key must contain 1-512 characters");
        error.code = "invalid_settings_key";
        error.statusCode = 400;
        throw error;
    }
    return key;
}

function validateDeviceId(deviceId) {
    if (deviceId === undefined || deviceId === null) return "unknown-device";
    if (typeof deviceId !== "string" || !deviceId.trim() || deviceId.length > 128) {
        const error = new Error("deviceId must contain 1-128 characters");
        error.code = "invalid_device_id";
        error.statusCode = 400;
        throw error;
    }
    return deviceId.trim();
}

function atomicWriteJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
        fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
        });
        fs.chmodSync(temporaryPath, 0o600);
        fs.renameSync(temporaryPath, filePath);
        fs.chmodSync(filePath, 0o600);
    } finally {
        if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
    }
}

class SettingsStore {
    constructor(rootDirectory, options = {}) {
        this.rootDirectory = path.resolve(rootDirectory);
        this.historyLimit = Number.isInteger(options.historyLimit)
            ? Math.max(0, options.historyLimit)
            : DEFAULT_HISTORY_LIMIT;
        this.locks = new Map();
    }

    _keyFile(tenantId, scope, key) {
        validateScope(scope);
        validateKey(key);
        if (typeof tenantId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(tenantId)) {
            throw new Error("invalid authenticated tenant id");
        }
        const encodedKey = Buffer.from(key, "utf8").toString("base64url");
        const scopeDirectory = path.join(this.rootDirectory, tenantId, scope);
        return {
            filePath: path.join(scopeDirectory, `${encodedKey}.json`),
            historyDirectory: path.join(scopeDirectory, `${encodedKey}.history`),
        };
    }

    _readDocument(filePath, scope, key) {
        if (!fs.existsSync(filePath)) {
            return {
                scope,
                key,
                revision: 0,
                updatedAt: null,
                deviceId: null,
                value: {},
            };
        }
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        } catch (error) {
            throw new Error(`settings document is not valid JSON: ${error.message}`);
        }
        return {
            scope,
            key,
            revision: Number.isInteger(parsed.revision) ? parsed.revision : 0,
            updatedAt: parsed.updatedAt || null,
            deviceId: parsed.deviceId || null,
            value: sanitizeSecrets(parsed.value || {}),
        };
    }

    async _withLock(lockKey, operation) {
        const previous = this.locks.get(lockKey) || Promise.resolve();
        let current;
        current = previous
            .catch(() => {})
            .then(operation)
            .finally(() => {
                if (this.locks.get(lockKey) === current) this.locks.delete(lockKey);
            });
        this.locks.set(lockKey, current);
        return current;
    }

    async get(tenantId, scope, key) {
        const paths = this._keyFile(tenantId, scope, key);
        return this._readDocument(paths.filePath, scope, key);
    }

    async put(tenantId, scope, key, payload = {}) {
        const paths = this._keyFile(tenantId, scope, key);
        const baseRevision = payload.baseRevision === undefined ? 0 : payload.baseRevision;
        if (!Number.isInteger(baseRevision) || baseRevision < 0) {
            const error = new Error("baseRevision must be a non-negative integer");
            error.code = "invalid_base_revision";
            error.statusCode = 400;
            throw error;
        }
        if (!Object.prototype.hasOwnProperty.call(payload, "value")) {
            const error = new Error("value is required");
            error.code = "value_required";
            error.statusCode = 400;
            throw error;
        }

        const deviceId = validateDeviceId(payload.deviceId);
        const lockKey = `${tenantId}/${scope}/${key}`;
        return this._withLock(lockKey, () => {
            const current = this._readDocument(paths.filePath, scope, key);
            if (baseRevision !== current.revision) {
                const error = new Error("settings revision is stale");
                error.code = "revision_conflict";
                error.statusCode = 409;
                error.current = current;
                throw error;
            }

            const sanitizedValue = sanitizeSecrets(cloneJson(payload.value));
            const next = {
                scope,
                key,
                revision: current.revision + 1,
                updatedAt: new Date().toISOString(),
                deviceId,
                value: sanitizedValue,
            };

            if (current.revision > 0 && this.historyLimit > 0) {
                atomicWriteJson(
                    path.join(paths.historyDirectory, `${current.revision}.json`),
                    current,
                );
            }
            atomicWriteJson(paths.filePath, next);
            this._trimHistory(paths.historyDirectory);
            return cloneJson(next);
        });
    }

    _trimHistory(historyDirectory) {
        if (!fs.existsSync(historyDirectory)) return;
        const files = fs
            .readdirSync(historyDirectory)
            .filter((file) => /^\d+\.json$/.test(file))
            .sort((a, b) => Number.parseInt(b) - Number.parseInt(a));
        for (const file of files.slice(this.historyLimit)) {
            fs.rmSync(path.join(historyDirectory, file), { force: true });
        }
    }

    async history(tenantId, scope, key) {
        const paths = this._keyFile(tenantId, scope, key);
        if (!fs.existsSync(paths.historyDirectory)) {
            return { scope, key, history: [] };
        }
        const items = fs
            .readdirSync(paths.historyDirectory)
            .filter((file) => /^\d+\.json$/.test(file))
            .sort((a, b) => Number.parseInt(b) - Number.parseInt(a))
            .slice(0, this.historyLimit)
            .map((file) => {
                const document = JSON.parse(
                    fs.readFileSync(path.join(paths.historyDirectory, file), "utf8"),
                );
                return {
                    scope,
                    key,
                    revision: document.revision,
                    updatedAt: document.updatedAt || null,
                    deviceId: document.deviceId || null,
                    value: sanitizeSecrets(document.value || {}),
                };
            });
        return { scope, key, history: items };
    }
}

module.exports = {
    DEFAULT_HISTORY_LIMIT,
    SettingsStore,
    isSecretKey,
    sanitizeSecrets,
    validateScope,
};
