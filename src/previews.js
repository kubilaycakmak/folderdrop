import path from 'node:path';
import sharp from 'sharp';
import mimeTypes from 'mime-types';
import { Worker } from 'node:worker_threads';
import { Capacity } from './security.js';
import { check, Problem } from './errors.js';

const images = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif', '.tiff': 'image/tiff', '.tif': 'image/tiff'
};
const audio = { '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav',
  '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.aac': 'audio/aac' };
const video = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.ogv': 'video/ogg', '.mkv': 'video/x-matroska' };
const textExtensions = new Set('txt md csv tsv json jsonl xml yaml yml toml ini log js mjs cjs ts tsx jsx css scss html htm svg py rb rs go c h cpp hpp java kt swift sh ps1 bat sql diff patch r php ipynb tex'.split(' '));
const capacity = new Capacity(3, 'Preview capacity is busy. Try again in a moment.');
export const TEXT_LIMIT = 128 * 1024;
export const IMAGE_LIMIT = 32 * 1024 ** 2;
export const PDF_LIMIT = 24 * 1024 ** 2;
sharp.cache(false);
sharp.concurrency(2);

export function format(name) {
  const ext = path.extname(name).toLowerCase();
  if (Object.hasOwn(images, ext)) return { kind: 'image', mime: images[ext] };
  if (Object.hasOwn(audio, ext)) return { kind: 'audio', mime: audio[ext] };
  if (Object.hasOwn(video, ext)) return { kind: 'video', mime: video[ext] };
  if (ext === '.pdf') return { kind: 'pdf', mime: 'application/pdf' };
  const mime = mimeTypes.lookup(ext);
  if (textExtensions.has(ext.slice(1))) return { kind: 'text', mime: mime || 'text/plain' };
  return { kind: 'unknown', mime: mime || 'application/octet-stream' };
}

async function read(file, length) {
  const data = Buffer.alloc(Math.min(file.size, length));
  let offset = 0;
  while (offset < data.length) {
    const { bytesRead } = await file.handle.read(data, offset, data.length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return data.subarray(0, offset);
}

async function renderPDF(file, page, signal) {
  check(file.size <= PDF_LIMIT, 415, 'PDF preview is limited to 24 MiB.');
  const data = await read(file, PDF_LIMIT);
  signal.throwIfAborted();
  const worker = new Worker(new URL('./pdf-worker.js', import.meta.url), {
    workerData: { data, page }, resourceLimits: { maxOldGenerationSizeMb: 128 }, stdout: true, stderr: true
  });
  worker.stdout.resume();
  worker.stderr.resume();
  const abort = () => void worker.terminate();
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 12000);
  try {
    return await new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.once('exit', () => reject(new Error('PDF worker ended')));
      worker.once('message', resolve);
    });
  } catch {
    throw new Problem(415, 'This PDF is encrypted, invalid, or exceeds the preview budget.');
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    await worker.terminate();
  }
}

export async function createPreview(file, type, params, signal) {
  const release = capacity.enter();
  try {
    if (type.kind === 'text') {
      const data = await read(file, TEXT_LIMIT);
      check(!data.includes(0), 415, 'This file contains binary data.');
      let content;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(data, { stream: file.size > TEXT_LIMIT }); }
      catch { throw new Problem(415, 'Text preview supports valid UTF-8.'); }
      return { json: { text: content, truncated: file.size > TEXT_LIMIT } };
    }
    if (type.kind === 'image') {
      check(file.size <= IMAGE_LIMIT, 415, 'Image preview is limited to 32 MiB.');
      const size = params.has('thumb') ? 560 : 1920;
      let transformed;
      try {
        const processor = sharp(await read(file, IMAGE_LIMIT), { limitInputPixels: 24_000_000, autoOrient: true, failOn: 'error' });
        const metadata = await processor.metadata();
        check(['jpeg', 'png', 'webp', 'gif', 'heif', 'tiff'].includes(metadata.format), 415, 'This image format cannot be previewed.');
        transformed = await processor.resize(size, size, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).timeout({ seconds: 8 }).toBuffer();
      } catch { throw new Problem(415, 'This image is invalid, unsupported, or exceeds the preview budget.'); }
      return { bytes: transformed, type: 'image/webp' };
    }
    if (type.kind === 'pdf') {
      const page = Number(params.get('page') ?? 1);
      check(Number.isInteger(page) && page > 0 && page <= 10000, 400, 'Invalid PDF page.');
      const rendered = await renderPDF(file, page, signal);
      check(rendered.bytes, 415, rendered.reason ?? 'This PDF could not be previewed.');
      return { bytes: rendered.bytes, type: 'image/png', pages: rendered.pages };
    }
    throw new Problem(415, 'There is no safe built-in preview for this format.');
  } finally { release(); }
}
