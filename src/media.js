import fs from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { Capacity, digest } from './security.js';
import { check, Problem } from './errors.js';
import { stamp } from './files.js';

const MAX = 48 * 1024 ** 2;
const MAX_FILES = 8;
const LIFETIME = 10 * 60 * 1000;

export class MediaPreviews {
  entries = new Map();
  capacity = new Capacity(2, 'Media previews are busy. Try again shortly.');
  constructor(directory) { this.base = directory; }
  async open() {
    const previous = await fs.readdir(this.base, { withFileTypes: true });
    for (const item of previous) if (item.isDirectory() && /^media-[a-z0-9]{6}$/i.test(item.name)) {
      const folder = path.join(this.base, item.name);
      const entries = await fs.readdir(folder);
      if (entries.every(name => /^[a-f0-9]{64}$/.test(name))) await fs.rm(folder, { recursive: true, force: true });
    }
    this.directory = await fs.mkdtemp(path.join(this.base, 'media-'));
  }

  async preview(file, type, signal) {
    check(file.size > 0 && file.size <= MAX, 415, 'Audio and video preview is limited to 48 MiB. Download the original to play it locally.');
    const clear = async (key, entry) => {
      this.entries.delete(key);
      await fs.rm(entry.path, { force: true }).catch(() => {});
    };
    for (const [key, entry] of this.entries) if (!entry.active && entry.time + LIFETIME < Date.now()) await clear(key, entry);
    const sourceStamp = stamp(file.stat);
    const key = digest(`${sourceStamp}:${type.mime}`);
    let entry = this.entries.get(key);
    if (!entry) {
      const free = this.capacity.enter();
      const reservation = { path: path.join(this.directory, key), active: 1, time: Date.now() };
      try {
        if (this.entries.size >= MAX_FILES) {
          const oldest = [...this.entries].filter(([, value]) => !value.active).sort((a, b) => a[1].time - b[1].time)[0];
          check(oldest, 429, 'All media preview slots are busy.');
          await clear(...oldest);
        }
        this.entries.set(key, reservation);
        try {
          reservation.mime = await this.render(file, type, reservation.path, signal);
          check(stamp(await file.handle.stat({ bigint: true })) === sourceStamp, 409, 'The source changed during preview. Retry after editing is finished.');
          entry = reservation;
        } catch (error) { await clear(key, reservation); throw error; }
        finally { reservation.active--; }
      } finally { free(); }
    }
    check(entry.mime, 429, 'This preview is being generated. Try again shortly.');
    entry.time = Date.now();
    entry.active++;
    let handle;
    try {
      handle = await fs.open(entry.path, 'r');
      const stat = await handle.stat({ bigint: true });
      return { mime: entry.mime, handle, stat, size: Number(stat.size),
        close: async () => { try { await handle.close(); } finally { entry.active--; } } };
    } catch (error) { await handle?.close(); entry.active--; throw error; }
  }

  async render(file, type, location, signal) {
    signal.throwIfAborted();
    const worker = new Worker(new URL('./media-worker.js', import.meta.url), {
      workerData: { fd: file.handle.fd, size: file.size, mime: type.mime, outputPath: location, max: MAX },
      resourceLimits: { maxOldGenerationSizeMb: 136 }, stdout: true, stderr: true
    });
    worker.stdout.resume();
    worker.stderr.resume();
    const abort = () => void worker.terminate();
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 11000);
    try {
      const result = await new Promise((resolve, reject) => {
        worker.once('error', reject);
        worker.once('exit', () => reject(new Error('Media worker ended')));
        worker.once('message', resolve);
      });
      check(result.mime, 415, result.reason ?? 'This media cannot be previewed.');
      const resultStat = await fs.stat(location);
      check(resultStat.size <= MAX, 415, 'The generated media preview exceeds the size limit.');
      return result.mime;
    } catch (error) {
      if (error instanceof Problem) throw error;
      throw new Problem(415, 'This media is invalid, unsupported, or exceeds the preview budget.');
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      await worker.terminate();
    }
  }

  async close() {
    if (this.directory) await fs.rm(this.directory, { recursive: true, force: true, maxRetries: 6 });
  }
}
