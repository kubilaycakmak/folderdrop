import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, draft, sharing, signIn, send } from './helpers.js';

async function stoppedDownload(t, mode) {
  const f = await fixture(t);
  const big = path.join(f.source, 'large.bin');
  await fs.writeFile(big, '');
  await fs.truncate(big, 256 * 1024 ** 2);
  const share = await draft(f, { items: [{ root: 0, relative: 'large.bin' }] });
  const link = await sharing(f, share, mode === 'expiry' ? { expires: Date.now() + 1800 } : {});
  const auth = await signIn(link);
  const file = `download/${share.items[0].id}`;
  const response = await new Promise((resolve, reject) =>
    http.get(`${link.url}/${file}`, { headers: { Cookie: auth.cookie } }, resolve).on('error', reject));
  let received = 0;
  const first = once(response, 'data');
  response.on('data', chunk => { received += chunk.length; response.pause(); });
  await first;
  assert.equal(response.statusCode, 200);
  assert.ok(f.app.deliveries.transfers().some(task => task.kind === 'download'));
  const closed = once(response, 'close').catch(() => {});
  if (mode === 'revoke') await f.app.call('revoke-recipient', { id: share.id, recipient: link.id });
  if (mode === 'permissions') await f.app.call('update-recipient', { id: share.id, recipient: link.id, download: false });
  if (mode === 'expiry') await delay(2000);
  response.removeAllListeners('data');
  response.on('data', chunk => { received += chunk.length; });
  response.resume();
  await closed;
  assert.ok(received > 0 && received < 256 * 1024 ** 2);
  assert.equal(response.complete, false);
  assert.equal((await auth.request(file)).status, mode === 'permissions' ? 401 : 410);
}

for (const mode of ['expiry', 'revoke', 'permissions']) {
  test(`${mode} interrupts an active authorized download`, { timeout: 12000 }, t => stoppedDownload(t, mode));
}

test('restart retains sessions, download grants, uploads and permanent revocations', async t => {
  const f = await fixture(t);
  const share = await draft(f, { inbox: { path: f.inbox, types: ['text/plain'] } });
  const link = await sharing(f, share, { limit: 1, upload: true });
  const auth = await signIn(link);
  const file = `download/${share.items[0].id}`;
  const first = await auth.request(file, undefined, { headers: { Range: 'bytes=0-2' } });
  const resume = first.headers.get('x-folderdrop-resume');
  assert.equal(await first.text(), '012');
  const upload = await (await auth.request('uploads', { name: 'return.txt', size: 4 })).json();
  assert.equal((await patch(auth, upload.id, 0, 'ab')).status, 200);
  const inactive = await sharing(f, share);
  await f.app.call('revoke-recipient', { id: share.id, recipient: inactive.id });
  await f.restart();
  assert.equal(f.app.network.status(share.id).addresses[0], new URL(link.url).origin);
  assert.equal((await link.redeem()).status, 410);
  assert.equal((await inactive.redeem()).status, 410);
  assert.equal((await (await auth.request(`uploads/${upload.id}`)).json()).offset, 2);
  assert.equal((await patch(auth, upload.id, 2, 'cd')).status, 200);
  assert.equal((await auth.request(`uploads/${upload.id}/complete`, {})).status, 200);
  assert.equal(await fs.readFile(path.join(f.inbox, 'return.txt'), 'utf8'), 'abcd');
  assert.equal(await (await auth.request(file, undefined, { headers: { Range: 'bytes=3-', 'X-FolderDrop-Resume': resume } })).text(), '3456789');
  await f.app.call('revoke', { id: share.id });
  await f.restart();
  assert.equal(f.app.inspect(share.id).revoked, true);
  await assert.rejects(f.app.call('start', { id: share.id }), { status: 410 });
});

function patch(auth, id, offset, value) {
  return auth.request(`uploads/${id}`, undefined, { method: 'PATCH', headers: {
    'Upload-Offset': String(offset), 'Content-Type': 'application/offset+octet-stream'
  }, body: value });
}

