# Send an end-to-end encrypted delivery

1. In the sender workspace, select files and start sharing. **Public link (Cloudflare)** requires encrypted links. For other network modes, select **End-to-end encrypted ZIP** when issuing a recipient code.
2. Give the recipient the share link and one-time access code. Send the decryption key through a separate trusted channel. The key is shown at issuance and rotation.
3. The recipient opens their installed FolderDrop workspace and selects **Receive encrypted delivery**. They enter the link, code and decryption key, then choose a local directory for the decrypted ZIP. The public page only displays receiving instructions.

This mode delivers one ZIP per authorized selection. Browser previews and inbox uploads belong to ordinary browser shares on a trusted local or self-hosted network. Existing browser links use their original mode on local, LAN and self-hosted listeners. A Cloudflare listener rejects existing browser links. Issue a new encrypted link before sending via Cloudflare.

## What the provider can see

The sender streams a ZIP of authorized files through the [age v1 format](https://age-encryption.org/v1) using a fresh file key for each transfer. The recipient generates no dependency on tunnel-hosted JavaScript for decryption. The sender stores the age public recipient key and never persists the matching private key in its application database. The recipient's local service uses the decryption key only on the receiving computer. Use a trusted FolderDrop installation and enter the key only in its local workspace.

Cloudflare sees link identifiers, one-time redemption codes, session tokens, response ciphertext length, timing and network metadata. ZIP entry names and file bytes travel as authenticated ciphertext. Private LAN links use plain HTTP, so the local network has the same visibility. Transport intermediaries can observe, block, replay, or alter traffic. The recipient verifies ciphertext integrity before exposing a completed ZIP. Verify the sender and key through the separate trusted channel. The ZIP carries no FolderDrop sender signature.

## One-time codes and retries

Redemption atomically consumes the code before the sender starts sending files. A new receiver session cannot reuse it. If a download fails after redemption, keep the local receiving dialog open and retry. The local receiver keeps only the remote session token in memory for ten minutes after an interrupted attempt. It does not keep the private key. Retries of the same archive reuse the logical download allowance during the grant window and restart from the beginning rather than using HTTP ranges.

An encrypted archive may contain up to 16 GiB. The receiving app stages the plaintext before saving an authenticated ZIP under a generic name. It never extracts files or overwrites an existing ZIP. Abrupt OS or process termination may leave an incomplete local staging directory. Revocation and expiry stop new access. Recipients or intermediaries may retain bytes they previously received. Treat the key as sensitive for as long as old ciphertext exists.

To replace lost credentials, generate a new code in the recipient profile. FolderDrop rotates the decryption key and invalidates the previous session. A matching old key can still decrypt previously captured ciphertext.

## CLI and MCP

Use `folderdrop issue DELIVERY_ID --encrypted` for an encrypted link on local, LAN or self-hosted listeners. The public listener selects encryption automatically. For MCP, set `encrypted: true` on `issue_access_code` to request the same encrypted result. Both operations explicitly return the one-time code and decryption key. Keep those values out of shell logs, issue reports and shared agent transcripts.
