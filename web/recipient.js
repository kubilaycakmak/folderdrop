import { $, $$, api, actionHeaders, basename, busy, bytes, date, escape as e, fileVisual, icon, modal, parse, toast } from './shared.js';

const main = $('#main');
const base = location.pathname.replace(/\/$/, '');
const endpoint = suffix => `${base}/${suffix}`;
let data;
let folder = '';
let query = '';
let view = localStorage.getItem('folderdrop-view') === 'list' ? 'list' : 'gallery';
const selected = new Set();
let previewRequest;
let previewURL;
let assetGeneration = 0;
let accessTimer;
let checkingAccess = false;

function locked(error) {
  const closed = error && error.status !== 401;
  main.innerHTML = `<section class="unlock"><div class="unlock-emblem">${icon('lock')}</div>
    <h1>${closed ? 'Delivery unavailable' : 'Open your delivery'}</h1>
    <p>${closed ? e(error.message) : 'Enter the one-time access code from your sender. Keep this browser available to return to the delivery.'}</p>
    ${closed ? '' : `<form id="redeem"><label>Access code<input name="code" placeholder="ABCDE-12345-ABCDE-12345" required maxlength="32" autocomplete="one-time-code" spellcheck="false" autocapitalize="characters"></label>
    <p id="unlock-error" class="error" role="alert" tabindex="-1" hidden></p>
    <button class="button primary wide">Open delivery ${icon('arrow')}</button></form>`}</section>`;
  if (!closed) $('#redeem').onsubmit = event => {
    event.preventDefault();
    const form = event.currentTarget;
    void busy($('button', form), async () => {
      await api(endpoint('redeem'), { code: new FormData(form).get('code') });
      await load();
    }, $('#unlock-error'));
  };
}

async function load() {
  try {
    data = await api(endpoint('manifest'));
    document.body.dataset.theme = data.theme;
    document.title = `${data.title} · FolderDrop`;
    layout();
    clearInterval(accessTimer);
    if (!data.dryRun) accessTimer = setInterval(checkAccess, 3000);
  } catch (error) { locked(error); }
  finally { main.setAttribute('aria-busy', 'false'); $('h1')?.setAttribute('tabindex', '-1'); $('h1')?.focus(); }
}

async function checkAccess() {
  if (document.hidden || checkingAccess) return;
  checkingAccess = true;
  try { await parse(await fetch(endpoint('access-check'), { signal: AbortSignal.timeout(5000) })); }
  catch (error) {
    clearInterval(accessTimer);
    if (!data) return;
    data = undefined;
    selected.clear();
    $('#dialog').close();
    locked(error.status === 401 ? error : Object.assign(new Error(error.status ? error.message :
      'This delivery is offline. Check the link with the sender, then reload the page.'), { status: error.status ?? 503 }));
    $('h1').tabIndex = -1;
    $('h1').focus();
  } finally { checkingAccess = false; }
}

function layout() {
  main.innerHTML = `${data.dryRun ? '<div class="banner"><strong>Recipient preview</strong> <span>Uploads are disabled in preview.</span></div>' : ''}
    <section class="delivery-hero ${data.cover ? 'has-cover' : ''}">
    <div class="delivery-copy"><div class="delivery-metadata">${data.version ? '<span>Immutable snapshot</span>' : '<span>Live files</span>'}</div>
    <h1>${e(data.title)}</h1>${data.intro ? `<p class="intro">${e(data.intro)}</p>` : ''}
    <div class="delivery-count">${icon('folder')} ${data.files.length} ${data.files.length === 1 ? 'file' : 'files'}${data.expires ? ` <span>·</span> Available until ${e(date(data.expires))}` : ''}</div></div>
    ${data.cover ? `<div class="cover-art" data-cover="${data.cover}">${fileVisual('image')}</div>` : '<div class="cover-pattern" aria-hidden="true"><span></span><span></span><span></span></div>'}</section>
    <section class="delivery-files" aria-labelledby="files-heading"><div class="section-heading"><h2 id="files-heading">Files</h2>
    ${data.permissions.upload && !data.dryRun ? `<button type="button" class="button" id="upload-open">${icon('upload')} Send files</button>` : ''}</div>
    <div class="file-tools"><nav id="crumbs" class="crumbs" aria-label="Delivery folders"></nav>
    <div class="file-filters"><label class="search">${icon('search')}<input type="search" id="search" aria-label="Search files" placeholder="Search files"></label>
    <div class="segmented" aria-label="File layout"><button class="icon-button" id="gallery" title="Gallery view" aria-label="Gallery view">${icon('grid')}</button>
    <button class="icon-button" id="list" title="List view" aria-label="List view">${icon('list')}</button></div></div></div>
    <div id="selection" class="selection" hidden></div><div id="file-list"></div></section>
    <footer class="delivery-footer">Shared with FolderDrop${data.remaining === null ? '' : ` <span id="remaining">· ${data.remaining} downloads remaining</span>`}</footer>`;
  $('#search').oninput = event => { query = event.target.value.trim().toLowerCase(); renderFiles(); };
  for (const mode of ['gallery', 'list']) $(`#${mode}`).onclick = () => {
    view = mode;
    localStorage.setItem('folderdrop-view', mode);
    renderFiles();
  };
  if ($('#upload-open')) $('#upload-open').onclick = () => void uploads();
  if (data.cover) attachImages([$('[data-cover]')], true);
  renderFiles();
}

