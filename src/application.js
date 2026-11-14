import path from 'node:path';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import QRCode from 'qrcode';
import { Store } from './store.js';
import { Deliveries } from './deliveries.js';
import { Uploads } from './uploads.js';
import { Network } from './network.js';
import { recipientHandler } from './recipient.js';
import { inspectFolder, scan } from './files.js';
import { installTunnel, tunnelVersion } from './tunnel.js';
import { check, Problem } from './errors.js';
import { setTimeout as delay } from 'node:timers/promises';
import { Receiver } from './receiver.js';

export class Application {
  constructor(directory) {
    this.store = new Store(directory);
    this.deliveries = new Deliveries(this.store);
    this.uploads = new Uploads(this.deliveries);
    this.receiver = new Receiver();
    this.network = new Network(this.deliveries, recipientHandler(this.deliveries, this.uploads));
  }

  async open() {
    await this.deliveries.snapshots.recover();
    await this.deliveries.media.open();
    await this.uploads.recover();
    await this.network.restore();
    this.timer = setInterval(() => { this.deliveries.sweep(); this.network.sweep(); }, 150).unref();
    this.cleaner = setInterval(() => {
      this.deliveries.cleanup();
      this.maintenance ??= this.uploads.recover().catch(() => {}).finally(() => { this.maintenance = null; });
    }, 30000).unref();
  }

  inspect(id) {
    return { ...this.deliveries.inspect(id), connection: this.network.status(id),
      transfers: this.deliveries.transfers(id) };
  }

  links(id, recipientId) {
    const share = this.deliveries.get(id);
    const recipient = this.deliveries.recipient(share, recipientId);
    if (share.network?.mode === 'public' && !recipient.encryption) return [];
    return this.network.status(id).addresses.map(address => `${address}/s/${id}/${recipientId}`);
  }

  async diagnostics() {
    return { node: process.version, platform: process.platform, architecture: process.arch,
      dataDirectory: this.store.directory, tunnel: await tunnelVersion(this.store.directory),
      modes: ['local', 'lan', 'public', 'self-hosted'], preview: ['image', 'text', 'pdf', 'audio', 'video'], externalModel: false };
  }

  async call(action, input = {}) {
    const { id, recipient } = input;
    switch (action) {
      case 'list':
        return this.deliveries.list().map(share => ({ ...share, connection: this.network.status(share.id) }));
      case 'inspect': return this.inspect(id);
      case 'version-items': return this.deliveries.versionItems(id, input.version);
      case 'connection': return { connection: this.network.status(id), transfers: this.deliveries.transfers(id) };
      case 'scan': {
        check(typeof input.path === 'string', 400, 'Enter a folder path.');
        return scan(path.resolve(input.path));
      }
      case 'browse': return inspectFolder(input.path || await fs.realpath(homedir()));
      case 'create': return this.deliveries.save({ ...input, id: undefined, revision: undefined });
      case 'edit': return this.deliveries.save(input);
      case 'issue': {
        const issued = await this.deliveries.issue(id, input);
        return { ...issued, links: this.links(id, issued.id) };
      }
      case 'rotate': return { ...await this.deliveries.rotate(id, recipient), links: this.links(id, recipient) };
      case 'update-recipient': return this.deliveries.updateRecipient(id, recipient, input);
      case 'revoke-recipient': return this.deliveries.revokeRecipient(id, recipient);
      case 'remove-recipient': return this.deliveries.revokeRecipient(id, recipient, true);
      case 'links': {
        const links = this.links(id, recipient);
        const address = links[0];
        return { links, qr: address ? await QRCode.toDataURL(address, { width: 256, margin: 2 }) : null };
      }
      case 'start':
        check(input.mode !== 'public' || input.confirmPublic === true, 400, 'Explicitly confirm public sharing to start Cloudflare.');
        await this.network.start(id, input);
        return this.inspect(id);
      case 'verify': return this.network.verify(id);
      case 'stop': await this.network.stop(id); return this.inspect(id);
      case 'revoke': await this.network.stop(id, true); return this.inspect(id);
      case 'snapshot': return this.deliveries.snapshot(id, input.revision);
      case 'set-version': return this.deliveries.setVersion(id, input.revision, input.version);
      case 'remove-version': return this.deliveries.removeVersion(id, input.version);
      case 'remove': {
        const result = await this.deliveries.remove(id);
        await this.uploads.recover();
        return result;
      }
      case 'transfers': return this.deliveries.transfers(id);
      case 'diagnostics': return this.diagnostics();
      case 'tunnel-install': return installTunnel(this.store.directory);
      default: throw new Problem(404, 'Unknown FolderDrop operation.', 'unknown_operation');
    }
  }

  async close() {
    clearInterval(this.timer);
    clearInterval(this.cleaner);
    this.deliveries.abortAll();
    await this.network.close();
    await this.maintenance;
    for (let attempt = 0; attempt < 100 && (this.deliveries.tasks.size || this.uploads.busy.size); attempt++) await delay(25);
    await this.deliveries.media.close();
    this.store.close();
  }
}
