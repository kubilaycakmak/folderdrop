import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Application } from './application.js';
import { Admin } from './admin.js';
import { closeServer, listen } from './network.js';
import { Store } from './store.js';
import { check, Problem } from './errors.js';
import { token } from './security.js';

const stateFile = directory => path.join(directory, 'runtime.json');
function running(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export async function serve(directory, port, ready) {
  const app = new Application(directory);
  const key = token(32);
  try {
    app.store.transaction(() => {
      check(!running(app.store.get('daemon', 'owner')?.pid), 409, 'Another FolderDrop service already owns this data directory.');
      app.store.put('daemon', { id: 'owner', pid: process.pid, key: key.slice(0, 12) });
    });
  } catch (error) { app.store.close(); throw error; }
  let server;
  let closing;
  let inFlight = 0;
  let drained;
  const drain = () => inFlight ? new Promise(resolve => { drained = resolve; }) : Promise.resolve();
  const close = () => {
    closing ??= (async () => {
      await fs.rm(stateFile(directory), { force: true });
      app.deliveries.abortAll();
      if (server) await closeServer(server);
      await drain();
      await app.close();
      const store = new Store(directory);
      store.transaction(() => {
        if (store.get('daemon', 'owner')?.key === key.slice(0, 12)) store.delete('daemon', 'owner');
      });
      store.close();
    })();
    return closing;
  };
  try {
    const admin = new Admin(app, key);
    admin.shutdown = close;
    server = await listen((req, res) => {
      inFlight++;
      void admin.handle(req, res).finally(() => { if (!--inFlight) drained?.(); });
    }, '127.0.0.1', port);
    admin.address = `http://127.0.0.1:${server.address().port}`;
    await app.open();
    const metadata = { origin: admin.address, secret: key, pid: process.pid };
    const temp = path.join(directory, `runtime-${key.slice(0, 12)}.tmp`);
    await fs.writeFile(temp, JSON.stringify(metadata), { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, stateFile(directory));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void close());
    if (ready) await ready(admin);
    return { app, admin, close };
  } catch (error) { await close(); throw error; }
}

export async function request(runtime, action, input) {
  const result = await fetch(`${runtime.origin}/rpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-FolderDrop-Action': '1', Authorization: `Bearer ${runtime.secret}` },
    body: JSON.stringify({ action, input })
  }).catch(() => { throw new Problem(503, 'The local FolderDrop service is unreachable.', 'service_unavailable'); });
  const data = await result.json();
  if (!result.ok) throw new Problem(result.status, data.error, data.code);
  return data;
}

export async function discover(directory) {
  try {
    const runtime = JSON.parse(await fs.readFile(stateFile(directory), 'utf8'));
    return /^http:\/\/127\.0\.0\.1:\d+$/.test(runtime.origin) && running(runtime.pid) && typeof runtime.secret === 'string' ? runtime : null;
  } catch { return null; }
}

export async function client(directory, port = 0) {
  let runtime = await discover(directory);
  if (runtime) return runtime;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/folderdrop.js', import.meta.url)),
    'daemon', '--data-dir', directory, '--admin-port', String(port)],
  { detached: true, windowsHide: true, stdio: 'ignore' });
  child.once('error', () => {});
  child.unref();
  for (let retry = 0; retry < 100; retry++) {
    await delay(100);
    runtime = await discover(directory);
    if (runtime) return runtime;
    if (child.exitCode !== null && retry > 12) break;
  }
  throw new Problem(503, 'FolderDrop could not start. Run folderdrop serve --no-open to see the startup error.', 'startup_failed');
}
