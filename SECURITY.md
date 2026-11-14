# Security and privacy

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/kubilaycakmak/folderdrop/security/advisories/new). Include the FolderDrop version, operating system, sharing mode, and the expected access boundary. Use disposable sample files and redact share links, access codes, session tokens, and local paths. Please keep reports about vulnerabilities in the private channel while a fix is prepared.

## Access and transport

- FolderDrop shares explicitly selected paths. Each recipient needs a link and a generated one-time access code. The application stores salted code hashes and hashed session tokens. Revocation and expiration end active access. Recipients can keep any bytes they already received.
- Loopback administration stays on the sender's computer. The recipient server has separate routes. Responses request no caching and no indexing. Access checks, rather than crawler directives, protect private content.
- Cloudflare Quick Tunnel uses a public HTTPS entry point at the Cloudflare edge and an encrypted tunnel back to the host. As the TLS endpoint and HTTP proxy, Cloudflare can inspect the files, previews, uploads, access codes, headers, and session cookies that pass through the tunnel. The connector serves selected content through FolderDrop. It has no FolderDrop route for browsing the sender's filesystem.
- LAN mode uses HTTP. For sensitive internet transfers, set up self-hosted HTTPS with a reverse proxy and DNS configuration you control. The configured proxy and intended recipients can read the data in that arrangement.
- FolderDrop currently offers no sender-to-recipient encryption at the application layer. The local data directory, snapshots, inbox, and originals rely on the operating system's permissions and disk protection. Uploaded originals are untrusted files. Confirm any regulatory or organizational requirements before sharing sensitive material.

See the [filesystem and process boundaries](docs/architecture.md), [access lifecycle](docs/lifecycle.md), and [Cloudflare encryption model](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/).
