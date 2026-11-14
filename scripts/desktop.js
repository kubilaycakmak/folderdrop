import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifests = ['package.json', 'package-lock.json'];
const production = ['bin', 'src', 'web', 'LICENSE', 'SECURITY.md', 'README.md', 'docs'];
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const runtimeVersion = '24.22.3';
const targets = {
  'win32-x64': ['win-x64.zip', 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f'],
  'darwin-arm64': ['darwin-arm64.tar.gz', 'ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd'],
  'darwin-x64': ['darwin-x64.tar.gz', '977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7'],
  'linux-x64': ['linux-x64.tar.xz', '4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb'],
  'linux-arm64': ['linux-arm64.tar.xz', '6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c']
};
const target = `${process.platform}-${process.arch}`;
const [archiveSuffix, expected] = targets[target] ?? [];
if (!archiveSuffix || !process.env.npm_execpath) throw new Error('Run npm run build:desktop on a supported target.');

const windows = process.platform === 'win32';
const mac = process.platform === 'darwin';
const npmCli = process.env.npm_execpath;
const node = windows ? 'node.exe' : 'node';
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'folderdrop-desktop-'));
const stage = path.join(temporary, 'build');
const out = path.join(root, 'dist');
const bundle = mac ? path.join(stage, 'FolderDrop.app') : path.join(stage, 'FolderDrop');
const resources = mac ? path.join(bundle, 'Contents', 'Resources') : windows ? bundle : path.join(bundle, 'usr', 'lib', 'folderdrop');
const app = path.join(resources, 'app');
const runtime = path.join(resources, 'runtime');
const launcher = windows ? path.join(resources, 'FolderDrop.exe') : mac ? path.join(bundle, 'Contents', 'MacOS', 'FolderDrop') : path.join(resources, 'FolderDrop');
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options });

