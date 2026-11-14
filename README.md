# FolderDrop · Private File and Folder Sharing

FolderDrop is an open-source, self-hosted file sharing app. Share selected files and folders from your own computer using a private link and a one-time access code. Browser deliveries support previews, downloads and invited uploads. Cloudflare deliveries encrypt the selected files as a ZIP for the recipient's local FolderDrop app.

[Try FolderDrop](#try-it) · [Desktop packages](docs/desktop.md) · [Network and privacy](#network-and-privacy) · [Report a bug](https://github.com/kubilaycakmak/folderdrop/issues)

![FolderDrop recipient gallery showing artwork and a lookbook](docs/screenshots/recipient-gallery.png)

## Try it

### Desktop

The Windows, macOS and Linux desktop packages bundle Node.js and open the local FolderDrop workspace in your default browser. See the [desktop package guide](docs/desktop.md) for supported platforms and the status of downloadable builds.

### From source

Node.js 22.16 or newer is required for the source and CLI installation. Clone, install and launch:

```sh
git clone https://github.com/kubilaycakmak/folderdrop.git
cd folderdrop
npm ci
npm run dev
```

1. Browse a source folder, select files, and repeat for additional folders. Delivery paths are editable and independent of the original paths.
2. Add a title, introduction, cover, and file descriptions. Set the order and choose a theme.
3. Set an optional expiration and configure an inbox if you want to receive files.
4. Preview the delivery. Start a network listener and issue an access code for each recipient. Send the code separately from the link when possible.

The first successful redemption consumes the code and opens a browser session. The same code fails in any other browser or after the original browser loses its session. The sender can generate a fresh code or revoke a link. A local or LAN listener only works while the FolderDrop service is running.

## Network and privacy

| How recipients connect | Who handles traffic |
| --- | --- |
| Local | Loopback on your own computer |
| LAN | Your local network over HTTP |
| Cloudflare Quick Tunnel | Encrypted ZIP required. Cloudflare sees access codes, session tokens, sizes and timing. The decryption key is sent separately through a trusted channel. |
| Self-hosted HTTPS | The HTTPS reverse proxy you configure handles the traffic. Select an encrypted ZIP for a recipient when the proxy should only see ciphertext. |

FolderDrop limits access to selected files and recipient permissions. It leaves original files on disk. See [encrypted delivery](docs/encryption.md) for sending and receiving keys, and [the security policy](SECURITY.md) for limitations and reporting.

## Commands

```sh
folderdrop --help
folderdrop --version
folderdrop menu
folderdrop diagnostics --json
folderdrop create ./files --title "Client delivery"
folderdrop list --json
folderdrop start DELIVERY_ID --mode lan
folderdrop issue DELIVERY_ID --label "Client reviewer"
folderdrop links DELIVERY_ID RECIPIENT_ID
folderdrop stop DELIVERY_ID
```

In a checkout, run the same commands with `node bin/folderdrop.js <command>`. The project uses `@kubilaycakmak/folderdrop` as its package name. The package is currently unpublished. Verify a local tarball with `npm run verify:package`.

| Capability | Behavior |
| --- | --- |
| Administration | Loopback workspace with a launch key, guided setup, recipient preview, profiles, snapshots, listeners, progress, and revocation |
| Local and LAN | Loopback-only local sharing, or explicit interface binding with LAN addresses |
| Cloudflare | Explicit Quick Tunnel, verified optional provider acquisition, readiness, public-origin probe, reconnect, and teardown |
| Self-hosting | Recipient-only loopback upstream behind an HTTPS reverse proxy, with a configured external address and persistent state |
| Files and versions | Curated live manifests and independent, SHA-256-indexed snapshot copies with pinned links |
| Previews | Resized images, rasterized PDF pages, bounded UTF-8 text, and remuxed media when container and codecs permit |
| Downloads | Streaming originals and ZIPs, individual and selected files, bounded retry grants and byte ranges |
| Uploads | Opt-in inbox, resumable staged uploads, MIME and quota checks, cancellation, and collision-safe renaming |
| Agent tools | MCP over stdio using the official SDK, with explicit code creation and public start |

- [CLI and manifest reference](docs/cli.md)
- [Networking, Cloudflare, and self-hosting](docs/networking.md)
- [Lifecycle, snapshots, previews, and uploads](docs/lifecycle.md)
- [MCP setup and tools](docs/mcp.md)
- [Architecture and dependencies](docs/architecture.md)
- [Demo and screenshots](docs/demo.md)
- [Verification and platform results](docs/verification.md)
- [Contributing](CONTRIBUTING.md)