test('upload quotas reserve unfinished bytes, enforce type, isolate profiles and rename collisions', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.inbox, 'feedback.txt'), 'old');
  const share = await draft(f, { inbox: { path: f.inbox, types: ['text/plain'], maxFile: 8, maxTotal: 13, maxFiles: 3, concurrency: 1 } });
  const a = await signIn(await sharing(f, share, { upload: true }));
  const b = await signIn(await sharing(f, share, { upload: true }));
  const reviewer = await signIn(await sharing(f, share, { upload: true, browseInbox: true }));
  for (const name of ['../x', 'COM1.txt', '.shadow', 'a:b']) assert.equal((await a.request('uploads', { name, size: 2 })).status, 400);
  assert.equal((await a.request('uploads', { name: 'big.txt', size: 9 })).status, 400);
  const first = await (await a.request('uploads', { name: 'feedback.txt', size: 5 })).json();
  assert.equal((await b.request('uploads', { name: 'over.txt', size: 6 })).status, 413);
  assert.deepEqual(await (await b.request('uploads')).json(), []);
  assert.equal((await b.request(`uploads/${first.id}`)).status, 404);
  assert.equal((await patch(a, first.id, 2, 'here')).status, 409);
  assert.equal((await patch(a, first.id, 0, 'hello')).status, 200);
  const done = await (await a.request(`uploads/${first.id}/complete`, {})).json();
  assert.equal(done.name, 'feedback (1).txt');
  assert.equal(await fs.readFile(path.join(f.inbox, done.name), 'utf8'), 'hello');
  assert.equal(await fs.readFile(path.join(f.inbox, 'feedback.txt'), 'utf8'), 'old');
  assert.equal((await (await reviewer.request('uploads')).json())[0].name, done.name);
  assert.deepEqual(await (await b.request('uploads')).json(), []);
  const binary = await (await b.request('uploads', { name: 'binary.txt', size: 4 })).json();
  assert.equal((await patch(b, binary.id, 0, Buffer.from([0, 1, 2, 3]))).status, 200);
  assert.equal((await b.request(`uploads/${binary.id}/complete`, {})).status, 415);
  assert.equal((await b.request('uploads', { name: 'count.txt', size: 0 })).status, 413);
  assert.equal((await b.request(`uploads/${binary.id}`, undefined, { method: 'DELETE' })).status, 200);
  assert.deepEqual(await fs.readdir(path.join(f.inbox, '.folderdrop-incoming')), []);
});

test('active upload cancellation and expiry discard the uncommitted chunk', { timeout: 12000 }, async t => {
  const f = await fixture(t);
  const share = await draft(f, { inbox: { path: f.inbox, types: ['*/*'], concurrency: 1 } });
  const link = await sharing(f, share, { upload: true, expires: Date.now() + 2500 });
  const auth = await signIn(link);
  const upload = await (await auth.request('uploads', { name: 'pending.bin', size: 16384 })).json();
  const second = await (await auth.request('uploads', { name: 'other.bin', size: 2 })).json();
  function partial(id) {
    let req;
    const result = new Promise(resolve => {
      req = http.request(`${link.url}/uploads/${id}`, { method: 'PATCH', headers: {
        Cookie: auth.cookie, 'X-FolderDrop-Action': '1', 'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': '0', 'Content-Length': 16384
      } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', error => resolve(error.code));
      req.write(Buffer.alloc(512));
    });
    t.after(() => req.destroy());
    return result;
  }
  const first = partial(upload.id);
  for (let attempt = 0; attempt < 40 && !f.app.uploads.busy.has(upload.id); attempt++) await delay(25);
  assert.equal((await patch(auth, second.id, 0, 'ab')).status, 429);
  assert.equal((await auth.request(`uploads/${upload.id}`, undefined, { method: 'DELETE' })).status, 200);
  assert.equal(await first, 'ECONNRESET');
  for (let attempt = 0; attempt < 40 && f.app.uploads.busy.has(upload.id); attempt++) await delay(25);
  assert.equal((await auth.request(`uploads/${upload.id}`)).status, 404);
  const replacement = await (await auth.request('uploads', { name: 'pending.bin', size: 16384 })).json();
  const expiring = partial(replacement.id);
  assert.equal(await expiring, 'ECONNRESET');
  assert.equal((await auth.request('uploads')).status, 410);
  await f.app.uploads.recover();
  assert.deepEqual(await fs.readdir(path.join(f.inbox, '.folderdrop-incoming')), []);
});

test('public start requires intent; self-hosted link is HTTPS with a recipient-only origin', async t => {
  const f = await fixture(t);
  const share = await draft(f);
  await assert.rejects(f.app.call('start', { id: share.id, mode: 'public' }), /Explicitly confirm/);
  const temporary = await f.app.call('start', { id: share.id });
  const port = Number(new URL(temporary.connection.addresses[0]).port);
  await f.app.call('stop', { id: share.id });
  const started = await f.app.call('start', { id: share.id, mode: 'self-hosted', external: 'https://drop.example.invalid', port });
  assert.equal(started.connection.reachability, 'unverified');
  const issued = await f.app.call('issue', { id: share.id });
  assert.match(issued.links[0], /^https:\/\/drop\.example\.invalid/);
  const local = new URL(issued.links[0]).pathname;
  const result = await send(`${started.connection.upstream}${local}/redeem`, { code: issued.code });
  assert.equal(result.status, 200);
  assert.match(result.headers.get('set-cookie'), /; Secure/);
  assert.equal((await fetch(`${started.connection.upstream}/api/config`)).status, 404);
});
