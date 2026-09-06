const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const cors = require("cors");

const animaPlugin = require("./index");
const {
    createTenantNamespace,
    isCollectionListPath,
    scopeRequestBody,
    unscopeResponse,
} = require("./namespace");
const { TokenStore } = require("./auth");
const {
    SettingsStore,
    sanitizeSecrets,
} = require("./settings_store");
const { createOutboundPolicy } = require("./outbound_policy");

const DEFAULT_PORT = 8890;
const DEFAULT_JSON_LIMIT = "10mb";

function parseList(value, fallback = []) {
    if (Array.isArray(value)) {
        return value.map((item) => String(item).trim()).filter(Boolean);
    }
    if (value === undefined || value === null || value === "") return fallback;
    return String(value)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

function resolveDataRoot(value) {
    return path.resolve(
        value || process.env.ANIMA_DATA_ROOT || path.join(__dirname, "data"),
    );
}

function ensureDataRoot(rootDirectory) {
    fs.mkdirSync(rootDirectory, { recursive: true, mode: 0o700 });
    try {
        fs.chmodSync(rootDirectory, 0o700);
    } catch {}
    return rootDirectory;
}

function configuredCorsOrigins(value) {
    return parseList(
        value ?? process.env.ANIMA_CORS_ORIGINS,
        ["*"],
    );
}

function createCorsMiddleware(origins) {
    const allowAll = origins.includes("*");
    return cors({
        origin(origin, callback) {
            // Non-browser clients do not send Origin. They still need the
            // normal bearer-token authentication below.
            if (!origin || allowAll || origins.includes(origin)) {
                callback(null, true);
                return;
            }
            callback(null, false);
        },
        credentials: false,
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: ["Authorization", "Content-Type"],
        exposedHeaders: ["Content-Disposition"],
        optionsSuccessStatus: 204,
    });
}

function bearerToken(req) {
    const header = req.get("authorization");
    if (typeof header !== "string") return null;
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : null;
}

function createAuthMiddleware(tokenStore) {
    return (req, res, next) => {
        const rawToken = bearerToken(req);
        const user = rawToken ? tokenStore.authenticate(rawToken) : null;
        if (!user) {
            res.set("WWW-Authenticate", "Bearer");
            res.status(401).json({
                error: "unauthorized",
                message: "a valid bearer token is required",
            });
            return;
        }
        req.animaUser = user;
        next();
    };
}

function createNamespaceMiddleware(outboundPolicy) {
    return (req, res, next) => {
        try {
            const namespace = createTenantNamespace(req.animaUser.tenantId);
            req.animaNamespace = namespace;
            req.animaOutboundPolicy = outboundPolicy;
            req.body = scopeRequestBody(req.body, namespace);

            const sendJson = res.json.bind(res);
            res.json = (payload) => {
                const requestPath = `${req.baseUrl || ""}${req.path || ""}`;
                return sendJson(
                    unscopeResponse(payload, namespace, "", {
                        collectionList: isCollectionListPath(requestPath),
                    }),
                );
            };
            next();
        } catch (error) {
            next(error);
        }
    };
}

function errorPayload(error) {
    const code = error?.code || "internal_error";
    const payload = {
        error: code,
        message: error?.message || "internal server error",
    };
    if (error?.current !== undefined) {
        payload.current = sanitizeSecrets(error.current);
    }
    return payload;
}

function sendRouteError(res, error) {
    const statusCode = Number.isInteger(error?.statusCode)
        ? error.statusCode
        : error?.type === "entity.too.large"
          ? 413
          : 500;
    if (res.headersSent) return;
    res.status(statusCode).json(errorPayload(error));
}

async function createApp(options = {}) {
    const dataRoot = ensureDataRoot(resolveDataRoot(options.dataRoot));
    const tokenStore =
        options.tokenStore || new TokenStore(path.join(dataRoot, "tokens.json"));
    const settingsStore =
        options.settingsStore ||
        new SettingsStore(path.join(dataRoot, "settings"), {
            historyLimit:
                options.settingsHistoryLimit === undefined
                    ? Number(process.env.ANIMA_HISTORY_LIMIT || 20)
                    : options.settingsHistoryLimit,
        });
    const outboundPolicy =
        options.outboundPolicy || createOutboundPolicy(options);

    const app = express();
    app.disable("x-powered-by");
    app.locals.anima = {
        dataRoot,
        tokenStore,
        settingsStore,
        outboundPolicy,
    };

    const corsMiddleware = createCorsMiddleware(
        configuredCorsOrigins(options.corsOrigins),
    );
    // CORS must run before authentication so browser preflight can complete
    // without a bearer token. It is not used as an authentication boundary.
    app.use(corsMiddleware);
    app.use(
        express.json({
            limit:
                options.jsonLimit ||
                process.env.ANIMA_JSON_LIMIT ||
                DEFAULT_JSON_LIMIT,
        }),
    );

    app.get("/healthz", (req, res) => {
        res.json({ ok: true });
    });

    const authenticate = createAuthMiddleware(tokenStore);
    app.get("/v1/me", authenticate, (req, res) => {
        res.json({
            apiVersion: "v1",
            user: {
                id: req.animaUser.id,
                label: req.animaUser.label,
            },
            capabilities: {
                anima: true,
                settings: true,
            },
        });
    });

    const settingsAuth = authenticate;
    app.get(
        "/v1/settings/:scope/:key/history",
        settingsAuth,
        async (req, res) => {
            try {
                res.json(
                    await settingsStore.history(
                        req.animaUser.tenantId,
                        req.params.scope,
                        req.params.key,
                    ),
                );
            } catch (error) {
                sendRouteError(res, error);
            }
        },
    );
    app.get(
        "/v1/settings/:scope/:key",
        settingsAuth,
        async (req, res) => {
            try {
                res.json(
                    await settingsStore.get(
                        req.animaUser.tenantId,
                        req.params.scope,
                        req.params.key,
                    ),
                );
            } catch (error) {
                sendRouteError(res, error);
            }
        },
    );
    app.put(
        "/v1/settings/:scope/:key",
        settingsAuth,
        async (req, res) => {
            try {
                res.json(
                    await settingsStore.put(
                        req.animaUser.tenantId,
                        req.params.scope,
                        req.params.key,
                        req.body,
                    ),
                );
            } catch (error) {
                sendRouteError(res, error);
            }
        },
    );

    const animaRouter = express.Router();
    await animaPlugin.init(animaRouter, { dataRoot });
    app.use(
        "/v1/anima",
        authenticate,
        createNamespaceMiddleware(outboundPolicy),
        animaRouter,
    );

    app.use((req, res) => {
        res.status(404).json({
            error: "not_found",
            message: "route not found",
        });
    });
    app.use((error, req, res, next) => {
        if (error?.type === "entity.too.large") {
            sendRouteError(res, error);
            return;
        }
        if (error?.statusCode) {
            sendRouteError(res, error);
            return;
        }
        console.error("[Anima Remote] request failed:", error);
        sendRouteError(res, error);
    });

    return {
        app,
        dataRoot,
        tokenStore,
        settingsStore,
        outboundPolicy,
    };
}

async function startServer(options = {}) {
    const runtime = await createApp(options);
    const port = Number(options.port ?? process.env.ANIMA_PORT ?? DEFAULT_PORT);
    const host = options.host || process.env.ANIMA_HOST || "127.0.0.1";
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error("ANIMA_PORT must be an integer between 0 and 65535");
    }

    const server = await new Promise((resolve, reject) => {
        const listener = runtime.app.listen(port, host);
        listener.once("listening", () => resolve(listener));
        listener.once("error", reject);
    });
    const address = server.address();
    console.log(
        `[Anima Remote] listening on ${host}:${typeof address === "object" ? address.port : port}`,
    );
    return { ...runtime, server };
}

if (require.main === module) {
    startServer().catch((error) => {
        console.error("[Anima Remote] failed to start:", error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    DEFAULT_PORT,
    createApp,
    createAuthMiddleware,
    createNamespaceMiddleware,
    parseList,
    resolveDataRoot,
    startServer,
};
