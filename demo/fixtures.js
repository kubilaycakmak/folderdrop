import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, Output, WebMOutputFormat } from 'mediabunny';

function pdf(lines) {
  const pages = lines.map((text, index) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`);
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  pages.forEach((page, index) => {
    const program = `0.11 0.24 0.16 rg 0 598 612 194 re f\n1 1 1 rg BT /F1 30 Tf 58 690 Td (Field Notes / Studio) Tj ET\n0.11 0.24 0.16 rg BT /F1 20 Tf 58 543 Td (${lines[index]}) Tj ET\n`;
    objects.push(page, `<< /Length ${program.length} >>\nstream\n${program}endstream`);
  });
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset.toString().padStart(10, '0') + ' 00000 n \n';
  });
  return `${body}xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.join('')}trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${body.length}\n%%EOF\n`;
}

function wav() {
  const count = 16000;
  const buffer = Buffer.alloc(44 + count * 2);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(16000, 24); buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36);
  buffer.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) {
    const envelope = Math.sin(Math.PI * i / count) ** 2;
    buffer.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * i / count) * 5600 * envelope), 44 + i * 2);
  }
  return buffer;
}

async function webm() {
  // Two 64×48 VP8 keyframes of solid colors generated using Chromium WebCodecs.
  const frames = [
    'UAMAnQEqQAAwAAAHCIWFiJmEiAEkEA7AP4AgghFS8wg/fOiA/va+B//8pV4LG6PP//vgT7wJ94E/3HSughwA',
    'cAMAnQEqQAAwAAAHCIWFiJmEiAEkEBOtUB/AEDhG5hBTGzwsAP7+pHr/+qx/qsf6rH/6rH/89M15g/wsAA=='
  ];
  const track = new EncodedVideoPacketSource('vp8');
  const target = new BufferTarget();
  const output = new Output({ format: new WebMOutputFormat(), target });
  output.addVideoTrack(track);
  output.setMetadataTags({ title: 'Synthetic palette motion', comment: 'Sample camera metadata for removal verification' });
  await output.start();
  for (const [index, payload] of frames.entries()) {
    await track.add(new EncodedPacket(Buffer.from(payload, 'base64'), 'key', index * 0.5, 0.5),
      { decoderConfig: { codec: 'vp8', codedWidth: 64, codedHeight: 48 } });
  }
  await output.finalize();
  return Buffer.from(target.buffer);
}

async function artwork(destination, variant) {
  const palettes = [['#cbd4a8', '#74977b', '#386353', '#264740'], ['#e0cbad', '#ac8f69', '#6f775b', '#404f43']];
  const [sky, distant, near, ground] = palettes[variant];
  const horizon = `<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="760" viewBox="0 0 1120 760">
  <defs><linearGradient id="s" x2="0%" y2="100%"><stop stop-color="${sky}"/><stop offset="1" stop-color="#f4e6b8"/></linearGradient>
  <pattern id="grid" width="19" height="19" patternUnits="userSpaceOnUse"><path d="M0 19L19 0" fill="none" stroke="#f8f8e0" stroke-opacity=".18"/></pattern></defs>
  <path fill="url(#s)" d="M0 0h1120v760H0z"/><circle cx="${variant ? 820 : 720}" cy="215" r="88" fill="#fbebba"/>
  <path fill="${distant}" d="M0 482L179 318l150 97 166-197L656 438l113-89 116 46 235-151v516H0z"/>
  <path fill="${near}" d="M0 561l142-85 133 34 177-60 113 82 194-117 142 40 219-76v381H0z"/>
  <path fill="${ground}" d="M0 623l130-113 195 78 131-64 173 96 135-62 183 36 173-108v274H0z"/>
  <path fill="url(#grid)" d="M0 0h1120v760H0z"/>
  <path d="M45 45h66m-66 0v66m1030-66h-66m66 0v66M45 715h66m-66 0v-66m1030 66h-66m66 0v-66" stroke="#fcf4d1" stroke-opacity=".65" fill="none"/>
  </svg>`;
  await sharp(Buffer.from(horizon)).jpeg({ quality: 88 }).toFile(destination);
}

export async function fixtures(directory) {
  const source = path.join(directory, 'Field Notes');
  const inbox = path.join(directory, 'Inbox');
  for (const folder of [path.join(source, 'Photography'), path.join(source, 'Project notes'), inbox]) {
    await fs.mkdir(folder, { recursive: true });
  }
  await Promise.all([
    artwork(path.join(source, 'Ridge study.jpg'), 0),
    artwork(path.join(source, 'Evening light.jpg'), 1),
    fs.writeFile(path.join(source, 'Lookbook.pdf'), pdf(['Art direction and image selections', 'Delivery notes and next steps'])),
    fs.writeFile(path.join(source, 'Photography', 'Ambient tone.wav'), wav()),
    webm().then(video => fs.writeFile(path.join(source, 'Photography', 'Palette motion.webm'), video)),
    fs.writeFile(path.join(source, 'Project notes', 'Read me.txt'), 'FIELD NOTES\n\nThe selected artwork, lookbook and a short audio reference are ready for review.\n'),
    fs.writeFile(path.join(source, 'Project notes', 'Editable project.proj'), Buffer.from([0, 12, 24, 48, 96]))
  ]);
  return { source, inbox };
}

export function demoManifest(source, inbox) {
  return { roots: [{ path: source, label: 'Field Notes' }],
    presentation: { title: 'Field Notes Studio', intro: 'Selected artwork, a lookbook, and production notes for the autumn collection.', theme: 'paper' },
    items: [
      ['Ridge study.jpg', 'Primary landscape study for the collection.'],
      ['Evening light.jpg', 'Warm palette exploration.'],
      ['Lookbook.pdf', 'Art direction and delivery notes.'],
      ['Photography/Ambient tone.wav', 'A short audio reference.'],
      ['Photography/Palette motion.webm', 'A one-second palette motion test.'],
      ['Project notes/Read me.txt', 'Read this first for the delivery context.'],
      ['Project notes/Editable project.proj', 'Editable source project.']
    ].map(([relative, description]) => ({ root: 0, relative, path: relative, description })),
    inbox: { path: inbox, types: ['text/plain', 'application/pdf', 'image/*'], maxFile: 16777216, maxTotal: 67108864, maxFiles: 20 } };
}
