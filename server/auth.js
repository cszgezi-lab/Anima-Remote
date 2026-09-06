const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_SCRYPT = Object.freeze({
    n: 16384,
    r: 8,
    p: 1,
    keyLength: 32,
});

function ensureParentDirectory(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function atomicWriteJson(filePath, value) {
    ensureParentDirectory(filePath);
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    const contents = `${JSON.stringify(value, null, 2)}\n`;
    try {
        fs.writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
        fs.chmodSync(temporaryPath, 0o600);
        fs.renameSync(temporaryPath, filePath);
        fs.chmodSync(filePath, 0o600);
    } finally {
        if (fs.existsSync(temporaryPath)) {
            fs.rmSync(temporaryPath, { force: true });
        }
    }
}

function validateLabel(label) {
    if (typeof label !== "string") {
        throw new TypeError("label must be a string");
    }
    const normalized = label.trim();
    if (!normalized || normalized.length > 64) {
        throw new TypeError("label must contain 1-64 characters");
    }
    if (normalized.includes("\0")) {
        throw new TypeError("label contains an invalid character");
    }
    return normalized;
}

function encodeHash(token, parameters = DEFAULT_SCRYPT) {
    const salt = crypto.randomBytes(16);
    const digest = crypto.scryptSync(token, salt, parameters.keyLength, {
        N: parameters.n,
        r: parameters.r,
        p: parameters.p,
        maxmem: 64 * 1024 * 1024,
    });
    return [
        "scrypt",
        parameters.n,
        parameters.r,
        parameters.p,
        salt.toString("base64url"),
        digest.toString("base64url"),
    ].join("$");
}

function verifyHash(token, encodedHash) {
    if (
        typeof token !== "string" ||
        typeof encodedHash !== "string" ||
        !encodedHash.startsWith("scrypt$")
    ) {
        return false;
    }

    const parts = encodedHash.split("$");
    if (parts.length !== 6) return false;

    // The encoded form is: scrypt$N$r$p$salt$digest.
    // The old destructuring skipped the algorithm field and therefore
    // compared against the literal string "scrypt" as a numeric cost.
    const [algorithm, nText, rText, pText, saltText, digestText] = parts;
    if (algorithm !== "scrypt") return false;

    const n = Number(nText);
    const r = Number(rText);
    const p = Number(pText);
    if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
        return false;
    }
    if (n < 1024 || r < 1 || p < 1 || n > 1_048_576) return false;

    try {
        const salt = Buffer.from(saltText, "base64url");
        const expected = Buffer.from(digestText, "base64url");
        if (salt.length < 8 || expected.length < 16) return false;

        const actual = crypto.scryptSync(token, salt, expected.length, {
            N: n,
            r,
            p,
            maxmem: 128 * 1024 * 1024,
        });
        return (
            actual.length === expected.length &&
            crypto.timingSafeEqual(actual, expected)
        );
    } catch {
        return false;
    }
}

function deriveTenantId(userId) {
    return `tenant_${crypto
        .createHash("sha256")
        .update(String(userId), "utf8")
        .digest("hex")
        .slice(0, 32)}`;
}

function tokenLookup(rawToken) {
    return crypto
        .createHash("sha256")
        .update(String(rawToken), "utf8")
        .digest("base64url");
}

function fileSignature(filePath) {
    try {
        const stat = fs.statSync(filePath, { bigint: true });
        return `${stat.mtimeNs}:${stat.size}`;
    } catch (error) {
        if (error?.code === "ENOENT") return "missing";
        throw error;
    }
}

class TokenStore {
    constructor(filePath, options = {}) {
        this.filePath = path.resolve(filePath);
        this.writeQueue = Promise.resolve();
        this.cachedDocument = null;
        this.cachedSignature = null;
        this.verifyToken = options.verifyToken || verifyHash;
    }

    _readFile() {
        const signature = fileSignature(this.filePath);
        if (this.cachedDocument && this.cachedSignature === signature) {
            return this.cachedDocument;
        }
        if (!fs.existsSync(this.filePath)) {
            const empty = { version: 1, users: [] };
            this.cachedDocument = empty;
            this.cachedSignature = "missing";
            return empty;
        }

        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
        } catch (error) {
            throw new Error(`token file is not valid JSON: ${error.message}`);
        }