function renderFiles() {
  const visible = data.files.filter(file => query ? `${file.path} ${file.description}`.toLowerCase().includes(query) :
    file.path.startsWith(folder));
  const subfolders = new Map();
  const files = [];
  for (const file of visible) {
    const remaining = file.path.slice(folder.length);
    if (!query && remaining.includes('/')) {
      const name = remaining.split('/')[0];
      subfolders.set(name, (subfolders.get(name) ?? 0) + 1);
    } else files.push(file);
  }
  const parts = folder.split('/').filter(Boolean);
  const crumbs = $('#crumbs');
  crumbs.innerHTML = `<button class="crumb" data-folder="" ${!folder ? 'aria-current="location"' : ''}>All files</button>` +
    parts.map((part, index) => `${icon('chevron')}<button class="crumb" data-folder="${e(parts.slice(0, index + 1).join('/') + '/')}" ${index === parts.length - 1 ? 'aria-current="location"' : ''}>${e(part)}</button>`).join('');
  const area = $('#file-list');
  const focus = document.activeElement?.dataset;
  area.className = view === 'gallery' ? 'file-grid' : 'file-list';
  for (const mode of ['gallery', 'list']) $(`#${mode}`).setAttribute('aria-pressed', String(view === mode));
  const folders = subfolders.size ? `<div class="folder-grid">${[...subfolders].map(([name, count]) => `<button class="folder-card" data-folder="${e(folder + name + '/')}">
    <span class="folder-symbol">${icon('folder')}</span><span><strong>${e(name)}</strong><small>${count} ${count === 1 ? 'file' : 'files'}</small></span>${icon('chevron')}</button>`).join('')}</div>` : '';
  area.innerHTML = folders +
    files.map(file => {
      const title = basename(file.path);
      return `<article class="file-card"><button class="file-thumb" type="button" data-preview="${file.id}" ${!file.available ? 'disabled' : ''} aria-label="Open ${e(title)}"
        ${data.permissions.preview && file.kind === 'image' && file.available ? `data-thumb="${file.id}"` : ''}>${fileVisual(file.kind, title.split('.').at(-1).slice(0, 8).toUpperCase())}</button>
        <div class="file-info"><button class="file-title" data-preview="${file.id}" ${!file.available ? 'disabled' : ''}>${e(title)}</button>
        <small>${query ? e(file.path) + ' · ' : ''}${bytes(file.size)}</small>${file.description ? `<p>${e(file.description)}</p>` : ''}</div>
        ${data.permissions.download && file.available ? `<div class="file-actions"><label class="selection-check"><input type="checkbox" data-select="${file.id}" ${selected.has(file.id) ? 'checked' : ''} aria-label="Select ${e(title)}"></label>
        <button class="icon-button" data-download="${file.id}" aria-label="Download original ${e(title)}" title="Download original">${icon('download')}</button></div>` : ''}</article>`;
    }).join('') || `<div class="empty">${icon(query ? 'search' : 'folder')}<h3>${query ? 'No matching files' : 'No files here'}</h3><p>${query ? 'Try another name or clear the search.' : 'The sender has not included files in this view.'}</p></div>`;
  for (const item of $$('[data-folder]', main)) item.onclick = () => {
    folder = item.dataset.folder;
    query = '';
    $('#search').value = '';
    renderFiles();
    $('[aria-current="location"]', crumbs)?.focus();
  };
  for (const item of $$('[data-preview]', area)) item.onclick = () => void preview(data.files.find(file => file.id === item.dataset.preview));
  for (const item of $$('[data-download]', area)) item.onclick = () => void busy(item, () => download(data.files.find(file => file.id === item.dataset.download)));
  for (const item of $$('[data-select]', area)) item.onchange = () => {
    if (item.checked) selected.add(item.dataset.select);
    else selected.delete(item.dataset.select);
    selection();
  };
  if (focus?.select) $(`[data-select="${focus.select}"]`, area)?.focus();
  attachImages($$('[data-thumb]', area).slice(0, 80));
  selection();
}

