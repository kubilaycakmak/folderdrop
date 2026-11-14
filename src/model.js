import { check } from './errors.js';
import { namePart, relativeParts, MAX_ITEMS } from './files.js';

export const THEMES = ['paper', 'midnight', 'grove'];
export const text = (value, max, label, fallback = '') => {
  const result = value ?? fallback;
  check(typeof result === 'string' && result.length <= max, 400, `${label} must be at most ${max} characters.`);
  return result.trim();
};

export function integer(value, min, max, label, fallback) {
  const result = value ?? fallback;
  check(Number.isSafeInteger(result) && result >= min && result <= max, 400, `${label} must be an integer from ${min} to ${max}.`);
  return result;
}

export function presentation(input, items) {
  const theme = input.theme ?? 'paper';
  check(THEMES.includes(theme), 400, 'Choose a supported theme.');
  const cover = input.cover || null;
  check(!cover || items.some(item => item.id === cover && /\.(?:jpe?g|png|webp|gif|avif|tiff?)$/i.test(item.path)),
    400, 'Choose an image from this delivery as the cover.');
  return { title: text(input.title, 120, 'Title', 'Untitled delivery') || 'Untitled delivery',
    intro: text(input.intro, 3000, 'Introduction'), theme, cover };
}

export function archivePaths(items) {
  const files = new Set();
  const folders = new Map();
  for (const item of items) {
    const parts = relativeParts(item.path);
    const key = value => value.normalize('NFKC').toLowerCase();
    const file = key(item.path);
    check(!files.has(file) && !folders.has(file), 400, `Duplicate delivery path: ${item.path}`);
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join('/');
      const canonical = key(parent);
      check(!files.has(canonical) && (!folders.has(canonical) || folders.get(canonical) === parent), 400, `Conflicting delivery path: ${item.path}`);
      folders.set(canonical, parent);
    }
    files.add(file);
  }
}

export function expiry(value) {
  if (value === null || value === '' || value === undefined) return null;
  const time = typeof value === 'number' ? value : Date.parse(value);
  check(Number.isSafeInteger(time) && time > 0 && time <= 8640000000000000, 400, 'Enter a valid expiration date.');
  return time;
}

export function profile(input, items, uploadEnabled) {
  const allowed = input.items ?? null;
  const available = new Set(items.map(item => item.id));
  check(allowed === null || (Array.isArray(allowed) && allowed.length <= MAX_ITEMS &&
    allowed.every(id => available.has(id))), 400, 'Choose items from the delivery.');
  check(!input.upload || uploadEnabled, 400, 'Configure a separate inbox before allowing uploads.');
  return {
    label: text(input.label, 80, 'Recipient name', 'Recipient') || 'Recipient',
    items: allowed && [...new Set(allowed)], preview: input.preview !== false, download: input.download !== false,
    upload: input.upload === true, browseInbox: input.browseInbox === true && input.upload === true,
    limit: input.limit == null || input.limit === '' ? null : integer(input.limit, 1, 100000, 'Download limit'),
    expires: expiry(input.expires)
  };
}

export function uploadRules(input, root) {
  const types = input.types ?? ['image/*', 'application/pdf', 'text/plain', 'application/zip'];
  check(Array.isArray(types) && types.length > 0 && types.length <= 32 && types.every(type =>
    /^(?:\*\/\*|[a-z0-9-]+\/(?:\*|[a-z0-9.+-]+))$/.test(type)), 400, 'Enter valid MIME types such as image/*.');
  return { root, types, maxFile: integer(input.maxFile, 1, 2 ** 40, 'Per-file bytes', 100 * 1024 ** 2),
    maxTotal: integer(input.maxTotal, 1, 2 ** 42, 'Inbox bytes', 1024 ** 3),
    maxFiles: integer(input.maxFiles, 1, 10000, 'Inbox file count', 100),
    concurrency: integer(input.concurrency, 1, 16, 'Concurrent uploads', 2) };
}

export function unpackRoots(inputs) {
  check(Array.isArray(inputs) && inputs.length <= 32, 400, 'Choose up to 32 source folders.');
  return inputs.map(input => ({ source: input.path, label: namePart(input.label) }));
}
