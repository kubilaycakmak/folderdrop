import { asset, body, fail, headers, json, origin } from './http.js';
import { cookie, setCookie, token } from './security.js';
import { check } from './errors.js';
import { SESSION_AGE } from './deliveries.js';
import { format } from './previews.js';
import { sendArchive, sendItem } from './transfers.js';

const SESSION = 'folderdrop_recipient';
const routes = /^\/s\/([\w-]{32})\/([\w-]{22})(?:\/(.*))?$/;
const archiveTickets = new Map();

export async function manifest(deliveries, getContext) {
  const release = deliveries.reading.enter();
  try {
    const context = getContext();
    const { content, items, recipient, share } = context;
    const files = [];
    for (const item of items) {
      const file = await deliveries.open(context, item).catch(() => null);
      const available = !!file;
      const size = file?.size ?? null;
      await file?.handle.close();
      files.push({ id: item.id, path: item.path, description: item.description, size, available, ...format(item.path) });
    }
    const current = getContext();
    check(current.recipient.epoch === recipient.epoch && current.share.revision === share.revision, 409,
      'The delivery changed. Reload to see its current contents.');
    const title = content.presentation.title;
    const expires = [share.expires, recipient.expires].filter(value => value != null);
    return { ...content.presentation, title, cover: recipient.preview && items.some(item => item.id === content.presentation.cover) ? content.presentation.cover : null,
      version: recipient.version || null, dryRun: !!context.dryRun, expires: expires.length ? Math.min(...expires) : null,
      permissions: { preview: recipient.preview, download: recipient.download, upload: recipient.upload, browseInbox: recipient.browseInbox },
      remaining: recipient.limit == null ? null : Math.max(0, recipient.limit - recipient.count), files };
  } finally { release(); }
}

export async function recipientAPI(req, res, url, tail, deliveries, uploads, getContext) {
  if (req.method === 'GET' && tail === 'manifest') return json(res, await manifest(deliveries, getContext));
  const item = /^(download|preview|media|media-info)\/([\w-]{22})$/.exec(tail);
  if (item && (req.method === 'GET' || req.method === 'HEAD' && item[1] !== 'preview')) {
    const permission = item[1] === 'download' ? 'download' : 'preview';
    return sendItem(req, res, deliveries, () => getContext(permission), item[2], item[1], url.searchParams);
  }
  if (req.method === 'POST' && tail === 'archive') {
    const input = await body(req, 65536);
    return sendArchive(req, res, deliveries, () => getContext('download'), input.items);
  }
  if (req.method === 'POST' && tail === 'archive-ticket') {
    const context = getContext('download');
    check(deliveries.canDownload(context), 403, 'The download limit has been reached.', 'download_limit');
    const { items } = await body(req, 65536);
    check(Array.isArray(items) && items.length > 0 && items.length <= 1000 && new Set(items).size === items.length, 400, 'Select up to 1,000 distinct files.');
    for (const id of items) deliveries.item(context, id);
    for (const [key, value] of archiveTickets) if (value.until <= Date.now()) archiveTickets.delete(key);
    check(archiveTickets.size < 256, 429, 'Too many archive requests. Try again shortly.');
    const ticket = token(18);
    archiveTickets.set(ticket, { items, share: context.share.id, recipient: context.recipient.id, epoch: context.recipient.epoch,
      dryRun: context.dryRun, until: Date.now() + 60000 });
    return json(res, { ticket });
  }
  const downloadCheck = /^download-check\/([\w-]{22})$/.exec(tail);
  if (req.method === 'GET' && downloadCheck) {
    const context = getContext('download');
    const item = deliveries.item(context, downloadCheck[1]);
    const file = await deliveries.open(context, item);
    try {
      getContext('download');
      return json(res, { authorized: deliveries.mayGrant(context, item, file.stat) });
    } finally { await file.handle.close(); }
  }
  const archive = /^archive\/([\w-]{24})$/.exec(tail);
  if (req.method === 'GET' && archive) {
    const value = archiveTickets.get(archive[1]);
    const context = getContext('download');
    check(value && value.until > Date.now() && value.share === context.share.id && value.recipient === context.recipient.id &&
      value.epoch === context.recipient.epoch && value.dryRun === context.dryRun, 410, 'This archive request has expired.');
    archiveTickets.delete(archive[1]);
    return sendArchive(req, res, deliveries, () => getContext('download'), value.items);
  }
  const upload = /^uploads(?:\/([\w-]{24})(\/complete)?)?$/.exec(tail);
  if (upload) {
    const context = () => getContext('upload');
    check(!context().dryRun, 403, 'Uploads become available after sharing.');
    const [, id, complete] = upload;
    if (req.method === 'GET') return json(res, id ? uploads.status(id, context) : uploads.list(context()));
    if (req.method === 'POST' && !id) return json(res, await uploads.create(await body(req, 4096), context), 201);
    if (req.method === 'PATCH' && id && !complete) return json(res, await uploads.patch(id, context, req));
    if (req.method === 'POST' && id && complete) return json(res, await uploads.finish(id, context));
    if (req.method === 'DELETE' && id && !complete) return json(res, await uploads.cancel(id, context));
  }
  check(false, 404, 'Page not found.');
}

export function recipientHandler(deliveries, uploads) {
  return async (req, res, config) => {
    headers(res);
    try {
      check(config.origins.has(`${config.secure ? 'https' : 'http'}://${req.headers.host}`) ||
        config.origins.has(`http://${req.headers.host}`), 421, 'Use the address provided by the sender.');
      const url = new URL(req.url, 'http://recipient.invalid');
      check(req.url.startsWith('/') && !req.url.startsWith('//') && !/[\\%]/.test(req.url.split('?')[0]), 404, 'Page not found.');
      check(!req.url.split('?')[0].split('/').some(part => part === '..' || part === '.'), 404, 'Page not found.');
      if (req.method === 'GET' && url.pathname === `/_folderdrop/ready/${config.nonce}`) {
        return res.writeHead(204, { 'X-FolderDrop-Probe': config.nonce }).end();
      }
      const shared = /^\/assets\/(style\.css|shared\.js|recipient\.js)$/.exec(url.pathname);
      if (req.method === 'GET' && shared) return await asset(res, shared[1]);
      const route = routes.exec(url.pathname);
      check(route && route[1] === config.share, 404, 'This private link is unavailable.');
      const [, id, recipientId, tail = ''] = route;
      const getContext = permission => deliveries.context(id, recipientId, cookie(req, SESSION), permission);
      if (req.method === 'GET' && !tail) return await asset(res, 'recipient.html');
      if (req.method === 'GET' && tail === 'access-check') { getContext(); return res.writeHead(204).end(); }
      if (req.method !== 'GET' && req.method !== 'HEAD') origin(req, config.origins);
      if (req.method === 'POST' && tail === 'redeem') {
        const input = await body(req, 4096);
        const secret = await deliveries.redeem(id, recipientId, input.code);
        setCookie(res, SESSION, secret, `/s/${id}/${recipientId}`, SESSION_AGE / 1000, config.secure);
        return json(res, { opened: true });
      }
      return await recipientAPI(req, res, url, tail, deliveries, uploads, getContext);
    } catch (error) { fail(res, error); }
  };
}
