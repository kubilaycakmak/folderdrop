# Networking and self-hosting

The admin server always listens on `127.0.0.1`. Each active delivery has its own recipient-only listener. Local and LAN use plain HTTP and browser session cookies. Anyone able to observe network traffic on a plain HTTP LAN can observe codes and cookies. Use an HTTPS mode on a network you do not control.

| Mode | Bind | Meaning of connection status |
| --- | --- | --- |
| Local | `127.0.0.1` | Loopback listener; only usable from this host |
| LAN | Explicit IP or `0.0.0.0` | Listener bound; the sender still needs a reachable local network and suitable firewall settings |
| Public | `127.0.0.1` behind the Cloudflare connector | Provider readiness and external HTTPS probe shown independently |
| Self-hosted | `127.0.0.1` by default, or explicit IP | Proxy origin listener; external HTTPS probe can be requested separately |

The serving computer, service, and selected source volumes must stay online. Snapshots can survive an offline source volume. A successful external-origin probe proves that the current host reached this specific recipient listener through the advertised address. Test a disposable recipient link from an independent network to verify external reachability for your recipients. A local listener by itself provides no internet route.

## Cloudflare Quick Tunnel

Install the provider independently from [Cloudflare Downloads](https://developers.cloudflare.com/tunnel/downloads/) or explicitly acquire the pinned executable:

```sh
folderdrop tunnel-install
folderdrop diagnostics
folderdrop start DELIVERY_ID --mode public --confirm-public
folderdrop links DELIVERY_ID RECIPIENT_ID
```

FolderDrop looks for an absolute executable in `FOLDERDROP_CLOUDFLARED`, a locally verified pinned installation, or an executable in absolute PATH directories. Set environment variables before launching the FolderDrop service. The pinned installer downloads assets from [cloudflared 2026.11.0](https://github.com/cloudflare/cloudflared/releases/tag/2026.11.0) and checks SHA-256 against values shipped in FolderDrop before extraction or execution. Pinned assets cover Windows x64, Linux x64/arm64, and macOS x64/arm64. For other provider-supported systems, use a trusted system install. Diagnostics only runs `cloudflared --version`.

FolderDrop gives the connector an empty private config and a loopback metrics address. It watches `/ready` and the allocated hostname, probes its own recipient-only endpoint over public HTTPS, and reconnects with bounded backoff. Stopping, revoking, or losing the service process tears down the connector. A new Quick Tunnel can have a different hostname. Fetch fresh recipient links after reconnect and use a new code if a previous browser cookie was tied to the old origin. FolderDrop leaves Quick Tunnels stopped after a service restart.

[Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) provide temporary addresses for testing and development, have a 200 in-flight request cap, and do not guarantee uptime. FolderDrop uses polling and upload chunks no larger than 8 MiB, with 4 MiB chunks in the browser. Cloudflare edge limits and timeouts still apply. Check DNS, outbound HTTPS and port 7844, the provider version, and Cloudflare availability if readiness stays disconnected. Use a correctly configured reverse proxy for stable addresses.

## HTTPS reverse proxy

Run a foreground service as the local account that owns FolderDrop data and can read the selected sources. Give the proxy a stable recipient-only listener:

```sh
folderdrop serve --no-open --data-dir /srv/folderdrop/state
# In a second shell with the same user and data directory:
folderdrop start DELIVERY_ID --mode self-hosted --port 7318 \
  --external https://deliveries.example.com --data-dir /srv/folderdrop/state
folderdrop verify DELIVERY_ID --data-dir /srv/folderdrop/state
```

Point your DNS record at the reverse proxy. A minimal Caddy site serving that delivery:

```caddy
deliveries.example.com {
    reverse_proxy 127.0.0.1:7318
}
```

Configure TLS and expose the proxy's HTTP/HTTPS ports as needed by its certificate workflow. Preserve the external Host header, request methods, streaming responses, and byte range headers. Do not cache private responses or log complete request URI paths. Set body limits large enough for one 8 MiB upload chunk. Give each delivery its own hostname and upstream port. Administration must never be a proxy upstream. For remote administration, use a private SSH port forward to a fixed `--admin-port` and open the reported loopback launch URL on your client with that same port.

On a service restart FolderDrop restores enabled local, LAN, and configured self-hosted listeners at their saved ports. Binding failures surface in administration and leave those deliveries stopped. With the same HTTPS origin and the original browser cookie, recipients can continue valid sessions after restart. Keep the same service account, writable state and inbox directories, and source volume mount points. Revocation is durable.

### Example service unit

```ini
[Unit]
Description=FolderDrop
After=network-online.target

[Service]
User=folderdrop
WorkingDirectory=/srv/folderdrop
ExecStart=/usr/local/bin/folderdrop serve --no-open --admin-port 7317 --data-dir /srv/folderdrop/state --json
Restart=on-failure
StandardOutput=null
StandardError=journal
UMask=0077

[Install]
WantedBy=multi-user.target
```

Adjust the executable pathname to the real installation. Use a service command such as `folderdrop --data-dir /srv/folderdrop/state --no-open` as the service account to request a fresh administrator launch key interactively.