        if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.users)) {
            throw new Error("token file has an unsupported format");
        }

        for (const user of parsed.users) {
            if (!user || typeof user !== "object") {
                throw new Error("token file contains an invalid user record");
            }
            if (Object.prototype.hasOwnProperty.call(user, "token")) {
                throw new Error(
                    "token file contains a raw token; remove it and recreate the record",
                );
            }
            if (
                typeof user.id !== "string" ||
                typeof user.label !== "string" ||
                typeof user.tokenHash !== "string"
            ) {
                throw new Error("token file contains an invalid user record");
            }
            if (
                user.tokenLookup !== undefined &&
                (typeof user.tokenLookup !== "string" ||
                    !/^[A-Za-z0-9_-]{43}$/.test(user.tokenLookup))
            ) {
                throw new Error("token file contains an invalid lookup fingerprint");
            }
        }

        this.cachedDocument = parsed;
        this.cachedSignature = signature;
        return parsed;
    }

    _writeFile(document) {
        atomicWriteJson(this.filePath, document);
        this.cachedDocument = document;
        this.cachedSignature = fileSignature(this.filePath);
    }

    async _withWriteLock(operation) {
        const previous = this.writeQueue;
        let current;
        current = previous
            .catch(() => {})
            .then(operation)
            .finally(() => {
                if (this.writeQueue === current) {
                    this.writeQueue = Promise.resolve();
                }
            });
        this.writeQueue = current;
        return current;
    }

    async create(label) {
        const normalizedLabel = validateLabel(label);
        return this._withWriteLock(() => {
            const document = structuredClone(this._readFile());
            const userId = crypto.randomUUID();
            const rawToken = `anima_${crypto.randomBytes(32).toString("base64url")}`;
            const createdAt = new Date().toISOString();
            document.users.push({
                id: userId,
                label: normalizedLabel,
                tokenHash: encodeHash(rawToken),
                tokenLookup: tokenLookup(rawToken),
                createdAt,
                revokedAt: null,
            });
            this._writeFile(document);
            return {
                id: userId,
                label: normalizedLabel,
                token: rawToken,
                createdAt,
            };
        });
    }

    list() {
        return this._readFile().users.map((user) => ({
            id: user.id,
            label: user.label,
            createdAt: user.createdAt,
            revokedAt: user.revokedAt || null,
            status: user.revokedAt ? "revoked" : "active",
        }));
    }

    async revoke({ id, label } = {}) {
        if ((id === undefined || id === null) && !label) {
            throw new TypeError("id or label is required");
        }
        return this._withWriteLock(() => {
            const document = structuredClone(this._readFile());
            const matches = document.users.filter((user) => {
                if (id !== undefined && id !== null) return user.id === String(id);
                return user.label === String(label).trim();
            });
            if (matches.length === 0) return null;
            if (matches.length > 1) {
                throw new Error("label matches multiple users; use id instead");
            }
            const user = matches[0];
            if (!user.revokedAt) {
                user.revokedAt = new Date().toISOString();
                this._writeFile(document);
            }
            return {
                id: user.id,
                label: user.label,
                revokedAt: user.revokedAt,
            };
        });
    }

    authenticate(rawToken) {
        if (typeof rawToken !== "string" || rawToken.length < 16 || rawToken.length > 4096) {
            return null;
        }

        const users = this._readFile().users;
        const lookup = tokenLookup(rawToken);
        // New records use a fast, one-way lookup fingerprint to select one
        // scrypt candidate. The high-entropy token is still verified with
        // scrypt before authentication succeeds. Records created by an older
        // preview without tokenLookup remain readable as a bounded fallback.
        const candidates = users.filter(
            (user) =>
                !user.revokedAt &&
                (user.tokenLookup === lookup || user.tokenLookup === undefined),
        );
        let matchedUser = null;
        for (const user of candidates) {
            if (this.verifyToken(rawToken, user.tokenHash) && !matchedUser) {
                matchedUser = user;
            }
        }

        if (!matchedUser) return null;
        return {
            id: matchedUser.id,
            label: matchedUser.label,
            tenantId: deriveTenantId(matchedUser.id),
        };
    }
}

module.exports = {
    TokenStore,
    deriveTenantId,
    encodeHash,
    tokenLookup,
    verifyHash,
};
