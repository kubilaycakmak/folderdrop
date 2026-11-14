import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { launchConnector, Tunnel } from '../src/tunnel.js';
import { fixture } from './helpers.js';

test('provider supervision reconnects with a new address and tears down the child', { timeout: 14000 }, async t => {
  const f = await fixture(t);
  const children = [];
  const simulated = (binary, args, options) => {
    assert.equal(binary, 'cloudflared');
    assert.deepEqual(args.slice(0, 2), ['tunnel', '--config']);
    assert.equal(path.dirname(args[2]), f.data);
    assert.match(path.basename(args[2]), /^cloudflared-quick-[\w-]{16}\.yml$/);
    assert.equal(args[3], '--no-autoupdate');
    assert.equal(args.at(-1), 'http://127.0.0.1:7318');
    assert.equal(options.stdio[0], 'ignore');
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const server = createServer((req, res) => res.writeHead(req.url === '/ready' ? 200 : 404).end());
    child.kill = () => { server.close(() => child.emit('exit')); server.closeAllConnections(); };
    const number = children.push(child);
    const port = Number(args[args.indexOf('--metrics') + 1].split(':')[1]);
    server.listen(port, '127.0.0.1', () => child.stderr.write(`| https://folderdrop-test-${number}.trycloudflare.com |\n`));
    return child;
  };
  const tunnel = new Tunnel('cloudflared', 'http://127.0.0.1:7318', f.data, async url => url.includes('-2.'), simulated);
  t.after(() => tunnel.stop());
  async function ready(index) {
    for (let attempt = 0; attempt < 90; attempt++) {
      if (tunnel.state.addresses[0]?.includes(`-${index}.`)) return tunnel.state;
      await delay(100);
    }
    assert.fail(`Provider ${index} never became ready`);
  }
  assert.equal((await ready(1)).reachability, 'unverified');
  children[0].kill();
  assert.equal((await ready(2)).reachability, 'origin_probe_ok');
  await tunnel.stop();
  assert.equal(tunnel.state.connection, 'stopped');
  assert.equal(children.length, 2);
});

test('disconnecting the provider owner closes its child process', { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const child = launchConnector(process.execPath, ['-e', 'console.log(process.pid); setInterval(() => {}, 1000);'],
    { cwd: f.data, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  child.stderr.resume();
  t.after(() => { if (child.connected) child.stop(); child.stdout.destroy(); child.stderr.destroy(); });
  const [info] = await once(child.stdout, 'data');
  const provider = Number(info.toString().trim());
  assert.ok(provider > 0);
  child.disconnect();
  await exited;
  assert.throws(() => process.kill(provider, 0), { code: 'ESRCH' });
});
