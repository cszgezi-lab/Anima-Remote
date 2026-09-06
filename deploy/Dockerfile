FROM node:24.18.0-bookworm-slim

LABEL org.opencontainers.image.title="Anima Remote" \
      org.opencontainers.image.description="Private, authenticated Anima RAG service for TauriTavern" \
      org.opencontainers.image.source="https://example.invalid/anima-remote"

ENV NODE_ENV=production \
    ANIMA_HOST=0.0.0.0 \
    ANIMA_PORT=8000 \
    ANIMA_DATA_ROOT=/var/lib/anima \
    ANIMA_JSON_LIMIT=10mb \
    ANIMA_HEALTH_TIMEOUT_MS=4000

WORKDIR /app

# Install only the server runtime dependencies.  The source tree is copied
# after npm ci so ordinary source changes do not invalidate the dependency
# layer during development.
COPY server/package.json server/package-lock.json /app/server/
COPY server/patches /app/server/patches
RUN cd /app/server \
    && npm ci --omit=dev --ignore-scripts \
    && npx --no-install patch-package \
    && node -e "const fs=require('node:fs'); const p='node_modules/vectra/lib/ItemSelector.js'; const s=fs.readFileSync(p,'utf8'); if (!s.includes('Array.isArray(value)') || !s.includes('String(excluded) === String(item)')) { throw new Error('vectra patch verification failed'); }" \
    && npm cache clean --force

COPY --chown=10001:10001 server /app/server
COPY --chown=10001:10001 deploy/container-entrypoint.sh /usr/local/bin/anima-entrypoint
COPY --chown=10001:10001 deploy/healthcheck /usr/local/bin/anima-healthcheck
COPY --chown=10001:10001 deploy/token-cli.js /app/deploy/token-cli.js

RUN groupadd --gid 10001 anima \
    && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/anima --shell /usr/sbin/nologin anima \
    && mkdir -p /app/server/data/bm25_indexes /var/lib/anima \
    && chown -R 10001:10001 /app /var/lib/anima /home/anima \
    && chmod 0755 /usr/local/bin/anima-entrypoint /usr/local/bin/anima-healthcheck

USER 10001:10001

# The application listens on the container interface.  The host-side
# published address is constrained by ANIMA_BIND_IP in docker-compose.yml.
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "/usr/local/bin/anima-healthcheck"]

# Do not silently fall back to the SillyTavern plugin entry point.  The
# standalone authenticated runner is a deliberate prerequisite for this
# image; the entrypoint exits clearly if it has not been supplied yet.
ENTRYPOINT ["/usr/local/bin/anima-entrypoint"]
CMD ["node", "/app/server/standalone.js"]
