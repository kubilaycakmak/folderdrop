import { readFile } from 'node:fs/promises';
import { check, problem } from './errors.js';

export const jsonType = 'application/json; charset=utf-8';
export const csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self'; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";
export const isolated = "sandbox; default-src 'none'; frame-ancestors 'none'";
export function headers(res) {
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

export function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': jsonType, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

export function fail(res, error) {
  if (res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  const safe = problem(error);
  for (const header of ['Content-Length', 'Content-Disposition', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) res.removeHeader(header);
  json(res, { error: safe.message, code: safe.code }, safe.status);
}

export async function body(req, limit = 2 * 1024 ** 2) {
  check(req.headers['content-type']?.split(';')[0] === 'application/json', 415, 'Send application/json.');
  check(!req.headers['content-length'] || Number(req.headers['content-length']) <= limit, 413, 'This request is too large.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    check(size <= limit, 413, 'This request is too large.');
    chunks.push(chunk);
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
  check(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 400, 'Send a JSON object.');
  return parsed;
}

const assets = new Map([
  ['style.css', 'text/css'],
  ['shared.js', 'text/javascript'], ['admin.js', 'text/javascript'], ['recipient.js', 'text/javascript'],
  ['admin.html', 'text/html'], ['recipient.html', 'text/html'], ['encrypted-link.html', 'text/html']
]);
const cached = new Map();
export async function asset(res, name, render) {
  const type = assets.get(name);
  check(type, 404, 'Page not found.');
  if (!cached.has(name)) cached.set(name, await readFile(new URL(`../web/${name}`, import.meta.url)));
  const source = cached.get(name);
  const bytes = render ? Buffer.from(render(source.toString('utf8'))) : source;
  res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Content-Length': bytes.length });
  res.end(bytes);
}

export function origin(req, allowed, header = 'x-folderdrop-action') {
  check(req.headers[header] === '1' && (!req.headers.origin || allowed.has(req.headers.origin)) &&
    req.headers['sec-fetch-site'] !== 'cross-site', 403, 'Cross-site requests are blocked.', 'csrf');
}

export function disposition(name, kind = 'attachment') {
  const ascii = name.replace(/[^a-z0-9._ -]/gi, '_');
  const unicode = encodeURIComponent(name.toWellFormed()).replace(/['()*]/g, character =>
    `%${character.charCodeAt(0).toString(16)}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${unicode}`;
}
