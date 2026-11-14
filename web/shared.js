const glyphs = {
  drop: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M12 10v6m-3-3 3 3 3-3',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  plus: 'M12 5v14M5 12h14', refresh: 'M20 11a8 8 0 1 0-2 6m2-12v6h-6',
  settings: 'M4 7h16M4 12h16M4 17h16M8 4v6m8-1v6m-5-1v6', arrow: 'M5 12h14m-6-6 6 6-6 6',
  back: 'M19 12H5m6 6-6-6 6-6', close: 'M6 6l12 12M18 6 6 18', lock: 'M6 11h12v9H6z M8 11V8a4 4 0 1 1 8 0v3m-4 4v2',
  download: 'M12 4v11m-4-4 4 4 4-4M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4',
  upload: 'M12 16V5m-4 4 4-4 4 4M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4',
  grid: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z',
  list: 'M8 5h12M8 12h12M8 19h12M4 5h.01M4 12h.01M4 19h.01',
  search: 'M20 20l-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  image: 'M4 4h16v16H4z M5 17l5-5 4 4 2-2 4 4M15 9h.01',
  file: 'M6 3h8l4 4v14H6z M14 3v5h4M9 13h6m-6 4h6',
  archive: 'M4 4h16v5H4z M6 9v11h12V9m-8 4h4',
  audio: 'M9 18V6l11-2v12M9 18a2.5 2 0 1 1-5 0 2.5 2.5 0 0 1 5 0m11-2a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0',
  video: 'M4 5h16v14H4z M10 9l5 3-5 3z',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  check: 'M5 12l4 4L19 6', globe: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z M2 12h20M12 2a18 18 0 0 0 0 20m0-20a18 18 0 0 1 0 20',
  chevron: 'M9 6l6 6-6 6', up: 'M6 14l6-6 6 6', down: 'M6 10l6 6 6-6'
};

export const $ = (selector, base = document) => base.querySelector(selector);
export const $$ = (selector, base = document) => [...base.querySelectorAll(selector)];
export const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const icon = (name, className = '') => `<svg class="icon ${className}" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${glyphs[name] ?? glyphs.file}"/></svg>`;
for (const element of $$('[data-icon]')) element.innerHTML = icon(element.dataset.icon);

export const fileIcon = kind => ['image', 'audio', 'video'].includes(kind) ? kind : 'file';
export function bytes(size) {
  if (!Number.isFinite(size)) return 'Unavailable';
  if (size === 0) return '0 B';
  const unit = Math.min(Math.floor(Math.log(size) / Math.log(1024)), 4);
  return `${new Intl.NumberFormat('en', { maximumFractionDigits: unit ? 1 : 0 }).format(size / 1024 ** unit)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`;
}
export const date = value => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value) : 'No expiration';
export const basename = file => file.split('/').at(-1);
export const button = (label, id, style = '', glyph = '') => `<button type="button" id="${id}" class="button ${style}">${glyph ? icon(glyph) : ''}${label}</button>`;

export const actionHeaders = { 'X-FolderDrop-Action': '1' };
export async function parse(response) {
  if (response.ok) return response;
  const data = await response.json().catch(() => ({ error: `Request failed (HTTP ${response.status}).` }));
  throw Object.assign(new Error(data.error), { status: response.status, code: data.code });
}
export async function api(url, input, options = {}) {
  const method = options.method ?? (input === undefined ? 'GET' : 'POST');
  const response = await parse(await fetch(url, { ...options, method,
    headers: { ...actionHeaders, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
    body: input === undefined ? options.body : JSON.stringify(input)
  }));
  return response.json();
}

let timer;
export function toast(message) {
  const element = $('#toast');
  element.hidden = false;
  element.textContent = message;
  clearTimeout(timer);
  timer = setTimeout(() => { element.hidden = true; }, 5500);
}

export async function busy(element, operation, errorElement = null) {
  if (element?.disabled) return;
  if (element) { element.disabled = true; element.setAttribute('aria-busy', 'true'); }
  if (errorElement) errorElement.hidden = true;
  try { return await operation(); }
  catch (error) {
    const message = error.message === 'Failed to fetch' ? 'The connection was interrupted. Check that the sender is still sharing.' : error.message;
    if (errorElement) { errorElement.textContent = message; errorElement.hidden = false; errorElement.focus(); }
    else toast(message);
  } finally {
    if (element) { element.disabled = false; element.removeAttribute('aria-busy'); }
  }
}

export function modal(title, markup) {
  const dialog = $('#dialog');
  if (dialog.open) dialog.close();
  const content = $('#dialog-content');
  content.innerHTML = `<div class="dialog-head"><h2 id="dialog-title">${escape(title)}</h2><button class="icon-button" aria-label="Close dialog" data-close>${icon('close')}</button></div>${markup}`;
  dialog.setAttribute('aria-labelledby', 'dialog-title');
  $('[data-close]', dialog).onclick = () => dialog.close();
  dialog.showModal();
  return dialog;
}

export async function confirmAction(title, explanation, label) {
  const dialog = modal(title, `<p>${escape(explanation)}</p><form method="dialog" class="row end">
    <button class="button" value="cancel" autofocus>Cancel</button><button class="button danger" value="yes">${escape(label)}</button></form>`);
  return new Promise(resolve => {
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'yes'), { once: true });
  });
}

export function fileVisual(kind, caption = '') {
  return `<span class="file-visual kind-${kind}">${icon(fileIcon(kind))}${caption ? `<span>${escape(caption)}</span>` : ''}</span>`;
}
