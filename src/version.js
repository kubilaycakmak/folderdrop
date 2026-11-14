import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const root = fileURLToPath(new URL('../', import.meta.url));
const build = createHash('sha256').update(VERSION);
for (const directory of ['bin', 'src', 'web']) {
  const names = readdirSync(path.join(root, directory), { recursive: true }).filter(name => /\.(js|css|html)$/.test(name)).sort();
  for (const name of names) {
    build.update('\0' + directory + '/' + name.replaceAll(path.sep, '/') + '\0');
    build.update(readFileSync(path.join(root, directory, name), 'utf8').replaceAll('\r\n', '\n'));
  }
}
export const BUILD = build.digest('hex').slice(0, 10);
