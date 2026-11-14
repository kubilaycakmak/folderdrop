# Changelog

## 1.0.0 — Unreleased

- Add the loopback workspace, curated recipient gallery and list, and clipboard and QR tools for private links.
- Add transactional, single-redemption access codes with independent recipient permissions and session invalidation.
- Add snapshot versioning, live source tracking, streaming transfers, ranged downloads and ZIPs, and resumable inbox uploads.
- Add local and LAN listeners, supervised Cloudflare Quick Tunnels, and reverse-proxy self-hosting.
- Label loopback links as local-only and show mode-specific actions before starting a listener.
- Disclose the HTTPS and Cloudflare trust boundaries in the workspace and documentation. Add no-index headers to private responses.
- Require end-to-end encrypted ZIPs on Cloudflare listeners. Keep one-time codes and decrypt in the recipient's local workspace.
- Add an independently hosted browser receiver for encrypted ZIPs on phones without an app installation.
- Make the phone receiver selectable in the sharing workspace and add a browser link on encrypted delivery pages.
- Identify the running build in both interfaces, default Cloudflare sharing to the project web receiver in the workspace, and let phone users check the connection before redeeming a code.
- Refresh open link and QR dialogs when a tunnel reconnects, while preserving newly issued credentials.
- Build self-contained desktop preview packages for Windows, macOS, and Debian/Ubuntu.
- Add CLI, stdio MCP, reproducible fixtures, browser journeys, local cross-platform checks, and production tarball verification.
