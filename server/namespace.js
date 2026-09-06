const crypto = require("node:crypto");

const MAX_LOGICAL_ID_LENGTH = 256;
const MAX_ID_LIST_LENGTH = 256;
const PHYSICAL_ID_MARKER = "id_";
const ID_KEYS = new Set([
    "collectionId",
    "collectionIds",
    "sessionId",
    "libName",
    "sourceIds",
    "targetId",
    "dbId",
    "current_session_id",
]);
const CONTEXT_ID_KEYS = new Set(["chatContext", "kbContext"]);
const RESPONSE_ID_KEYS = new Set([
    "collectionId",
    "requestedCollectionId",
    "targetId",
    "libName",
    "dbId",
    "sessionId",
    "current_session_id",
    "source",
    "_source_collection",
    "_source_db",
]);

class NamespaceError extends Error {
    constructor(message, code = "invalid_namespace_input") {
        super(message);
        this.name = "NamespaceError";
        this.code = code;
        this.statusCode = 400;
    }
}

function createTenantNamespace(tenantId) {
    if (typeof tenantId !== "string" || !tenantId) {
        throw new NamespaceError("authenticated tenant is missing", "tenant_missing");
    }

    const opaquePart = crypto
        .createHash("sha256")
        .update(tenantId, "utf8")
        .digest("hex")
        .slice(0, 32);
    const prefix = `tenant_${opaquePart}__`;

    const encodeLogicalId = (logicalId) =>
        Buffer.from(logicalId, "utf8").toString("base64url");

    const decodePhysicalId = (physicalId) => {
        if (
            typeof physicalId !== "string" ||
            !physicalId.startsWith(`${prefix}${PHYSICAL_ID_MARKER}`)
        ) {
            return null;
        }

        const encoded = physicalId.slice(
            prefix.length + PHYSICAL_ID_MARKER.length,
        );
        if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;

        try {
            const decoded = Buffer.from(encoded, "base64url").toString("utf8");
            // Buffer.from is deliberately permissive. Re-encoding prevents
            // alternate spellings from becoming a second representation.
            if (encodeLogicalId(decoded) !== encoded) return null;
            return decoded;
        } catch {
            return null;
        }
    };

    const scopeId = (value) => {
        if (typeof value !== "string" && typeof value !== "number") {
            throw new NamespaceError("identifier must be a string or number");
        }
        const logical = String(value);
        if (!logical.trim() || logical.length > MAX_LOGICAL_ID_LENGTH) {
            throw new NamespaceError(
                `identifier must contain 1-${MAX_LOGICAL_ID_LENGTH} characters`,
            );
        }
        if (logical.includes("\0")) {
            throw new NamespaceError("identifier contains an invalid character");
        }

        return `${prefix}${PHYSICAL_ID_MARKER}${encodeLogicalId(logical)}`;
    };

    const isOwnedPhysicalId = (value) => decodePhysicalId(value) !== null;

    const stripId = (value) =>
        isOwnedPhysicalId(value) ? decodePhysicalId(value) : value;

    const scopeIdList = (value) => {
        if (!Array.isArray(value)) {
            throw new NamespaceError("identifier list must be an array");
        }
        if (value.length > MAX_ID_LIST_LENGTH) {
            throw new NamespaceError(
                `identifier list cannot contain more than ${MAX_ID_LIST_LENGTH} items`,
            );
        }
        return value.map((item) => scopeId(item));
    };

    return {
        tenantId,
        prefix,
        decodePhysicalId,
        encodeLogicalId,
        scopeId,
        scopeIdList,
        isOwnedPhysicalId,
        stripId,
    };
}

function scopeRequestBody(value, namespace, parentKey = "") {
    if (!namespace || value === null || value === undefined) return value;

    if (Array.isArray(value)) {
        if (ID_KEYS.has(parentKey) || parentKey === "ids") {
            return namespace.scopeIdList(value);
        }
        return value.map((item) => scopeRequestBody(item, namespace, parentKey));
    }

    if (typeof value !== "object") return value;

    const result = {};
    for (const [key, child] of Object.entries(value)) {
        // The authenticated token is the sole source of tenant identity. The
        // client field is intentionally ignored, including nested copies.
        if (key === "tenantId") continue;

        if (ID_KEYS.has(key)) {
            result[key] = Array.isArray(child)
                ? namespace.scopeIdList(child)
                : child === null || child === undefined
                  ? child
                  : namespace.scopeId(child);
            continue;
        }

        if (key === "ids" && CONTEXT_ID_KEYS.has(parentKey)) {
            result[key] = Array.isArray(child)
                ? namespace.scopeIdList(child)
                : child;
            continue;
        }

        result[key] = scopeRequestBody(child, namespace, key);
    }
    return result;
}

function isCollectionListPath(pathname) {
    const normalized = String(pathname || "").split("?", 1)[0].replace(/\/$/, "");
    return normalized === "/v1/anima/list" || normalized === "/v1/anima/bm25/list";
}

function unscopeResponse(value, namespace, key = "", options = {}) {
    if (!namespace || value === null || value === undefined) return value;

    if (Array.isArray(value)) {
        if (options.collectionList) {
            return value
                .filter((item) => namespace.isOwnedPhysicalId(item))
                .map((item) => namespace.stripId(item));
        }
        if (key === "collectionIds" || key === "sourceIds") {
            return value
                .filter((item) => namespace.isOwnedPhysicalId(item))
                .map((item) => namespace.stripId(item));
        }
        return value.map((item) => unscopeResponse(item, namespace, key, options));
    }

    if (typeof value !== "object") {
        if (RESPONSE_ID_KEYS.has(key)) return namespace.stripId(value);
        return value;
    }

    const result = {};
    for (const [childKey, child] of Object.entries(value)) {
        if (RESPONSE_ID_KEYS.has(childKey)) {
            if (Array.isArray(child)) {
                result[childKey] = child
                    .filter((item) => namespace.isOwnedPhysicalId(item))
                    .map((item) => namespace.stripId(item));
            } else {
                result[childKey] = namespace.stripId(child);
            }
        } else {
            result[childKey] = unscopeResponse(child, namespace, childKey, options);
        }
    }
    return result;
}

module.exports = {
    CONTEXT_ID_KEYS,
    ID_KEYS,
    MAX_ID_LIST_LENGTH,
    MAX_LOGICAL_ID_LENGTH,
    NamespaceError,
    createTenantNamespace,
    isCollectionListPath,
    scopeRequestBody,
    unscopeResponse,
};
