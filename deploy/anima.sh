#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"
DATA_DIR="${SCRIPT_DIR}/data"

die() {
    printf '[anima] ERROR: %s\n' "$*" >&2
    exit 1
}

usage() {
    cat <<'EOF'
Usage: deploy/anima.sh <command> [argument]

Commands:
  config                         Validate and print the Compose model
  build                          Build the image
  up                             Build and start the standalone service
  down                           Stop and remove the service (keeps data)
  restart                        Restart the service
  status                         Show Compose status
  logs [--tail=200]              Follow service logs
  health                         Check the local /healthz endpoint
  token-create <label>           Create one personal token; print it once
  token-list                     List token ids/labels/statuses, never raw tokens
  token-revoke-id <id>           Revoke one token by immutable id
  token-revoke-label <label>     Revoke one token by label if it is unique
  backup [archive.tar.gz]        Stop writes, archive deploy/data, restart if needed
  restore <archive.tar.gz>       Restore only with a literal --confirm flag
  serve                          Configure Tailscale Serve HTTPS to the local port
  serve-status                   Show Tailscale Serve configuration
  migration-check [source]       Read-only source inspection; never imports data
  help                           Show this help
EOF
}

if ! command -v docker >/dev/null 2>&1; then
    die "docker is not installed or not on PATH"
fi

DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then
    if command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
        DOCKER=(sudo docker)
    else
        die "Docker is not accessible; grant the current user Docker access or run with sudo"
    fi
fi

compose() {
    local env_args=()
    if [ -f "$SCRIPT_DIR/.env" ]; then
        env_args=(--env-file "$SCRIPT_DIR/.env")
    fi
    "${DOCKER[@]}" compose --project-directory "$REPO_DIR" "${env_args[@]}" -f "$COMPOSE_FILE" "$@"
}

configured_port() {
    if [ -n "${ANIMA_PORT:-}" ]; then
        printf '%s' "$ANIMA_PORT"
        return
    fi
    if [ -f "$SCRIPT_DIR/.env" ]; then
        local value
        value="$(sed -n 's/^[[:space:]]*ANIMA_PORT[[:space:]]*=[[:space:]]*\([0-9][0-9]*\)[[:space:]]*$/\1/p' "$SCRIPT_DIR/.env" | tail -n 1)"
        if [ -n "$value" ]; then
            printf '%s' "$value"
            return
        fi
    fi
    printf '18000'
}

require_env_for_runtime() {
    [ -f "$SCRIPT_DIR/.env" ] || die "missing deploy/.env; copy deploy/.env.example to deploy/.env and edit provider/CORS values"
    [ -f "$REPO_DIR/server/standalone.js" ] || die "server/standalone.js is missing; the old server/index.js is only a SillyTavern plugin entry point, so deployment is intentionally blocked"
}

running_container_id() {
    compose ps -q anima-remote 2>/dev/null | head -n 1
}

is_running() {
    local id
    id="$(running_container_id)"
    [ -n "$id" ] && [ "$("${DOCKER[@]}" inspect -f '{{.State.Running}}' "$id" 2>/dev/null || true)" = "true" ]
}

cmd="${1:-help}"
shift || true

