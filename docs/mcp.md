# Model Context Protocol

FolderDrop has a real stdio MCP server and calls the same daemon and service operations as the CLI and workspace. It uses the coding agent's configured model and makes no model calls.

```json
{
  "mcpServers": {
    "folderdrop": {
      "command": "npx",
      "args": ["-y", "@kubilaycakmak/folderdrop@latest", "mcp"]
    }
  }
}
```

For an unreleased checkout or a local tarball installation, set `command` to `node` and put the absolute installed `bin/folderdrop.js` path before `mcp` in `args`. On hosts whose launcher cannot run `npx.cmd`, the absolute Node entry point works without a shell. Use `--data-dir` to select a separate workspace. The stdio server uses stdout for MCP messages.

| Area | Tools |
| --- | --- |
| Discover | `list_deliveries`, `inspect_delivery`, `scan_folder`, `list_manifest`, `diagnostics` |
| Curate | `create_delivery`, `edit_delivery` |
| Access | `list_recipients`, `list_recipient_items`, `issue_access_code`, `rotate_access_code`, `update_recipient`, `revoke_recipient`, `remove_recipient`, `get_recipient_links` |
| Versions | `create_snapshot`, `set_default_version`, `remove_snapshot` |
| Network | `start_sharing`, `start_self_hosted_sharing`, `start_public_sharing`, `verify_self_hosted_origin`, `stop_delivery`, `revoke_delivery`, `remove_delivery` |
| Activity | `transfer_status` |

List tools expose `offset` and `limit`. `inspect_delivery` provides summary and current revision. File lists are paginated separately. Tool errors include a safe structured code and explanation. Paths refer to the server's local filesystem. The MCP client should run as a trusted local user with access to that workspace.

Ask for an access code only as part of an intended creation or rotation. These tools explicitly return the secret. Tool outputs may be retained by the MCP client. Routine listings omit code values and hashes. Request `get_recipient_links` to obtain the active URLs. Only `start_public_sharing` with `confirmPublic: true` provisions a managed external tunnel. Start self-hosted sharing explicitly to bind a proxy origin for your configured domain.
