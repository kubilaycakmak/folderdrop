import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serve } from '../src/daemon.js';
import { once } from 'node:events';

export async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'folderdrop-test-'));
  const roots = Object.fromEntries(['source', 'inbox', 'data', 'other'].map(name => [name, path.join(directory, name)]));
  await Promise.all(Object.values(roots).map(root => fs.mkdir(root)));
  await fs.mkdir(path.join(roots.source, 'notes'));
  await fs.writeFile(path.join(roots.source, 'notes', 'hello.txt'), '0123456789');
  await fs.writeFile(path.join(roots.source, 'active.html'), '<script>window.alert(1)</script>');
  await fs.writeFile(path.join(roots.other, 'private.txt'), 'private');
  let runtime = await serve(roots.data, 0);
  t.after(async () => {
    await runtime.close();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  return { ...roots, directory, get app() { return runtime.app; }, get admin() { return runtime.admin; },
    async restart() { await runtime.close(); runtime = await serve(roots.data, 0); } };
}

export const actionHeaders = { 'X-FolderDrop-Action': '1' };
export async function send(url, input, options = {}) {
  return fetch(url, { ...options, method: options.method ?? (input === undefined ? 'GET' : 'POST'),
    headers: { ...actionHeaders, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
    body: input === undefined ? options.body : JSON.stringify(input) });
}

export async function draft(f, extras = {}) {
  return f.app.call('create', { roots: [{ path: f.source, label: 'Files' }],
    items: [{ root: 0, relative: 'notes/hello.txt', path: 'Notes/hello.txt' }, { root: 0, relative: 'active.html', path: 'active.html' }],
    presentation: { title: 'Private delivery', intro: 'Hello' }, ...extras });
}

export async function sharing(f, share, input = {}) {
  if (!f.app.deliveries.get(share.id).enabled) await f.app.call('start', { id: share.id });
  const issued = await f.app.call('issue', { id: share.id, ...input });
  const url = issued.links[0];
  return { ...issued, url, redeem: () => send(`${url}/redeem`, { code: issued.code }) };
}

export async function signIn(link) {
  const response = await link.redeem();
  if (!response.ok) throw new Error(`Redeem returned ${response.status}: ${await response.text()}`);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  return { cookie, request: (tail, input, options) => send(`${link.url}/${tail}`, input, { ...options, headers: { Cookie: cookie, ...options?.headers } }) };
}

export async function zipContents(buffer) {
  const { default: unzip } = await import('yauzl');
  const zip = await new Promise((resolve, reject) => unzip.fromBuffer(buffer, { lazyEntries: true }, (error, result) => error ? reject(error) : resolve(result)));
  const entries = new Map();
  return new Promise((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', () => resolve(entries));
    zip.on('entry', entry => {
      zip.openReadStream(entry, async (error, stream) => {
        if (error) return reject(error);
        const data = [];
        stream.on('data', chunk => data.push(chunk));
        try {
          await once(stream, 'end');
          entries.set(entry.fileName, Buffer.concat(data).toString());
          zip.readEntry();
        } catch (error) { reject(error); }
      });
    });
    zip.readEntry();
  });
}
