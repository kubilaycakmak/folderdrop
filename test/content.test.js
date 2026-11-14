import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, draft, sharing, signIn, zipContents } from './helpers.js';
import { demoManifest, fixtures } from '../demo/fixtures.js';

test('streaming original supports HEAD, byte ranges, validators, and bounded resume accounting', async t => {
  const f = await fixture(t);
  const share = await draft(f);
  const link = await sharing(f, share, { limit: 1 });
  const { request } = await signIn(link);
  const file = `download/${share.items[0].id}`;
  const head = await request(file, undefined, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '10');
  assert.match(head.headers.get('content-disposition'), /attachment.*hello.txt/);
  assert.equal(head.headers.get('accept-ranges'), 'bytes');
  const etag = head.headers.get('etag');
  const first = await request(file, undefined, { headers: { Range: 'bytes=0-3' } });
  assert.equal(first.status, 206);
  assert.equal(first.headers.get('content-range'), 'bytes 0-3/10');
  assert.equal(await first.text(), '0123');
  const grant = first.headers.get('x-folderdrop-resume');
  const rest = await request(file, undefined, { headers: { Range: 'bytes=-6', 'If-Range': etag, 'X-FolderDrop-Resume': grant } });
  assert.equal(await rest.text(), '456789');
  assert.equal(rest.headers.get('x-folderdrop-resume'), grant);
  assert.equal((await request(file, undefined, { headers: { 'If-None-Match': etag } })).status, 304);
  assert.equal((await request(file, undefined, { headers: { 'If-Match': '"wrong"' } })).status, 412);
  assert.equal((await request(file, undefined, { headers: { Range: 'bytes=200-300' } })).status, 416);
  assert.equal((await request(`download/${share.items[1].id}`)).status, 403);
  assert.equal((await request(`download-check/${share.items[1].id}`)).status, 403);
  assert.equal((await request(`download-check/${share.items[0].id}`)).status, 200);
  assert.equal((await request('archive-ticket', { items: [share.items[0].id] })).status, 403);
  await fs.writeFile(path.join(f.source, 'notes', 'hello.txt'), 'new original');
  assert.equal((await request(file, undefined, { headers: { 'X-FolderDrop-Resume': grant } })).status, 410);
  const manifest = await (await request('manifest')).json();
  assert.equal(manifest.remaining, 0);
});

test('selected ZIP streams organized entries and consumes a single grant per archive', async t => {
  const f = await fixture(t);
  const share = await draft(f);
  const link = await sharing(f, share, { limit: 1 });
  const { request } = await signIn(link);
  const items = share.items.map(item => item.id);
  const response = await request('archive', { items });
  assert.equal(response.status, 200);
  const original = Buffer.from(await response.arrayBuffer());
  const entries = await zipContents(original);
  assert.deepEqual([...entries], [['Notes/hello.txt', '0123456789'], ['active.html', '<script>window.alert(1)</script>']]);
  const grant = response.headers.get('x-folderdrop-resume');
  assert.equal((await request('archive', { items })).status, 403);
  const retry = await request('archive', { items }, { headers: { 'X-FolderDrop-Resume': grant } });
  assert.equal(retry.status, 200);
  assert.deepEqual([...await zipContents(Buffer.from(await retry.arrayBuffer()))], [...entries]);
  const ranged = await request('archive', { items }, { headers: { 'X-FolderDrop-Resume': grant, Range: 'bytes=20-50', 'If-Range': response.headers.get('etag') } });
  assert.equal(ranged.status, 206);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), original.subarray(20, 51));
  await assert.rejects(f.app.call('edit', { id: share.id, revision: f.app.inspect(share.id).revision,
    items: [{ ...share.items[0], path: 'Same.txt' }, { ...share.items[1], path: 'same.txt' }] }), /Duplicate/);
});