function attachImages(nodes, cover = false) {
  if (!nodes.length) return;
  const generation = cover ? null : ++assetGeneration;
  const queue = [...nodes];
  const next = async () => {
    while (queue.length && (cover || generation === assetGeneration)) {
      const node = queue.shift();
      if (!node.isConnected) continue;
      const image = new Image();
      image.alt = '';
      image.decoding = 'async';
      await new Promise(resolve => {
        image.onload = () => { if (node.isConnected) node.replaceChildren(image); resolve(); };
        image.onerror = resolve;
        image.src = endpoint(`preview/${node.dataset.thumb ?? node.dataset.cover}${cover ? '' : '?thumb'}`);
      });
    }
  };
  for (let index = 0; index < (cover ? 1 : 2); index++) void next();
}

function selection() {
  const bar = $('#selection');
  bar.hidden = selected.size === 0;
  bar.innerHTML = `<strong>${selected.size} selected</strong><button class="button quiet" id="clear-selection">Clear</button>
    <button class="button primary" id="archive">${icon('archive')} Download ZIP</button>`;
  $('#clear-selection').onclick = () => { selected.clear(); renderFiles(); $('#search').focus(); };
  $('#archive').onclick = () => void busy($('#archive'), () => download(null));
}

async function download(file) {
  const target = file ? endpoint(`download/${file.id}`) : endpoint('archive');
  if (typeof window.showSaveFilePicker === 'function') {
    let handle;
    try { handle = await window.showSaveFilePicker({ suggestedName: file ? basename(file.path) : 'delivery.zip' }); }
    catch (error) { if (error.name === 'AbortError') return; }
    if (handle) return saveStream(handle, target, file);
  }
  let link = target;
  if (file) {
    await api(endpoint(`download-check/${file.id}`));
  } else {
    const { ticket } = await api(endpoint('archive-ticket'), { items: [...selected] });
    link = endpoint(`archive/${ticket}`);
  }
  const anchor = document.createElement('a');
  anchor.href = link;
  anchor.target = 'folderdrop-download';
  anchor.download = file ? basename(file.path) : 'delivery.zip';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => void updateAllowance(), 1000);
  toast('Download sent to your browser’s download manager.');
}

async function saveStream(handle, target, file) {
  const controller = new AbortController();
  const dialog = modal('Downloading original files', `<p id="download-note">Preparing download…</p><progress aria-label="Download progress"></progress>
    <p id="transfer-error" class="error" role="alert" hidden></p><button class="button" id="download-cancel">Cancel download</button>`);
  $('#download-cancel').onclick = () => controller.abort();
  dialog.addEventListener('close', () => controller.abort(), { once: true });
  let writable;
  try {
    const response = await parse(await fetch(target, { method: file ? 'GET' : 'POST', signal: controller.signal,
      headers: file ? {} : { ...actionHeaders, 'Content-Type': 'application/json' }, body: file ? undefined : JSON.stringify({ items: [...selected] }) }));
    writable = await handle.createWritable();
    const size = Number(response.headers.get('content-length'));
    const progress = $('progress', dialog);
    let copied = 0;
    const measure = new TransformStream({ transform(chunk, stream) {
      copied += chunk.length;
      if (size > 0) { progress.max = size; progress.value = copied; }
      $('#download-note', dialog).textContent = size ? `${bytes(copied)} of ${bytes(size)}` : `${bytes(copied)} received`;
      stream.enqueue(chunk);
    } });
    await response.body.pipeThrough(measure).pipeTo(writable, { signal: controller.signal });
    dialog.close();
    void updateAllowance();
    toast('Download saved.');
  } catch (error) {
    await writable?.abort().catch(() => {});
    if (dialog.open) {
      $('#transfer-error', dialog).hidden = false;
      $('#transfer-error', dialog).textContent = controller.signal.aborted ? 'Download cancelled.' : error.message;
      const cancel = $('#download-cancel', dialog);
      cancel.textContent = 'Close';
      cancel.onclick = () => dialog.close();
    }
  }
}

