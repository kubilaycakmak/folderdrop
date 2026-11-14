#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import QRCode from 'qrcode';
import { client, discover, request, serve } from '../src/daemon.js';
import { dataDirectory } from '../src/store.js';
import { check, Problem, problem } from '../src/errors.js';
import { integer } from '../src/model.js';
import { VERSION } from '../src/version.js';

const help = `FolderDrop ${VERSION}
Private, curated file delivery from your computer.

Usage: folderdrop [folder] [options]
       folderdrop <command> [delivery-id] [options]

  serve [folder]               Run in the foreground and open administration
  menu                         Interactive terminal menu
  create [folder]              Create a draft from a folder or --input manifest.json
  list                         List drafts and live listeners
  inspect <id>                 Show delivery, versions, profiles, and transfer status
  edit <id> --input file       Apply manifest JSON using the current revision
  snapshot <id>                Take an independent snapshot for new links
  set-version <id> [version]   Choose a version, or omit it to use live files
  remove-version <id> <version> Delete an unused owned version
  issue <id>                   Generate a new recipient and a one-time code
  rotate <id> <recipient>      End a session and generate a fresh one-time code
  update-recipient <id> <recipient> --input file
  revoke-recipient <id> <recipient>
  remove-recipient <id> <recipient>
  links <id> <recipient>       Show links and a terminal QR
  start <id>                   Start sharing (--mode local|lan|public|self-hosted)
  verify <id>                  Check the self-hosted HTTPS endpoint from this host
  stop <id>                    Stop a listener and interrupt ongoing transfers
  revoke <id>                  Permanently close a delivery
  remove <id>                  Remove a stopped delivery and its snapshots
  transfers [id]               Show active transfer progress
  diagnostics                  Check runtime and provider availability
  tunnel-install               Download and verify the pinned cloudflared release
  mcp                          Run the MCP server over stdio
  shutdown                     Stop the local service and all listeners

  -h, --help                  Show this help
  -v, --version               Print the version
  --json                      Return JSON (including errors)
  --data-dir PATH             Override the persistent data directory
  --admin-port PORT           Choose a loopback administration port (0 = automatic)
  --mode MODE                 Network mode for start (default local)
  --host IP --port PORT       Recipient listener interface and port
  --external HTTPS_ORIGIN     External origin for self-hosted mode
  --confirm-public            Explicitly authorize creation of a public tunnel
  --input FILE                Read operation parameters from a JSON file
  --title TEXT --label TEXT   Delivery title or recipient label
  --no-open                   Skip launching a browser

Exit status: 0 success, 2 input error, 3 not found, 4 denied/closed/conflict,
5 service or provider unavailable, 1 other failure.
`;

const commands = new Set('serve menu create list inspect edit snapshot set-version remove-version issue rotate update-recipient revoke-recipient remove-recipient links start verify stop revoke remove transfers diagnostics tunnel-install mcp shutdown daemon'.split(' '));
const strings = Object.fromEntries('data-dir admin-port mode host port external input title label'.split(' ').map(key => [key, { type: 'string' }]));
const flags = Object.fromEntries('json no-open confirm-public'.split(' ').map(key => [key, { type: 'boolean' }]));

function openBrowser(url) {
  const windows = process.platform === 'win32';
  const command = windows ? path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe') :
    process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [url], { detached: true, stdio: 'ignore', windowsHide: true });
  child.once('error', () => {});
  child.unref();
}

async function output(result, options, action) {
  if (options.json) { console.log(JSON.stringify(result)); return; }
  if (action === 'launch') {
    if (options['no-open']) console.log(`Administration launch link (one use, two minutes)\n${result.url}`);
    else {
      openBrowser(result.url);
      console.log(`FolderDrop administration opened at ${new URL(result.url).origin}. Use --no-open if a browser is unavailable.`);
    }
    return;
  }
  const { links, qr, ...rest } = Array.isArray(result) ? { results: result } : result;
  if (Object.keys(rest).length) console.log(JSON.stringify(rest, null, 2));
  if (links?.length) {
    console.log(links.join('\n'));
    if (process.stdout.isTTY) console.log(await QRCode.toString(links[0], { type: 'terminal', small: true }));
  }
}

async function config(file) {
  if (!file) return {};
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    check(data && typeof data === 'object' && !Array.isArray(data), 400, 'Input must be a JSON object.');
    return data;
  } catch { throw new Problem(400, 'Could not read a valid JSON input file.'); }
}

