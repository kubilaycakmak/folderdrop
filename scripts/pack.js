import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCB } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCB);
const root = fileURLToPath(new URL('../', import.meta.url));
const sandbox = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'folderdrop-pack-'));
const cwd = path.join(sandbox, 'fresh-user');
const data = path.join(sandbox, 'data');
const source = path.join(sandbox, 'originals');
const outside = path.join(sandbox, 'outside-installation');
const entry = path.join(cwd, 'node_modules', '@kubilaycakmak', 'folderdrop', 'bin', 'folderdrop.js');
const env = { ...process.env };
delete env.NODE_PATH;
delete env.NODE_OPTIONS;
const npm = async (args, directory) => {
  assert.ok(process.env.npm_execpath, 'Run this verifier with npm run verify:package.');
  return execFile(process.execPath, [process.env.npm_execpath, ...args], { cwd: directory, env, timeout: 180000, maxBuffer: 2 ** 20 });
};
const run = async (...args) => JSON.parse((await execFile(process.execPath, [entry, ...args, '--json', '--data-dir', data],
  { cwd: outside, env, timeout: 20000 })).stdout);

try {
  await Promise.all([cwd, source, outside].map(folder => fs.mkdir(folder)));
  await fs.writeFile(path.join(source, 'hello.txt'), 'Packed application smoke test.');
  const pack = await npm(['pack', '--json', '--pack-destination', sandbox], root);
  const [archive] = JSON.parse(pack.stdout);
  const files = archive.files.map(file => file.path);
  for (const file of ['bin/folderdrop.js', 'src/application.js', 'src/tunnel-child.js', 'src/pdf-worker.js', 'src/mcp.js', 'web/admin.html',
    'web/recipient.html', 'web/style.css', 'demo/fixtures.js', 'package.json', 'README.md', 'LICENSE']) assert.ok(files.includes(file), file);
  for (const file of files) assert.match(file, /^(?:bin\/|src\/|web\/|demo\/|docs\/|package\.json$|README\.md$|LICENSE$|CHANGELOG\.md$|CONTRIBUTING\.md$)/);
  await fs.writeFile(path.join(cwd, 'package.json'), '{"name":"fresh-folderdrop-user","version":"1.0.0","private":true}');
  await npm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', path.join(sandbox, archive.filename)], cwd);
  const dependencyList = await npm(['ls', '--omit=dev', '--all', '--json'], cwd);
  assert.ok(JSON.parse(dependencyList.stdout).dependencies['@kubilaycakmak/folderdrop']);
  const executable = await npm(['exec', '--offline', '--', 'folderdrop', '--version', '--json'], cwd);
  assert.equal(JSON.parse(executable.stdout).version, archive.version);
  const installed = new Set(await fs.readdir(path.join(cwd, 'node_modules')));
  assert.ok(!installed.has('@playwright') && !installed.has('yauzl'));
  assert.equal((await run('--version')).version, archive.version);
  const launch = await run('--no-open', source);
  const admin = new URL(launch.url);
  const shell = await fetch(admin.origin);
  assert.match(await shell.text(), /FolderDrop/);
  assert.equal((await fetch(`${admin.origin}/assets/admin.js`)).status, 200);
  const share = await run('create', source);
  await run('snapshot', share.id);
  await run('start', share.id);
  const recipient = await run('issue', share.id);
  const redeemed = await fetch(`${recipient.links[0]}/redeem`, { method: 'POST',
    headers: { 'X-FolderDrop-Action': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ code: recipient.code }) });
  assert.equal(redeemed.status, 200);
  const cookie = redeemed.headers.get('set-cookie').split(';')[0];
  const original = await fetch(`${recipient.links[0]}/download/${share.items[0].id}`, { headers: { Cookie: cookie } });
  assert.equal(await original.text(), 'Packed application smoke test.');
  const demoEntry = path.resolve(path.dirname(entry), '../demo/create.js');
  const demo = JSON.parse((await execFile(process.execPath, [demoEntry, path.join(sandbox, 'demo')],
    { cwd: outside, env, timeout: 15000 })).stdout);
  const curated = await run('create', '--input', demo.manifest);
  await run('start', curated.id);
  const previewLink = await run('issue', curated.id);
  const previewSession = await fetch(`${previewLink.links[0]}/redeem`, { method: 'POST',
    headers: { 'X-FolderDrop-Action': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ code: previewLink.code }) });
  assert.equal(previewSession.status, 200);
  const previewCookie = previewSession.headers.get('set-cookie').split(';')[0];
  for (const [suffix, route, mime] of [['.jpg', 'preview', 'image/webp'], ['.pdf', 'preview', 'image/png'], ['.webm', 'media', 'video/webm']]) {
    const item = curated.items.find(item => item.path.endsWith(suffix));
    const response = await fetch(`${previewLink.links[0]}/${route}/${item.id}`, { headers: { Cookie: previewCookie } });
    assert.equal(response.status, 200, suffix);
    assert.ok(response.headers.get('content-type').startsWith(mime));
    assert.ok((await response.arrayBuffer()).byteLength > 100);
  }
  const { Client } = await import('@modelcontextprotocol/client');
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  const mcp = new Client({ name: 'folderdrop-packed-smoke', version: '1' });
  try {
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [entry, 'mcp', '--data-dir', data], cwd: outside }));
    assert.ok((await mcp.listTools()).tools.some(tool => tool.name === 'issue_access_code'));
    assert.equal((await mcp.callTool({ name: 'inspect_delivery', arguments: { id: share.id } })).structuredContent.items, 1);
  } finally { await mcp.close(); }
  await run('revoke', share.id);
  const packed = path.join(sandbox, archive.filename);
  const sha256 = createHash('sha256').update(await fs.readFile(packed)).digest('hex');
  console.log(`Verified ${archive.filename} (${files.length} files, ${archive.size} bytes) through a clean production install, CLI, HTTP, previews, snapshot, and MCP.`);
  console.log(`SHA-256 ${sha256}`);
  console.log(files.join('\n'));
  if (process.env.FOLDERDROP_KEEP_TARBALL === '1') await fs.copyFile(packed, path.join(root, archive.filename));
} finally {
  await run('shutdown').catch(() => {});
  await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