async function updateAllowance() {
  if (!data || data.remaining === null) return;
  try {
    const latest = await api(endpoint('manifest'));
    data.remaining = latest.remaining;
    $('#remaining').textContent = `· ${latest.remaining} downloads remaining`;
  } catch {}
}

async function preview(file) {
  const dialog = modal(basename(file.path), `<div class="preview-surface" id="preview-media" aria-live="polite">Loading preview…</div>
    <p class="preview-description">${e(file.description)}</p><div class="row end">
    ${data.permissions.download ? `<button class="button primary" id="preview-download">${icon('download')} Download original</button>` : ''}</div>`);
  const area = $('#preview-media', dialog);
  const controller = new AbortController();
  previewRequest?.abort();
  previewRequest = controller;
  function cleanup() { controller.abort(); if (previewURL) URL.revokeObjectURL(previewURL); previewURL = null; }
  dialog.addEventListener('close', cleanup, { once: true });
  if ($('#preview-download')) $('#preview-download').onclick = () => void busy($('#preview-download'), () => download(file));
  const fallback = message => {
    if (!controller.signal.aborted) area.innerHTML = `<div class="empty">${icon('file')}<h3>Preview unavailable</h3><p>${e(message)}</p></div>`;
  };
  if (!data.permissions.preview) return fallback('The sender disabled previews for your link.');
  if (file.kind === 'unknown') return fallback('This file format has no built-in preview.');
  if (['audio', 'video'].includes(file.kind)) {
    const player = document.createElement(file.kind);
    try {
      const result = await api(endpoint(`media-info/${file.id}`), undefined, { signal: controller.signal });
      if (!player.canPlayType(result.mime)) return fallback('This browser does not support the media format or codec.');
    } catch (error) { return fallback(error.message); }
    if (controller.signal.aborted) return;
    player.controls = true;
    player.preload = 'metadata';
    const loading = document.createElement('p');
    loading.className = 'muted';
    loading.setAttribute('role', 'status');
    loading.textContent = 'Loading media preview…';
    const release = () => {
      clearTimeout(timeout);
      player.removeEventListener('error', playbackError);
      player.removeAttribute('src');
      player.load();
    };
    const unavailable = message => { release(); fallback(message); };
    const playbackError = () => unavailable('The browser could not play this codec or the source became unavailable.');
    const timeout = setTimeout(() => unavailable('The media preview did not load. Try again or download the original if available.'), 8000);
    player.addEventListener('error', playbackError, { once: true });
    player.addEventListener('loadedmetadata', () => { clearTimeout(timeout); loading.remove(); }, { once: true });
    controller.signal.addEventListener('abort', release, { once: true });
    area.replaceChildren(loading, player);
    player.src = endpoint(`media/${file.id}`);
    return;
  }
  let page = 1;
  async function render() {
    try {
      const response = await parse(await fetch(endpoint(`preview/${file.id}?page=${page}`), { signal: controller.signal }));
      if (file.kind === 'text') {
        const result = await response.json();
        area.innerHTML = `<pre tabindex="0">${e(result.text)}</pre>${result.truncated ? '<p class="muted">Showing the first 128 KiB.</p>' : ''}`;
      } else {
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        if (previewURL) URL.revokeObjectURL(previewURL);
        previewURL = URL.createObjectURL(blob);
        const pages = Number(response.headers.get('x-folderdrop-pages'));
        area.innerHTML = `<img src="${previewURL}" alt="${e(file.kind === 'pdf' ? `Page ${page} of ${pages}` : basename(file.path))}">
          ${pages > 1 ? `<div class="row center page-tools"><button class="button" id="prev-page" ${page <= 1 ? 'disabled' : ''}>Previous</button>
          <span>Page ${page} of ${pages}</span><button class="button" id="next-page" ${page >= pages ? 'disabled' : ''}>Next</button></div>` : ''}`;
        if (pages > 1) {
          $('#prev-page').onclick = event => void busy(event.currentTarget, () => { page--; return render(); });
          $('#next-page').onclick = event => void busy(event.currentTarget, () => { page++; return render(); });
        }
      }
    } catch (error) { fallback(error.message); }
  }
  await render();
}

