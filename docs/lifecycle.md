# Access, versions, and transfers

Cloudflare uses [end-to-end encrypted ZIP delivery](encryption.md), which has a separate local receiving workflow. Browser-only previews and inbox uploads use ordinary browser deliveries.

## One-time access

Delivery IDs and recipient IDs are random. Each recipient has a separate manifest, permissions, expiry, limit, and generated 80-bit access code. A code is a password for a single redemption. FolderDrop stores its salted scrypt hash until redemption. It consumes the code and creates an expiring session in one SQLite transaction. If two people submit the code at the same time, the first committed redemption wins. FolderDrop rate-limits attempts before expensive hash work.

The browser gets a path-scoped, HttpOnly, SameSite=Strict cookie. It is also Secure in public and self-hosted modes. The database retains only the hash of the session token. An authorized browser can return for up to seven days, unless the delivery or recipient expires sooner. Switching browsers, clearing cookies, or losing a redemption response after the commit requires a new code. The sender can intentionally rotate the code and end the existing session. Codes and recipient URLs do not appear in server logs.

| Change | Session and transfers |
| --- | --- |
| Stop | Interrupts active transfers and rejects new access. A restart on the same address can reuse valid cookies and transfer grants after the sender starts the delivery again. |
| Revoke or expire | Ends new access and interrupts active requests. Bytes already received stay with the recipient. Closed deliveries and expired recipient links cannot be reopened. |
| Edit recipient permissions | Invalidates the session, active previews, download grants and uploads. An unused code can still be redeemed with the updated profile. A used code needs rotation. |
| Change live source membership | Invalidates live recipient sessions. Existing item permissions intersect the new manifest. New source items require an explicit recipient permission update. Pinned snapshot recipients retain their version. |
| Change inbox configuration | Invalidates upload-capable sessions and their staged uploads. |
| Change presentation metadata or default version | Existing sessions retain their permissions. Pinned snapshots keep their copied presentation. Live recipients see the latest presentation upon reload. |

## Source files and snapshots

A live share refers to selected regular-file paths under approved roots. Authorized replacements appear at those paths. Newly created neighbors are outside the manifest. Unavailable items stay visible with an unavailable status. Change a recipient's permissions to include a newly added manifest item.

A snapshot is a complete independent copy, with a version ID, byte count, item sizes and SHA-256 digests. FolderDrop rechecks original identities and modification stamps before copying each source, after copying, and across the completed set. A share revision change before commit also aborts publication. The default version affects newly issued links. Previous snapshot links remain pinned. Live links stay live.

Snapshot copies live under `snapshots/` in the data directory. Administration reports storage and exposes deletion for unused copies. The installation allows up to 200 versions and 100 GiB of stored snapshots. Switch the default and close links referencing an old version before deleting it. Revocation and expiration do not delete originals. Removing a stopped delivery cleans up its snapshots and unfinished uploads. Completed inbox files remain owned by the inbox.

## Previews

| Type | Behavior |
| --- | --- |
| JPEG, PNG, WebP, GIF, AVIF, TIFF | First frame, auto-orientation, and resized WebP delivery. Maximum source 32 MiB and 24 megapixels. Image tags, location and device metadata are stripped. |
| PDF | Page-by-page raster preview. Maximum source 24 MiB. Encrypted, invalid, or over-budget pages show a download fallback. No original PDF actions, embedded scripts, or document metadata are run or displayed by the preview. |
| Text and source | Up to 128 KiB of valid UTF-8. HTML, SVG, and source code display as escaped text. Metadata contained in the text itself is visible as file content. |
| Audio and video | Supported formats are remuxed with the primary media tracks and empty container metadata, then played in the browser. Maximum 48 MiB per source or preview. Supported MP4/MOV, WebM/Matroska, WAV, MP3, Ogg/Opus, AAC and FLAC combinations depend on container and codec. A browser-specific MIME/codec check and playback error show an explicit fallback. |
| Other originals | Download fallback when the profile permits downloads. |

Previews contain portions of the selected content. Preview permission therefore allows the recipient to capture the preview bytes or displayed information. It is separate from permission to download the original. Generated media previews remove container tags and extra tracks. Encoded media content or content visible or audible in the recording can still carry identifying information. Original downloads always preserve the complete original bytes and any embedded metadata.

## Download accounting and resume

The first successful original GET for a file representation opens a one-hour logical transfer grant and uses one download. Repeated GETs or ranges for that recipient, item, representation, and valid permission epoch reuse the grant. A changed live file, expired grant, or different item opens a new grant. HEAD and conditional 304 responses do not use the allowance. An accepted request that starts streaming counts even if cancelled. Limits persist across restart. Preview requests do not open original-download grants.

Each new ZIP uses one download for the entire selection. ZIPs retain the curated paths and fixed archive timestamps and modes. Encoded traversal, case-equivalent entry names, and file/directory collisions are rejected. The archive streams as a ZIP with stored entries and ZIP64 when needed, so its content length is known in advance. HTTP clients can repeat the identical ordered POST selection with the `X-FolderDrop-Resume` value and an optional single `Range` and `If-Range` header. FolderDrop rebuilds the ZIP with backpressure and only sends the requested bytes. Rebuilding may still read earlier source bytes. Source changes invalidate the archive grant.

Individual downloads support HEAD, ETag, Last-Modified, conditional requests and one HTTP byte range. HTTP clients can send their existing `X-FolderDrop-Resume` value to prevent silently resuming a different representation. The browser can save a stream directly when File System Access is available. Other browsers use their native download manager. FolderDrop never gathers an entire download to create a client blob.

## Receiving files

Choose an existing separate inbox and opt each recipient into uploads. Upload quotas reserve bytes and file slots for incomplete files, and measure existing inbox files. Complete file type is checked with file signatures and UTF-8 text detection, with binary fallback. This is a type allowlist. It does not scan for malware or parse every possible format. Use `*/*` only when the sender intends to accept arbitrary bytes. Keep the inbox private outside web document roots and treat returned originals as untrusted.

The browser uploads in 4 MiB chunks, up to 8 MiB per API request. Complete chunks are synchronized to disk before their offsets advance. Pause preserves the latest acknowledged offset. Resume by selecting the same file. Cancel discards staging. A disconnection discards the uncommitted chunk. An invalidated session or 24 hours of inactivity releases its unfinished upload and quota. Completion atomically allocates the final filename without overwrite, using `name (1).ext`, `name (2).ext`, and so on when needed. An acknowledged upload is committed to the selected inbox. A file that reaches its atomic commit before connection loss can remain committed even if the browser never received the acknowledgment.

Recipient access to other people's uploads is disabled by default. A profile with inbox browsing can see the names, sizes, and status of completed uploads for that delivery. The inbox does not expose original uploaded bytes via a browser route. Move files into a curated source folder and select them in a manifest to deliver them.
