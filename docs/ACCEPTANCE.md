# Acceptance criteria

## Verification record (2026-09-06)

- Passed: server unit/security suite (17), extension suite (10), static install/security contracts (6), and a real temporary two-token black-box suite (14/14).
- Passed: Compose configuration expansion with `deploy/.env.example`; Bash/PowerShell/JavaScript syntax checks.
- Pending on target environment: Docker image build and healthy-container smoke test, Tailscale Serve HTTPS request, Android clean Git install, and upstream local-SillyTavern smoke test.
- Migration remains closed: existing SillyTavern Anima vectors/BM25/sessions are not copied or shared with Remote.

## Installation and compatibility

- TauriTavern can install the extension from a Git URL with no local Node.js or server plugin.
- The extension manifest, module imports, CSS, dialogs, and mobile layout load successfully.
- Missing TavernHelper produces one actionable diagnostic instead of a long silent wait.
- Existing Anima panels, labels, defaults, import/export formats, and automation remain available.

## Remote connection

- A user enters server URL and token once, tests the connection, and reloads without re-entering them.
- All backend calls use the shared transport; no hard-coded plugin API calls remain outside the transport module.
- Local SillyTavern mode still works.
- Network failures do not corrupt local settings or memory metadata.

## Multi-user isolation

- Two tokens using identical character/chat/collection names cannot list, query, modify, export, or delete each other's data.
- Tenant identity always comes from authentication.
- Concurrent writes to one tenant/collection are serialized; different tenants do not share queues or caches.

## Settings sync

- Global, character, and chat settings sync independently with revisions.
- Local changes are immediately effective and asynchronously persisted remotely.
- Restarting or using a second device restores the latest settings.
- Conflicting prompt arrays retain recoverable history.
- Provider secrets are not included in settings-download responses.

## Automation and performance

- Pre-generation retrieval remains synchronous and bounded by a timeout.
- Post-response status and scheduled summaries remain automatic.
- Server-side indexes stay warm across extension reloads.
- Settings synchronization occurs on changes/startup, not on every generation request.

## Deployment and operations

- Docker deployment uses persistent data and a health check.
- Default published port binds to a configurable Tailscale IP, never `0.0.0.0`.
- Mobile onboarding uses a valid HTTPS URL; the private Tailscale Serve path is documented and tested separately from the internal application port.
- Existing server Anima data is not overwritten; migration is explicit, dry-runnable, backed up, and reversible.
- Documentation includes owner setup, friend onboarding, token revocation, update, backup, restore, and rollback.

## Verification gates

- All automated tests pass.
- A clean install test is completed in TauriTavern mobile or an equivalent documented harness.
- A two-user isolation test is completed with identical logical collection ids.
- An upstream-local-mode smoke test passes.
- No credentials or production data are present in Git history or build artifacts.
