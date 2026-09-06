# Threat model

## Protected assets

- Per-user memories, vector collections, BM25 indexes, echo sessions, and synchronized settings.
- User bearer tokens and provider credentials.
- The host and private Tailnet reachable by the server.

## Trust boundaries

- TauriTavern and its installed extension are user-controlled clients. A request body cannot choose a tenant.
- The bearer token identifies one tenant. Authentication is separate from CORS and Tailscale network membership.
- Provider URLs and headers supplied by the client are untrusted outbound-proxy input.
- Files imported from a client are untrusted data and must never select a filesystem path.

## Required controls

1. The server derives an opaque tenant prefix from the authenticated token record and applies it to every collection, BM25 library, session, cache, and write-queue key.
2. Logical identifiers use a reversible, collision-free encoding. Sanitizing two different names to the same filename is not acceptable.
3. List and response transformations reveal only resources owned by the authenticated tenant.
4. Tokens are stored as password hashes, shown once at creation, never logged, and individually revocable.
5. Settings synchronization removes credential-like fields recursively before persistence and response.
6. Outbound requests allow only approved protocols and hosts, reject URL credentials and private/reserved addresses by default, and revalidate every redirect target.
7. Production mobile access uses HTTPS. The application listener remains private and binds only to an explicitly configured local or Tailscale address.
8. Payload limits, timeouts, and per-resource write serialization prevent a client from indefinitely blocking the shared service.

## Deliberate non-goals

- Tokens do not make a malicious client trustworthy; they only isolate and revoke it.
- This release does not provide shared memories or collaborative editing. Friends receive separate private tenants.
- Public Internet exposure, billing, commercial hosting, and untrusted self-registration are outside the supported deployment model.
- Provider API secrets remain device-local and are not synchronized. Requests may traverse the server proxy, so server operators can technically observe them in process memory; logs must redact them.

## Verification

The release gate requires automated two-token tests using identical logical identifiers, settings conflict and secret-redaction tests, proxy-policy tests, and a static scan for direct backend URLs in the extension. A private HTTPS connection must also be verified from an Android release build or documented equivalent device test.
