import path from 'node:path';
import { Readable, Transform, pipeline as pipe } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import { check } from './errors.js';
import { disposition, isolated, json } from './http.js';
import { digest } from './security.js';
import { stamp } from './files.js';
import { createPreview, format } from './previews.js';

export function parseRange(value, size) {
  const parts = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!parts || size === 0 || (!parts[1] && !parts[2])) return null;
  const first = parts[1] && Number(parts[1]);
  const last = parts[2] && Number(parts[2]);
  const start = first === '' ? Math.max(0, size - last) : first;
  const end = first === '' || last === '' ? size - 1 : Math.min(last, size - 1);
  return start < size && start <= end && Number.isSafeInteger(start) && Number.isSafeInteger(end) ? { start, end } : null;
}

function transferSignal(res, task) {
  const socket = new AbortController();
  const abort = () => { if (!res.writableFinished) socket.abort(); };
  res.once('close', abort);
  return AbortSignal.any([socket.signal, task.signal]);
}

function measure(task) {
  return new Transform({ transform(chunk, encoding, callback) { task.add(chunk.length); callback(null, chunk); } });
}

function recheck(getContext, original) {
  return () => check(getContext().recipient.epoch === original.recipient.epoch, 403, 'The transfer permission changed.');
}

export async function sendItem(req, res, deliveries, getContext, id, purpose, params) {
  const context = getContext();
  const item = deliveries.item(context, id);
  const type = format(item.path);
  const media = purpose === 'media' || purpose === 'media-info';
  if (media) check(type.kind === 'audio' || type.kind === 'video', 415, 'This format is not playable media.');
  const filename = path.posix.basename(item.path);
  const original = await deliveries.open(context, item);
  let file = original;
  let task;
  const valid = recheck(getContext, context);
  try {
    valid();
    if (media) {
      task = deliveries.begin(context, 'preview', null, valid);
      file = await deliveries.media.preview(original, type, transferSignal(res, task));
      valid();
      if (purpose === 'media-info') return json(res, { mime: file.mime });
    }
    if (purpose === 'preview') {
      task = deliveries.begin(context, 'preview', null, valid);
      const data = await createPreview(file, type, params, transferSignal(res, task));
      valid();
      if (data.json) return json(res, data.json);
      if (data.pages) res.setHeader('X-FolderDrop-Pages', data.pages);
      res.setHeader('Content-Security-Policy', isolated);
      res.writeHead(200, { 'Content-Type': data.type, 'Content-Length': data.bytes.length });
      return res.end(data.bytes);
    }
    const etag = `"${item.sha256 ?? digest(stamp(file.stat))}"`;
    const date = new Date(Number(file.stat.mtimeMs));
    const since = Math.floor(date.getTime() / 1000);
    const tags = header => header?.split(',').map(tag => tag.trim()) ?? [];
    const condition = tags(req.headers['if-match']);
    const unmodified = Date.parse(req.headers['if-unmodified-since']) / 1000;
    check(!(condition.length && !condition.includes('*') && !condition.includes(etag)) &&
      !(!condition.length && since > unmodified), 412, 'The original changed.');
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', date.toUTCString());
    res.setHeader('Content-Security-Policy', isolated);
    const noneMatch = tags(req.headers['if-none-match']);
    if ((noneMatch.length && (noneMatch.includes('*') || noneMatch.some(tag => tag.replace(/^W\//, '') === etag))) ||
      (!noneMatch.length && since <= Date.parse(req.headers['if-modified-since']) / 1000)) {
      res.writeHead(304).end();
      return;
    }
    const ifRange = req.headers['if-range'];
    const rangeHeader = req.headers.range && (!ifRange || ifRange === etag || since === Date.parse(ifRange) / 1000);
    const range = rangeHeader ? parseRange(req.headers.range, file.size) : undefined;
    res.setHeader('Accept-Ranges', 'bytes');
    if (range === null) return res.writeHead(416, { 'Content-Range': `bytes */${file.size}` }).end();
    const total = range ? range.end - range.start + 1 : file.size;
    if (req.method === 'GET') {
      if (!task) task = deliveries.begin(context, 'download', total, valid);
      if (purpose === 'download') {
        const grant = deliveries.grant(context, 'file', `${id}:${etag}`, req.headers['x-folderdrop-resume']);
        res.setHeader('X-FolderDrop-Resume', grant.id);
      }
    }
    if (range) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
    res.writeHead(range ? 206 : 200, { 'Content-Type': file.mime ?? type.mime, 'Content-Length': total,
      'Content-Disposition': disposition(media ? 'media-preview' : filename, media ? 'inline' : 'attachment') });
    if (req.method === 'HEAD' || !total) return res.end();
    await pipeline(file.handle.createReadStream({ autoClose: false, start: range?.start ?? 0,
      end: range?.end ?? file.size - 1 }), measure(task), res, { signal: transferSignal(res, task) });
  } finally { task?.done(); await file.close?.(); await original.handle.close(); }
}

const zipDate = new Date(2000, 0, 1, 12);
export async function sendArchive(req, res, deliveries, getContext, ids) {
  const context = getContext();
  check(Array.isArray(ids) && ids.length > 0 && ids.length <= 1000 && new Set(ids).size === ids.length, 400, 'Select up to 1,000 distinct files.');
  const valid = recheck(getContext, context);
  const files = [];
  for (const id of ids) {
    const item = deliveries.item(context, id);
    const file = await deliveries.open(context, item);
    try { files.push({ item, size: file.size, signature: stamp(file.stat) }); }
    finally { await file.handle.close(); }
    valid();
  }
  const key = digest(JSON.stringify(files.map(file => [file.item.id, file.item.path, file.signature])));
  const etag = `"${key}"`;
  const resumed = req.headers['x-folderdrop-resume'];
  const wantsRange = req.headers.range && (!req.headers['if-range'] || req.headers['if-range'] === etag);
  check(!wantsRange || resumed, 400, 'Resume an archive with its X-FolderDrop-Resume grant.');
  if (req.headers['if-match']) check(req.headers['if-match'] === etag || req.headers['if-match'] === '*', 412, 'The archive selection changed.');
  const task = deliveries.begin(context, 'archive', null, valid);
  const signal = transferSignal(res, task);
  const zip = new yazl.ZipFile();
  zip.on('error', error => zip.outputStream.destroy(error));
  const active = new Set();
  try {
    for (const { item, size, signature } of files) {
      zip.addReadStreamLazy(item.path, { size, mtime: zipDate, mode: 0o100644, compress: false, forceDosTimestamp: true }, callback => {
        (async () => {
          signal.throwIfAborted();
          valid();
          const file = await deliveries.open(context, item);
          if (signal.aborted || stamp(file.stat) !== signature) {
            await file.handle.close();
            signal.throwIfAborted();
            check(false, 409, 'A selected source changed while assembling the archive.');
          }
          if (!size) {
            await file.handle.close();
            callback(null, Readable.from([]));
            return;
          }
          const checked = new Transform({
            transform(chunk, encoding, done) { done(null, chunk); },
            flush(done) { file.handle.stat({ bigint: true }).then(stat => {
              try { check(stamp(stat) === signature, 409, 'A selected source changed during archiving.'); done(); }
              catch (error) { done(error); }
            }, done); }
          });
          const input = file.handle.createReadStream({ start: 0, end: size - 1, autoClose: false });
          active.add(input);
          checked.once('close', () => { active.delete(input); input.destroy(); void file.handle.close().catch(() => {}); });
          callback(null, checked);
          pipe(input, checked, () => {});
        })().catch(callback);
      });
    }
    const size = await new Promise(resolve => zip.end({}, resolve));
    signal.throwIfAborted();
    valid();
    const range = wantsRange ? parseRange(req.headers.range, size) : undefined;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('ETag', etag);
    if (range === null) {
      zip.outputStream.destroy();
      return res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
    }
    const grant = deliveries.grant(context, 'archive', key, resumed);
    res.setHeader('X-FolderDrop-Resume', grant.id);
    res.setHeader('Content-Security-Policy', isolated);
    const total = range ? range.end - range.start + 1 : size;
    task.setTotal(total);
    if (range) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    res.writeHead(range ? 206 : 200, { 'Content-Type': 'application/zip', 'Content-Disposition': disposition('delivery.zip'),
      'Content-Length': total });
    if (!range) await pipeline(zip.outputStream, measure(task), res, { signal });
    else {
      let offset = 0;
      const slice = new Transform({ transform(chunk, encoding, callback) {
        const start = Math.max(0, range.start - offset);
        const end = Math.min(chunk.length, range.end + 1 - offset);
        offset += chunk.length;
        callback(null, end > start ? chunk.subarray(start, end) : undefined);
      } });
      await pipeline(zip.outputStream, slice, measure(task), res, { signal });
    }
  } finally {
    zip.outputStream.destroy();
    for (const stream of active) stream.destroy();
    task.done();
  }
}
