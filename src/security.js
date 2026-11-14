import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { check } from './errors.js';

const derive = promisify(scrypt);
export const token = (bytes = 24) => randomBytes(bytes).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('hex');
export const accessCode = () => randomBytes(10).toString('hex').toUpperCase().match(/.{5}/g).join('-');

export async function secretHash(value, salt = token(16)) {
  const key = await derive(value, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 ** 2 });
  return `${salt}:${key.toString('hex')}`;
}

export async function matchesSecret(value, stored) {
  const hash = await secretHash(value, stored.split(':')[0]);
  return equal(hash, stored);
}

export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function cookie(req, name) {
  return req.headers.cookie?.split(/; */).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1) ?? '';
}

export function setCookie(res, name, value, path, maxAge, secure = false) {
  res.setHeader('Set-Cookie', `${name}=${value}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}

export class Capacity {
  #used = 0;
  constructor(max, message) { this.max = max; this.message = message; }
  enter() {
    check(this.#used < this.max, 429, this.message, 'busy');
    this.#used++;
    return () => { this.#used--; };
  }
}
