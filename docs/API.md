# Remote API contract v1

The client stores an HTTPS base URL such as `https://anima-host.example-tailnet.ts.net`. Except for the liveness endpoint, every request carries:

```http
Authorization: Bearer <user-token>
Content-Type: application/json
```

The server derives the tenant from the bearer token. A tenant identifier supplied by a client is ignored or rejected.

Android production builds must not depend on cleartext HTTP. A private deployment should terminate TLS with Tailscale Serve or another explicitly configured HTTPS reverse proxy while keeping the application port private.

## Service endpoints

### `GET /healthz`

Unauthenticated container liveness. Returns `{ "ok": true }` without user or storage details.

### `GET /v1/me`

Authenticated connection test. Returns the API version, capabilities, and a non-secret user label.

## Anima compatibility endpoints

All upstream Anima backend endpoints are mounted below:

```text
/v1/anima
```

Examples:

```text
POST /v1/anima/insert
POST /v1/anima/query
POST /v1/anima/delete
POST /v1/anima/proxy/forward
GET  /v1/anima/list
GET  /v1/anima/bm25/list
```

The client sends upstream logical `collectionId`, `collectionIds`, `sessionId`, and library names. The server maps these to tenant-prefixed physical names before invoking upstream code and removes only its own tenant prefix from responses. Cross-tenant names are rejected.

## Settings endpoints

Scopes are `global`, `character`, and `chat`. Keys are URL-encoded opaque client identities. The canonical global key is `default`.

### `GET /v1/settings/:scope/:key`

Returns:

```json
{
  "scope": "global",
  "key": "default",
  "revision": 3,
  "updatedAt": "2026-09-06T00:00:00.000Z",
  "deviceId": "android-example",
  "value": {}
}
```

Missing documents return revision `0` and an empty value.

### `PUT /v1/settings/:scope/:key`

Request:

```json
{
  "baseRevision": 3,
  "deviceId": "android-example",
  "value": {}
}
```

Success increments the revision. A stale `baseRevision` returns HTTP 409 with:

```json
{
  "error": "revision_conflict",
  "current": {}
}
```

The server stores bounded history before replacing a document. Keys named `key`, `apiKey`, `token`, `cookie`, `password`, `secret`, or equivalent case-insensitive variants are removed recursively from synchronized values.

### `GET /v1/settings/:scope/:key/history`

Returns bounded non-secret previous versions for recovery.

## Error contract

Errors are JSON:

```json
{
  "error": "stable_machine_code",
  "message": "human-readable detail"
}
```

The server uses 400 for invalid input, 401 for missing/invalid tokens, 403 for policy violations, 404 for missing routes/resources, 409 for revision conflicts, 413 for payload limits, 429 for rate limiting, and 5xx for server/upstream failures.
