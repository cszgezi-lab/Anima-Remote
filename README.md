# Anima Remote for TauriTavern

Anima Remote adapts the upstream Anima Memory System so a TauriTavern user can install the frontend extension, connect it to a private remote server, and retain Anima's familiar UI and automatic memory workflow.

This repository contains:

- `extension/`: the upstream Anima frontend with a remote transport and setup UI.
- `server/`: the Anima RAG backend with authenticated multi-user namespaces and settings sync.
- `deploy/`: private-network Docker deployment assets.
- `docs/`: architecture, installation, migration, and verification documentation.

The root [`manifest.json`](manifest.json) is the Git-install entry point for TauriTavern and loads the assets under `extension/`. The same `extension/` directory can also be published as a smaller extension-only repository without changing its internal imports.

The security and isolation assumptions are documented in [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md). TauriTavern-specific limits and phone verification are documented in [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md). The supported default is one private Tailnet service with a separate revocable token and isolated data namespace for every person.

The codebase is a deployment-ready release candidate. Automated server, extension, static-contract, and real temporary two-token black-box tests pass, and the Compose model validates. Docker image/runtime, Tailscale HTTPS, and Android clean-install checks must still be completed on the target server/device before calling a production rollout complete. Existing Anima data must remain separate; legacy memory migration is intentionally not enabled yet.

After dependencies are installed in each package, `npm test` runs the unit/static suites and `npm run test:local` starts a temporary authenticated server and runs the complete black-box suite.

## License

The upstream Anima sources are licensed under CC BY-NC 4.0. Attribution is retained, modifications must be identified, and commercial use is not permitted. See the license files in `extension/` and `server/`.