async function uploads() {
  const dialog = modal('Send files to the sender', `<p>Files go into the sender’s inbox. Duplicate names are renamed.</p>
    <form id="upload-form"><label>Choose a file<input required type="file" id="upload-file"></label>
    <div class="row"><button class="button primary">${icon('upload')} Upload</button>
    <button type="button" class="button" id="refresh-uploads">Refresh</button></div></form>
    <p class="error" id="upload-error" role="alert" tabindex="-1" hidden></p><div id="upload-progress" hidden><progress aria-label="Upload progress"></progress> <span></span>
    <button class="button" id="pause-upload">Pause</button></div><div id="upload-list" aria-live="polite"></div>`);
  let active;
  let running = false;
  const form = $('#upload-form', dialog);
  const fileField = $('#upload-file', dialog);
  const errorField = $('#upload-error', dialog);
  dialog.addEventListener('close', () => active?.abort(), { once: true });
  $('#pause-upload', dialog).onclick = () => { active?.abort(); toast('Upload paused. Select the same file to resume.'); };
  async function refresh() {
    const entries = await api(endpoint('uploads'));
    if (!dialog.open) return;
    const area = $('#upload-list', dialog);
    area.innerHTML = entries.length ? `<h3>${data.permissions.browseInbox ? 'Inbox activity' : 'Your uploads'}</h3>` + entries.map(upload =>
      `<div class="upload-row"><div><strong>${e(upload.name)}</strong><small>${upload.complete ? 'Saved in inbox' : `${bytes(upload.offset)} of ${bytes(upload.size)} saved`}</small></div>
      ${upload.complete ? icon('check') : `<button class="button" data-discard="${upload.id}">Cancel upload</button>`}</div>`).join('') : '<p class="muted">No files sent yet.</p>';
    for (const control of $$('[data-discard]', area)) control.onclick = () => void busy(control, async () => {
      await api(endpoint(`uploads/${control.dataset.discard}`), undefined, { method: 'DELETE' });
      await refresh();
    }, errorField);
    return entries;
  }
  $('#refresh-uploads', dialog).onclick = event => void busy(event.currentTarget, refresh, errorField);
  form.onsubmit = event => {
    event.preventDefault();
    if (running) return;
    void busy($('button', form), async () => {
      const file = fileField.files[0];
      if (!file) return;
      active = new AbortController();
      const { signal } = active;
      running = true;
      const progress = $('#upload-progress', dialog);
      progress.hidden = false;
      const meter = $('progress', progress);
      meter.max = file.size || 1;
      try {
        const records = await refresh();
        let upload = records?.find(entry => !entry.complete && entry.name === file.name && entry.size === file.size);
        const fingerprint = `folderdrop-upload:${base}:${file.name}:${file.size}:${file.lastModified}`;
        const saved = sessionStorage.getItem(fingerprint);
        if (upload && saved !== upload.id && !window.confirm('Resume the pending upload with this file? Use the same content to avoid mixing bytes.')) upload = null;
        upload ??= await api(endpoint('uploads'), { name: file.name, size: file.size }, { signal });
        sessionStorage.setItem(fingerprint, upload.id);
        while (upload.offset < file.size) {
          meter.value = upload.offset;
          $('span', progress).textContent = `${bytes(upload.offset)} of ${bytes(file.size)} saved`;
          upload = await api(endpoint(`uploads/${upload.id}`), undefined, { method: 'PATCH', signal, body: file.slice(upload.offset, upload.offset + 4 * 1024 ** 2),
            headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(upload.offset) } });
        }
        const done = await api(endpoint(`uploads/${upload.id}/complete`), {}, { signal });
        sessionStorage.removeItem(fingerprint);
        fileField.value = '';
        if (dialog.open) toast(`Saved in inbox as ${done.name}.`);
      } catch (error) { if (!signal.aborted) throw error; }
      finally {
        running = false;
        progress.hidden = true;
        if (dialog.open) await refresh();
      }
    }, errorField);
  };
  await busy(null, refresh, errorField);
}

void load();
