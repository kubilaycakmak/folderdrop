import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { check, Problem } from './errors.js';

export const MAX_ITEMS = 1000;
const reserved = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
export function namePart(name) {
  check(typeof name === 'string' && name.length > 0 && Buffer.byteLength(name) <= 240 &&
    name === name.toWellFormed() && name !== '.' && name !== '..' &&
    !/[<>:"/\\|?*\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]|[. ]$/u.test(name) &&
    !reserved.test(name) && !name.startsWith('.'), 400, 'Use portable names without hidden entries or special characters.', 'invalid_name');
  return name;
}

export function relativeParts(value) {
  check(typeof value === 'string' && value.length <= 1024, 400, 'Invalid relative path.');
  const parts = value.split('/');
  check(parts.length <= 32, 400, 'Folder nesting exceeds 32 levels.');
  return parts.map(namePart);
}

// Older Windows libuv lstat reports device 0 while fstat reports the volume ID.
// The canonical absolute path check fixes the volume before comparing NTFS file IDs.
export const identity = stat => process.platform === 'win32' ? String(stat.ino) : `${stat.dev}:${stat.ino}`;
export const stamp = stat => `${identity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const statPath = pathName => fs.lstat(pathName, { bigint: true });
const unavailable = () => new Problem(404, 'This file is unavailable or has moved.', 'unavailable');
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

async function entry(pathName, directory) {
  const stat = await statPath(pathName);
  if (!(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n) ||
      stat.ino === 0n || stat.isSymbolicLink() || !samePath(await fs.realpath(pathName), pathName)) throw unavailable();
  return stat;
}

export async function anchor(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 4096, 400, 'Enter a folder path.');
  const absolute = path.resolve(value);
  try {
    const stat = await entry(absolute, true);
    return { path: absolute, identity: identity(stat) };
  } catch {
    throw new Problem(400, 'Choose an existing real folder without symlinks or junctions.');
  }
}

async function chain(root, parts) {
  const first = await entry(root.path, true);
  if (identity(first) !== root.identity) throw unavailable();
  const identities = [identity(first)];
  let absolute = root.path;
  for (const part of parts) {
    absolute = path.join(absolute, part);
    identities.push(identity(await entry(absolute, true)));
  }
  return { absolute, signature: identities.join('/') };
}

export async function openAuthorized(root, relative, testHook) {
  const parts = relativeParts(relative);
  const leaf = parts.pop();
  let handle;
  try {
    const parent = await chain(root, parts);
    const absolute = path.join(parent.absolute, leaf);
    const before = await entry(absolute, false);
    await testHook?.();
    handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(Number.MAX_SAFE_INTEGER) ||
        identity(before) !== identity(stat)) throw unavailable();
    if (process.platform === 'linux' && !samePath(await fs.realpath(`/proc/self/fd/${handle.fd}`), absolute)) throw unavailable();
    const after = await entry(absolute, false);
    if (identity(after) !== identity(stat) || (await chain(root, parts)).signature !== parent.signature) throw unavailable();
    return { handle, stat, size: Number(stat.size) };
  } catch {
    await handle?.close().catch(() => {});
    throw unavailable();
  }
}

export async function inspectFolder(value) {
  const root = await anchor(value);
  const folders = [];
  let count = 0;
  const entries = await fs.opendir(root.path);
  for await (const item of entries) {
    if (++count > 10000 || folders.length === 300) break;
    if (!item.isDirectory() || item.name.startsWith('.')) continue;
    const absolute = path.join(root.path, item.name);
    if (await entry(absolute, true).catch(() => null)) folders.push({ name: item.name, path: absolute });
  }
  if (identity(await entry(root.path, true)) !== root.identity) throw unavailable();
  return { path: root.path, parent: path.dirname(root.path) === root.path ? null : path.dirname(root.path),
    folders: folders.sort((a, b) => a.name.localeCompare(b.name)), truncated: count > 10000 || folders.length === 300 };
}

export async function scan(rootPath) {
  const root = await anchor(rootPath);
  const files = [];
  let skipped = 0;
  let visited = 0;
  async function walk(parts) {
    const parent = await chain(root, parts);
    const directory = await fs.opendir(parent.absolute);
    for await (const item of directory) {
      check(++visited <= 10000, 413, 'This folder has more than 10,000 entries. Choose a smaller folder.');
      try { namePart(item.name); } catch { skipped++; continue; }
      const relative = [...parts, item.name].join('/');
      if (parts.length >= 31 || relative.length > 1024) { skipped++; continue; }
      if (item.isDirectory()) {
        await walk([...parts, item.name]).catch(error => {
          if (error instanceof Problem && error.status === 413) throw error;
          skipped++;
        });
        continue;
      }
      if (!item.isFile()) { skipped++; continue; }
      const file = await openAuthorized(root, relative).catch(() => null);
      if (!file) { skipped++; continue; }
      await file.handle.close();
      files.push({ relative, size: file.size });
      check(files.length <= MAX_ITEMS, 413, 'This folder contains more than 1,000 eligible files. Choose a smaller folder.');
    }
  }
  await walk([]);
  return { root: root.path, files: files.sort((a, b) => a.relative.localeCompare(b.relative)), skipped };
}

export async function inboxEntries(root, maxEntries = 10000) {
  const parent = await chain(root, []);
  const directory = await fs.opendir(parent.absolute);
  const files = [];
  let visited = 0;
  for await (const item of directory) {
    check(++visited <= maxEntries, 413, 'The inbox contains too many entries.');
    const stat = await statPath(path.join(parent.absolute, item.name)).catch(() => null);
    if (stat?.isFile() && !stat.isSymbolicLink()) files.push({ name: item.name, size: Number(stat.size) });
  }
  if ((await chain(root, [])).signature !== parent.signature) throw unavailable();
  return files;
}

export async function linkInbox(root, stage, name) {
  const parent = await chain(root, []);
  const target = path.join(parent.absolute, namePart(name));
  // link() is atomic and refuses to replace an existing destination.
  await fs.link(stage, target);
  if ((await chain(root, [])).signature !== parent.signature) throw unavailable();
  return target;
}
