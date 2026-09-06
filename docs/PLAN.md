# Delivery plan and review gates

## User-facing outcome

An owner deploys one private server. Each TauriTavern user installs TavernHelper and the Anima Remote extension from Git, enters a server URL and personal token once, and then uses the familiar Anima UI and automatic workflow. Users do not share settings or memories unless an explicit future sharing feature is enabled.

## Parallel implementation

1. Server worker: authenticated standalone runtime, tenant namespace, settings revisions, secret filtering, management CLI, tests.
2. Extension worker: one transport abstraction, connection UI, local/remote mode, settings sync foundations, compatibility tests.
3. Deployment worker: Docker assets and owner/friend/migration/operations documentation.
4. Independent verifier: black-box contract, isolation, policy, and frontend static tests.

Write sets are disjoint. The lead agent owns API/architecture decisions, integration edits, final review, and rework assignments.

## Lead-agent review gates

### Gate 1: source and license

- Upstream attribution and CC BY-NC 4.0 text remain present.
- Modified project is clearly marked non-commercial and unofficial.
- No secret or production data is copied from the existing server.

### Gate 2: compatibility

- Original Anima panels and default behavior remain intact.
- Local SillyTavern mode remains functional.
- Remote mode has one connection section and no scattered endpoint configuration.
- No direct `/api/plugins/anima-rag` string remains outside the transport implementation or an intentional test/compatibility constant.

### Gate 3: security and isolation

- Token lookup is constant-time where practical and persisted tokens are hashed.
- Tenant ids are server-derived and cannot be selected in payloads.
- Every path-like logical id is encoded to an opaque physical namespace without traversal.
- List, export, import, query, delete, rebuild, BM25, KB, session, cache, and queue behavior is tenant-scoped.
- Proxy endpoint rejects unapproved protocols, loopback/link-local/metadata targets, credentials in URLs, and disallowed hosts.
- CORS is not treated as authentication.

### Gate 4: synchronization

- Existing global < character < chat precedence is unchanged.
- Local save remains immediate; remote synchronization is asynchronous and failure-tolerant.
- Revision conflicts are explicit and recoverable.
- Secret fields never leave the client through settings sync and never return from the server.

### Gate 5: reliability and performance

- Pre-generation retrieval has a bounded timeout and clear fallback behavior.
- Post-response work does not block rendering the model response.
- Settings are not uploaded on every generation.
- Indexes and write queues remain warm in the server process.
- Repeated requests can be made idempotent where background retry could duplicate writes.

### Gate 6: verification

- Server unit/integration tests pass.
- Extension static/unit tests pass.
- Independent black-box suite passes against a clean temporary server.
- Two tokens with the same logical ids cannot observe or mutate each other.
- Compose configuration validates and health check passes.
- Android release compatibility does not rely on cleartext HTTP; HTTPS/Tailscale Serve onboarding is verified.
- Clean install and connection steps are reproducible from documentation.

## Rework policy

Failed gates are assigned back to the worker owning that write set with concrete evidence and a required regression test. Integration fixes that cross write sets are performed by the lead agent after worker changes are reviewed.
