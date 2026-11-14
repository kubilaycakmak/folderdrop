import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { fileTypeFromBuffer } from 'file-type';
import { anchor, identity, inboxEntries, linkInbox, namePart } from './files.js';
import { check, Problem } from './errors.js';
import { token } from './security.js';
import { closed } from './deliveries.js';
import { integer } from './model.js';

const CHUNK = 8 * 1024 ** 2;
const IDLE = 24 * 60 * 60 * 1000;
const visible = ({ id, name, size, offset, complete, mime }) => ({ id, name, size, offset, complete, mime });

function collisionName(filename, index) {
  if (!index) return filename;
  const { name, ext } = path.parse(filename);
  const suffix = ` (${index})`;
  const budget = 240 - Buffer.byteLength(ext) - suffix.length;
  if (budget < 1) return collisionName(`${[...filename].slice(0, 50).join('')}.download`, index);
  let base = '';
  for (const char of name) {
    if (Buffer.byteLength(base + char) > budget) break;
    base += char;
  }
  return `${base || 'f'}${suffix}${ext}`;
}

async function sniff(handle, size) {
  const sample = Buffer.alloc(Math.min(32768, size));
  const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
  const data = sample.subarray(0, bytesRead);
  const known = await fileTypeFromBuffer(data).catch(() => null);
  if (known) return known.mime;
  if (data.some(byte => byte < 32 && ![9, 10, 13].includes(byte))) return 'application/octet-stream';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data, { stream: bytesRead < size });
    return 'text/plain';
  } catch { return 'application/octet-stream'; }
}

export class Uploads {
  busy = new Map();
  locks = new Set();
  constructor(deliveries) { this.deliveries = deliveries; this.store = deliveries.store; }