test('optimistic revisions reject concurrent editors and snapshots pin coherent independent copies', { timeout: 25000 }, async t => {
  const f = await fixture(t);
  const share = await draft(f);
  const edits = await Promise.allSettled(['A', 'B'].map(title => f.app.call('edit', { id: share.id, revision: share.revision, presentation: { title } })));
  assert.deepEqual(edits.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  const original = path.join(f.source, 'notes', 'hello.txt');
  const first = await f.app.call('snapshot', { id: share.id, revision: f.app.inspect(share.id).revision });
  assert.equal((await f.app.call('version-items', { id: share.id, version: first.version }))[0].sha256.length, 64);
  assert.equal(first.snapshotBytes, 42);
  const link = await sharing(f, share);
  const { request } = await signIn(link);
  await fs.writeFile(original, 'second version');
  const next = await f.app.call('snapshot', { id: share.id, revision: f.app.inspect(share.id).revision });
  assert.notEqual(next.version, first.version);
  assert.equal(await (await request(`download/${share.items[0].id}`)).text(), '0123456789');
  const fresh = await signIn(await sharing(f, share));
  assert.equal(await (await fresh.request(`download/${share.items[0].id}`)).text(), 'second version');
  await assert.rejects(f.app.call('remove-version', { id: share.id, version: first.version }), /pinned/);
  await f.app.call('revoke-recipient', { id: share.id, recipient: link.id });
  await f.app.call('remove-version', { id: share.id, version: first.version });
  assert.equal(await fs.readFile(original, 'utf8'), 'second version');
  const service = f.app.deliveries;
  const copy = service.snapshots.copy.bind(service.snapshots);
  service.snapshots.copy = async manifest => {
    const result = await copy(manifest);
    await service.save({ id: share.id, revision: manifest.revision, presentation: { intro: 'Concurrent edit' } });
    return result;
  };
  await assert.rejects(f.app.call('snapshot', { id: share.id, revision: f.app.inspect(share.id).revision }), /changed during/);
  assert.equal((await fs.readdir(service.snapshots.directory)).length, 1);
});

test('live listings report removed files, active HTML is inert, and edits invalidate permissions', async t => {
  const f = await fixture(t);
  const share = await draft(f);
  const link = await sharing(f, share);
  const auth = await signIn(link);
  const html = await auth.request(`preview/${share.items[1].id}`);
  assert.equal((await html.json()).text, '<script>window.alert(1)</script>');
  const download = await auth.request(`download/${share.items[1].id}`);
  assert.match(download.headers.get('content-security-policy'), /^sandbox/);
  assert.match(download.headers.get('content-disposition'), /^attachment/);
  await download.text();
  await fs.unlink(path.join(f.source, 'notes', 'hello.txt'));
  assert.equal((await (await auth.request('manifest')).json()).files[0].available, false);
  await f.app.call('update-recipient', { id: share.id, recipient: link.id, download: false, preview: false });
  assert.equal((await auth.request('manifest')).status, 401);
  const rotated = await f.app.call('rotate', { id: share.id, recipient: link.id });
  const replacement = await signIn({ ...link, redeem: () => import('./helpers.js').then(({ send }) => send(`${link.url}/redeem`, { code: rotated.code })) });
  assert.equal((await replacement.request(`download/${share.items[1].id}`)).status, 403);
  assert.equal((await replacement.request(`preview/${share.items[1].id}`)).status, 403);
});

test('generated media strips container tags and preserves the unavailable-download boundary', async t => {
  const f = await fixture(t);
  const { source, inbox } = await fixtures(path.join(f.directory, 'demo'));
  const share = await f.app.call('create', demoManifest(source, inbox));
  const auth = await signIn(await sharing(f, share, { download: false }));
  const video = share.items.find(item => item.path.endsWith('.webm')).id;
  const original = await fs.readFile(path.join(source, 'Photography', 'Palette motion.webm'));
  assert.ok(original.includes(Buffer.from('Sample camera metadata')));
  const preview = await auth.request(`media/${video}`);
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get('content-type'), /^video\/webm/);
  const converted = Buffer.from(await preview.arrayBuffer());
  assert.ok(converted.length > 100);
  assert.ok(!converted.includes(Buffer.from('Sample camera metadata')));
  assert.equal((await auth.request(`download/${video}`)).status, 403);
});

test('a source change during copying prevents snapshot publication', async t => {
  const f = await fixture(t);
  const pathname = path.join(f.source, 'changing.bin');
  await fs.writeFile(pathname, '');
  await fs.truncate(pathname, 64 * 1024 ** 2);
  const share = await draft(f, { items: [{ root: 0, relative: 'changing.bin' }] });
  const copies = f.app.deliveries.snapshots.directory;
  const snapshot = f.app.call('snapshot', { id: share.id, revision: share.revision });
  const observed = snapshot.catch(error => error);
  let copy;
  for (let attempt = 0; attempt < 200 && !copy; attempt++) {
    const [version] = await fs.readdir(copies);
    if (version) {
      const target = path.join(copies, version, share.items[0].id);
      if ((await fs.stat(target).catch(() => null))?.isFile()) copy = target;
    }
    if (!copy) await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.ok(copy, 'Observed the independent copy before mutating its source');
  await fs.truncate(pathname, 512);
  const error = await observed;
  assert.equal(error.status, 409);
  assert.equal(f.app.inspect(share.id).versions.length, 0);
  assert.deepEqual(await fs.readdir(copies), []);
});
