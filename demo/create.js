import path from 'node:path';
import fs from 'node:fs/promises';
import { fixtures, demoManifest } from './fixtures.js';

const root = path.resolve(process.argv[2] ?? '.folderdrop-demo');
const { source, inbox } = await fixtures(root);
const manifest = path.join(root, 'manifest.json');
await fs.writeFile(manifest, JSON.stringify(demoManifest(source, inbox), null, 2));
console.log(JSON.stringify({ source, inbox, manifest, data: path.join(root, 'Data') }, null, 2));
