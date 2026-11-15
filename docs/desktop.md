# FolderDrop desktop packages

Desktop builds include Node.js and the same FolderDrop CLI, filesystem services, and browser workspace. Senders launch the app and use their default browser. Recipients open their link in a browser and need no app.

Choose **Quit FolderDrop** in the workspace to stop the service and all active sharing. Closing the browser tab leaves the service running.

| Platform | Package | Launch after installation |
| --- | --- | --- |
| Windows x64 | ZIP | Extract the entire ZIP, then double-click `FolderDrop.exe` |
| macOS Apple silicon or Intel | ZIP with a `.app` bundle | Extract and open `FolderDrop.app` |
| Debian/Ubuntu x64 or ARM64 | DEB | Open the DEB in the distribution's package installer and launch **FolderDrop** from the application menu |

## Public downloads

The [public release](https://github.com/kubilaycakmak/folderdrop/releases/latest) provides tested Windows x64, macOS Apple Silicon, and Debian/Ubuntu x64 archives. Other architectures are source-build targets. Compare the download with its SHA-256 checksum before opening it. A matching checksum checks the file against the published bytes. Publisher identity is established through a platform signature.

The public Windows and macOS launchers are unsigned. The macOS package has no Apple notarization. SmartScreen, Smart App Control, Gatekeeper, and managed-device policies may warn about or block these downloads. If the app is blocked, keep your system protections enabled and consider the [source instructions](../README.md#from-source). See [Microsoft SmartScreen](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation) and [Apple's guidance for opening apps](https://support.apple.com/en-us/102445).

Verify an archive using its companion checksum from the release. On Windows, run `Get-FileHash -Algorithm SHA256 -LiteralPath .\FolderDrop-1.0.0-windows-x64.zip` and compare the hash. On macOS and Linux, run `shasum -a 256 -c <archive-name>.sha256` or `sha256sum -c <archive-name>.sha256` from the download directory.

FolderDrop is provided as is, without warranty. Use it at your own risk. The [MIT License](../LICENSE) describes the limits on the liability of the authors and copyright holders.

Local and LAN sharing use the included runtime. To enable Cloudflare Quick Tunnel, select **Public link (Cloudflare)** and use **Install verified Cloudflare connector** if the provider is missing. The CLI also supports `tunnel-install`. See [networking and privacy](networking.md).

## Build from source

Use the native target OS and CPU with npm and Node 24. Windows needs the .NET Framework C# compiler included with the supported build environment. macOS needs `ditto` and `plutil`. Debian/Ubuntu needs `dpkg-deb`.

```sh
npm run build:desktop
```

The build checks the upstream Node archive against pinned SHA-256 values, installs locked production dependencies into a temporary bundle, packages the launcher and its runtime, and smoke-tests the extracted archive using the launcher from outside its installation directory. The platform package and its checksum land in `dist/`.

## Windows publisher signing

Install SignTool from the Windows SDK and make your publisher code-signing certificate available in the current user's Personal (`My`) certificate store. The private key can remain on its signing device. Set the certificate thumbprint and run the signed build:

```powershell
$env:FOLDERDROP_SIGNTOOL = 'C:\Path\To\WindowsSDK\x64\signtool.exe'
$env:FOLDERDROP_SIGNING_THUMBPRINT = '<40-character certificate thumbprint>'
npm run build:desktop -- --signed
```

Omit `FOLDERDROP_SIGNTOOL` if SignTool is already on `PATH`. The build uses DigiCert's RFC 3161 timestamp service by default. Set `FOLDERDROP_SIGNING_TIMESTAMP_URL` to use your publisher's service. SignTool signs the launcher with SHA-256 and verifies the signature and timestamp on the extracted copy. A failed signature or smoke test leaves the previous published artifact in place. Signed ZIP filenames end in `-signed.zip`. The Authenticode signature covers the launcher. Use the companion SHA-256 checksum to check the complete ZIP. See [Microsoft SignTool](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool).

## Optional macOS signing and notarization

Use a native Mac to run `npm run verify:release` and `npm run build:desktop` for the target architecture. For a signed and notarized build, use a Developer ID Application identity and Apple's [distribution signing guide](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac) to sign nested executables before signing the `.app` with the hardened runtime. Submit the signed archive with `notarytool`, staple and validate the app, then recreate the ZIP with `ditto` and generate its checksum. Install the final archive on a clean Mac to verify Gatekeeper and the bundled JavaScript runtime. See [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
