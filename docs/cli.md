# Command line and manifests

Run `folderdrop --help` for syntax and exit codes. Without arguments, FolderDrop starts or finds the service for the selected data directory and opens a browser with a single-use launch key. Give the command an existing folder to preselect it. Use `--json --no-open` to explicitly request the launch URL in a scripted workflow. Treat it as a credential for its two-minute lifetime. Bookmarks to administration work while its browser session is valid.

`serve` keeps the process in the foreground and accepts Ctrl+C or a service manager. Regular commands contact a single detached service per data directory. The interactive `menu` requires a TTY. Use individual commands or `--json` in scripts. Shutdown closes listeners and drains the service. It preserves delivery state for the next start. Use `stop` to keep a delivery offline across restart, or `revoke` to permanently invalidate it.

## Working with a manifest

```json
{
  "roots": [
    {"path": "/home/alex/exports", "label": "Images"},
    {"path": "/home/alex/documents", "label": "Documents"}
  ],
  "items": [
    {"root": 0, "relative": "shot.jpg", "path": "Gallery/Opening.jpg", "description": "Hero selection"},
    {"root": 1, "relative": "notes.pdf", "path": "Review notes.pdf"}
  ],
  "presentation": {
    "title": "Studio delivery",
    "intro": "Review the gallery and return your notes.",
    "theme": "grove"
  },
  "expires": "2027-03-15T20:00:00Z",
  "inbox": {
    "path": "/home/alex/inbox",
    "types": ["application/pdf", "text/plain", "image/*"],
    "maxFile": 41943040,
    "maxTotal": 268435456,
    "maxFiles": 50,
    "concurrency": 2
  }
}
```

`root` is the zero-based root index. Separate native absolute roots from forward-slash relative paths. Array order determines presentation order. A missing delivery path uses the root label plus the relative path. `create FOLDER` selects eligible regular files recursively and preserves paths relative to that folder. Use `create --input manifest.json` for a curated multi-root draft.

`inspect` returns the current revision, roots, item IDs, recipients, versions, connection status and active transfers to the local administrator. Preserve IDs on edits to the same source items. Supply the inspected `revision` in the edit JSON for optimistic concurrency. A revision conflict calls for inspecting and merging again. Set `presentation.cover` to an image item ID or `null`. Themes are `paper`, `midnight`, and `grove`.

```sh
folderdrop edit DELIVERY_ID --input edits.json
folderdrop snapshot DELIVERY_ID
folderdrop set-version DELIVERY_ID VERSION_ID
folderdrop issue DELIVERY_ID --input profile.json
folderdrop update-recipient DELIVERY_ID RECIPIENT_ID --input profile.json
folderdrop rotate DELIVERY_ID RECIPIENT_ID
folderdrop revoke-recipient DELIVERY_ID RECIPIENT_ID
folderdrop remove-version DELIVERY_ID VERSION_ID
folderdrop revoke DELIVERY_ID
folderdrop remove DELIVERY_ID
folderdrop shutdown
```

A profile can set `label`, `version`, `items` (array of item IDs), `preview`, `download`, `upload`, `browseInbox`, `limit`, and `expires`. Omitted `version` uses the delivery default. Explicit `null` pins the live manifest. Omitted `items` grants the items present in that version when the profile is issued. Upload requires an inbox. Code values appear only in explicit `issue` and `rotate` results. `links` returns the current addresses. It includes a QR for ordinary browser links or for an encrypted link with a web receiver configured. When running interactively, it prints the QR in the terminal.

Exit codes are `0` for success, `1` for other internal errors, `2` for input errors, `3` for missing records, `4` for invalidated or denied operations and conflicts, and `5` for service or provider errors. JSON failures include `error` and `code`.
