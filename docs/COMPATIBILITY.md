# TauriTavern compatibility notes

## What can be installed on a phone

TauriTavern supports SillyTavern-style third-party frontend extensions installed from a Git repository. Anima Remote therefore keeps `extension/manifest.json`, JavaScript modules, styles, dialogs, and assets as a normal extension. No Node.js package or SillyTavern server plugin is installed on the phone.

The original Anima frontend calls `window.TavernHelper` for world-book and layered-chat operations. The current release consequently requires a compatible TavernHelper extension to be installed and enabled. Anima Remote must show a direct diagnostic when it is absent; silently waiting through repeated reloads is not an acceptable fallback. Removing this dependency would require reimplementing TavernHelper's behavior and is not part of the remote-transport adaptation.

## Network behavior

TauriTavern's Android release configuration disables cleartext traffic. A phone must connect to an HTTPS URL such as a Tailscale Serve MagicDNS address. `http://localhost` and loopback addresses are retained only for local development tests; `http://100.x.x.x` is not a supported production address.

Cross-origin requests require server CORS support for `Authorization` and preflight `OPTIONS`. CORS does not authenticate a user; every non-health API request still requires a bearer token.

## Startup and refresh performance

TauriTavern defers third-party extension activation until its main UI is ready. The extension should perform only these startup tasks:

1. Load local Anima settings and render the existing UI.
2. Validate the saved remote connection without blocking the UI.
3. Download settings only when synchronization is enabled and merge them by scope.

Vector indexes, BM25 indexes, sessions, and write queues live in the long-running server process. Reloading the mobile WebView must not restart the server, reinstall dependencies, or rebuild indexes. Failed connection or settings-sync requests fall back to the last local state and must not delay ordinary chat startup indefinitely.

## Supported user model

One owner can host the service for several friends. Each person installs the same frontend extension but receives an individual token. The server maps that token to a private tenant, so identical character names and chat identifiers do not conflict. Sharing one token intentionally collapses that boundary and is unsupported.

This release has no public registration and no collaborative-memory mode. Access is granted by the owner through Tailnet membership plus a separately issued service token.

## Release verification

- Install the extension from a Git URL in a clean TauriTavern profile.
- Verify the original Anima panels, mobile layout, import/export, automatic retrieval, and summary workflow.
- Verify a missing TavernHelper produces one actionable message.
- Verify an HTTPS remote URL succeeds and a non-loopback HTTP URL is rejected before credentials are sent.
- Reload TauriTavern and verify the server connection and non-secret settings restore without rebuilding server indexes.
