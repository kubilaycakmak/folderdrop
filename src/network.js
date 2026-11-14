import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { closed } from './deliveries.js';
import { check, Problem } from './errors.js';
import { integer } from './model.js';
import { token } from './security.js';
import { Tunnel, tunnelVersion } from './tunnel.js';

const address = (host, port) => new URL(`http://${host.includes(':') ? `[${host}]` : host}:${port}`).origin;
export async function listen(handler, host, port) {
  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 120000, headersTimeout: 10000 }, handler);
  server.maxConnections = 128;
  server.keepAliveTimeout = 5000;
  server.setTimeout(125000);
  try {
    await new Promise((resolve, reject) => server.once('error', reject).listen({ host, port, exclusive: true }, resolve));
  } catch (error) {
    throw new Problem(409, error.code === 'EADDRINUSE' ? 'This port is already in use. Choose another port.' : 'Could not bind this interface. Check its address and port.', 'bind_failed');
  }
  return server;
}

export async function closeServer(server) {
  await new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

export function settings(input) {
  const mode = input.mode ?? 'local';
  check(['local', 'lan', 'public', 'self-hosted'].includes(mode), 400, 'Choose local, LAN, public, or self-hosted mode.');
  const host = mode === 'lan' ? input.host || '0.0.0.0' : mode === 'self-hosted' ? input.host || '127.0.0.1' : '127.0.0.1';
  check(isIP(host) && !host.includes('%'), 400, 'Choose an IPv4 or IPv6 interface address.');
  const port = integer(input.port, mode === 'self-hosted' ? 1 : 0, 65535, 'Port', mode === 'self-hosted' ? 7318 : 0);
  let external = null;
  if (mode === 'self-hosted') {
    let url;
    try { url = new URL(input.external); } catch {}
    check(url?.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
      400, 'Enter an HTTPS external origin such as https://deliveries.example.com.');
    external = url.origin;
  }
  return { mode, host, port, external };
}

function networkAddresses(host, port) {
  if (host !== '0.0.0.0' && host !== '::') return [address(host, port)];
  const interfaces = Object.values(networkInterfaces()).flat().filter(item => item && !item.internal &&
    !item.address.includes('%') && !/^fe80:/i.test(item.address) && (host === '::' || item.family === 'IPv4'));
  return [...new Set(interfaces.map(item => address(item.address, port)))];
}

export class Network {
  active = new Map();
  starting = new Set();
  failures = new Map();
  constructor(deliveries, handler) { this.deliveries = deliveries; this.handler = handler; }

  status(id) {
    const share = this.deliveries.get(id);
    if (closed(share)) return { connection: 'closed', addresses: [], reachability: 'unverified' };
    const entry = this.active.get(id);
    if (entry) return entry.tunnel?.state ?? entry.status;
    if (this.failures.has(id)) return { connection: 'error', addresses: [], reachability: 'unverified', message: this.failures.get(id) };
    return { connection: 'stopped', addresses: [], reachability: 'unverified' };
  }

  async start(id, input, restore = false) {
    check(!this.active.has(id) && !this.starting.has(id), 409, 'Stop the current listener before starting another one.');
    const initial = this.deliveries.get(id);
    check(!closed(initial), 410, 'This delivery has expired or been revoked.');
    check(initial.items.length || initial.version, 400, 'Select files or a snapshot before starting.');
    check(this.active.size + this.starting.size < 32, 507, 'Stop another listener before starting this delivery.');
    const plan = settings(input);
    this.starting.add(id);
    this.failures.delete(id);
    let server;
    let tunnel;
    try {
      const provider = plan.mode === 'public' ? await tunnelVersion(this.deliveries.store.directory) : null;
      check(!provider || provider.available, 503, provider?.message);
      const nonce = token(18);
      let origins = new Set();
      const currentOrigins = () => new Set([...origins, ...(tunnel?.state.addresses ?? []), ...(tunnel?.candidate ? [tunnel.candidate] : [])]);
      server = await listen((req, res) => this.handler(req, res, {
        share: id, origins: currentOrigins(), nonce,
        secure: plan.mode === 'public' || plan.mode === 'self-hosted', encryptedOnly: plan.mode === 'public'
      }), plan.host, plan.port);
      const actual = server.address().port;
      const upstream = address(plan.host, actual);
      const addresses = plan.mode === 'self-hosted' ? [plan.external] : networkAddresses(plan.host, actual);
      origins = new Set(addresses);
      if (plan.mode === 'lan' && plan.host === '::') origins.add(address('::1', actual));
      if (plan.mode === 'lan' && ['0.0.0.0', '::'].includes(plan.host)) origins.add(address('127.0.0.1', actual));
      if (plan.mode === 'public' || plan.mode === 'self-hosted') origins.add(upstream);
      const probe = async (external, signal) => fetch(`${external}/_folderdrop/ready/${nonce}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(3500)]), redirect: 'error'
      }).then(async response => {
        await response.body?.cancel();
        return response.status === 204 && response.headers.get('x-folderdrop-probe') === nonce;
      }).catch(() => false);
      if (!restore) this.deliveries.toggle(id, { ...plan, port: plan.mode === 'public' ? 0 : actual }, true);
      if (provider) tunnel = new Tunnel(provider.executable, upstream, this.deliveries.store.directory, probe);
      const state = { connection: plan.mode === 'self-hosted' ? 'proxy_listener' : 'listening',
        addresses, upstream: plan.mode === 'self-hosted' ? upstream : undefined,
        reachability: plan.mode === 'local' ? 'loopback' : 'unverified',
        message: plan.mode === 'lan' && !addresses.length ? 'No usable interfaces were detected. Connect to your network.' : undefined };
      this.active.set(id, { server, tunnel, status: state, probe, plan });
      return this.status(id);
    } catch (error) {
      await tunnel?.stop();
      if (server) await closeServer(server);
      throw error;
    } finally { this.starting.delete(id); }
  }

  async verify(id) {
    const entry = this.active.get(id);
    check(entry?.plan.mode === 'self-hosted', 400, 'Start the self-hosted listener first.');
    entry.status.reachability = await entry.probe(entry.plan.external, AbortSignal.timeout(4000)) ? 'origin_probe_ok' : 'unverified';
    return this.status(id);
  }

  async closeListener(id) {
    const entry = this.active.get(id);
    this.active.delete(id);
    if (!entry) return;
    await entry.tunnel?.stop();
    await closeServer(entry.server);
  }

  async stop(id, revoke = false) {
    check(!this.starting.has(id), 409, 'Wait for the listener to finish starting.');
    this.deliveries.toggle(id, null, false, revoke);
    this.failures.delete(id);
    await this.closeListener(id);
    return this.status(id);
  }

  async restore() {
    for (const summary of this.deliveries.list().filter(share => share.enabled)) {
      const share = this.deliveries.get(summary.id);
      if (closed(share) || share.network?.mode === 'public' || !share.network) {
        this.deliveries.toggle(share.id, null, false);
        continue;
      }
      try { await this.start(share.id, share.network, true); }
      catch (error) {
        this.deliveries.toggle(share.id, null, false);
        this.failures.set(share.id, error.message);
      }
    }
  }

  sweep() {
    for (const id of this.active.keys()) {
      const share = this.deliveries.get(id);
      if (!closed(share)) continue;
      if (share.enabled) this.deliveries.toggle(id, null, false);
      void this.closeListener(id).catch(() => {});
    }
  }

  async close() { await Promise.all([...this.active.keys()].map(id => this.closeListener(id))); }
}
