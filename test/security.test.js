import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { openAuthorized, anchor, relativeParts } from '../src/files.js';
import { fixture, draft, sharing, signIn, send } from './helpers.js';

test('each receipt requires an atomically consumed code and returns a scoped session', async t => {
  const f = await fixture(t);
  const share = await draft(f);
  const link = await sharing(f, share, { items: [share.items[0].id] });
  const unauthenticated = await fetch(`${link.url}/manifest`);
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(unauthenticated.headers.get('cache-control'), 'private, no-store');
  assert.equal((await send(`${link.url}/redeem`, { code: '00000-00000-00000-00000' })).status, 401);
  const responses = await Promise.all([link.redeem(), link.redeem(), link.redeem()]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 410, 410]);
  const details = responses.find(response => response.ok).headers.get('set-cookie');
  assert.match(details, /HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(details, /; Secure/);
  const cookie = details.split(';')[0];
  const response = await send(`${link.url}/manifest`, undefined, { headers: { Cookie: cookie } });
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const manifest = await response.json();
  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.files[0].path, 'Notes/hello.txt');
  assert.doesNotMatch(JSON.stringify(manifest), /absolute|identity|private\.txt|active\.html/);
  assert.equal((await send(`${link.url}/download/${share.items[1].id}`, undefined, { headers: { Cookie: cookie } })).status, 404);
  const second = await sharing(f, share);
  assert.equal((await send(`${second.url}/manifest`, undefined, { headers: { Cookie: cookie } })).status, 401);
  assert.doesNotMatch(JSON.stringify(await f.app.call('inspect', { id: share.id })), new RegExp(link.code));
});

test('raw requests cannot use encoded traversal, reach admin, or spoof an administrator host', async t => {
  const f = await fixture(t);
  const share = await draft(f);
  const link = await sharing(f, share);
  const base = new URL(link.url);
  const raw = (url, pathname, headers) => new Promise((resolve, reject) =>
    http.get({ hostname: url.hostname, port: url.port, path: pathname, headers }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject));
  for (const suffix of ['/%2e%2e/%2e%2e', '/preview/%2e%2e%2fother', '/preview/C:%5cWindows', '/download/..\\secret']) {
    assert.equal(await raw(base, base.pathname + suffix), 404);
  }
  assert.equal(await raw(base, '/api/config'), 404);
  assert.equal(await raw(base, '/assets/admin.js'), 404);
  const admin = new URL(f.admin.address);
  assert.equal(await raw(admin, '/', { Host: 'foreign.example' }), 421);
  for (const bad of ['../private', 'C:/windows', 'a\\b', 'a/CON.txt', 'a/NUL', '.env', 'dir./x', 'a//b']) assert.throws(() => relativeParts(bad));
});

test('cross-site actions and independent admin sessions are enforced', async t => {
  const f = await fixture(t);
  const share = await draft(f);
  const link = await sharing(f, share);
  const { url } = f.admin.launch();
  const key = new URL(url).hash.slice(1);
  const boot = `${f.admin.address}/bootstrap`;
  assert.equal((await fetch(boot, { method: 'POST', body: JSON.stringify({ key }) })).status, 403);
  assert.equal((await send(boot, { key }, { headers: { Origin: 'https://other.example' } })).status, 403);
  assert.equal((await send(boot, { key }, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const signed = await send(boot, { key }, { headers: { Origin: f.admin.address } });
  assert.equal(signed.status, 200);
  assert.equal((await send(boot, { key })).status, 401);
  assert.equal((await send(`${f.admin.address}/api/action`, { action: 'list' })).status, 401);
  assert.equal((await send(`${link.url}/redeem`, { code: link.code }, { headers: { Origin: 'https://other.example' } })).status, 403);
  const auth = await signIn(link);
  assert.equal((await send(`${f.admin.address}/api/action`, { action: 'list' }, { headers: { Cookie: auth.cookie } })).status, 401);
  assert.equal((await auth.request('archive', { items: [share.items[0].id] }, { headers: { Origin: 'https://other.example' } })).status, 403);
});

test('hard links, directory junctions and a swap between validation and open fail closed', async t => {
  const f = await fixture(t);
  const root = await anchor(f.source);
  const original = path.join(f.source, 'notes', 'hello.txt');
  await fs.link(path.join(f.other, 'private.txt'), path.join(f.source, 'linked.txt'));
  await assert.rejects(openAuthorized(root, 'linked.txt'), { code: 'unavailable' });
  await fs.symlink(f.other, path.join(f.source, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(openAuthorized(root, 'junction/private.txt'), { code: 'unavailable' });
  await assert.rejects(openAuthorized(root, 'notes/hello.txt', async () => {
    await fs.rename(original, path.join(f.source, 'notes', 'moved.txt'));
    await fs.writeFile(original, 'replacement');
  }), { code: 'unavailable' });
  const moved = path.join(f.source, 'notes-before');
  await assert.rejects(openAuthorized(root, 'notes/hello.txt', async () => {
    await fs.rename(path.join(f.source, 'notes'), moved);
    await fs.symlink(f.other, path.join(f.source, 'notes'), process.platform === 'win32' ? 'junction' : 'dir');
  }), { code: 'unavailable' });
});
