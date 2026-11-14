import { read } from 'node:fs';
import { promisify } from 'node:util';
import { parentPort, workerData } from 'node:worker_threads';
import { ADTS, FLAC, MATROSKA, MP3, MP4, OGG, QTFF, WAVE, WEBM, Conversion, CustomSource,
  FilePathTarget, FlacOutputFormat, Input, Mp3OutputFormat, Mp4OutputFormat, OggOutputFormat, Output,
  WavOutputFormat, WebMOutputFormat } from 'mediabunny';

const readBytes = promisify(read);
const { fd, size, outputPath, mime, max } = workerData;
const formats = {
  'audio/wav': () => new WavOutputFormat(), 'audio/mpeg': () => new Mp3OutputFormat(),
  'audio/ogg': () => new OggOutputFormat(), 'audio/flac': () => new FlacOutputFormat(),
  'video/webm': () => new WebMOutputFormat(), 'video/x-matroska': () => new WebMOutputFormat()
};
const source = new CustomSource({ maxCacheSize: 4 * 1024 ** 2, getSize: () => size, handleUnhandledError() {},
  async read(start, end) {
    if (end - start > 8 * 1024 ** 2) throw new Error('Invalid media packet size');
    const buffer = Buffer.allocUnsafe(end - start);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await readBytes(fd, buffer, offset, buffer.length - offset, start + offset);
      if (!bytesRead) throw new Error('Source changed during preview');
      offset += bytesRead;
    }
    return buffer;
  }
});
const input = new Input({ source, formats: [MP4, QTFF, MP3, ADTS, WAVE, FLAC, OGG, WEBM, MATROSKA] });
const target = new FilePathTarget(outputPath);
const output = new Output({ target, format: formats[mime]?.() ?? new Mp4OutputFormat({ fastStart: false }) });
try {
  const conversion = await Conversion.init({ input, output, tracks: 'primary', tags: {}, showWarnings: false,
    copy: { mode: 'forced' }, video: { discard: mime.startsWith('audio/') } });
  if (!conversion.isValid || conversion.discardedTracks.some(track => track.track.type !== 'subtitle') ||
      (mime.startsWith('video/') && !(await input.getPrimaryVideoTrack()))) throw new Error('Unsupported media codec');
  target.on('write', ({ end }) => { if (end > max) throw new Error('Media preview exceeds its size limit'); });
  await conversion.execute();
  parentPort.postMessage({ mime: await output.getMimeType() });
} catch {
  await output.cancel().catch(() => {});
  parentPort.postMessage({ reason: 'This container or codec could not be converted within the safe preview limits.' });
} finally { input.dispose(); }
