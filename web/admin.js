import { $, $$, api, basename, busy, bytes, confirmAction, date, escape as e, icon, modal, toast } from './shared.js';

const main = $('#main');
const steps = ['Choose files', 'Presentation', 'Access & lifetime', 'Preview & share'];
const call = (action, input = {}) => api('/api/action', { action, input });
let records = [];
let delivery;
let draft;
let step = 0;
let initial = '';
let timer;

function emptyDraft() {
  return { roots: [], items: [], presentation: { title: '', intro: '', theme: 'paper', cover: null }, expires: null, inbox: null };
}
const state = record => record.revoked ? 'Revoked' : record.expires && record.expires <= Date.now() ? 'Expired' :
  ({ listening: 'Sharing', provider_connected: 'Tunnel connected', proxy_listener: 'Proxy listener', connecting: 'Connecting',
    reconnecting: 'Reconnecting', error: 'Connection error' }[record.connection?.connection] ?? (record.network ? 'Stopped' : 'Draft'));
const banner = () => '<p id="form-error" class="error" role="alert" tabindex="-1" hidden></p>';
const progress = () => `<nav aria-label="Delivery setup" class="steps">${steps.map((name, index) =>
  `<button type="button" data-step="${index}" ${index === step ? 'aria-current="step"' : ''} ${index > step && !delivery ? 'disabled' : ''}><span>${index + 1}</span>${name}</button>`).join('')}</nav>`;
