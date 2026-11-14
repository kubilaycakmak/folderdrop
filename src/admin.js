import { asset, body, fail, headers, json, origin } from './http.js';
import { check } from './errors.js';
import { cookie, digest, equal, setCookie, token } from './security.js';
import { recipientAPI } from './recipient.js';

const ADMIN = 'folderdrop_admin';
const SHIFT = 12 * 60 * 60 * 1000;
const publicAssets = /^\/assets\/(style\.css|shared\.js|admin\.js|recipient\.js)$/;

export class Admin {
  boot = new Map();
  sessions = new Map();
  constructor(app, secret, initial) {
    this.app = app;
    this.secret = secret;
    this.initial = initial ?? '';
  }

  clean() {
    for (const records of [this.boot, this.sessions]) for (const [key, expires] of records) {
      if (expires <= Date.now()) records.delete(key);
    }
  }

  launch(initial) {
    this.clean();
    check(this.boot.size < 128 && this.sessions.size < 128, 429, 'Too many active administrator sessions.');
    if (initial !== undefined) this.initial = initial;
    const key = token(24);
    this.boot.set(digest(key), Date.now() + 120000);
    return { url: `${this.address}/#${key}` };
  }

  async handle(req, res) {
    headers(res);
    try {
      const allowed = new Set([this.address]);
      check(`http://${req.headers.host}` === this.address, 421, 'Use the loopback administration address.');
      check(req.url.startsWith('/') && !req.url.startsWith('//') && !/[\\%]/.test(req.url.split('?')[0]), 404, 'Page not found.');
      check(!req.url.split('?')[0].split('/').some(part => part === '..' || part === '.'), 404, 'Page not found.');
      const url = new URL(req.url, this.address);
      const assets = publicAssets.exec(url.pathname);
      if (req.method === 'GET' && assets) return await asset(res, assets[1]);
      if (req.method === 'GET' && url.pathname === '/') return await asset(res, 'admin.html');
      if (req.method !== 'GET' && req.method !== 'HEAD') origin(req, allowed);
      if (req.method === 'POST' && url.pathname === '/bootstrap') {
        const input = await body(req, 4096);
        check(typeof input.key === 'string' && input.key.length <= 128, 400, 'Invalid launch key.');
        const hash = digest(input.key);
        const expires = this.boot.get(hash);
        check(expires > Date.now(), 401, 'This launch link expired. Run folderdrop again to open administration.');
        this.boot.delete(hash);
        const session = token(32);
        this.sessions.set(digest(session), Date.now() + SHIFT);
        setCookie(res, ADMIN, session, '/', SHIFT / 1000);
        return json(res, { signedIn: true });
      }
      const rpc = equal(req.headers.authorization, `Bearer ${this.secret}`);
      const authorized = () => check(rpc || this.sessions.get(digest(cookie(req, ADMIN))) > Date.now(),
        401, 'Open FolderDrop from the terminal to unlock administration.', 'admin_required');
      authorized();
      if (req.method === 'POST' && url.pathname === '/rpc') {
        check(rpc, 403, 'This endpoint is for local command clients.');
        const input = await body(req);
        if (input.action === 'launch') return json(res, this.launch(input.input?.initial));
        if (input.action === 'shutdown') {
          res.once('finish', () => void this.shutdown());
          return json(res, { stopped: true });
        }
        return json(res, await this.app.call(input.action, input.input));
      }
      if (req.method === 'GET' && url.pathname === '/api/config') return json(res, { initial: this.initial });
      if (req.method === 'POST' && url.pathname === '/api/action') {
        const input = await body(req);
        return json(res, await this.app.call(input.action, input.input));
      }
      const preview = /^\/preview\/([\w-]{32})(?:\/as\/([\w-]{22}))?(?:\/(.*))?$/.exec(url.pathname);
      if (preview) {
        const [, id, recipient, tail = ''] = preview;
        if (!tail && req.method === 'GET') return await asset(res, 'recipient.html');
        return await recipientAPI(req, res, url, tail, this.app.deliveries, this.app.uploads, permission => {
          authorized();
          const context = this.app.deliveries.preview(id, recipient);
          check(!permission || context.recipient[permission], 403, 'This permission is disabled in the selected profile.');
          return context;
        });
      }
      check(false, 404, 'Page not found.');
    } catch (error) { fail(res, error); }
  }
}
