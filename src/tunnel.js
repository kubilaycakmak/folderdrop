import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { check, Problem } from './errors.js';
import { token } from './security.js';

const exec = promisify(execFile);
const VERSION = '2026.11.0';
const assets = {
  'linux-x64': ['linux-amd64', '51f7c68b57ed7269164075d7e789efce5b59355982f06392deeb037d982a51fd'],
  'linux-arm64': ['linux-arm64', 'abe54a006acf9faf2d19ee9d953cb0d0804e92f59c5382a162e57b84d086f56f'],
  'darwin-x64': ['darwin-amd64.tgz', '8a59d51120cebbe902f0a8d6e1b7a7fd4f9a5bb4dcb3e0f05872483e75e7db6b'],
  'darwin-arm64': ['darwin-arm64.tgz', '8c2f90277ef06a6080bb40b964d33f09f1188102f8798f2e344174b6cf41accf'],
  'win32-x64': ['windows-amd64.exe', 'd5c1d82031da6253dcdcff64c944cd0fe063016edeb2e4fd088075fc9bd52d0a']
};
const binaryName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
const platformAsset = () => assets[`${process.platform}-${process.arch}`];
const providerDir = directory => path.join(directory, 'providers', VERSION);
const binaryPath = directory => path.join(providerDir(directory), binaryName);
const cleanVariables = () => Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^(?:TUNNEL_|QUICK_TUNNEL_|CLOUDFLARED_)/i.test(name)));

export function launchConnector(binary, args, options) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./tunnel-child.js', import.meta.url)), binary, ...args],
    { ...options, stdio: [...options.stdio, 'ipc'] });
  child.stop = () => {
    if (child.connected) child.send('stop', error => { if (error) child.kill(); });
  };
  return child;
}

async function decompressTar(buffer) {
  const chunks = [];
  let size = 0;
  for await (const chunk of Readable.from([buffer]).pipe(createGunzip())) {
    size += chunk.length;
    check(size <= 100 * 1024 ** 2, 502, 'The provider archive exceeds the extraction limit.');
    chunks.push(chunk);
  }
  const tar = Buffer.concat(chunks);
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = tar.subarray(offset, offset + 100).toString().split('\0')[0];
    if (!name) break;
    const length = Number.parseInt(tar.subarray(offset + 124, offset + 136).toString().replace(/\0/g, '').trim(), 8);
    check(Number.isSafeInteger(length) && length >= 0 && offset + 512 + length <= tar.length, 502, 'Invalid provider archive.');
    if (['cloudflared', './cloudflared'].includes(name) && [0, 48].includes(tar[offset + 156])) {
      return tar.subarray(offset + 512, offset + 512 + length);
    }
    offset += 512 + Math.ceil(length / 512) * 512;
  }
  throw new Problem(502, 'The provider archive did not contain cloudflared.');
}

export async function installTunnel(directory) {
  const asset = platformAsset();
  check(asset, 400, 'No pinned download exists for this platform. Install cloudflared through Cloudflare and set FOLDERDROP_CLOUDFLARED.');
  const [name, expected] = asset;
  const folder = providerDir(directory);
  const target = binaryPath(directory);
  const response = await fetch(`https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/cloudflared-${name}`,
    { signal: AbortSignal.timeout(120000) });
  check(response.ok, 502, 'Could not download the pinned cloudflared release from GitHub.');
  const chunks = [];
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    check(size <= 80 * 1024 ** 2, 502, 'The provider download exceeds the size limit.');
    hash.update(chunk);
    chunks.push(Buffer.from(chunk));
  }
  check(hash.digest('hex') === expected, 502, 'The cloudflared checksum did not match. The download was discarded.');
  const archive = Buffer.concat(chunks);
  const binary = name.endsWith('.tgz') ? await decompressTar(archive) : archive;
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const temp = path.join(folder, `install-${token(12)}`);
  try {
    await fs.writeFile(temp, binary, { mode: 0o700, flag: 'wx' });
    await fs.rename(temp, target);
    if (name.endsWith('.tgz')) await fs.writeFile(`${target}.tgz`, archive, { mode: 0o600 });
  } finally { await fs.rm(temp, { force: true }); }
  return { path: target, version: VERSION, verified: true };
}

export async function resolveTunnel(directory) {
  const configured = process.env.FOLDERDROP_CLOUDFLARED;
  if (configured) {
    check(path.isAbsolute(configured), 400, 'Set FOLDERDROP_CLOUDFLARED to an absolute executable pathname.');
    return configured;
  }
  const installed = binaryPath(directory);
  const currentAsset = platformAsset();
  if (currentAsset) {
    const [name, expected] = currentAsset;
    const contents = await fs.readFile(installed).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (contents) {
      const archive = name.endsWith('.tgz') ? await fs.readFile(`${installed}.tgz`).catch(() => null) : contents;
      check(archive && createHash('sha256').update(archive).digest('hex') === expected &&
        (!name.endsWith('.tgz') || (await decompressTar(archive)).equals(contents)), 502, 'The managed cloudflared binary changed. Reinstall it.');
      return installed;
    }
  }
  // Avoid searching the working directory on Windows.
  for (const folder of (process.env.PATH ?? '').split(path.delimiter).filter(value => path.isAbsolute(value))) {
    const candidate = path.join(folder, binaryName);
    if ((await fs.stat(candidate).catch(() => null))?.isFile()) return candidate;
  }
  throw new Problem(503, 'Install cloudflared, set FOLDERDROP_CLOUDFLARED, or run folderdrop tunnel-install.');
}

