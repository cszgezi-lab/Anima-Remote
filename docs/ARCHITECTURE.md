# Architecture

## Product contract

The normal user flow is:

1. Install TavernHelper in TauriTavern.
2. Install this repository URL from TauriTavern's extension manager; the root manifest loads `extension/`.
3. Enter a server URL and one user token once.
4. Use the existing Anima panels and automation without manual memory maintenance.

The extension must retain the upstream Anima UI. Remote-specific controls belong in one small connection section and must not replace the existing API, summary, RAG, BM25, knowledge, or state panels.

## Runtime split

### TauriTavern extension

- Owns UI, chat events, prompt construction, worldbook writes, character overrides, chat metadata, and status rendering.
- Uses a single transport abstraction for all Anima backend requests.
- Keeps a local cached copy of non-secret settings for instant startup and offline tolerance.
- Pushes changed settings to the server and reconciles newer remote revisions on startup.

### Remote server

- Authenticates every request with a per-user bearer token.
- Derives an opaque tenant id from the token and prefixes every vector, BM25, session, job, and settings key.
- Runs the existing Anima RAG algorithms and upstream API proxy behavior.
- Stores versioned non-secret settings.
- Never returns provider secrets to a client.

## Settings scopes and precedence

The existing Anima precedence is preserved:

```text
user global < character override < chat metadata
```

Settings documents are split by scope instead of being stored as one mutable blob:

- `global`: API profile references, summary prompt, global RAG/BM25 defaults.
- `character`: character-specific RAG, BM25, knowledge, and state configuration.
- `chat`: automation flags and bindings for one chat.

Each document has `revision`, `updatedAt`, and `deviceId`. Updates use optimistic concurrency. Independent fields can merge; conflicting prompt arrays are retained as recoverable versions instead of concatenated.

## Tenant isolation

Client payloads retain upstream logical collection ids for UI compatibility. The server maps them internally:

```text
tenantId + logicalCollectionId -> opaque physical key
```

The mapping is applied to vector collections, BM25 files, sessions, write queues, imports, exports, lists, rebuilds, and deletes. List and export endpoints only expose logical names belonging to the authenticated tenant.

## Compatibility modes

- `local`: unchanged upstream `/api/plugins/anima-rag` behavior for original SillyTavern.
- `remote`: absolute server URL plus bearer token for TauriTavern.

The local mode remains available so the fork can be regression-tested against upstream behavior.

## Security boundary

- The application process binds only to loopback or the server's Tailscale address. Mobile clients use HTTPS (preferably Tailscale Serve on the private tailnet); TauriTavern's Android release build disables cleartext HTTP.
- Every remote endpoint still requires a strong per-user token.
- Friends receive separate tokens and should join the private Tailnet under an ACL that only grants the required service access; tokens are never shared between people.
- CORS is allowlisted for configured Tauri/WebView origins; it is not the authentication boundary.
- The generic upstream proxy endpoint is authenticated and subject to an outbound target policy.
- Tokens and provider credentials are never logged.

Public-internet exposure is not the default architecture. It would require an explicit domain/TLS, rate-limit, abuse-control, and operations review beyond the private Tailnet deployment.
