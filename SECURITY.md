# Security and privacy

FolderDrop comes as is, without warranty. Use it at your own risk. The [MIT License](LICENSE) sets out the limits on the liability of the authors and copyright holders.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/kubilaycakmak/folderdrop/security/advisories/new). Include the FolderDrop version, operating system, sharing mode, and the expected access boundary. Use disposable sample files and redact share links, access codes, session tokens, and local paths. Please keep reports about vulnerabilities in the private channel while a fix is prepared.

## Access and transport

- FolderDrop shares explicitly selected paths. Each recipient needs a link and a generated one-time access code. The application stores salted code hashes and hashed session tokens. Revocation and expiration end active access. Recipients can keep any bytes they already received.
- Loopback administration stays on the sender's computer. The recipient server has separate routes. Responses request no caching and no indexing. Access checks, rather than crawler directives, protect private content.
- Cloudflare Quick Tunnel requires encrypted ZIP delivery. FolderDrop encrypts ZIP bytes and entry names with age before sending them to Cloudflare. The recipient opens them in their trusted local FolderDrop installation or a web receiver hosted independently of the tunnel provider. Cloudflare can inspect the link path, one-time code, session token, transport metadata and ciphertext. It can interrupt or replace responses. The decryption key must stay out of any page served by the same intermediary.
- LAN mode uses HTTP. For sensitive internet transfers, set up self-hosted HTTPS with a reverse proxy and DNS configuration you control. The configured proxy and intended recipients can read the data in that arrangement.
- Use a trusted out-of-band channel for the decryption key and verify the sender identity through that channel. Age encryption authenticates the encrypted bytes and detects corruption. FolderDrop does not sign the archive to prove the sender's identity. The local data directory, snapshots, inbox, and originals rely on OS permissions and disk protection. Treat received files as untrusted.

See the [filesystem and process boundaries](docs/architecture.md), [access lifecycle](docs/lifecycle.md), and [Cloudflare encryption model](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/).
