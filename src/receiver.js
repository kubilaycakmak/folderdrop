import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Decrypter, identityToRecipient } from 'age-encryption';
import { anchor, linkInbox } from './files.js';
import { check, Problem } from './errors.js';
import { body, json } from './http.js';
import { Capacity } from './security.js';
import { MAX_ENCRYPTED_ZIP as MAX_BYTES } from './transfers.js';

const RETRY_AGE = 10 * 60 * 1000;
const idPattern = /^[\w-]{43}$/;
const privateHost = /^(?:127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\]|\[f[cd][a-f0-9:]+\])$/i;

function address(input) {
  let url;
  try { url = new URL(input); } catch {}
  check(url && (url.protocol === 'https:' || url.protocol === 'http:' && privateHost.test(url.hostname)) &&
    !url.username && !url.password && !url.search && !url.hash &&
    /^\/s\/[\w-]{32}\/[\w-]{22}$/.test(url.pathname),
  400, 'Paste a FolderDrop recipient link over HTTPS or on a private local network.');
  return url.href;
}

async function redeem(link, code, recipientKey, signal) {
  const response = await fetch(`${link}/redeem`, { method: 'POST', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', 'X-FolderDrop-Action': '1' },
    body: JSON.stringify({ code, recipientKey }) });
  if (response.status === 410) {
    await response.body?.cancel();
    throw new Problem(410, 'The one-time code was used, expired, or the sender closed the link.', 'link_closed');
  }
  if (response.status === 422) {
    await response.body?.cancel();
    throw new Problem(422, 'The decryption key does not match this delivery. Check the key and try again.', 'decryption_key_mismatch');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Problem(response.status === 401 ? 401 : 502, response.status === 401 ?
      'The one-time access code did not match.' : 'The sender could not open this encrypted link.', 'redemption_failed');
  }
  const reader = response.body?.getReader();
  const chunks = [];
  let count = 0;
  try {
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      check(count <= 1024, 502, 'The sender returned an invalid encrypted session.');
      chunks.push(value);
    }
  } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
  let session;
  try { ({ session } = JSON.parse(Buffer.concat(chunks).toString())); } catch {}
  check(typeof session === 'string' && idPattern.test(session), 502, 'The sender returned an invalid encrypted session.');
  return session;
}

function limitedZip(expected) {
  let size = 0;
  let prefix = Buffer.alloc(0);
  return new Transform({
    transform(chunk, encoding, done) {
      size += chunk.length;
      try {
        check(size <= MAX_BYTES, 413, 'The delivery exceeds the 16 GiB receiving limit.');
        if (prefix.length < 4) {
          prefix = Buffer.concat([prefix, chunk.subarray(0, 4 - prefix.length)]);
          if (prefix.length === 4) check(prefix.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
            422, 'The encrypted content is not a FolderDrop ZIP archive.');
        }
        done(null, chunk);
      } catch (error) { done(error); }
    },
    flush(done) { done(prefix.length < 4 || size !== expected ? new Problem(422, 'The encrypted archive was incomplete.') : undefined); }
  });
}

export class Receiver {
  capacity = new Capacity(2, 'Two encrypted downloads are already active.');
  attempts = new Map();

  async handle(req, res) {
    const signal = new AbortController();
    res.once('close', () => signal.abort());
    const input = await body(req, 8192);
    res.setTimeout(0);
    return json(res, await this.receive(input, signal.signal));
  }

