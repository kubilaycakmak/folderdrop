import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/version.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'dist', 'web-receiver');
await mkdir(output, { recursive: true });
await build({ entryPoints: [path.join(root, 'mobile', 'receiver.js')], outfile: path.join(output, 'receiver.js'),
  format: 'esm', platform: 'browser', target: ['safari17', 'chrome120'], bundle: true, legalComments: 'eof' });
const html = await readFile(path.join(root, 'mobile', 'index.html'), 'utf8');
const css = await readFile(path.join(root, 'mobile', 'receiver.css'), 'utf8');
const script = await readFile(path.join(output, 'receiver.js'), 'utf8');
const revision = createHash('sha256').update([VERSION, html, css, script].join('\0').replaceAll('\r\n', '\n')).digest('hex').slice(0, 10);
await writeFile(path.join(output, 'index.html'), html.replaceAll('@@BUILD@@', revision).replace('@@VERSION@@', VERSION));
await writeFile(path.join(output, 'receiver.css'), css);
console.log(output);