async function main() {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: { ...strings, ...flags,
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' } } });
  } catch (error) { throw new Problem(400, error.message); }
  const options = args.values;
  if (options.help) { console.log(help); return; }
  if (options.version) { console.log(options.json ? JSON.stringify({ version: VERSION }) : VERSION); return; }
  const [first, second, third, fourth] = args.positionals;
  check(!fourth, 400, 'Too many positional arguments. Run folderdrop --help.');
  const directory = dataDirectory(options['data-dir']);
  const adminPort = integer(options['admin-port'] === undefined ? undefined : Number(options['admin-port']), 0, 65535, 'Admin port', 0);
  const action = commands.has(first) ? first : 'launch';
  const initial = first && !commands.has(first) ? path.resolve(first) : second && action === 'serve' ? path.resolve(second) : undefined;
  if (action === 'mcp') { await (await import('../src/mcp.js')).mcp(directory); return; }
  if (action === 'daemon' || action === 'serve') {
    await serve(directory, adminPort, action === 'serve' ? admin => output(admin.launch(initial), options, 'launch') : undefined);
    return;
  }
  if (action === 'shutdown' && !await discover(directory)) return output({ stopped: true }, options, action);
  if (action === 'menu') {
    check(process.stdin.isTTY && process.stdout.isTTY && !options.json, 400, 'The menu needs an interactive terminal. Use folderdrop --help for commands.');
  }
  if (action === 'launch' && initial) {
    const { stat } = await import('node:fs/promises');
    check((await stat(initial).catch(() => null))?.isDirectory(), 400, 'Pass an existing folder or run folderdrop --help.');
  }
  const runtime = await client(directory, adminPort);
  const call = (operation, input) => request(runtime, operation, input);
  if (action === 'menu') {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      while (true) {
        const answer = await terminal.question('\n1 Open administration\n2 List deliveries\n3 Inspect a delivery\n4 Start locally\n5 Stop a delivery\n6 Diagnostics\n0 Exit\n> ');
        const operation = { 1: 'launch', 2: 'list', 3: 'inspect', 4: 'start', 5: 'stop', 6: 'diagnostics' }[answer.trim()];
        if (answer.trim() === '0') break;
        if (!operation) continue;
        try {
          const id = ['inspect', 'start', 'stop'].includes(operation) ? (await terminal.question('Delivery ID: ')).trim() : undefined;
          await output(await call(operation, { id }), options, operation);
        } catch (error) { console.error(problem(error).message); }
      }
    } finally { terminal.close(); }
    return;
  }
  let input = { ...await config(options.input), id: second, ...(initial ? { initial } : {}) };
  if (action === 'create' && second) {
    const scanned = await call('scan', { path: path.resolve(second) });
    const name = path.basename(scanned.root) || 'Files';
    input = { ...input, roots: [{ path: scanned.root, label: 'Files' }], items: scanned.files.map(file => ({ root: 0, relative: file.relative, path: file.relative })),
      presentation: { title: name, ...input.presentation } };
  }
  if (options.title !== undefined) input.presentation = { ...input.presentation, title: options.title };
  if (options.label !== undefined) input.label = options.label;
  if (['rotate', 'update-recipient', 'revoke-recipient', 'remove-recipient', 'links'].includes(action)) input.recipient = third;
  if (['set-version', 'remove-version'].includes(action)) input.version = third ?? null;
  if (['edit', 'snapshot', 'set-version'].includes(action) && input.revision === undefined) input.revision = (await call('inspect', { id: second })).revision;
  if (action === 'start') {
    input = { ...input, mode: options.mode ?? input.mode, host: options.host ?? input.host, external: options.external ?? input.external,
      port: options.port === undefined ? input.port : Number(options.port), confirmPublic: options['confirm-public'] === true };
  }
  let result = await call(action, input);
  if (action === 'start' && input.mode === 'public') {
    for (let count = 0; count < 45 && ['connecting', 'reconnecting'].includes(result.connection.connection); count++) {
      await delay(1000);
      result = await call('inspect', { id: second });
    }
    check(result.connection.connection === 'provider_connected', 503,
      'Cloudflare did not become ready. Check folderdrop inspect for connection status. The service continues retrying until stopped.');
  }
  await output(result, options, action);
}

try { await main(); } catch (error) {
  const safe = problem(error);
  const exit = safe.status === 404 ? 3 : [401, 403, 409, 410, 429].includes(safe.status) ? 4 :
    safe.status >= 502 ? 5 : safe.status < 500 ? 2 : 1;
  if (process.argv.includes('--json')) console.log(JSON.stringify({ error: safe.message, code: safe.code }));
  else console.error(safe.message);
  process.exitCode = exit;
}
