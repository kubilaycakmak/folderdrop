import path from 'node:path';
import { anchor, openAuthorized, relativeParts, MAX_ITEMS, stamp } from './files.js';
import { archivePaths, expiry, presentation, profile, text, unpackRoots, uploadRules } from './model.js';
import { accessCode, Capacity, digest, matchesSecret, secretHash, token } from './security.js';
import { check, Problem } from './errors.js';
import { Snapshots } from './snapshots.js';
import { MediaPreviews } from './media.js';
import { generateIdentity, identityToRecipient } from 'age-encryption';

const DAY = 86400000;
export const SESSION_AGE = 7 * DAY;
export const RESUME_AGE = 60 * 60 * 1000;
const overlap = (a, b) => {
  const relative = path.relative(a, b);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
export const closed = (record, now = Date.now()) => record.revoked || (record.expires != null && record.expires <= now);
const brief = ({ id, label, items, preview, download, upload, browseInbox, limit, expires, version, redeemed, revoked, count, encryption }) =>
  ({ id, label, items, preview, download, upload, browseInbox, limit, expires, version, redeemed, revoked, count, encrypted: !!encryption });

async function newEncryption() {
  const decryptionKey = await generateIdentity();
  const encryption = await identityToRecipient(decryptionKey);
  return { decryptionKey, encryption };
}

export class Deliveries {
  changes = new Capacity(4, 'Too many deliveries are being edited.');
  copying = new Capacity(1, 'A snapshot is already being copied.');
  hashing = new Capacity(4, 'Too many access attempts. Try again shortly.');
  reading = new Capacity(12, 'Too many deliveries are loading.');
  attempts = new Map();
  tasks = new Map();

  constructor(store) {
    this.store = store;
    this.snapshots = new Snapshots(store);
    this.media = new MediaPreviews(store.directory);
  }

  get(id) {
    const share = this.store.get('share', id);
    check(share, 404, 'Delivery not found.', 'not_found');
    return share;
  }

  recipients(id) {
    return this.store.byShare('recipient', id);
  }

  list() {
    return this.store.all('share').sort((a, b) => b.created - a.created).map(share => ({
      id: share.id, ...share.presentation, cover: undefined, enabled: share.enabled, network: share.network?.mode,
      expires: share.expires, revoked: share.revoked, count: share.items.length, revision: share.revision, version: share.version
    }));
  }

  inspect(id) {
    const share = this.get(id);
    const versions = this.versions(id);
    return { ...share, recipients: this.recipients(id).map(brief),
      versions: versions.map(({ id: version, bytes, created, count }) => ({ id: version, bytes, created, count })),
      snapshotBytes: versions.reduce((sum, version) => sum + version.bytes, 0) };
  }

  async save(input) {
    const release = this.changes.enter();
    try {
      const previous = input.id ? this.get(input.id) : undefined;
      check(!previous || !closed(previous), 410, 'This delivery has expired or been revoked. Create a new delivery.');
      check(!previous || input.revision === previous.revision, 409, 'This delivery changed. Reload it before editing.', 'conflict');
      const roots = input.roots === undefined && previous ? previous.roots : await Promise.all(unpackRoots(input.roots ?? []).map(async root =>
        ({ ...await anchor(root.source), label: root.label })));
      for (const root of roots) {
        check(!overlap(root.path, this.store.directory) && !overlap(this.store.directory, root.path),
          400, 'Source folders must be separate from the FolderDrop data directory.');
      }
      const entries = input.items ?? previous?.items ?? [];
      check(Array.isArray(entries) && entries.length <= MAX_ITEMS, 400, 'Choose up to 1,000 files.');
      const prior = new Map(previous?.items.map(item => [item.id, item]));
      const items = entries.map(item => {
        check(item && Number.isInteger(item.root) && roots[item.root], 400, 'Choose a source folder for each item.');
        const relative = relativeParts(item.relative).join('/');
        const display = relativeParts(item.path ?? `${roots[item.root].label}/${relative}`).join('/');
        const old = prior.get(item.id);
        const unchanged = old?.relative === relative && previous.roots[old.root]?.path === roots[item.root].path;
        return { id: unchanged ? old.id : token(16), root: item.root, relative, path: display,
          description: text(item.description, 1500, 'Description'), unchanged };
      });
      archivePaths(items);
      check(new Set(items.map(item => item.id)).size === items.length, 400, 'Choose each manifest item once.');
      check(Buffer.byteLength(JSON.stringify(items)) <= 2 * 1024 ** 2, 413, 'The delivery metadata is too large. Shorten item paths and descriptions.');
      for (const item of items) {
        if (!item.unchanged) {
          const { handle } = await openAuthorized(roots[item.root], item.relative);
          await handle.close();
        }
        delete item.unchanged;
      }
      let inbox = previous?.inbox ?? null;
      if (input.inbox === null) inbox = null;
      if (input.inbox) inbox = uploadRules(input.inbox, await anchor(input.inbox.path));
      if (inbox) this.validateInbox(inbox.root, roots);
      const display = presentation({ ...previous?.presentation, ...input.presentation }, items);
      const now = Date.now();
      const share = { id: previous?.id ?? token(), created: previous?.created ?? now, updated: now,
        revision: (previous?.revision ?? 0) + 1, roots, items, presentation: display, inbox,
        expires: input.expires === undefined ? previous?.expires ?? null : expiry(input.expires),
        enabled: previous?.enabled ?? false, revoked: false, version: previous?.version ?? null, network: previous?.network ?? null };
      const manifestChanged = previous && (previous.items.length !== items.length ||
        previous.items.some(item => !items.some(current => current.id === item.id)) ||
        JSON.stringify(previous.roots) !== JSON.stringify(roots));
      const inboxChanged = previous && JSON.stringify(previous.inbox) !== JSON.stringify(inbox);
      this.store.transaction(() => {
        if (previous) check(this.get(share.id).revision === previous.revision, 409, 'This delivery changed. Reload it before editing.', 'conflict');
        check(previous || this.store.keys('share').length < 500, 507, 'Remove a delivery before creating another.');
        this.store.put('share', share);
        if (previous) for (const recipient of this.recipients(share.id)) {
          const invalidate = (manifestChanged && !recipient.version) || (inboxChanged && recipient.upload);
          if (!invalidate) continue;
          // A live profile never automatically expands to newly selected files.
          const allowed = new Set(items.map(item => item.id));
          if (!recipient.version) recipient.items = recipient.items.filter(item => allowed.has(item));
          if (!inbox) { recipient.upload = false; recipient.browseInbox = false; }
          this.invalidate(recipient);
        }
      });
      this.sweep();
      return this.inspect(share.id);
    } finally { release(); }
  }

  validateInbox(root, roots) {
    const separate = folder => !overlap(folder, root.path) && !overlap(root.path, folder);
    check(separate(this.store.directory) && roots.every(source => separate(source.path)), 400,
      'Choose an inbox outside the source folders and the FolderDrop data directory.');
  }

  versions(id) { return this.store.snapshotCatalog(id); }

  versionItems(id, version) {
    const { items } = this.content(this.get(id), version);
    return items.map(({ integrityStamp, ...item }) => item);
  }

  async snapshot(id, revision) {
    const release = this.copying.enter();
    try {
      const share = this.get(id);
      check(!share.revoked && share.revision === revision, 409, 'Reload the delivery before taking a snapshot.');
      const version = await this.snapshots.copy(share);
      try {
        this.store.transaction(() => {
          const fresh = this.get(id);
          check(fresh.revision === revision && !fresh.revoked, 409, 'The delivery changed during copying. No snapshot was published.');
          this.store.put('snapshot', version);
          this.store.put('share', { ...fresh, version: version.id, revision: fresh.revision + 1 });
        });
      } catch (error) { await this.snapshots.erase(version.id); throw error; }
      return this.inspect(id);
    } finally { release(); }
  }

  setVersion(id, revision, version) {
    const share = this.get(id);
    check(!share.revoked && share.revision === revision, 409, 'Reload the delivery before changing its default version.');
    check(!version || this.versions(id).some(item => item.id === version), 404, 'Version not found.');
    this.store.put('share', { ...share, version: version ?? null, revision: revision + 1 });
    return this.inspect(id);
  }

  async removeVersion(id, version) {
    const share = this.get(id);
    const record = this.store.get('snapshot', version);
    check(record?.share === id, 404, 'Version not found.');
    check((share.version !== version || closed(share)) && !this.recipients(id).some(recipient => recipient.version === version && !closed(recipient) && !closed(share)),
      409, 'Change the default version and revoke or expire links pinned to this version first.');
    this.store.transaction(() => {
      if (share.version === version) this.store.put('share', { ...share, version: null, revision: share.revision + 1 });
      this.store.delete('snapshot', version);
    });
    await this.snapshots.erase(version);
    return this.inspect(id);
  }

  content(share, version) {
    if (!version) return share;
    const published = this.store.get('snapshot', version);
    check(published?.share === share.id, 410, 'This version is no longer available.');
    return published;
  }

  async issue(id, input) {
    const share = this.get(id);
    check(!closed(share), 410, 'This delivery has expired or been revoked.');
    const version = input.version === undefined ? share.version : input.version || null;
    const content = this.content(share, version);
    const encrypted = input.encrypted ?? share.network?.mode === 'public';
    check(typeof encrypted === 'boolean', 400, 'Select a valid encryption mode.');
    check(share.network?.mode !== 'public' || encrypted, 400, 'Cloudflare requires an encrypted recipient link.');
    check(!encrypted || (input.download !== false && !input.upload && !input.browseInbox), 400,
      'Encrypted links only support downloads. Use a separate trusted delivery for file requests.');
    const permissions = profile(encrypted ? { ...input, preview: false } : input, content.items, !!share.inbox);
    const items = permissions.items ?? content.items.map(item => item.id);
    check(!encrypted || items.length > 0, 400, 'Select at least one file for the encrypted archive.');
    const code = accessCode();
    const release = this.hashing.enter();
    try {
      const { encryption, decryptionKey } = encrypted ? await newEncryption() : {};
      const hash = await secretHash(code);
      const recipient = this.store.transaction(() => {
        check(this.get(id).revision === share.revision, 409, 'The delivery changed. Review and retry.');
        check(this.recipients(id).length < 100, 507, 'Remove a recipient before adding another.');
        return this.store.put('recipient', { ...permissions, id: token(16), share: id, version, hash, encryption,
          items, redeemed: null,
          revoked: false, epoch: 0, count: 0 });
      });
      return { ...brief(recipient), code, ...(decryptionKey ? { decryptionKey } : {}) };
    } finally { release(); }
  }

  recipient(share, id) {
    const recipient = this.store.get('recipient', id);
    check(recipient?.share === share.id, 404, 'This private link is unavailable.', 'not_found');
    return recipient;
  }

  async rotate(id, recipientId) {
    const share = this.get(id);
    const recipient = this.recipient(share, recipientId);
    check(!closed(share) && !closed(recipient), 410, 'This link is closed. Issue a new link.');
    const code = accessCode();
    const release = this.hashing.enter();
    try {
      const { encryption, decryptionKey } = recipient.encryption ? await newEncryption() : {};
      const hash = await secretHash(code);
      const fresh = this.recipient(this.get(id), recipientId);
      check(fresh.epoch === recipient.epoch && !closed(fresh) && !closed(this.get(id)), 409, 'The link changed. Reload and retry.');
      this.store.transaction(() => this.invalidate({ ...fresh, redeemed: null, hash, encryption }));
      this.sweep();
      return { ...brief(this.recipient(share, recipientId)), code, ...(decryptionKey ? { decryptionKey } : {}) };
    } finally { release(); }
  }

  invalidate(recipient) {
    this.store.delete('session', recipient.id);
    this.store.clearGrants(recipient.id);
    this.store.put('recipient', { ...recipient, epoch: recipient.epoch + 1 });
  }

  updateRecipient(id, recipientId, input) {
    const share = this.get(id);
    const recipient = this.recipient(share, recipientId);
    check(!closed(share) && !closed(recipient), 410, 'This link is closed.');
    check(!recipient.encryption || (input.download !== false && !input.upload && !input.browseInbox), 400,
      'Encrypted links only support downloads. Use a separate trusted delivery for file requests.');
    const updated = profile({ ...recipient, ...input, ...(recipient.encryption ? { preview: false } : {}) },
      this.content(share, recipient.version).items, !!share.inbox);
    const items = updated.items ?? this.content(share, recipient.version).items.map(item => item.id);
    check(!recipient.encryption || items.length > 0, 400, 'Select at least one file for the encrypted archive.');
    this.store.transaction(() => this.invalidate({ ...recipient, ...updated, items }));
    this.sweep();
    return brief(this.recipient(share, recipientId));
  }

  revokeRecipient(id, recipientId, remove = false) {
    const recipient = this.recipient(this.get(id), recipientId);
    this.store.transaction(() => {
      this.invalidate({ ...recipient, revoked: true, hash: null });
      if (remove) this.store.delete('recipient', recipientId);
    });
    this.sweep();
    return { id: recipientId, revoked: true, removed: remove };
  }

  gate(id, recipientId) {
    const share = this.get(id);
    const recipient = this.recipient(share, recipientId);
    check(share.enabled && !closed(share) && !closed(recipient), 410, 'This private link is no longer available.', 'link_closed');
    return { share, recipient };
  }

  async redeem(id, recipientId, value) {
    const { recipient } = this.gate(id, recipientId);
    check(!recipient.redeemed, 410, 'This access code has already been used. Ask the sender for a new code.', 'code_used');
    const code = text(value, 64, 'Access code').replace(/[\s-]+/g, '').toUpperCase();
    check(/^[A-F0-9]{20}$/.test(code), 401, 'Enter the access code from the sender.', 'code_invalid');
    const now = Date.now();
    const cached = this.attempts.get(recipientId);
    const limit = cached?.until > now ? cached : { count: 0, until: now + 60000 };
    check(limit.count < 12, 429, 'Too many attempts. Wait a minute and try again.', 'rate_limited');
    const release = this.hashing.enter();
    this.attempts.set(recipientId, { ...limit, count: limit.count + 1 });
    try {
      check(await matchesSecret(code.match(/.{5}/g).join('-'), recipient.hash), 401, 'That code did not match.', 'code_invalid');
      return this.store.transaction(() => {
        const fresh = this.gate(id, recipientId).recipient;
        check(!fresh.redeemed, 410, 'This access code has already been used. Ask the sender for a new code.', 'code_used');
        check(fresh.epoch === recipient.epoch, 409, 'The code changed. Enter the new code.');
        const secret = token(32);
        this.store.put('recipient', { ...fresh, redeemed: now, hash: null });
        this.store.put('session', { id: fresh.id, secret: digest(secret), expires: now + SESSION_AGE, epoch: fresh.epoch });
        this.attempts.delete(recipientId);
        return secret;
      });
    } finally { release(); }
  }

  context(id, recipientId, secret, permission) {
    const { share, recipient } = this.gate(id, recipientId);
    const session = this.store.get('session', recipientId);
    check(typeof secret === 'string' && /^[\w-]{43}$/.test(secret) && session &&
      session.secret === digest(secret) && session.expires > Date.now() && session.epoch === recipient.epoch,
      401, 'Enter your one-time access code.', 'authentication_required');
    check(!permission || recipient[permission], 403, 'The sender disabled this action.', 'permission_denied');
    const content = this.content(share, recipient.version);
    return { share, recipient, content, items: content.items.filter(item => recipient.items.includes(item.id)), session };
  }

  preview(id, recipientId) {
    const share = this.get(id);
    const recipient = recipientId ? this.recipient(share, recipientId) :
      { preview: true, download: true, upload: !!share.inbox, browseInbox: false, version: share.version, items: null };
    const content = this.content(share, recipient.version);
    return { share, recipient, content, items: content.items.filter(item => !recipient.items || recipient.items.includes(item.id)), dryRun: true };
  }

  item(context, id) {
    const item = context.items.find(item => item.id === id);
    check(item, 404, 'This file is outside the recipient manifest.', 'not_found');
    return item;
  }

  async open(context, item) {
    if (!context.content.root) return openAuthorized(context.share.roots[item.root], item.relative);
    const file = await openAuthorized(context.content.root, item.id);
    if (item.integrityStamp && stamp(file.stat) !== item.integrityStamp) {
      await file.handle.close();
      throw new Problem(409, 'The stored snapshot file changed. Ask the sender for another version.', 'snapshot_changed');
    }
    return file;
  }

  canDownload(context) {
    if (context.dryRun) return true;
    const { recipient } = this.gate(context.share.id, context.recipient.id);
    return recipient.limit == null || recipient.count < recipient.limit;
  }

  grant(context, kind, key, requestedId) {
    if (context.dryRun) return { id: token(16) };
    const recipientId = context.recipient.id;
    return this.store.transaction(() => {
      const { recipient } = this.gate(context.share.id, recipientId);
      check(recipient.epoch === context.recipient.epoch && recipient.download, 403, 'The download permission changed.');
      const grants = this.store.grants(recipientId).filter(grant => grant.epoch === recipient.epoch && grant.until > Date.now());
      const existing = grants.find(grant => grant.kind === kind && grant.key === key && (!requestedId || grant.id === requestedId));
      if (existing && (kind === 'file' || kind === 'encrypted' || requestedId)) return existing;
      check(!requestedId, 410, 'The resume grant expired or the file changed.');
      check(grants.length < 128, 429, 'Too many active download grants. Try again later.');
      check(recipient.limit == null || recipient.count < recipient.limit, 403, 'The download limit has been reached.', 'download_limit');
      this.store.put('recipient', { ...recipient, count: recipient.count + 1 });
      return this.store.put('grant', { id: token(16), recipient: recipientId, key, kind, epoch: recipient.epoch, until: Date.now() + RESUME_AGE });
    });
  }

  mayGrant(context, item, stat) {
    if (context.dryRun) return true;
    const { recipient } = this.gate(context.share.id, context.recipient.id);
    const key = `${item.id}:"${item.sha256 ?? digest(stamp(stat))}"`;
    const allowed = this.canDownload(context);
    check(allowed || this.store.grants(recipient.id).some(grant => grant.kind === 'file' &&
      grant.key === key && grant.epoch === recipient.epoch && grant.until > Date.now()), 403, 'The download limit has been reached.', 'download_limit');
    return true;
  }

  begin(context, kind, total, recheck) {
    if (this.tasks.size >= 64) throw new Problem(429, 'Too many transfers are active. Try again shortly.', 'busy');
    const controller = new AbortController();
    const task = { id: token(12), share: context.share.id, recipient: context.dryRun ? null : context.recipient.id,
      kind, total, bytes: 0, started: Date.now(), controller, recheck };
    this.tasks.set(task.id, task);
    return { signal: controller.signal, add: bytes => { task.bytes += bytes; }, setTotal: size => { task.total = size; },
      done: () => this.tasks.delete(task.id) };
  }

  transfers(share) {
    return [...this.tasks.values()].filter(task => !share || task.share === share).map(({ controller, recheck, ...task }) => task);
  }

  sweep() {
    const now = Date.now();
    for (const task of this.tasks.values()) {
      try { task.recheck(); } catch { task.controller.abort(); }
    }
    for (const [id, attempt] of this.attempts) if (attempt.until <= now) this.attempts.delete(id);
  }

  abortAll() {
    for (const task of this.tasks.values()) task.controller.abort();
  }

  cleanup() {
    this.store.clearExpired(Date.now());
  }

  toggle(id, mode, enabled, revoked = false) {
    const share = this.get(id);
    check(!enabled || !closed(share), 410, 'This delivery has expired or been revoked.');
    check(!enabled || share.items.length > 0 || share.version, 400, 'Select a file or snapshot before starting.');
    this.store.transaction(() => {
      this.store.put('share', { ...share, enabled, revoked: share.revoked || revoked, network: mode ?? share.network, revision: share.revision + 1 });
      if (revoked) for (const recipient of this.recipients(id)) {
        this.invalidate({ ...recipient, hash: null, revoked: true });
      }
    });
    this.sweep();
    return this.inspect(id);
  }

  async remove(id) {
    const share = this.get(id);
    check(!share.enabled, 409, 'Stop or revoke the delivery before removing it.');
    const versions = this.versions(id);
    this.store.transaction(() => {
      for (const recipient of this.recipients(id)) {
        this.store.delete('session', recipient.id);
        this.store.clearGrants(recipient.id);
        this.store.delete('recipient', recipient.id);
      }
      for (const version of versions) this.store.delete('snapshot', version.id);
      this.store.delete('share', id);
    });
    this.sweep();
    for (const version of versions) await this.snapshots.erase(version.id);
    return { id, removed: true };
  }
}
