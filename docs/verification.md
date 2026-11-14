# Verification

Run the checks below in a checkout on the target operating system.

```sh
npm ci
npm run build
npm test
npx playwright install chromium
npm run test:browser
npm audit --omit=dev
npm run verify:package
```

On Linux, use `npx playwright install --with-deps chromium` if browser system libraries are missing. Set `FOLDERDROP_KEEP_TARBALL=1` when running package verification to keep the tested release archive in the checkout. The verifier prints its exact contents and SHA-256 digest. From a production installation in a fresh directory and a different working directory it exercises the npm executable, CLI, HTTP, image/PDF/video previews, snapshots, and a genuine MCP handshake.

The [native OS matrix](../.github/workflows/ci.yml) configures Windows, macOS and Linux runners for Node 22.16.0 and Node 24. The release review uses the results from locally accessible environments. A configured CI job does not constitute an observed pass.

| Environment | Outcome |
| --- | --- |
| Windows x64, Node 22.16.0 and 26.13.0 | Integration tests, Chromium journeys, build, and installed tarball smoke test |
| Ubuntu 24.04 x64 on WSL2, Node 24.22.1 | Integration tests, Chromium journeys, build, and installed tarball smoke test |
| Native Linux and macOS CI runners | Workflow configured. No hosted run was available in the local review. |
| Cloudflare Quick Tunnel | Windows x64 provider verified. Independent network probes in Germany and Finland received HTTP 200 from the live demo origin. Two separate Chromium contexts using the public URL confirmed unauthenticated access returned 401, first redemption returned 200, and reuse returned 410. After teardown Cloudflare returned 530 and no demo connector process remained. |
| HTTPS reverse proxy | Loopback TLS proxy, Secure cookie, recipient-only origin and resumed access after restart verified. |

Local integration tests cover code-redemption races, authorization and crossing origin boundaries, junction and hard-link checks, descriptor replacement, range and archive integrity, revision races, independent snapshots, transfer invalidation, restart recovery, upload limits and collisions, media metadata, a TLS reverse proxy and the provider supervisor with a simulated child and loopback readiness endpoint. Browser journeys cover the guided administration workflow, private receipt, screenshots, preview fallback, transfer tools, and contributions.

The Cloudflare binary acquisition and version check can be run without establishing a tunnel. End-to-end public delivery requires explicit operator intent, a real Cloudflare connection, and ideally a request from a second network. For a local verification of a TLS reverse proxy, use the documented upstream and a local test certificate. For deployment, verify the actual DNS, certificate and listener URL from a recipient network.
