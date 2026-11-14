import { test, expect, devices } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream';
import QRCode from 'qrcode';
import selfsigned from 'selfsigned';
import { serve } from '../../src/daemon.js';
import { BUILD, VERSION } from '../../src/version.js';
import { zipContents } from '../helpers.js';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `https://127.0.0.1:${server.address().port}`;
}

test('a phone browser decrypts through a trusted receiver without installing FolderDrop', async ({ browser, browserName }) => {
  const temporary = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'folderdrop-web-receive-'));
  let service;
  const servers = [];
  let phone;
  let admin;
  try {
    const assets = path.join(temporary, 'receiver');
    const source = path.join(temporary, 'source');
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'mobile.txt'), 'Confidential sample for the mobile ZIP test.');
    execFileSync(process.execPath, ['scripts/web-receiver.js', assets], { stdio: 'ignore', timeout: 15000 });
    const tls = await selfsigned.generate([{ name: 'commonName', value: 'FolderDrop browser test' }], {
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }]
    });
    const cert = { key: tls.private, cert: tls.cert };
    const receiver = https.createServer(cert, async (req, res) => {
      const names = { '/': ['index.html', 'text/html'], '/receiver.js': ['receiver.js', 'text/javascript'],
        '/receiver.css': ['receiver.css', 'text/css'] };
      const file = names[new URL(req.url, 'https://receiver.invalid').pathname];
      if (!file) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': file[1] }).end(await fs.readFile(path.join(assets, file[0])));
    });
    servers.push(receiver);
    const trusted = await listen(receiver);
    let upstream;
    const edgeCapture = [];
    const edge = https.createServer(cert, (req, res) => {
      const record = { headers: req.headers, url: req.url, body: [], method: req.method };
      edgeCapture.push(record);
      req.on('data', chunk => record.body.push(chunk));
      const toSender = http.request(new URL(req.url, upstream), { method: req.method, headers: req.headers }, reply => {
        res.writeHead(reply.statusCode, reply.headers);
        pipeline(reply, res, () => {});
      });
      toSender.on('error', () => { if (!res.headersSent) res.writeHead(502).end(); });
      pipeline(req, toSender, () => {});
    });
    servers.push(edge);
    const publicAddress = await listen(edge);
    service = await serve(path.join(temporary, 'state'), 0);
    const { app } = service;
    const share = await app.call('create', { roots: [{ label: 'Test', path: source }], items: [{ root: 0, relative: 'mobile.txt' }] });
    const temporaryListener = await app.call('start', { id: share.id, mode: 'local' });
    const port = Number(new URL(temporaryListener.connection.addresses[0]).port);
    await app.call('stop', { id: share.id });
    admin = await browser.newPage();
    await admin.goto(service.admin.launch().url);
    await expect(admin.locator('#workspace-build')).toHaveText(`v${VERSION} · build ${BUILD}`);
    const receiverField = admin.getByLabel('Trusted web receiver (optional)', { exact: true });
    await admin.getByLabel('Network mode').selectOption('public');
    await expect(receiverField).toHaveValue('https://folderdrop-receiver.netlify.app/');
    await admin.getByLabel('Network mode').selectOption('self-hosted');
    await admin.getByLabel('External HTTPS origin').fill(publicAddress);
    await admin.getByLabel('Listener port').fill(String(port));
    await admin.getByRole('button', { name: 'Use FolderDrop web receiver' }).click();
    await expect(receiverField).toHaveValue('https://folderdrop-receiver.netlify.app/');
    await receiverField.fill(trusted);
    await admin.getByRole('button', { name: 'Start proxy listener' }).click();
    await expect(admin.getByText('Phone links enabled for')).toBeVisible();
    upstream = (await app.call('inspect', { id: share.id })).connection.upstream;
    await admin.getByRole('button', { name: 'Issue access code' }).click();
    await admin.getByLabel('Recipient name').fill('Phone demo');
    await admin.getByLabel('End-to-end encrypted ZIP').check();
    await admin.getByRole('button', { name: 'Generate code' }).click();
    const dialog = admin.getByRole('dialog');
    const code = dialog.getByRole('textbox', { name: 'One-time access code' });
    const key = dialog.getByLabel('Decryption key', { exact: true });
    await expect(code).toBeVisible();
    const { recipients } = await app.call('inspect', { id: share.id });
    const [profile] = recipients;
    const { links, receiverLinks } = await app.call('links', { id: share.id, recipient: profile.id });
    const issued = { links, id: profile.id, code: await code.inputValue(), decryptionKey: await key.inputValue() };
    expect(new URL(receiverLinks[0]).origin).toBe(trusted);
    expect(receiverLinks[0]).not.toContain(issued.code);
    expect(receiverLinks[0]).not.toContain(issued.decryptionKey);
    await expect(dialog.getByLabel('Phone or browser link')).toHaveValue(receiverLinks[0]);
    await expect(dialog.getByRole('link', { name: 'Open in phone browser' })).toHaveAttribute('href', receiverLinks[0]);
    await expect(dialog.getByRole('link', { name: /Scan to open/ })).toHaveAttribute('href', receiverLinks[0]);
    await expect(dialog.getByRole('img', { name: 'QR code for the phone or browser link' })).toHaveAttribute('src',
      await QRCode.toDataURL(receiverLinks[0], { width: 256, margin: 2 }));
    const listener = app.network.active.get(share.id);
    const ready = listener.status;
    listener.status = { ...ready, connection: 'reconnecting', addresses: [] };
    await expect(dialog.getByRole('status')).toContainText('No current recipient address');
    await expect(dialog.getByRole('img', { name: /QR code/ })).toHaveCount(0);
    const moved = 'https://replacement.example';
    listener.status = { ...ready, addresses: [moved] };
    const movedLink = `${trusted}/#${new URLSearchParams({ delivery: moved + new URL(issued.links[0]).pathname })}`;
    await expect(dialog.getByRole('link', { name: /Scan to open/ })).toHaveAttribute('href', movedLink);
    await expect(dialog.getByRole('img', { name: /QR code/ })).toHaveAttribute('src',
      await QRCode.toDataURL(movedLink, { width: 256, margin: 2 }));
    await expect(code).toHaveValue(issued.code);
    await expect(key).toHaveValue(issued.decryptionKey);
    listener.status = ready;
    await expect(dialog.getByLabel('Phone or browser link')).toHaveValue(receiverLinks[0]);
    phone = await browser.newContext({
      ...devices[browserName === 'webkit' ? 'iPhone 15' : 'Pixel 7'],
      ignoreHTTPSErrors: true, acceptDownloads: true
    });
    const page = await phone.newPage();
    const [link] = issued.links;
    await page.goto(link);
    await expect(page.locator('input, script')).toHaveCount(0);
    const openReceiver = page.getByRole('link', { name: 'Open in phone browser' });
    await expect(openReceiver).toHaveAttribute('href', receiverLinks[0]);
    await openReceiver.click();
    await expect(page.getByLabel('Delivery link')).toHaveValue(issued.links[0]);
    await expect(page.getByRole('heading', { name: 'Receive encrypted files' })).toBeVisible();
    await expect(page.locator('#receiver-build')).toHaveText(/^v[\d.]+ · build [a-f\d]{10}$/);
    expect(new URL(page.url()).hash).toBe('');
    const ok = await page.request.fetch(link + '/redeem', { method: 'OPTIONS',
      headers: { Origin: trusted, 'Access-Control-Request-Method': 'POST' } });
    expect(ok.status()).toBe(204);
    expect(ok.headers()['access-control-allow-origin']).toBe(trusted);
    const refused = await page.request.fetch(link + '/redeem', { method: 'OPTIONS',
      headers: { Origin: 'https://untrusted.example', 'Access-Control-Request-Method': 'POST' } });
    expect(refused.status()).toBe(403);
    expect(refused.headers()['access-control-allow-origin']).toBeUndefined();
    const unopened = await page.request.get(link + '/encrypted', { headers: { Origin: trusted } });
    expect(unopened.status()).toBe(401);
    await page.getByRole('button', { name: 'Check connection' }).click();
    await expect(page.getByRole('status')).toContainText('The one-time code is still required');
    expect((await app.call('inspect', { id: share.id })).recipients.find(profile => profile.id === issued.id).redeemed).toBeFalsy();
    await page.getByLabel('One-time access code').fill(issued.code);
    await page.getByLabel('Decryption key').fill(issued.decryptionKey);
    await page.getByRole('button', { name: 'Open delivery' }).click();
    await expect(page.getByText('ZIP verified. Save it to this device.')).toBeVisible();
    const downloading = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Save ZIP' }).click();
    const retrieved = await zipContents(await fs.readFile(await (await downloading).path()));
    expect(retrieved.get('Test/mobile.txt')).toBe('Confidential sample for the mobile ZIP test.');
    expect(edgeCapture.some(entry => entry.headers.origin === trusted && entry.method === 'GET' && entry.url.endsWith('/encrypted'))).toBe(true);
    expect(edgeCapture.every(entry =>
      ![entry.url, JSON.stringify(entry.headers), Buffer.concat(entry.body).toString()].some(value => value.includes(issued.decryptionKey))
    )).toBe(true);
    const secondPhone = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const fresh = await secondPhone.newPage();
      await fresh.goto(trusted);
      await fresh.goto(receiverLinks[0]);
      await expect(fresh.getByLabel('Delivery link')).toHaveValue(link);
      await fresh.getByLabel('One-time access code').fill(issued.code);
      await fresh.getByLabel('Decryption key').fill(issued.decryptionKey);
      await fresh.getByRole('button', { name: 'Open delivery' }).click();
      await expect(fresh.getByRole('alert')).toContainText('This code was used');
    } finally { await secondPhone.close(); }
  } finally {
    await admin?.close();
    await phone?.close();
    for (const server of servers) {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    }
    await service?.close();
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 6 });
  }
});
