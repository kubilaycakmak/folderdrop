# Send an end-to-end encrypted delivery

1. In the sender workspace, select files and start sharing. **Public link (Cloudflare)** requires encrypted links. For other network modes, select **End-to-end encrypted ZIP** when issuing a recipient code.
2. Give the recipient the share link and one-time access code. Send the decryption key through a separate trusted channel. The key is shown at issuance and rotation.
3. For phones, send the **Phone or browser link**. The recipient opens it in Safari or Chrome, enters the code and key, and saves the ZIP. For computers, the installed FolderDrop workspace also supports **Receive encrypted delivery** and can save larger ZIPs.

## Set up the web receiver for phones

The sender runs FolderDrop. Recipients only need a browser when a trusted web receiver is configured. Build the static receiver from the same source revision as the desktop app:

```sh
npm ci
npm run build:web-receiver
```

Publish the three files under `dist/web-receiver/` on a dedicated HTTPS origin you control and trust. Use a host that is independent of the delivery tunnel and its operator. A reader hosted behind the same intermediary gives that intermediary the ability to substitute the code that handles the key. Avoid third-party scripts and analytics on the receiver origin. Set `X-Frame-Options: DENY` or `Content-Security-Policy: frame-ancestors 'none'` as an HTTP response header. Serve `receiver.js` as JavaScript. The receiver needs no backend.

In the sender's **Public link (Cloudflare)** or **Self-hosted (HTTPS reverse proxy)** network settings, enter the complete **Trusted web receiver** address before starting. For an active delivery, stop and restart with that setting. Send the generated **Phone or browser link** or its QR directly to the recipient, and send the key separately. The browser link pre-fills the delivery address in a fragment and contains neither the code nor the key. FolderDrop allows only the configured receiver origin on the encrypted download and redemption routes.

The web receiver keeps credentials in the tab and holds a verified ZIP in memory until saved. Its limit is 64 MiB of uncompressed ZIP data. For larger deliveries, split the selected files into smaller shares or use the desktop receiver. Keep the tab open to retry a failed or cancelled download after the code has been consumed.

This mode delivers one ZIP per authorized selection. Browser previews and inbox uploads belong to ordinary browser shares on a trusted local or self-hosted network. Existing browser links use their original mode on local, LAN and self-hosted listeners. A Cloudflare listener rejects existing browser links. Issue a new encrypted link before sending via Cloudflare.

## What the provider can see

The sender streams a ZIP of authorized files through the [age v1 format](https://age-encryption.org/v1) using a fresh file key for each transfer. The sender stores the age public recipient key and never persists the matching private key in its application database. The recipient decrypts with their local installation or with code served by the independently trusted HTTPS receiver. Enter the key only in the receiver you verified independently with the sender.

Cloudflare sees link identifiers, one-time redemption codes, session tokens, response ciphertext length, timing and network metadata. ZIP entry names and file bytes travel as authenticated ciphertext. Private LAN links use plain HTTP, so the local network has the same visibility. Transport intermediaries can observe, block, replay, or alter traffic. The recipient verifies ciphertext integrity before exposing a completed ZIP. Verify the sender and key through the separate trusted channel. The ZIP carries no FolderDrop sender signature.

## One-time codes and retries

Redemption atomically consumes the code before the sender starts sending files. A new receiver session cannot reuse it. If a download fails after redemption, keep the local receiving dialog open and retry. The local receiver keeps only the remote session token in memory for ten minutes after an interrupted attempt. It does not keep the private key. Retries of the same archive reuse the logical download allowance during the grant window and restart from the beginning rather than using HTTP ranges.

An encrypted archive may contain up to 16 GiB. The receiving app stages the plaintext before saving an authenticated ZIP under a generic name. It never extracts files or overwrites an existing ZIP. Abrupt OS or process termination may leave an incomplete local staging directory. Revocation and expiry stop new access. Recipients or intermediaries may retain bytes they previously received. Treat the key as sensitive for as long as old ciphertext exists.

To replace lost credentials, generate a new code in the recipient profile. FolderDrop rotates the decryption key and invalidates the previous session. A matching old key can still decrypt previously captured ciphertext.

## CLI and MCP

Use `folderdrop issue DELIVERY_ID --encrypted` for an encrypted link on local, LAN or self-hosted listeners. The public listener selects encryption automatically. Configure the web receiver with `folderdrop start DELIVERY_ID --mode public --confirm-public --receiver-url https://receive.example.com/`, or the equivalent `receiverUrl` field in MCP. Use `links` to retrieve the browser link and QR. In MCP, set `encrypted: true` on `issue_access_code` to request the encryption key explicitly on other network modes. Keep codes and keys out of shell logs, issue reports and shared agent transcripts.