async function installRuntime() {
  const filename = `node-v${runtimeVersion}-${archiveSuffix}`;
  const archive = path.join(temporary, filename);
  const url = `https://nodejs.org/dist/v${runtimeVersion}/${filename}`;
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body) throw new Error(`Node.js download returned HTTP ${response.status}.`);
  const hash = createHash('sha256');
  let received = 0;
  const meter = new Transform({ transform(chunk, encoding, callback) {
    received += chunk.length;
    if (received > 80 * 1024 ** 2) return callback(new Error('Node.js download exceeds the size limit.'));
    hash.update(chunk);
    callback(null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(archive, { flags: 'wx' }));
  if (hash.digest('hex') !== expected) throw new Error('Node.js archive failed its pinned SHA-256 check.');
  const extracted = filename.replace(/\.(?:zip|tar\.gz|tar\.xz)$/, '');
  const executable = windows ? 'node.exe' : 'bin/node';
  run('tar', ['-xf', archive, '-C', temporary, `${extracted}/${executable}`, `${extracted}/LICENSE`]);
  await fs.mkdir(runtime, { recursive: true });
  await fs.copyFile(path.join(temporary, extracted, executable), path.join(runtime, node));
  await fs.copyFile(path.join(temporary, extracted, 'LICENSE'), path.join(runtime, 'LICENSE.nodejs'));
  if (!windows) await fs.chmod(path.join(runtime, node), 0o755);
}

async function writeLauncher() {
  if (windows) {
    const compiler = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    run(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/reference:System.Windows.Forms.dll',
      `/out:${launcher}`, path.join(root, 'desktop', 'launch.cs')]);
    return;
  }
  await fs.mkdir(path.dirname(launcher), { recursive: true });
  await fs.copyFile(path.join(root, 'desktop', mac ? 'launch-macos' : 'launch-linux'), launcher);
  await fs.chmod(launcher, 0o755);
  if (mac) {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>FolderDrop</string>
  <key>CFBundleIdentifier</key><string>com.github.kubilaycakmak.folderdrop</string>
  <key>CFBundleName</key><string>FolderDrop</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
</dict></plist>
`;
    const info = path.join(bundle, 'Contents', 'Info.plist');
    await fs.writeFile(info, plist);
    run('plutil', ['-lint', info]);
    return;
  }
  const applications = path.join(bundle, 'usr', 'share', 'applications');
  const icons = path.join(bundle, 'usr', 'share', 'icons', 'hicolor', 'scalable', 'apps');
  const bin = path.join(bundle, 'usr', 'bin');
  const control = path.join(bundle, 'DEBIAN');
  for (const directory of [applications, icons, bin, control]) await fs.mkdir(directory, { recursive: true });
  await fs.symlink('../lib/folderdrop/FolderDrop', path.join(bin, 'folderdrop-desktop'));
  await fs.copyFile(path.join(root, 'desktop', 'folderdrop.desktop'), path.join(applications, 'folderdrop.desktop'));
  await fs.copyFile(path.join(root, 'desktop', 'folderdrop.svg'), path.join(icons, 'folderdrop.svg'));
  const architecture = process.arch === 'arm64' ? 'arm64' : 'amd64';
  await fs.writeFile(path.join(control, 'control'), `Package: folderdrop
Version: ${version}
Section: net
Priority: optional
Architecture: ${architecture}
Maintainer: FolderDrop contributors <31804832+kubilaycakmak@users.noreply.github.com>
Depends: xdg-utils, libc6 (>= 2.34), libstdc++6
Description: Private file and folder sharing with one-time access codes
 FolderDrop opens its local sharing workspace in your default browser.
`);
}

async function makePackage() {
  const filename = `FolderDrop-${version}-${target}.${windows || mac ? 'zip' : 'deb'}`;
  const archive = path.join(out, filename);
  if (windows) run('tar', ['-a', '-cf', archive, '-C', stage, path.basename(bundle)]);
  else if (mac) run('ditto', ['-c', '-k', '--keepParent', bundle, archive]);
  else run('dpkg-deb', ['--root-owner-group', '--build', bundle, archive]);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  await fs.writeFile(`${archive}.sha256`, `${hash.digest('hex')}  ${filename}\n`);
  return archive;
}

async function smoke(archive) {
  const extracted = path.join(temporary, 'fresh user');
  const state = path.join(temporary, 'desktop-state');
  await fs.mkdir(extracted);
  if (windows) run('tar', ['-xf', archive, '-C', extracted]);
  else if (mac) run('ditto', ['-x', '-k', archive, extracted]);
  else run('dpkg-deb', ['--extract', archive, extracted]);
  const launcherPath = path.join(extracted, path.relative(windows || mac ? stage : bundle, launcher));
  const bundledNode = path.join(extracted, path.relative(windows || mac ? stage : bundle, runtime), node);
  const entry = path.join(extracted, path.relative(windows || mac ? stage : bundle, app), 'bin', 'folderdrop.js');
  const env = { ...process.env, FOLDERDROP_DATA_DIR: state };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  const invoke = (command, args) => execFileSync(command, args, { cwd: temporary, env, windowsHide: true, encoding: 'utf8', timeout: 15000 });
  try {
    const { version: actual } = JSON.parse(invoke(bundledNode, [entry, '--version', '--json']));
    if (actual !== version) throw new Error('The desktop archive returned an unexpected FolderDrop version.');
    const child = spawn(launcherPath, ['--no-open', '--json'], { cwd: temporary, env, windowsHide: true, stdio: 'ignore' });
    const launcherExit = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`The desktop launcher returned ${code}.`)));
    });
    const timer = setTimeout(() => child.kill(), 15000);
    try { await launcherExit; } finally { clearTimeout(timer); }
    const { discover, request } = await import(pathToFileURL(path.resolve(path.dirname(entry), '..', 'src', 'daemon.js')));
    const running = await discover(state);
    if (!running) throw new Error('The launcher did not start the bundled service.');
    const launch = await request(running, 'launch', {});
    const { origin, hash } = new URL(launch.url);
    const page = await fetch(origin, { signal: AbortSignal.timeout(5000) });
    if (!page.ok || !(await page.text()).includes('FolderDrop')) throw new Error('The launcher did not start the FolderDrop workspace.');
    const authenticated = await fetch(`${origin}/bootstrap`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-FolderDrop-Action': '1' }, body: JSON.stringify({ key: hash.slice(1) }) });
    if (!authenticated.ok) throw new Error('The desktop workspace could not redeem its launch key.');
    console.log(`Verified the desktop launcher, bundled Node, and workspace authentication for ${target}.`);
  } finally {
    invoke(bundledNode, [entry, 'shutdown', '--json']);
    for (let attempt = 0; attempt < 50; attempt++) {
      if (!(await fs.stat(path.join(state, 'runtime.json')).catch(() => null))) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

try {
  await fs.mkdir(app, { recursive: true });
  await fs.mkdir(out, { recursive: true });
  await installRuntime();
  for (const name of [...manifests, ...production]) await fs.cp(path.join(root, name), path.join(app, name), { recursive: true });
  run(path.join(runtime, node), [npmCli, 'ci', '--omit=dev', '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: app });
  await writeLauncher();
  const archive = await makePackage();
  await smoke(archive);
  console.log(archive);
} finally {
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
