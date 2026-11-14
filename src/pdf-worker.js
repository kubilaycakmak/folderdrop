import { parentPort, workerData } from 'node:worker_threads';
import * as canvas from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';

Object.assign(globalThis, { DOMMatrix: canvas.DOMMatrix, ImageData: canvas.ImageData, Path2D: canvas.Path2D });
const packageFile = import.meta.resolve('pdfjs-dist/package.json');
const directory = fileURLToPath(new URL('.', packageFile));
const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
try {
  const book = await getDocument({ data: workerData.data, isEvalSupported: false, disableFontFace: true,
    useSystemFonts: false, standardFontDataUrl: `${directory}standard_fonts/`, cMapUrl: `${directory}cmaps/`,
    wasmUrl: `${directory}wasm/`, iccUrl: `${directory}iccs/`, maxImageSize: 16000000, useWasm: false }).promise;
  const page = await book.getPage(workerData.page);
  const original = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(2, 1600 / Math.max(original.width, original.height)) });
  const surface = canvas.createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
  await page.render({ canvasContext: surface.getContext('2d'), viewport }).promise;
  parentPort.postMessage({ bytes: surface.toBuffer('image/png'), pages: book.numPages });
  await book.destroy();
} catch {
  parentPort.postMessage({ reason: 'This PDF page is encrypted, invalid, or unavailable.' });
}
