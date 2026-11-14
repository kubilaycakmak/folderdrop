import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openAuthorized, stamp, anchor } from './files.js';
import { check, Problem } from './errors.js';
import { token } from './security.js';

export class Snapshots {
  constructor(store) {
    this.store = store;
    this.directory = path.join(store.directory, 'snapshots');
  }
  async recover() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const owned = new Set(this.store.keys('snapshot'));
    for (const item of await fs.readdir(this.directory, { withFileTypes: true })) {
      if (item.isDirectory() && /^v-[\w-]{24}$/.test(item.name) && !owned.has(item.name)) await this.erase(item.name);
    }
  }
  async erase(id) {
    check(/^v-[\w-]{24}$/.test(id), 400, 'Invalid version.');
    await fs.rm(path.join(this.directory, id), { recursive: true, force: true });
  }
  async copy(share) {
    check(share.items.length > 0, 400, 'Select files before taking a snapshot.');
    const usage = this.store.snapshotUsage();
    check(usage.count < 200, 507, 'Remove an unused version before creating another.');
    const capacity = 100 * 1024 ** 3 - usage.bytes;
    const id = `v-${token(18)}`;
    const directory = path.join(this.directory, id);
    await fs.mkdir(directory, { mode: 0o700 });
    let bytes = 0;
    const files = [];
    const inspect = async item => openAuthorized(share.roots[item.root], item.relative);
    try {
      for (const item of share.items) {
        const source = await inspect(item);
        files.push({ ...item, stamp: stamp(source.stat), bytes: source.size });
        bytes += source.size;
        await source.handle.close();
        check(bytes <= capacity, 507, 'Snapshot storage would exceed 100 GiB.');
      }
      for (const file of files) {
        const source = await inspect(file);
        const hash = createHash('sha256');
        let count = 0;
        try {
          check(stamp(source.stat) === file.stamp, 409, 'A source changed while taking the snapshot. Retry when editing is finished.');
          const target = await fs.open(path.join(directory, file.id), 'wx', 0o600);
          try {
            const buffer = Buffer.allocUnsafe(128 * 1024);
            while (count < file.bytes) {
              const { bytesRead } = await source.handle.read(buffer, 0, Math.min(buffer.length, file.bytes - count), count);
              if (!bytesRead) break;
              const chunk = buffer.subarray(0, bytesRead);
              let written = 0;
              while (written < chunk.length) {
                const result = await target.write(chunk, written, chunk.length - written, count + written);
                check(result.bytesWritten > 0, 507, 'The snapshot could not be saved.');
                written += result.bytesWritten;
              }
              count += chunk.length;
              hash.update(chunk);
            }
            await target.sync();
          } finally { await target.close(); }
          check(count === file.bytes && stamp(await source.handle.stat({ bigint: true })) === file.stamp,
            409, 'A source changed while taking the snapshot. Retry when editing is finished.');
          file.sha256 = hash.digest('hex');
        } finally { await source.handle.close(); }
      }
      for (const file of files) {
        const source = await inspect(file);
        await source.handle.close();
        check(stamp(source.stat) === file.stamp, 409, 'A source changed while taking the snapshot. Retry when editing is finished.');
      }
      const root = await anchor(directory);
      for (const file of files) {
        const copy = await openAuthorized(root, file.id);
        file.integrityStamp = stamp(copy.stat);
        await copy.handle.close();
      }
      return { id, share: share.id, root, bytes, created: Date.now(), presentation: share.presentation,
        items: files.map(({ id: itemId, path: name, description, bytes: size, sha256, integrityStamp }) =>
          ({ id: itemId, path: name, description, size, sha256, integrityStamp })) };
    } catch (error) {
      await this.erase(id);
      if (error.code === 'unavailable') throw new Problem(409, 'A source became unavailable. No snapshot was published.');
      if (error.code === 'ENOSPC') throw new Problem(507, 'There is insufficient disk space for this snapshot.');
      throw error;
    }
  }
}
