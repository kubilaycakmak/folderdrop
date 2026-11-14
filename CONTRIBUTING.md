# Contributing

Use Node.js 22.16 or newer and install locked dependencies with `npm ci`. Run `npm run dev` to open administration or `npm run dev -- --no-open` on a terminal-only host. Use a dedicated `--data-dir` for destructive manual tests.

| Command | Purpose |
| --- | --- |
| `npm run build` | Validate modules and production dependency resolution. Application assets are already runnable. |
| `npm test` | Run Node integration tests against isolated filesystem fixtures and local HTTP listeners. |
| `npx playwright install chromium` | Install the Chromium browser used by the journeys. Add `--with-deps` on Linux when system libraries are needed. |
| `npm run test:browser` | Exercise administration and receipt in real Chromium browser contexts. |
| `npm run verify:package` | Pack, audit the file list, install production dependencies from the tarball, and smoke-test the installed runtime. |
| `npm audit --omit=dev` | Check the runtime dependency tree with the npm advisory service. |

Run verification locally and record the operating system and Node version in the pull request. For releases, verify Windows, macOS, and Linux using the minimum Node version and Node 24. Keep tests and demos on loopback unless you have been asked to open a real listener to another network. See [verification](docs/verification.md).

For filesystem or permission changes, test a direct URL as well as the browser UI. For a report about credentials, avoid attaching logs, HAR files, links, codes, or source contents. Describe the affected version and expected boundary.