const asDateInput = value => value ? new Date(value - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
const toExpiration = value => value ? new Date(value).toISOString() : null;
const selected = (a, b) => a === b ? 'selected' : '';
const checked = value => value ? 'checked' : '';

async function refresh() {
  records = await call('list');
  $('#deliveries').innerHTML = records.length ? records.map(record => `<button type="button" class="nav-delivery" data-open="${record.id}"
    ${delivery?.id === record.id ? 'aria-current="page"' : ''}><span class="nav-folder">${icon('folder')}</span>
    <span><strong>${e(record.title)}</strong><small>${state(record)} · ${record.count} files</small></span></button>`).join('') :
    '<p class="sidebar-empty">Your saved deliveries will appear here.</p>';
  for (const node of $$('[data-open]')) node.onclick = () => void busy(node, () => open(node.dataset.open, 3));
}

async function open(id, stage = 3) {
  delivery = await call('inspect', { id });
  draft = structuredClone(delivery);
  draft.inbox = delivery.inbox ? { ...delivery.inbox, path: delivery.inbox.root.path } : null;
  step = stage;
  render(true);
  await refresh();
}

function startNew() {
  delivery = undefined;
  step = 0;
  draft = emptyDraft();
  render(true);
  void busy(null, refresh);
}

function render(focus = false) {
  main.setAttribute('aria-busy', 'false');
  const closed = delivery && (delivery.revoked || delivery.expires && delivery.expires <= Date.now());
  if (closed) step = 3;
  main.innerHTML = `<div class="main-inner"><header class="page-heading"><div class="workspace-path">${icon('folder')} Deliveries ${icon('chevron')} ${delivery ? e(delivery.presentation.title) : 'New delivery'}</div>
    <h1 tabindex="-1">${delivery ? e(delivery.presentation.title) : 'Create a delivery'}</h1></header>
    ${closed ? '' : progress()}<section class="panel" id="step-panel">${[choose, curate, access, share][step]()}</section></div>`;
  for (const node of $$('[data-step]')) node.onclick = () => void changeStep(+node.dataset.step, node);
  $('#back')?.addEventListener('click', event => void changeStep(step - 1, event.currentTarget));
  $('#next')?.addEventListener('click', event => void changeStep(step + 1, event.currentTarget, true));
  [bindChoose, bindCurate, bindAccess, bindShare][step]();
  if (focus) $('h1').focus();
}

function choose() {
  return `<div class="panel-head"><span class="panel-icon">${icon('folder')}</span><div><h2>Choose files</h2><p>Build a delivery from one or more local folders.</p></div></div>
    <div class="panel-body">
    <form id="scan-form" class="scan-box"><label>Source folder<input name="path" value="${e(initial)}" placeholder="Enter an absolute folder path" required spellcheck="false"></label>
    <div class="row wrap"><button type="button" class="button" id="choose-folder">${icon('folder')} Choose folder</button>
    <button class="button primary" type="submit">${icon('plus')} Browse files</button></div></form>
    ${banner()}<div id="scan-results"></div><section class="source-summary" aria-labelledby="selected-files-heading"><h3 id="selected-files-heading">Selected files</h3>
    <div id="chosen"></div></section></div>
    <footer class="panel-foot"><span id="chosen-count" class="muted"></span><button id="next" class="button primary">Continue to presentation ${icon('arrow')}</button></footer>`;
}

function chosen() {
  $('#chosen-count').textContent = `${draft.items.length} selected`;
  $('#chosen').innerHTML = draft.items.length ? `<div class="chosen-list">${draft.items.map((item, index) =>
    `<div class="chosen-row">${icon('file')}<span>${e(item.path || item.relative)}</span><button type="button" class="icon-button" data-remove="${index}" aria-label="Remove ${e(item.path || item.relative)}">${icon('close')}</button></div>`).join('')}</div>` :
    `<div class="empty compact">${icon('folder')}<strong>No files selected</strong><p>Browse a folder to pick what recipients will see.</p></div>`;
  for (const node of $$('[data-remove]')) node.onclick = () => {
    const [item] = draft.items.splice(+node.dataset.remove, 1);
    if (item.id && draft.presentation.cover === item.id) draft.presentation.cover = null;
    chosen();
    $('#selected-files-heading').tabIndex = -1;
    $('#selected-files-heading').focus();
  };
}

function bindChoose() {
  chosen();
  const form = $('#scan-form');
  $('#choose-folder', form).onclick = () => folderPicker(async selected => {
    $('[name="path"]', form).value = selected;
    form.requestSubmit();
  }, $('[name="path"]', form).value);
  form.onsubmit = event => {
    event.preventDefault();
    const submit = $('[type="submit"]', form);
    if (submit.disabled) return;
    const value = new FormData(form).get('path');
    initial = value;
    const results = $('#scan-results');
    results.innerHTML = '<p class="muted" role="status">Scanning files…</p>';
    void busy(submit, async () => {
      const scanned = await call('scan', { path: value });
      results.innerHTML = scanned.files.length ? `<div class="scan-results">
        <div class="row between"><h3>Files in this folder</h3><button class="button quiet" id="select-all">Select all</button></div>
        <div class="scan-files">${scanned.files.map((file, index) => `<label class="scan-row"><input type="checkbox" data-found="${index}"><span>${e(file.relative)}</span><small>${bytes(file.size)}</small></label>`).join('')}</div>
        ${scanned.skipped ? `<p class="muted">${scanned.skipped} hidden, linked, or unavailable entries skipped.</p>` : ''}
        <button class="button" id="add-files">${icon('plus')} Add selected files</button></div>` : '<div class="empty compact"><strong>No eligible files found</strong><p>Choose a folder containing regular files.</p></div>';
      if (!scanned.files.length) return;
      $('#select-all').onclick = () => {
        const boxes = $$('[data-found]', results);
        const all = boxes.every(box => box.checked);
        for (const box of boxes) box.checked = !all;
        $('#select-all').textContent = all ? 'Select all' : 'Clear all';
      };
      $('#add-files').onclick = () => {
        const files = $$('[data-found]:checked', results);
        if (!files.length) return toast('Select at least one file from the folder.');
        let root = draft.roots.findIndex(item => item.path === scanned.root);
        if (root < 0) {
          root = draft.roots.length;
          const label = scanned.root.split(/[\\/]/).filter(Boolean).at(-1)?.replace(/[^a-z0-9_-]/gi, '-') || 'Files';
          draft.roots.push({ path: scanned.root, label: `Files-${root + 1}` });
          if (!draft.presentation.title) draft.presentation.title = label.replace(/-/g, ' ');
        }
        for (const control of files) {
          const file = scanned.files[+control.dataset.found];
          if (draft.items.some(item => item.root === root && item.relative === file.relative)) continue;
          const preferred = root ? `Files-${root + 1}/${file.relative}` : file.relative;
          draft.items.push({ root, relative: file.relative, path: preferred, description: '' });
        }
        chosen();
        toast(`${draft.items.length} files selected.`);
        $('#next').focus();
      };
      results.scrollIntoView({ block: 'nearest' });
    }, $('#form-error')).finally(() => { if ($('#form-error') && !$('#form-error').hidden) results.replaceChildren(); });
  };
}

function folderPicker(choose, start = '') {
  const dialog = modal('Choose a local folder', `<form id="browse-path" class="scan-box">
    <label>Folder path<input name="folder" value="${e(start)}" spellcheck="false"></label><button class="button">Go</button></form>
    <p class="error" id="browse-error" role="alert" tabindex="-1" hidden></p><div class="folder-results form-stack" id="folder-results"></div>`);
  const form = $('#browse-path', dialog);
  const input = $('[name="folder"]', form);
  const results = $('#folder-results', dialog);
  const error = $('#browse-error', dialog);
  let sequence = 0;
  async function navigate(path, focus = true) {
    const index = ++sequence;
    results.setAttribute('aria-busy', 'true');
    results.innerHTML = '<p class="muted">Looking for folders…</p>';
    try {
      const found = await call('browse', { path });
      if (index !== sequence || !dialog.open) return;
      input.value = found.path;
      results.innerHTML = `${found.parent ? `<button class="button quiet" id="folder-up">${icon('up')} Parent folder</button>` : ''}
        ${found.folders.length ? `<div id="local-folders" class="local-folders">${found.folders.map((folder, i) => `<button class="folder-card" data-folder-index="${i}">
          <span class="folder-symbol">${icon('folder')}</span><span>${e(folder.name)}</span>${icon('chevron')}</button>`).join('')}</div>` :
          '<p class="muted">There are no subfolders here.</p>'}
        ${found.truncated ? '<p class="muted">Enter an exact path to open folders beyond this list.</p>' : ''}
        <button class="button primary" id="use-folder">Use this folder</button>`;
      $('#folder-up', results)?.addEventListener('click', () => void busy(null, () => navigate(found.parent), error));
      for (const node of $$('[data-folder-index]', results)) node.onclick = () => void busy(null, () => navigate(found.folders[+node.dataset.folderIndex].path), error);
      $('#use-folder', results).onclick = () => { dialog.close(); void choose(found.path); };
      if (focus) ($('#folder-up', results) || $('#use-folder', results)).focus();
    } catch (failure) {
      if (index === sequence) results.replaceChildren();
      throw failure;
    } finally { if (index === sequence) results.setAttribute('aria-busy', 'false'); }
  }
  form.onsubmit = event => { event.preventDefault(); void busy($('button', form), () => navigate(input.value.trim()), error); };
  void busy(null, () => navigate(start, false), error);
}

function curate() {
  const meta = draft.presentation;
  return `<div class="panel-head"><span class="panel-icon">${icon('image')}</span><div><h2>Presentation</h2><p>Give recipients context and make the files easy to find.</p></div></div>
    <div class="panel-body form-stack"><label>Delivery title<input id="title" value="${e(meta.title)}" maxlength="120" required placeholder="e.g. Studio portfolio"></label>
    <label>Introduction<textarea id="intro" maxlength="3000" rows="3" placeholder="A short note about the delivery">${e(meta.intro)}</textarea></label>
    <fieldset class="theme-field"><legend>Theme</legend><div class="themes">${[['paper', 'Paper'], ['midnight', 'Midnight'], ['grove', 'Grove']].map(([key, name]) =>
      `<label class="theme-option" data-theme-chip="${key}"><input type="radio" name="theme" value="${key}" ${checked(meta.theme === key)}><span></span>${name}</label>`).join('')}</div></fieldset>
    <label>Cover image<select id="cover"><option value="">No cover image</option>${draft.items.filter(item => /\.(jpe?g|png|webp|gif|avif|tiff?)$/i.test(item.path)).map(item =>
      `<option value="${item.id}" ${selected(meta.cover, item.id)}>${e(item.path)}</option>`).join('')}</select></label>
    <div><h3>File order & details</h3><div id="curated"></div></div>${banner()}</div>
    <footer class="panel-foot"><button id="back" class="button quiet">${icon('back')} Back</button><button id="next" class="button primary">Continue to access ${icon('arrow')}</button></footer>`;
}

function bindCurate() {
  for (const field of ['title', 'intro', 'cover']) $(`#${field}`).oninput = event => { draft.presentation[field] = event.target.value || (field === 'cover' ? null : ''); };
  for (const field of $$('[name="theme"]')) field.onchange = () => { draft.presentation.theme = field.value; };
  const curated = $('#curated');
  const renderItems = () => {
    curated.innerHTML = draft.items.map((item, index) => `<details class="curated-row"><summary>${icon('file')} <span>${e(item.path)}</span></summary>
      <div class="curated-fields"><label>Delivery path<input data-path="${index}" value="${e(item.path)}" maxlength="1024"></label>
      <label>Description<textarea data-description="${index}" rows="2" maxlength="1500">${e(item.description)}</textarea></label>
      <div class="row"><button class="button" data-move="-1" data-index="${index}" ${index === 0 ? 'disabled' : ''}>${icon('up')} Move up</button>
      <button class="button" data-move="1" data-index="${index}" ${index === draft.items.length - 1 ? 'disabled' : ''}>${icon('down')} Move down</button></div></div></details>`).join('');
    for (const field of $$('[data-path]', curated)) field.oninput = () => {
      draft.items[+field.dataset.path].path = field.value;
      $('summary span', field.closest('details')).textContent = field.value;
    };
    for (const field of $$('[data-description]', curated)) field.oninput = () => { draft.items[+field.dataset.description].description = field.value; };
    for (const field of $$('[data-move]', curated)) field.onclick = () => {
      const from = +field.dataset.index;
      const to = from + +field.dataset.move;
      draft.items.splice(to, 0, draft.items.splice(from, 1)[0]);
      renderItems();
      const row = curated.children[to];
      row.open = true;
      $('summary', row).focus();
    };
  };
  renderItems();
}

function access() {
  const inbox = draft.inbox;
  return `<div class="panel-head"><span class="panel-icon">${icon('lock')}</span><div><h2>Access & lifetime</h2><p>Every recipient needs their own link and one-time access code.</p></div></div>
    <div class="panel-body form-stack"><label>Delivery expiration <span class="muted">(optional)</span><input type="datetime-local" id="expires" value="${asDateInput(draft.expires)}"></label>
    <div class="callout">${icon('lock')} <div><strong>Recipient permissions</strong><p>Set file access, preview, download limits, and uploads when issuing a link.</p></div></div>
    <label class="check-line"><input id="inbox-toggle" type="checkbox" ${checked(inbox)}> Receive files in a separate inbox</label>
    <div id="inbox-fields" class="form-grid" ${inbox ? '' : 'hidden'}>
    <div class="full scan-box"><label>Inbox folder<input id="inbox-path" value="${e(inbox?.path)}" placeholder="Absolute path to an existing folder"></label>
    <button class="button" id="choose-inbox" type="button">${icon('folder')} Choose inbox</button></div>
    <label class="full">Accepted MIME types<input id="inbox-types" value="${e((inbox?.types ?? ['image/*', 'application/pdf', 'text/plain', 'application/zip']).join(', '))}"></label>
    <label>Max bytes per file<input type="number" min="1" id="max-file" value="${inbox?.maxFile ?? 104857600}"></label>
    <label>Max inbox bytes<input type="number" min="1" id="max-total" value="${inbox?.maxTotal ?? 1073741824}"></label>
    <label>Max file count<input type="number" min="1" max="10000" id="max-files" value="${inbox?.maxFiles ?? 100}"></label>
    <label>Concurrent uploads<input type="number" min="1" max="16" id="max-concurrent" value="${inbox?.concurrency ?? 2}"></label></div>${banner()}</div>
    <footer class="panel-foot"><button id="back" class="button quiet">${icon('back')} Back</button><button id="next" class="button primary">Save & review ${icon('arrow')}</button></footer>`;
}

function bindAccess() {
  $('#inbox-toggle').onchange = event => { $('#inbox-fields').hidden = !event.target.checked; captureAccess(); };
  for (const field of $$('#expires, #inbox-fields input')) field.oninput = captureAccess;
  $('#choose-inbox').onclick = () => folderPicker(selected => { $('#inbox-path').value = selected; captureAccess(); }, $('#inbox-path').value);
}
function captureAccess() {
  draft.expires = toExpiration($('#expires').value);
  draft.inbox = $('#inbox-toggle').checked ? {
    path: $('#inbox-path').value.trim(), types: $('#inbox-types').value.split(',').map(value => value.trim()).filter(Boolean),
    maxFile: $('#max-file').valueAsNumber, maxTotal: $('#max-total').valueAsNumber,
    maxFiles: $('#max-files').valueAsNumber, concurrency: $('#max-concurrent').valueAsNumber } : null;
}

async function save() {
  const payload = { id: delivery?.id, revision: delivery?.revision, roots: draft.roots, items: draft.items,
    presentation: draft.presentation, expires: draft.expires, inbox: draft.inbox };
  const result = await call(delivery ? 'edit' : 'create', payload);
  delivery = await call('inspect', { id: result.id });
  draft = structuredClone(delivery);
  draft.inbox = delivery.inbox ? { ...delivery.inbox, path: delivery.inbox.root.path } : null;
  await refresh();
}

async function changeStep(target, node, forward = false) {
  if (target === step) return;
  await busy(node, async () => {
    if (step === 0 && target > 0) {
      if (!draft.items.length) throw new Error('Select at least one file to continue.');
      await save();
    }
    if (step === 1 && target > 1) {
      if (!draft.presentation.title.trim()) throw new Error('Enter a delivery title.');
      await save();
    }
    if (step === 2) captureAccess();
    if (target === 3 && delivery && (step !== 3 || forward)) await save();
    step = target;
    render(true);
  }, $('#form-error'));
}

function share() {
  const locked = delivery.revoked || (delivery.expires && delivery.expires <= Date.now());
  return `<div class="panel-head"><span class="panel-icon">${icon('eye')}</span><div><h2>Preview & share</h2><p>Check the recipient view, select a network, and issue private links.</p></div>
    <a class="button preview-button" target="_blank" rel="noopener" href="/preview/${delivery.id}">${icon('eye')} Preview delivery</a></div>
    <div class="panel-body form-stack"><section class="overview-strip"><div><small>Files</small><strong>${delivery.items.length}</strong></div><div><small>Lifetime</small><strong>${e(date(delivery.expires))}</strong></div>
    <div><small>Default content</small><strong>${delivery.version ? 'Immutable snapshot' : 'Live files'}</strong></div></section>
    <section><div class="row between"><h3>Connection</h3><span id="connection-tag" class="status-chip">${state(delivery)}</span></div><div id="connection-info"></div>
    ${!locked && !delivery.enabled ? `<form id="network-form" class="form-grid">
    <label class="full">Network mode<select id="mode" aria-describedby="mode-help"><option value="local">Local (this computer only)</option><option value="lan">Local network (LAN)</option>
    <option value="public">Public link (Cloudflare)</option><option value="self-hosted">Self-hosted (HTTPS reverse proxy)</option></select></label>
    <p id="mode-help" class="full muted"></p>
    <label id="host-field" hidden>Interface address<input id="host" placeholder="0.0.0.0"></label>
    <label id="port-field" hidden>Listener port<input type="number" id="port" min="1" max="65535" placeholder="Automatic"></label>
    <label class="full" id="external-field" hidden>External HTTPS origin<input type="url" id="external" placeholder="https://deliveries.example.com"></label>
    <label class="check-line full" id="public-field" hidden><input id="confirm-public" type="checkbox"> Start an internet-facing Cloudflare tunnel for this delivery.</label>
    <div class="full row wrap" id="provider-field" hidden><span class="muted" id="provider-status" role="status"></span>
    <button type="button" class="button" id="install-provider" hidden>Install verified Cloudflare connector</button></div>
    <div class="full row"><button class="button primary" id="start-sharing">${icon('globe')} Start sharing</button></div></form>` : ''}
    ${delivery.enabled && !locked ? '<div class="row" id="live-controls"><button class="button" id="stop">Stop sharing</button>' +
      (delivery.network?.mode === 'self-hosted' ? '<button class="button" id="verify">Check external origin</button>' : '') + '</div>' : ''}</section>
    <section><div class="row between"><h3>Recipients</h3>${locked ? '' : `<button class="button" id="issue">${icon('plus')} Issue access code</button>`}</div><div id="profiles"></div></section>
    <section><div class="row between"><h3>Snapshots</h3>${locked ? '' : '<button class="button" id="snapshot">Create snapshot</button>'}</div>
    <p class="muted">${bytes(delivery.snapshotBytes)} stored in independent versions. Existing links keep their version.</p><div id="versions"></div></section>
    <section><h3>Active transfers</h3><div id="transfers" aria-live="off"></div></section>${banner()}</div>
    <footer class="panel-foot"><div class="row">${locked ? '' : '<button id="back" class="button quiet">Edit settings</button>'}
    ${!delivery.revoked ? '<button id="revoke" class="button danger-text">Revoke delivery</button>' : ''}</div>
    ${delivery.enabled ? '' : '<button id="remove" class="button danger-text">Remove delivery</button>'}</footer>`;
}

async function reload() { await open(delivery.id, 3); }
function bindShare() {
  const id = delivery.id;
  const update = () => {
    const connection = delivery.connection;
    $('#connection-tag').textContent = state(delivery);
    $('#connection-info').innerHTML = `<p class="muted">${e(connection.message ?? (delivery.enabled ?
      (connection.reachability === 'origin_probe_ok' ? 'The external address reached this listener from this computer.' :
      (delivery.network.mode === 'local' ? 'Available on this computer while FolderDrop runs.' : 'Keep this computer online. External reachability is unverified.')) :
      'This delivery is currently offline.'))}</p>${connection.upstream ? `<p>Reverse proxy upstream <code>${e(connection.upstream)}</code></p>` : ''}`;
    $('#transfers').innerHTML = delivery.transfers?.length ? delivery.transfers.map(task => `<div class="transfer-row">
      <strong>${e(task.kind)}</strong><progress aria-label="${e(task.kind)} progress" ${task.total ? `max="${task.total}" value="${task.bytes}"` : ''}></progress>
      <span>${bytes(task.bytes)}${task.total ? ` / ${bytes(task.total)}` : ''}</span></div>`).join('') : '<p class="muted">No transfers in progress.</p>';
  };
  update();
  const form = $('#network-form');
  if (form) {
    const mode = $('#mode', form);
    mode.value = delivery.network?.mode ?? 'local';
    $('#host').value = delivery.network?.host ?? '';
    $('#port').value = delivery.network?.port || '';
    $('#external').value = delivery.network?.external ?? '';
    const install = $('#install-provider');
    const providerStatus = $('#provider-status');
    async function provider() {
      const info = (await call('diagnostics')).tunnel;
      providerStatus.textContent = info.available ? `Cloudflare connector ${info.version} is ready.` : info.message;
      install.hidden = info.available;
    }
    install.onclick = () => void busy(install, async () => {
      providerStatus.textContent = 'Downloading and verifying the Cloudflare connector…';
      try {
        await call('tunnel-install');
        await provider();
      } catch (error) {
        providerStatus.textContent = 'The connector could not be installed.';
        throw error;
      }
    }, $('#form-error'));
    function modeChanged() {
      const binding = ['lan', 'self-hosted'].includes(mode.value);
      $('#host-field').hidden = !binding;
      $('#port-field').hidden = !binding;
      $('#external-field').hidden = mode.value !== 'self-hosted';
      $('#public-field').hidden = mode.value !== 'public';
      $('#provider-field').hidden = mode.value !== 'public';
      if (mode.value === 'public') void busy(null, provider, $('#form-error'));
      const options = {
        local: ['Starts a 127.0.0.1 address that opens only on this computer.', 'Start local sharing'],
        lan: ['Creates links for devices on the same local network. People who can observe that network may read this HTTP traffic.', 'Start LAN sharing'],
        public: ['Creates a temporary HTTPS address. Each recipient needs a one-time code. Cloudflare terminates HTTPS and can read file contents, codes, and other traffic passing through its network.', 'Start public tunnel'],
        'self-hosted': ['Starts a listener for your HTTPS reverse proxy at the external address you configure.', 'Start proxy listener']
      };
      const [description, action] = options[mode.value];
      $('#mode-help').textContent = description;
      $('#start-sharing').innerHTML = `${icon('globe')} ${action}`;
    }
    mode.onchange = modeChanged;
    modeChanged();
    form.onsubmit = event => {
      event.preventDefault();
      return busy($('#start-sharing'), async () => {
        await call('start', { id, mode: mode.value, host: $('#host').value.trim(), port: $('#port').valueAsNumber || undefined,
          external: $('#external').value.trim(), confirmPublic: $('#confirm-public').checked });
        await reload();
      }, $('#form-error'));
    };
  }
  const wire = (selector, fn) => $(selector)?.addEventListener('click', event => void busy(event.currentTarget, fn, $('#form-error')));
  wire('#stop', async () => { await call('stop', { id }); await reload(); });
  wire('#verify', async () => { await call('verify', { id }); await reload(); });
  wire('#revoke', async () => {
    if (!await confirmAction('Revoke delivery?', 'All links and active transfers will close permanently.', 'Revoke delivery')) return;
    await call('revoke', { id }); await reload();
  });
  wire('#remove', async () => {
    if (!await confirmAction('Remove delivery?', 'The manifest and its owned snapshot copies will be removed. Original files stay on disk.', 'Remove delivery')) return;
    await call('remove', { id }); startNew();
  });
  wire('#snapshot', async () => {
    toast('Copying a snapshot…');
    await call('snapshot', { id, revision: delivery.revision });
    await reload(); toast('Snapshot saved.');
  });
  $('#issue')?.addEventListener('click', () => profileForm());
  profiles();
  versions();
  clearInterval(timer);
  timer = setInterval(async () => {
    if (step !== 3 || delivery?.id !== id || document.hidden) return;
    try {
      const fresh = await call('connection', { id });
      if (step !== 3 || delivery?.id !== id) return;
      if (fresh.connection.connection === 'closed' && delivery.connection.connection !== 'closed') {
        await reload();
        return;
      }
      delivery.connection = fresh.connection;
      delivery.transfers = fresh.transfers;
      update();
    } catch {}
  }, 1800);
}

function versions() {
  const area = $('#versions');
  const canEdit = !delivery.revoked && (!delivery.expires || delivery.expires > Date.now());
  area.innerHTML = (delivery.version && canEdit ? '<button class="button quiet" id="live-default">Use live files for new links</button>' : '') +
    delivery.versions.map(version => `<div class="profile-row"><div><strong>${e(version.id)}</strong><small>${e(date(version.created))} · ${bytes(version.bytes)}${delivery.version === version.id ? ' · Default' : ''}</small></div>
    <div class="row">${canEdit && delivery.version !== version.id ? `<button class="button" data-version="${version.id}">Set default</button>` : ''}
    ${delivery.version !== version.id || !canEdit ? `<button class="button danger-text" data-delete-version="${version.id}">Delete</button>` : ''}</div></div>`).join('');
  const id = delivery.id;
  const set = version => call('set-version', { id, revision: delivery.revision, version }).then(reload);
  $('#live-default')?.addEventListener('click', event => void busy(event.currentTarget, () => set(null)));
  for (const node of $$('[data-version]', area)) node.onclick = () => void busy(node, () => set(node.dataset.version));
  for (const node of $$('[data-delete-version]', area)) node.onclick = () => void busy(node, async () => {
    if (!await confirmAction('Delete snapshot?', 'Delete this independent copy from FolderDrop storage?', 'Delete snapshot')) return;
    await call('remove-version', { id, version: node.dataset.deleteVersion }); await reload();
  });
}

function profiles() {
  const area = $('#profiles');
  area.innerHTML = delivery.recipients.length ? delivery.recipients.map(profile => `<div class="profile-row"><div><strong>${e(profile.label)}</strong>
    <small>${profile.revoked ? 'Revoked' : profile.expires && profile.expires <= Date.now() ? 'Expired' : profile.redeemed ? 'Code used' : 'Code unused'} · ${profile.version ? 'Snapshot' : 'Live'} · ${profile.items.length} files</small></div>
    <div class="row">${profile.revoked ? '' : `<button class="button" data-links="${profile.id}">Link & QR</button>`}
    <button class="button" data-profile="${profile.id}">Manage</button></div></div>`).join('') : '<p class="muted">No recipient links have been issued.</p>';
  for (const node of $$('[data-profile]', area)) node.onclick = () => profileForm(delivery.recipients.find(profile => profile.id === node.dataset.profile));
  for (const node of $$('[data-links]', area)) node.onclick = () => void busy(node, () => credentials(node.dataset.links));
}

async function credentials(recipient, code) {
  const data = await call('links', { id: delivery.id, recipient });
  const local = data.links.length && delivery.network?.mode === 'local';
  const dialog = modal(code ? 'One-time access code' : 'Recipient link & QR', `<div class="form-stack">
    ${code ? `<p>Copy this code now. FolderDrop only shows it when it is issued.</p><label>One-time access code<input readonly id="access-code" value="${e(code)}"></label>
    <button class="button" data-copy="#access-code">Copy code</button>` : ''}
    ${local ? '<p class="callout">This link only opens on this computer. To share outside your network, stop local sharing and select Public link (Cloudflare).</p>' : ''}
    ${data.links.length ? data.links.map((link, index) => `<label>Recipient link${data.links.length > 1 ? ` ${index + 1}` : ''}
      <input readonly id="link-${index}" value="${e(link)}"></label><button class="button" data-copy="#link-${index}">Copy link</button>`).join('') +
      `<img class="qr" src="${e(data.qr)}" alt="QR code for the first recipient link" width="148" height="148">` :
      '<p class="muted">Start sharing or wait for the connection to come online, then open Link & QR.</p>'}</div>`);
  for (const node of $$('[data-copy]', dialog)) node.onclick = () => void busy(node, async () => {
    const input = $(node.dataset.copy, dialog);
    input.select();
    if (navigator.clipboard) await navigator.clipboard.writeText(input.value);
    else if (!document.execCommand('copy')) throw new Error('Copy the selected text with your keyboard.');
    toast('Copied.');
  });
}

function profileForm(existing) {
  const id = delivery.id;
  const recipient = existing?.id;
  const disabled = delivery.revoked || existing?.revoked || (delivery.expires && delivery.expires <= Date.now()) ||
    (existing?.expires && existing.expires <= Date.now());
  const dialog = modal(existing ? 'Manage recipient' : 'Issue access code', `<form id="profile-form" class="form-stack">
    ${disabled ? '<p>This link is closed.</p>' : `<label>Recipient name<input name="label" value="${e(existing?.label)}" maxlength="80" required placeholder="e.g. Studio team"></label>
    ${existing ? '' : `<label>Version<select id="profile-version"><option value="" ${selected(delivery.version, null)}>Live files</option>${delivery.versions.map(version =>
      `<option value="${version.id}" ${selected(delivery.version, version.id)}>${e(version.id)}</option>`).join('')}</select></label>`}
    <fieldset><legend>Permissions</legend><div class="form-grid">
    <label class="check-line"><input type="checkbox" name="preview" ${checked(existing?.preview ?? true)}> Preview files</label>
    <label class="check-line"><input type="checkbox" name="download" ${checked(existing?.download ?? true)}> Download originals and ZIPs</label>
    ${delivery.inbox ? `<label class="check-line"><input type="checkbox" name="upload" ${checked(existing?.upload)}> Send files</label>
    <label class="check-line"><input type="checkbox" name="browseInbox" ${checked(existing?.browseInbox)}> View completed inbox activity</label>` : ''}
    </div></fieldset><div class="form-grid"><label>Download limit<input name="limit" type="number" min="1" max="100000" value="${existing?.limit ?? ''}" placeholder="Unlimited"></label>
    <label>Recipient expiration<input name="expires" type="datetime-local" value="${asDateInput(existing?.expires)}"></label></div>
    <details><summary>Choose allowed files</summary><div id="profile-items" class="scan-files"></div></details>`}
    <p class="error" role="alert" id="profile-error" tabindex="-1" hidden></p>
    <div class="row wrap">${disabled ? '' : `<button class="button primary" id="save-profile">${existing ? 'Save permissions' : 'Generate code'}</button>`}
    ${existing ? `${!existing.version || delivery.versions.some(version => version.id === existing.version) ? `<a class="button" href="/preview/${id}/as/${recipient}" target="_blank" rel="noopener">Preview profile</a>` : ''}
    ${disabled ? '' : '<button type="button" class="button" id="rotate">Generate new code</button><button type="button" class="button danger-text" id="revoke-profile">Revoke link</button>'}
    <button type="button" class="button danger-text" id="remove-profile">Remove profile</button>` : ''}</div></form>`);
  const form = $('#profile-form', dialog);
  const field = selector => $(selector, form);
  let versionRequest = 0;
  const choices = async version => {
    const request = ++versionRequest;
    const list = field('#profile-items');
    const submit = field('#save-profile');
    const error = field('#profile-error');
    error.hidden = true;
    submit.disabled = true;
    list.textContent = 'Loading allowed files…';
    try {
      const items = version ? await call('version-items', { id, version }) : delivery.items;
      if (request !== versionRequest) return;
      list.innerHTML = items.map(item => `<label class="scan-row"><input type="checkbox" name="item" value="${item.id}" ${checked(!existing || existing.items.includes(item.id))}>
        <span>${e(item.path)}</span></label>`).join('') || '<p class="muted">There are no files in this version.</p>';
      submit.disabled = false;
    } catch (failure) {
      if (request !== versionRequest) return;
      list.replaceChildren();
      error.textContent = failure.message;
      error.hidden = false;
    }
  };
  if (!disabled) {
    void choices(existing ? existing.version : field('#profile-version').value);
    if (field('#profile-version')) field('#profile-version').onchange = event => void choices(event.target.value);
    form.onsubmit = event => {
      event.preventDefault();
      void busy(field('#save-profile'), async () => {
        const formData = new FormData(form);
        const input = { id, recipient, label: formData.get('label'), preview: formData.has('preview'), download: formData.has('download'),
          upload: formData.has('upload'), browseInbox: formData.has('browseInbox'), items: formData.getAll('item'), expires: toExpiration(formData.get('expires')),
          limit: formData.get('limit') ? +formData.get('limit') : null };
        if (!existing) input.version = field('#profile-version').value || null;
        const result = await call(existing ? 'update-recipient' : 'issue', input);
        dialog.close();
        await reload();
        if (result.code) await credentials(result.id, result.code);
        else toast('Permissions saved. A redeemed recipient needs a new code.');
      }, field('#profile-error'));
    };
  }
  const canUpload = $('[name="upload"]', form);
  const canBrowse = $('[name="browseInbox"]', form);
  if (canUpload && canBrowse) {
    const update = () => {
      canBrowse.disabled = !canUpload.checked;
      if (canBrowse.disabled) canBrowse.checked = false;
    };
    canUpload.addEventListener('change', update);
    update();
  }
  const sensitive = (selector, title, message, label, action) => field(selector)?.addEventListener('click', () => {
    // Keep the form dialog intact while asking for a destructive action.
    if (!window.confirm(`${title}\n\n${message}`)) return;
    void busy(field(selector), async () => {
      const result = await call(action, { id, recipient });
      dialog.close();
      await reload();
      if (result.code) await credentials(recipient, result.code);
      else toast(label);
    }, field('#profile-error'));
  });
  sensitive('#rotate', 'Generate a new code?', 'This ends the existing session.', 'Code generated.', 'rotate');
  sensitive('#revoke-profile', 'Revoke this link?', 'The recipient and their transfers will lose access.', 'Link revoked.', 'revoke-recipient');
  sensitive('#remove-profile', 'Remove this profile?', 'This permanently invalidates the link.', 'Profile removed.', 'remove-recipient');
}

$('#new').onclick = startNew;
$('#refresh').onclick = event => void busy(event.currentTarget, refresh);
$('#quit').onclick = event => void busy(event.currentTarget, async () => {
  if (!await confirmAction('Quit FolderDrop?', 'This stops all active sharing. Your deliveries and access profiles are saved.', 'Quit FolderDrop')) return;
  await call('quit');
  clearInterval(timer);
  for (const button of $$('.sidebar button')) button.disabled = true;
  main.innerHTML = '<div class="empty"><h1 tabindex="-1">FolderDrop has quit</h1><p>Open FolderDrop again to start a new workspace session.</p></div>';
  $('h1', main).focus();
});
$('#diagnostics').onclick = event => void busy(event.currentTarget, async () => {
  const info = await call('diagnostics');
  modal('Diagnostics', `<dl class="diagnostics"><dt>Runtime</dt><dd>${e(info.node)} · ${e(info.platform)} ${e(info.architecture)}</dd>
    <dt>Data directory</dt><dd><code>${e(info.dataDirectory)}</code></dd>
    <dt>Cloudflare provider</dt><dd>${e(info.tunnel.version ?? info.tunnel.message)}</dd></dl>`);
});

try {
  const key = location.hash.slice(1);
  if (key) { history.replaceState(null, '', '/'); await api('/bootstrap', { key }); }
  initial = (await api('/api/config')).initial;
  await refresh();
  if (records.length && !initial) await open(records[0].id);
  else {
    draft = emptyDraft();
    render();
    if (initial) $('#scan-form').requestSubmit();
  }
} catch (error) {
  main.setAttribute('aria-busy', 'false');
  main.innerHTML = `<div class="empty locked-admin">${icon('lock')}<h1>Open the local workspace</h1><p>${e(error.message)}</p><code>folderdrop --no-open</code></div>`;
  for (const id of ['new', 'refresh', 'diagnostics', 'quit']) $(`#${id}`).disabled = true;
}
