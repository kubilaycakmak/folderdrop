import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'dist', 'web-receiver');
await mkdir(output, { recursive: true });
await build({ entryPoints: [path.join(root, 'mobile', 'receiver.js')], outfile: path.join(output, 'receiver.js'),
  format: 'esm', platform: 'browser', target: ['safari17', 'chrome120'], bundle: true, legalComments: 'eof' });
for (const name of ['index.html', 'receiver.css']) await copyFile(path.join(root, 'mobile', name), path.join(output, name));
console.log(output);