export async function tunnelVersion(directory) {
  try {
    const executable = await resolveTunnel(directory);
    const { stdout } = await exec(executable, ['--version'], { env: cleanVariables(), windowsHide: true, timeout: 5000, maxBuffer: 8192 });
    check(/cloudflared version \S+/i.test(stdout), 503, 'The configured executable did not identify itself as cloudflared.');
    return { available: true, version: stdout.match(/cloudflared version (\S+)/i)[1], executable };
  } catch (error) {
    return { available: false, message: error instanceof Problem ? error.message : 'cloudflared could not run. Check permissions and architecture.' };
  }
}

async function port() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}

export class Tunnel {
  state = { connection: 'connecting', addresses: [], reachability: 'unverified' };
  #controller = new AbortController();
  constructor(binary, target, directory, probe, launch = launchConnector) {
    this.binary = binary;
    this.target = target;
    this.directory = directory;
    this.probe = probe;
    this.launch = launch;
    this.run = this.supervise();
  }

  async supervise() {
    const signal = this.#controller.signal;
    const config = path.join(this.directory, `cloudflared-quick-${token(12)}.yml`);
    try {
      await fs.writeFile(config, '{}\n', { mode: 0o600, flag: 'wx' });
      let retry = 1000;
      while (!signal.aborted) {
        const metrics = await port();
        if (signal.aborted) break;
        let url;
        let stdout = '';
        let hints = '';
        let ended = false;
        const child = this.launch(this.binary, ['tunnel', '--config', config, '--no-autoupdate',
          '--metrics', `127.0.0.1:${metrics}`, '--url', this.target],
        { cwd: this.directory, env: cleanVariables(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const exit = new Promise(resolve => {
          child.once('exit', () => { ended = true; resolve(); });
          child.once('error', () => { ended = true; resolve(); });
        });
        const receive = chunk => {
          stdout = (stdout + chunk.toString()).slice(-8192);
          url ??= stdout.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=[\s|/])/i)?.[0];
          this.candidate = url;
          if (/unable to reach|failed to request|network is unreachable|lookup .* no such host/i.test(stdout)) hints = 'Check DNS, outbound HTTPS and Cloudflare tunnel connectivity.';
        };
        child.stdout?.on('data', receive);
        child.stderr?.on('data', receive);
        const stop = () => child.stop ? child.stop() : child.kill();
        const startup = Date.now();
        let readyAt = 0;
        while (!ended && !signal.aborted) {
          const ready = await fetch(`http://127.0.0.1:${metrics}/ready`, { signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]) })
            .then(async result => { await result.body?.cancel(); return result.ok; }).catch(() => false);
          if (ready && url) {
            retry = 1000;
            readyAt ||= Date.now();
            const externallyVerified = await this.probe(url, signal);
            this.state = { connection: 'provider_connected', addresses: [url], reachability: externallyVerified ? 'origin_probe_ok' : 'unverified' };
          } else {
            this.state = { connection: readyAt ? 'reconnecting' : 'connecting', addresses: [], reachability: 'unverified', message: hints || undefined };
          }
          if (!readyAt && Date.now() - startup > 35000) break;
          await Promise.race([exit, delay(readyAt ? 5000 : 800, null, { signal, ref: false }).catch(() => {})]);
        }
        if (!ended) {
          stop();
          await Promise.race([exit, delay(2500, null, { ref: false })]);
          if (!ended) { child.kill('SIGKILL'); await exit; }
        }
        if (signal.aborted) break;
        this.candidate = undefined;
        this.state = { connection: 'reconnecting', addresses: [], reachability: 'unverified',
          message: hints || 'cloudflared disconnected. Check internet access, firewall, and the provider status. Retrying automatically.' };
        await delay(retry, null, { signal });
        retry = Math.min(retry * 2, 30000);
      }
    } catch {
      if (!signal.aborted) this.state = { connection: 'error', addresses: [], reachability: 'unverified',
        message: 'Could not supervise cloudflared. Check provider installation and data directory access.' };
    } finally { await fs.rm(config, { force: true }).catch(() => {}); }
  }

  async stop() {
    this.#controller.abort();
    await this.run;
    this.state = { connection: 'stopped', addresses: [], reachability: 'unverified' };
  }
}