  async receive(input, clientSignal = new AbortController().signal) {
    const link = address(input.link);
    const { decryptionKey, code, retry } = input;
    check(typeof decryptionKey === 'string' && /^AGE-SECRET-KEY-1[0-9A-Z]{58}$/.test(decryptionKey),
      400, 'Enter the decryption key separately provided by the sender.');
    let recipientKey;
    try { recipientKey = await identityToRecipient(decryptionKey); }
    catch { throw new Problem(400, 'The decryption key is invalid. Check the key from the sender.'); }
    check(typeof code === 'string' && /^[0-9A-Fa-f\s-]{20,32}$/.test(code), 400, 'Enter the one-time access code.');
    check(typeof retry === 'string' && idPattern.test(retry), 400, 'Start a new receiving session.');
    check(typeof input.destination === 'string' && path.isAbsolute(input.destination), 400, 'Choose a local destination folder.');
    const root = await anchor(input.destination);
    const release = this.capacity.enter();
    const download = new AbortController();
    const signal = AbortSignal.any([download.signal, clientSignal, AbortSignal.timeout(90 * 60 * 1000)]);
    let stage;
    let pending;
    let owned = false;
    try {
      for (const [id, attempt] of this.attempts) if (!attempt.active && attempt.until <= Date.now()) this.attempts.delete(id);
      pending = this.attempts.get(retry);
      check(!pending?.active, 409, 'This encrypted download is already running.');
      check(!pending || pending.link === link, 409, 'Use a new receiving session for a different link.');
      check(pending || this.attempts.size < 24, 429, 'Too many pending receiving sessions. Try again shortly.');
      pending ??= { link, until: Date.now() + RETRY_AGE };
      pending.active = true;
      this.attempts.set(retry, pending);
      owned = true;
      stage = await fs.mkdtemp(path.join(root.path, '.folderdrop-receive-'));
      const temporary = path.join(stage, 'archive.part');
      pending.session ??= await redeem(link, code, recipientKey, signal);
      const response = await fetch(`${link}/encrypted`, { signal, redirect: 'error',
        headers: { 'X-FolderDrop-Session': pending.session, 'Accept-Encoding': 'identity' } });
      if (!response.ok) {
        await response.body?.cancel();
        if ([401, 403, 404, 410].includes(response.status)) this.attempts.delete(retry);
        throw new Problem(response.status, 'The sender could not deliver the archive. Check permissions, expiration and connection.');
      }
      const ciphertextBytes = Number(response.headers.get('content-length'));
      check(response.body && !response.headers.get('content-encoding') && response.headers.get('content-type') === 'application/octet-stream' &&
        Number.isSafeInteger(ciphertextBytes) && ciphertextBytes > 0 && ciphertextBytes < MAX_BYTES + 8 * 1024 ** 2,
      413, 'The sender returned an invalid or oversized encrypted archive.');
      const decrypter = new Decrypter();
      decrypter.addIdentity(decryptionKey);
      try {
        const zip = await decrypter.decrypt(response.body);
        await pipeline(Readable.fromWeb(zip), limitedZip(zip.size(ciphertextBytes)),
          createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal });
      } catch (error) {
        if (error instanceof Problem || error.code === 'ENOSPC' || signal.aborted) throw error;
        throw new Problem(422, 'Could not authenticate and decrypt this archive. Check the key and retry.', 'decryption_failed');
      }
      signal.throwIfAborted();
      const { size } = await fs.stat(temporary);
      for (let i = 0; i < 100; i++) {
        const name = i ? `FolderDrop delivery (${i}).zip` : 'FolderDrop delivery.zip';
        try {
          await linkInbox(root, temporary, name);
          this.attempts.delete(retry);
          return { name, size };
        } catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      throw new Problem(409, 'Choose another folder or rename a previous FolderDrop delivery.');
    } catch (error) {
      if (error instanceof Problem) throw error;
      if (signal.aborted) throw new Problem(408, 'The encrypted download was interrupted. Retry from the same window.');
      if (error.code === 'ENOSPC') throw new Problem(507, 'The destination disk is full.');
      throw new Problem(502, 'Could not receive the encrypted delivery. Check the link, destination folder and connection.');
    } finally {
      download.abort();
      if (owned && this.attempts.get(retry) === pending) {
        pending.active = false;
        if (!pending.session) this.attempts.delete(retry);
        else pending.until = Date.now() + RETRY_AGE;
      }
      try {
        if (stage) await fs.rm(stage, { recursive: true, force: true, maxRetries: 5 });
      } finally { release(); }
    }
  }
}