  async stageRoot(root, create = false) {
    const folder = path.join(root.path, '.folderdrop-incoming');
    const current = await anchor(root.path);
    check(current.identity === root.identity, 409, 'The inbox moved. Ask the sender to reconnect it.');
    if (create) await fs.mkdir(folder, { mode: 0o700 }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    return anchor(folder);
  }

  async stage(record) {
    const folder = await this.stageRoot(record.root);
    check(folder.identity === record.stageIdentity && /^[\w-]{24}$/.test(record.id), 409, 'The upload staging directory changed.');
    return path.join(folder.path, record.id);
  }

  async create(input, getContext) {
    const context = getContext();
    const rules = context.share.inbox;
    check(rules && !context.dryRun, 403, 'Uploads are disabled here.');
    const name = namePart(input.name);
    const size = integer(input.size, 0, rules.maxFile, 'Upload size');
    const inboxKey = rules.root.identity;
    check(!this.locks.has(inboxKey), 429, 'The inbox is busy. Try again shortly.');
    this.locks.add(inboxKey);
    try {
      const actual = await inboxEntries(rules.root);
      const outstanding = this.store.all('upload').filter(upload => upload.root.identity === inboxKey && !upload.complete);
      check(actual.length + outstanding.length < rules.maxFiles, 413, 'The inbox file-count limit has been reached.');
      check(size + actual.reduce((sum, file) => sum + file.size, 0) +
        outstanding.reduce((sum, upload) => sum + upload.size, 0) <= rules.maxTotal,
      413, 'The inbox storage limit has been reached.');
      check(this.store.all('upload').length < 20000, 507, 'The upload catalog is full.');
      const folder = await this.stageRoot(rules.root, true);
      getContext();
      const record = { id: token(18), name, size, offset: 0, root: rules.root, stageIdentity: folder.identity,
        recipient: context.recipient.id, epoch: context.recipient.epoch, share: context.share.id, touched: Date.now(), complete: false };
      const handle = await fs.open(path.join(folder.path, record.id), 'wx', 0o600);
      try {
        record.identity = identity(await handle.stat({ bigint: true }));
        getContext();
        this.store.put('upload', record);
      } catch (error) {
        await fs.unlink(path.join(folder.path, record.id)).catch(() => {});
        throw error;
      } finally { await handle.close(); }
      return visible(record);
    } finally { this.locks.delete(inboxKey); }
  }

  record(id, context) {
    const upload = this.store.get('upload', id);
    check(upload?.recipient === context.recipient.id && upload.epoch === context.recipient.epoch &&
      upload.share === context.share.id, 404, 'This upload session is unavailable.');
    return upload;
  }

  list(context) {
    return this.store.byShare('upload', context.share.id).filter(upload =>
      upload.recipient === context.recipient.id && upload.epoch === context.recipient.epoch ||
      context.recipient.browseInbox && upload.complete)
      .sort((a, b) => b.touched - a.touched).slice(0, 200).map(visible);
  }

  status(id, getContext) { return visible(this.record(id, getContext())); }

  async open(record) {
    const location = await this.stage(record);
    const stat = await fs.lstat(location, { bigint: true });
    check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && identity(stat) === record.identity, 409, 'The staged upload changed.');
    const handle = await fs.open(location, constants.O_RDWR | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const actual = await handle.stat({ bigint: true });
    const verified = await fs.lstat(location, { bigint: true }).catch(() => null);
    if (!actual.isFile() || actual.nlink !== 1n || identity(actual) !== record.identity || !verified ||
        identity(verified) !== record.identity || await this.stage(record).catch(() => null) !== location) {
      await handle.close();
      throw new Problem(409, 'The staged upload changed.');
    }
    return { location, handle };
  }

  async patch(id, getContext, req) {
    const context = getContext();
    const record = this.record(id, context);
    check(!record.complete, 409, 'This upload is already complete.');
    check(req.headers['content-type'] === 'application/offset+octet-stream', 415, 'Send an upload chunk.');
    const length = integer(Number(req.headers['content-length']), 1, CHUNK, 'Chunk bytes');
    const start = Number(req.headers['upload-offset']);
    check(start === record.offset, 409, `The saved offset is ${record.offset} bytes.`, 'offset_mismatch');
    check(start + length <= record.size, 413, 'This chunk exceeds the declared file size.');
    const rules = context.share.inbox;
    check(!this.busy.has(id) && [...this.busy.values()].filter(value => value.inbox === rules.root.identity).length < rules.concurrency,
      429, 'The inbox has reached its concurrent upload limit.');
    const controller = new AbortController();
    const valid = () => { controller.signal.throwIfAborted(); getContext(); };
    const task = this.deliveries.begin(context, 'upload', length, valid);
    const abort = () => req.destroy();
    task.signal.addEventListener('abort', abort, { once: true });
    const progress = { controller, inbox: rules.root.identity, discard: false };
    this.busy.set(id, progress);
    let file;
    let offset = start;
    try {
      file = await this.open(record);
      await file.handle.truncate(start);
      for await (const chunk of req) {
        valid();
        check(offset + chunk.length <= start + length, 413, 'The chunk exceeded its declared size.');
        let written = 0;
        while (written < chunk.length) {
          const { bytesWritten } = await file.handle.write(chunk, written, chunk.length - written, offset + written);
          check(bytesWritten > 0, 507, 'The inbox could not save this chunk.');
          written += bytesWritten;
        }
        offset += written;
        task.add(written);
      }
      valid();
      check(offset === start + length, 400, 'The chunk ended early. Resume from the last saved offset.');
      await file.handle.sync();
      valid();
      this.store.put('upload', { ...record, offset, touched: Date.now() });
      return visible({ ...record, offset });
    } catch (error) {
      await file?.handle.truncate(start).catch(() => {});
      if (error.code === 'ENOSPC') throw new Problem(507, 'The inbox disk is full.');
      throw error;
    } finally {
      try {
        await file?.handle.close();
        if (progress.discard) await this.discard(record);
      } finally {
        this.busy.delete(id);
        task.done();
      }
    }
  }

  async finish(id, getContext) {
    const context = getContext();
    let record = this.record(id, context);
    if (record.complete) return visible(record);
    check(record.offset === record.size, 409, 'Resume the upload before completing it.');
    check(!this.busy.has(id), 429, 'Wait for this upload to finish writing.');
    const rules = context.share.inbox;
    check(!this.locks.has(rules.root.identity), 429, 'The inbox is busy. Try again shortly.');
    this.locks.add(rules.root.identity);
    this.busy.set(id, { controller: new AbortController(), inbox: rules.root.identity });
    try {
      if (record.target && await this.committed(record)) return this.acknowledge(record);
      const { location, handle } = await this.open(record);
      let mime;
      try {
        check((await handle.stat()).size === record.size, 409, 'The staged file size changed.');
        mime = await sniff(handle, record.size);
        check(rules.types.some(type => type === '*/*' || type === mime || type === `${mime.split('/')[0]}/*`),
          415, `The inbox does not accept ${mime} files.`);
        await handle.sync();
      } finally { await handle.close(); }
      for (let index = 0; index <= 999; index++) {
        check(!this.busy.get(id).controller.signal.aborted, 409, 'The upload was cancelled.');
        getContext();
        const target = collisionName(record.name, index);
        record = this.store.put('upload', { ...record, target, mime });
        try {
          // A completed atomic link is the commit point, even if access closes before the acknowledgement.
          await linkInbox(record.root, location, target);
          return await this.acknowledge(record);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
      }
      throw new Problem(409, 'Too many files use this name. Rename the file and try again.');
    } finally {
      try {
        if (this.busy.get(id)?.discard && !this.store.get('upload', id)?.complete) {
          if (record.target && await this.committed(record)) await this.acknowledge(record);
          else await this.discard(record);
        }
      } finally {
        this.busy.delete(id);
        this.locks.delete(rules.root.identity);
      }
    }
  }

  async committed(record) {
    const root = await anchor(record.root.path).catch(() => null);
    if (root?.identity !== record.root.identity) return false;
    const target = await fs.lstat(path.join(root.path, namePart(record.target)), { bigint: true }).catch(() => null);
    return target?.isFile() && !target.isSymbolicLink() && identity(target) === record.identity && Number(target.size) === record.size;
  }

  async acknowledge(record) {
    const location = await this.stage(record);
    await fs.unlink(location).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (process.platform !== 'win32') {
      const inbox = await fs.open(record.root.path, 'r');
      try { await inbox.sync(); } finally { await inbox.close(); }
    }
    return visible(this.store.put('upload', { ...record, name: record.target, complete: true, touched: Date.now() }));
  }

  async discard(record) {
    const location = await this.stage(record).catch(() => null);
    if (location) {
      const actual = await fs.lstat(location, { bigint: true }).catch(() => null);
      if (actual?.isFile() && identity(actual) === record.identity) {
        await fs.unlink(location).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    }
    this.store.delete('upload', record.id);
  }

  async cancel(id, getContext) {
    const record = this.record(id, getContext());
    check(!record.complete, 409, 'Completed uploads remain in the sender’s inbox.');
    const active = this.busy.get(id);
    if (active) { active.discard = true; active.controller.abort(); }
    this.deliveries.sweep();
    if (active) return { cancelling: true };
    if (record.target && await this.committed(record)) return this.acknowledge(record);
    await this.discard(record);
    return { cancelled: true };
  }

  async recover() {
    const now = Date.now();
    for (const record of this.store.all('upload')) {
      if (this.busy.has(record.id)) continue;
      if (record.complete) {
        if (now - record.touched > 30 * IDLE) this.store.delete('upload', record.id);
        continue;
      }
      const share = this.store.get('share', record.share);
      const recipient = this.store.get('recipient', record.recipient);
      if (record.target && await this.committed(record)) { await this.acknowledge(record); continue; }
      if (now - record.touched > IDLE || !share || closed(share) || !recipient || closed(recipient) ||
        recipient.epoch !== record.epoch) await this.discard(record);
    }
    const references = new Map(this.store.all('share').filter(share => share.inbox).map(share => [share.inbox.root.identity, share.inbox.root]));
    for (const record of this.store.all('upload')) references.set(record.root.identity, record.root);
    const catalog = new Set(this.store.all('upload').map(record => record.id));
    for (const [key, root] of references) {
      if (this.locks.has(key)) continue;
      const stage = await this.stageRoot(root).catch(() => null);
      if (!stage) continue;
      const dir = await fs.opendir(stage.path);
      for await (const item of dir) {
        if (!item.isFile() || !/^[\w-]{24}$/.test(item.name) || catalog.has(item.name) || this.locks.has(key) ||
            this.store.get('upload', item.name)) continue;
        const pathname = path.join(stage.path, item.name);
        const stat = await fs.lstat(pathname).catch(() => null);
        if (stat?.isFile() && stat.mtimeMs + IDLE < now) await fs.unlink(pathname).catch(() => {});
      }
    }
  }
}
