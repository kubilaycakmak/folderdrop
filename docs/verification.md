# Verification

Run the checks below in a checkout on the target operating system.

```sh
npm ci
npx playwright install chromium
npm run verify:release
```

The release command runs the build, integration tests, Chromium journeys, a production dependency audit, and the installed tarball check. On Linux, use `npx playwright install --with-deps chromium` if browser system libraries are missing. To exercise the phone flow in all supported test engines, run `npx playwright install chromium firefox webkit`, then `npm run test:browser -- --browser=all mobile-receiver.spec.js`.

Set `FOLDERDROP_KEEP_TARBALL=1` when running package verification to keep the tested release archive in the checkout. The verifier prints its exact contents and SHA-256 digest. From a production installation in a fresh directory and a different working directory it exercises the npm executable, CLI, HTTP, image/PDF/video previews, snapshots, and a genuine MCP handshake.

Run the release checks locally on Windows, macOS and Linux with Node 22.16.0 and Node 24. Include the platform and Node version in the review record. Run `npm run build:desktop` on each desktop package target. The initial repository revision passed all six platform and Node combinations before verification moved to local runs.

| Environment | Outcome |
| --- | --- |
| Windows x64, Node 22.16.0 and 26.13.0 | Integration tests, Chromium journeys, build, and installed tarball smoke test |
| Ubuntu 24.04 x64 on WSL2, Node 24.22.1 | Integration tests, Chromium journeys, build, and installed tarball smoke test |
| Native macOS 27.0.1 arm64, Node 24.22.1 | At `4a6aa6b`, 23 integration tests, 4 Chromium journeys, 4 WebKit journeys, production audit, clean tarball install, and the extracted desktop launcher passed. |
| Native macOS 27.0.1 arm64, Node 22.16.0 | At `4a6aa6b`, all 23 integration tests passed with the minimum supported Node version. |
| Initial release candidate across Windows, Linux, and macOS | All six OS and Node combinations passed. |
| Cloudflare Quick Tunnel | Windows x64 provider verified. Independent network probes in Germany and Finland received HTTP 200 from the live demo origin. Two separate Chromium contexts using the public URL confirmed unauthenticated access returned 401, first redemption returned 200, and reuse returned 410. After teardown Cloudflare returned 530 and no demo connector process remained. |
| HTTPS reverse proxy | Loopback TLS proxy, Secure cookie, recipient-only origin and resumed access after restart verified. |

Local integration tests cover code-redemption races, authorization and crossing origin boundaries, junction and hard-link checks, descriptor replacement, range and archive integrity, revision races, independent snapshots, transfer invalidation, restart recovery, upload limits and collisions, media metadata, a TLS reverse proxy and the provider supervisor with a simulated child and loopback readiness endpoint. Browser journeys cover the guided administration workflow, private receipt, screenshots, preview fallback, transfer tools, and contributions.

The Cloudflare binary acquisition and version check can be run without establishing a tunnel. End-to-end public delivery requires explicit operator intent, a real Cloudflare connection, and ideally a request from a second network. For a local verification of a TLS reverse proxy, use the documented upstream and a local test certificate. For deployment, verify the actual DNS, certificate and listener URL from a recipient network.
