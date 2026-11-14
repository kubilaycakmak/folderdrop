import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
let count = 0;
async function check(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await check(filename);
    if (entry.isFile() && entry.name.endsWith('.js')) {
      execFileSync(process.execPath, ['--check', filename], { stdio: 'inherit' });
      count++;
    }
  }
}
for (const folder of ['bin', 'src', 'web', 'demo', 'scripts', 'mobile']) await check(path.join(root, folder));
await Promise.all(['sharp', '@napi-rs/canvas', '@modelcontextprotocol/server', '@modelcontextprotocol/server/stdio',
  'pdfjs-dist/package.json', 'file-type', 'mediabunny', 'mime-types', 'yazl', 'qrcode', 'zod', 'age-encryption'].map(name => import.meta.resolve(name)));
console.error(`Checked ${count} JavaScript modules and resolved production dependencies.`);
