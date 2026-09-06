const dnsModule = require("node:dns");
const dns = dnsModule.promises;
const net = require("node:net");
const { Agent } = require("undici");

const HOP_BY_HOP_HEADERS = new Set([
    "connection",
    "content-length",
    "expect",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
]);

class OutboundPolicyError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "OutboundPolicyError";
        this.code = code;
        this.statusCode = 403;
    }
}

function parseBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === "") return fallback;
    return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseList(value) {
    if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
    return String(value || "")
        .split(",")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
}

function ipv4ToNumber(address) {
    return address
        .split(".")
        .reduce((result, part) => (result * 256) + Number(part), 0) >>> 0;
}

function ipv6ToBigInt(address) {
    let normalized = String(address || "")
        .toLowerCase()
        .replace(/^\[|\]$/g, "");
    if (normalized.includes(".")) {
        const separator = normalized.lastIndexOf(":");
        const ipv4 = normalized.slice(separator + 1);
        const octets = ipv4.split(".").map((part) => Number(part));
        if (
            octets.length !== 4 ||
            octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
        ) {
            return null;
        }
        const high = ((octets[0] << 8) | octets[1]).toString(16);
        const low = ((octets[2] << 8) | octets[3]).toString(16);
        normalized = `${normalized.slice(0, separator)}:${high}:${low}`;
    }

    const halves = normalized.split("::");
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const zeroCount = 8 - left.length - right.length;
    if (halves.length === 2 && zeroCount < 1) return null;
    const groups = [
        ...left,
        ...(halves.length === 2 ? new Array(zeroCount).fill("0") : []),
        ...right,
    ];
    if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
        return null;
    }
    return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group}`), 0n);
}

function isPrivateIp(address) {
    const normalized = String(address || "").toLowerCase().replace(/^\[|\]$/g, "");
    const version = net.isIP(normalized);
    if (version === 4) {
        const value = ipv4ToNumber(normalized);
        const ranges = [
            [0x00000000, 0xff000000], // 0.0.0.0/8
            [0x0a000000, 0xff000000], // 10.0.0.0/8
            [0x64400000, 0xffc00000], // 100.64.0.0/10 (Tailnet/shared space)
            [0x7f000000, 0xff000000], // loopback
            [0xa9fe0000, 0xffff0000], // link-local
            [0xac100000, 0xfff00000], // 172.16.0.0/12
            [0xc0000000, 0xffffff00], // 192.0.0.0/24
            [0xc0000200, 0xffffff00], // TEST-NET-1
            [0xc0a80000, 0xffff0000], // 192.168.0.0/16
            [0xc6120000, 0xfffe0000], // 198.18.0.0/15
            [0xc6336400, 0xffffff00], // TEST-NET-2
            [0xcb007100, 0xffffff00], // TEST-NET-3
            [0xe0000000, 0xf0000000], // multicast/reserved
        ];
        // Bitwise operators return signed 32-bit integers in JavaScript.
        // Normalize the result back to unsigned so ranges above 127.0.0.0
        // (for example 192.168.0.0/16) cannot bypass this check.
        return ranges.some(
            ([network, mask]) => ((value & mask) >>> 0) === network,
        );
    }
    if (version === 6) {
        const numeric = ipv6ToBigInt(normalized);
        if (numeric === null) return true;

        const matches = (prefix, bits) => {
            const shift = 128n - BigInt(bits);
            return (numeric >> shift) === (prefix >> shift);
        };
        if (
            matches(0n, 128) ||
            matches(1n, 128) ||
            matches(0xfc000000000000000000000000000000n, 7) ||
            matches(0xfe800000000000000000000000000000n, 10) ||
            matches(0xff000000000000000000000000000000n, 8)
        ) {
            return true;
        }

        // IPv4-mapped IPv6 addresses must receive the same RFC1918 and
        // loopback treatment as their IPv4 representation.
        if (matches(0xffff00000000n, 96)) {
            const ipv4Value = Number(numeric & 0xffffffffn);
            const ipv4 = [
                (ipv4Value >>> 24) & 0xff,
                (ipv4Value >>> 16) & 0xff,
                (ipv4Value >>> 8) & 0xff,
                ipv4Value & 0xff,
            ].join(".");
            return isPrivateIp(ipv4);
        }
        return false;
    }
    return false;
}

function hostMatches(hostname, allowedHosts) {
    // Standalone mode is fail-closed: an operator must name every provider
    // host explicitly instead of accidentally exposing a general web proxy.
    if (!allowedHosts || allowedHosts.length === 0) return false;
    const host = hostname.toLowerCase().replace(/\.$/, "");
    return allowedHosts.some((pattern) => {
        const normalized = String(pattern).toLowerCase().replace(/\.$/, "");
        if (normalized === "*") return true;
        if (normalized.startsWith("*.")) {
            const suffix = normalized.slice(1);
            return host.endsWith(suffix) && host.length > suffix.length;
        }
        return host === normalized;
    });
}

function createOutboundPolicy(options = {}) {
    const requestedTimeout = Number(
        options.requestTimeoutMs ?? process.env.ANIMA_REQUEST_TIMEOUT_MS ?? 30_000,
    );
    return {
        allowedHosts: parseList(options.allowedHosts ?? process.env.ANIMA_OUTBOUND_ALLOWLIST),
        allowedProtocols: options.allowedProtocols ||
            (parseBoolean(options.allowHttp ?? process.env.ANIMA_OUTBOUND_ALLOW_HTTP)
                ? ["https:", "http:"]
                : ["https:"]),
        allowPrivate: parseBoolean(
            options.allowPrivate ?? process.env.ANIMA_OUTBOUND_ALLOW_PRIVATE,
        ),
        resolveDns: options.resolveDns !== undefined ? Boolean(options.resolveDns) : true,
        maxHeaderCount: Number(options.maxHeaderCount || 64),
        maxHeaderValueLength: Number(options.maxHeaderValueLength || 16_384),
        requestTimeoutMs:
            Number.isFinite(requestedTimeout) && requestedTimeout > 0
                ? Math.min(requestedTimeout, 120_000)
                : 30_000,
    };
}

function createSafeLookup(policy, resolver = dnsModule.lookup) {
    return (hostname, options, callback) => {
        resolver(hostname, { ...options, all: true, verbatim: true }, (error, records) => {
            if (error) return callback(error);
            const addresses = Array.isArray(records) ? records : [records];
            if (
                addresses.length === 0 ||
                (!policy.allowPrivate &&
                    addresses.some((entry) => isPrivateIp(entry?.address)))
            ) {
                const denied = new OutboundPolicyError(
                    "private_outbound_denied",
                    "connection-time DNS resolved to a private or reserved address",
                );
                return callback(denied);
            }

            if (options?.all) return callback(null, addresses);
            const selected = addresses.find(
                (entry) => !options?.family || entry.family === options.family,
            ) || addresses[0];
            return callback(null, selected.address, selected.family);
        });
    };
}

function getOutboundDispatcher(policy) {
    if (!policy) return undefined;
    if (policy.allowPrivate || policy.resolveDns === false) return undefined;
    if (!Object.prototype.hasOwnProperty.call(policy, "_safeDispatcher")) {
        Object.defineProperty(policy, "_safeDispatcher", {
            configurable: false,
            enumerable: false,
            writable: false,
            value: new Agent({ connect: { lookup: createSafeLookup(policy) } }),
        });
    }
    return policy._safeDispatcher;
}

async function validateOutboundTarget(targetUrl, policy = createOutboundPolicy()) {
    if (typeof targetUrl !== "string" || targetUrl.length === 0 || targetUrl.length > 2048) {
        throw new OutboundPolicyError("invalid_outbound_url", "targetUrl is invalid");
    }

    let parsed;
    try {
        parsed = new URL(targetUrl);
    } catch {
        throw new OutboundPolicyError("invalid_outbound_url", "targetUrl is not a valid URL");
    }

    if (!policy.allowedProtocols.includes(parsed.protocol)) {
        throw new OutboundPolicyError(
            "outbound_protocol_denied",
            `outbound protocol ${parsed.protocol} is not allowed`,
        );
    }
    if (parsed.username || parsed.password) {
        throw new OutboundPolicyError(
            "outbound_credentials_denied",
            "credentials in outbound URLs are not allowed",
        );
    }
    if (!parsed.hostname || !hostMatches(parsed.hostname, policy.allowedHosts)) {
        throw new OutboundPolicyError(
            "outbound_host_denied",
            "outbound hostname is not in the configured allowlist",
        );
    }

    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!policy.allowPrivate) {
        if (
            hostname === "localhost" ||
            hostname.endsWith(".localhost") ||
            hostname.endsWith(".local") ||
            hostname.endsWith(".internal") ||
            isPrivateIp(hostname)
        ) {
            throw new OutboundPolicyError(
                "private_outbound_denied",
                "private, loopback, link-local, and internal targets are not allowed",
            );
        }

        if (policy.resolveDns && net.isIP(hostname) === 0) {
            let addresses;
            try {
                addresses = await dns.lookup(hostname, { all: true, verbatim: true });
            } catch {
                throw new OutboundPolicyError(
                    "outbound_dns_failed",
                    "outbound hostname could not be resolved",
                );
            }
            if (!addresses.length || addresses.some((entry) => isPrivateIp(entry.address))) {
                throw new OutboundPolicyError(
                    "private_outbound_denied",
                    "outbound hostname resolves to a private or reserved address",
                );
            }
        }
    }
    return parsed;
}

function sanitizeProxyHeaders(input, policy = createOutboundPolicy()) {
    if (input === undefined || input === null) return {};
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new OutboundPolicyError("invalid_proxy_headers", "headers must be an object");
    }

    const entries = Object.entries(input);
    if (entries.length > policy.maxHeaderCount) {
        throw new OutboundPolicyError("proxy_headers_too_many", "too many proxy headers");
    }

    const headers = {};
    for (const [name, value] of entries) {
        const normalizedName = String(name).toLowerCase();
        if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(normalizedName)) {
            throw new OutboundPolicyError("invalid_proxy_header", "proxy header name is invalid");
        }
        if (HOP_BY_HOP_HEADERS.has(normalizedName) || normalizedName.startsWith("proxy-")) {
            continue;
        }
        const normalizedValue = Array.isArray(value) ? value.join(", ") : String(value);
        if (normalizedValue.length > policy.maxHeaderValueLength || /[\r\n]/.test(normalizedValue)) {
            throw new OutboundPolicyError("invalid_proxy_header", "proxy header value is invalid");
        }
        headers[normalizedName] = normalizedValue;
    }
    return headers;
}

function redactOutboundUrl(targetUrl) {
    try {
        const parsed = new URL(targetUrl);
        parsed.username = "";
        parsed.password = "";
        parsed.search = parsed.search ? "?…" : "";
        parsed.hash = "";
        return parsed.toString();
    } catch {
        return "[invalid-url]";
    }
}

module.exports = {
    OutboundPolicyError,
    createSafeLookup,
    createOutboundPolicy,
    getOutboundDispatcher,
    isPrivateIp,
    redactOutboundUrl,
    sanitizeProxyHeaders,
    validateOutboundTarget,
};