case "$cmd" in
    config)
        compose config
        ;;
    build)
        require_env_for_runtime
        compose build
        ;;
    up)
        require_env_for_runtime
        mkdir -p "$DATA_DIR"
        chmod 700 "$DATA_DIR"
        compose up -d --build
        compose ps
        ;;
    down)
        compose down
        ;;
    restart)
        require_env_for_runtime
        compose restart anima-remote
        ;;
    status)
        compose ps
        ;;
    logs)
        compose logs "$@" anima-remote
        ;;
    health)
        port="$(configured_port)"
        curl --fail --silent --show-error "http://127.0.0.1:${port}/healthz"
        printf '\n'
        ;;
    token-create)
        label="${1:-}"
        [ -n "$label" ] || die "token-create requires a label"
        compose run --rm --no-deps --no-ports anima-remote node /app/deploy/token-cli.js create --label "$label"
        ;;
    token-list)
        compose run --rm --no-deps --no-ports anima-remote node /app/deploy/token-cli.js list
        ;;
    token-revoke-id)
        id="${1:-}"
        [ -n "$id" ] || die "token-revoke-id requires an id"
        compose run --rm --no-deps --no-ports anima-remote node /app/deploy/token-cli.js revoke --id "$id"
        ;;
    token-revoke-label)
        label="${1:-}"
        [ -n "$label" ] || die "token-revoke-label requires a label"
        compose run --rm --no-deps --no-ports anima-remote node /app/deploy/token-cli.js revoke --label "$label"
        ;;
    backup)
        mkdir -p "$SCRIPT_DIR/backups"
        archive="${1:-$SCRIPT_DIR/backups/anima-$(date -u +%Y%m%dT%H%M%SZ).tar.gz}"
        case "$archive" in
            "$DATA_DIR"/*) die "backup archive must not be written inside deploy/data" ;;
        esac
        [ ! -e "$archive" ] || die "refusing to overwrite existing archive: $archive"
        mkdir -p "$DATA_DIR"
        was_running=false
        if is_running; then
            was_running=true
            compose stop anima-remote
        fi
        cleanup() {
            if [ "$was_running" = true ]; then
                compose start anima-remote >/dev/null
            fi
        }
        trap cleanup EXIT
        umask 077
        tar --xattrs --acls -czf "$archive" -C "$SCRIPT_DIR" data
        sha256sum "$archive" | tee "${archive}.sha256"
        ;;
    restore)
        archive="${1:-}"
        confirm="${2:-}"
        [ -n "$archive" ] || die "restore requires an archive path"
        [ "$confirm" = "--confirm" ] || die "restore is destructive to the active data directory; add literal --confirm"
        [ -f "$archive" ] || die "archive does not exist: $archive"
        temp_dir="$(mktemp -d)"
        rollback_dir="$SCRIPT_DIR/data.pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"
        cleanup_restore() { rm -rf "$temp_dir"; }
        trap cleanup_restore EXIT
        tar --list --file "$archive" | awk 'BEGIN{bad=0} /^\// || /(^|\/)\.\.($|\/)/ {bad=1} END{exit bad}' || die "archive contains an unsafe absolute or parent-traversal path"
        tar --extract --file "$archive" --gzip --directory "$temp_dir"
        [ -d "$temp_dir/data" ] || die "archive must contain a top-level data/ directory"
        if is_running; then compose stop anima-remote; fi
        [ ! -e "$rollback_dir" ] || die "rollback directory already exists: $rollback_dir"
        if [ -e "$DATA_DIR" ]; then mv "$DATA_DIR" "$rollback_dir"; fi
        mv "$temp_dir/data" "$DATA_DIR"
        chmod 700 "$DATA_DIR"
        compose start anima-remote >/dev/null
        printf '[anima] restored data; previous data is recoverable at %s\n' "$rollback_dir"
        ;;
    serve)
        port="$(configured_port)"
        command -v tailscale >/dev/null 2>&1 || die "tailscale CLI is not installed"
        tailscale serve --bg --https=443 "http://127.0.0.1:${port}"
        tailscale serve status
        ;;
    serve-status)
        command -v tailscale >/dev/null 2>&1 || die "tailscale CLI is not installed"
        tailscale serve status
        ;;
    migration-check)
        source_dir="${1:-${ST_DOCKER_DIR:-}}"
        [ -n "$source_dir" ] || die "migration-check requires the existing SillyTavern docker directory as an argument or ST_DOCKER_DIR"
        plugin_dir="$source_dir/plugins/anima-rag"
        printf '[anima] read-only migration check for %s\n' "$plugin_dir"
        [ -d "$plugin_dir" ] || die "source plugin directory not found"
        printf '%s\n' '[anima] source exists; no files were copied or changed'
        find "$plugin_dir" -maxdepth 2 -type f -printf '%P\n' | sort | head -n 80
        if [ -f "$REPO_DIR/server/migrate.js" ] || [ -f "$REPO_DIR/server/bin/anima-migrate.js" ]; then
            printf '%s\n' '[anima] migration CLI candidate found; do not run it until its documented dry-run contract is reviewed'
        else
            printf '%s\n' '[anima] STATUS: 暂不迁移 — no migration CLI is present in this checkout'
        fi
        ;;
    help|--help|-h)
        usage
        ;;
    *)
        usage >&2
        die "unknown command: $cmd"
        ;;
esac
