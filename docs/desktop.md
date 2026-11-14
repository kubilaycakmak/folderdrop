# FolderDrop desktop packages

Desktop builds include Node.js and the same FolderDrop CLI, filesystem services, and browser workspace. Senders launch the app and use their default browser. Recipients open their link in a browser and need no app.

Choose **Quit FolderDrop** in the workspace to stop the service and all active sharing. Closing the browser tab leaves the service running.

| Platform | Package | Launch after installation |
| --- | --- | --- |
| Windows x64 | ZIP | Extract the entire ZIP, then double-click `FolderDrop.exe` |
| macOS Apple silicon or Intel | ZIP with a `.app` bundle | Extract and open `FolderDrop.app` |
| Debian/Ubuntu x64 or ARM64 | DEB | Open the DEB in the distribution's package installer and launch **FolderDrop** from the application menu |

## Preview builds

Maintainers build preview packages locally on each target OS. Build one using the instructions below or use a package supplied by the maintainer for testing. Compare the download with the maintainer's SHA-256 checksum before opening it. A matching checksum checks the file's integrity. A platform signature establishes the publisher's identity.

Windows and macOS preview builds use no FolderDrop publisher signature or Apple notarization. SmartScreen, Smart App Control, enterprise policy, or macOS Gatekeeper can warn about or block downloaded preview builds. The normal public desktop distribution needs trusted publisher signing on Windows and Developer ID signing plus notarization on macOS. See [Microsoft SmartScreen](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation) and [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).

Local and LAN sharing use the included runtime. To enable Cloudflare Quick Tunnel, select **Public link (Cloudflare)** and use **Install verified Cloudflare connector** if the provider is missing. The CLI also supports `tunnel-install`. See [networking and privacy](networking.md).

## Build from source

Use the native target OS and CPU with npm and Node 24. Windows needs the .NET Framework C# compiler included with the supported build environment. macOS needs `ditto` and `plutil`. Debian/Ubuntu needs `dpkg-deb`.

```sh
npm run build:desktop
```

The build checks the upstream Node archive against pinned SHA-256 values, installs locked production dependencies into a temporary bundle, packages the launcher and its runtime, and smoke-tests the extracted archive using the launcher from outside its installation directory. The platform package and its checksum land in `dist/`.
