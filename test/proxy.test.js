import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import { pipeline } from 'node:stream';
import selfsigned from 'selfsigned';
import { fixture, draft } from './helpers.js';

test('a loopback TLS reverse proxy serves the HTTPS recipient flow after restart', { timeout: 12000 }, async t => {
  const f = await fixture(t);
  const { private: key, cert } = await selfsigned.generate([{ name: 'commonName', value: 'FolderDrop loopback test' }], {
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] }]
  });
  let origin;
  const proxy = https.createServer({ key, cert }, (req, res) => {
    const upstream = http.request(new URL(req.url, origin), { method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers);
      pipeline(response, res, () => {});
    });
    upstream.once('error', () => { if (!res.headersSent && !res.destroyed) res.writeHead(502).end(); });
    pipeline(req, upstream, () => {});
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections(); }));
  const external = `https://127.0.0.1:${proxy.address().port}`;
  const share = await draft(f);
  const temporary = await f.app.call('start', { id: share.id });
  await f.app.call('stop', { id: share.id });
  const started = await f.app.call('start', { id: share.id, mode: 'self-hosted', external, port: Number(new URL(temporary.connection.addresses[0]).port) });
  origin = started.connection.upstream;
  const recipient = await f.app.call('issue', { id: share.id });
  const address = recipient.links[0];
  const request = (url, options = {}, data) => new Promise((resolve, reject) => {
    const call = https.request(url, { ...options, ca: cert, agent: false }, async response => {
      const chunks = [];
      try {
        for await (const chunk of response) chunks.push(chunk);
        resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() });
      } catch (error) { reject(error); }
    });
    call.once('error', reject);
    call.end(data);
  });
  const redeemed = await request(`${address}/redeem`, { method: 'POST', headers: { 'Content-Type': 'application/json',
    'X-FolderDrop-Action': '1', Origin: external } }, JSON.stringify({ code: recipient.code }));
  assert.equal(redeemed.status, 200);
  assert.match(redeemed.headers['set-cookie'][0], /; Secure/);
  const cookie = redeemed.headers['set-cookie'][0].split(';')[0];
  assert.equal((await request(`${external}/api/config`)).status, 404);
  await f.restart();
  const response = await request(`${address}/download/${share.items[0].id}`, { headers: { Cookie: cookie, Range: 'bytes=4-6' } });
  assert.equal(response.status, 206);
  assert.equal(response.body, '456');
});
