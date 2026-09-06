# Anima Remote contribution rules

- Preserve the upstream Anima UI and behavior unless a change is required for remote transport or TauriTavern compatibility.
- Keep upstream attribution and the CC BY-NC 4.0 license files. This project is non-commercial.
- Never commit API keys, access tokens, cookies, Tailnet details, or production data.
- All server-side data access must derive the tenant namespace from the authenticated token; never trust a client-supplied tenant id.
- Preserve Anima's effective-setting precedence: global settings < character overrides < chat metadata.
- Do not allow two processes to write the same Vectra/BM25 files concurrently.
- Frontend and server changes require tests. Run the relevant test suites before handing work back.
- Do not edit files outside `K:\JG\Anima-Remote`.

