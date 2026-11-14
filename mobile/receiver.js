import { Decrypter, identityToRecipient } from 'age-encryption';

const LIMIT = 64 * 1024 ** 2;
const OVERHEAD = 128 * 1024;
const options = { credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' };
const select = id => document.getElementById(id);
const form = select('receive');
const { delivery, code, key } = form.elements;
const submit = select('decrypt');
const cancel = select('cancel');
const progress = select('progress');
const status = select('status');
const error = select('error');
const save = select('save');
let transfer;
let session;
let savedUrl;

delivery.value = new URLSearchParams(location.hash.slice(1)).get('delivery')?.slice(0, 512) ?? '';
if (location.hash) history.replaceState(null, '', location.pathname);
submit.disabled = location.protocol !== 'https:';
if (submit.disabled) showError('Open this trusted receiver over HTTPS.');

function showError(message) {
  error.textContent = message;
  error.hidden = false;
  error.focus();
}

function clearSave() {
  if (savedUrl) URL.revokeObjectURL(savedUrl);
  savedUrl = undefined;
  save.removeAttribute('href');
  save.hidden = true;
}

function deliveryUrl(value) {
  let url;
  try { url = new URL(value); } catch {}
  if (url?.protocol !== 'https:' || url.username || url.password || url.hash || url.search ||
    url.origin === location.origin || !/^\/s\/[\w-]{32}\/[\w-]{22}$/.test(url.pathname)) {
    throw new Error('Enter the sender’s HTTPS encrypted delivery link.');
  }
  return url.href;
}

function denied(result, redeeming = false) {
  if (result.status === 410) return 'This code was used, expired, or the sender closed the link.';
  if (result.status === 401 && redeeming) return 'The one-time access code did not match.';
  if (result.status === 413) return 'This delivery is too large. Ask the sender for smaller deliveries or open it in FolderDrop on a computer.';
  return 'The sender could not open this delivery. Check the link and ask the sender to verify access.';
}

async function redeem(link, accessCode, signal) {
  const response = await fetch(`${link}/redeem`, { ...options, signal, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-FolderDrop-Action': '1' },
    body: JSON.stringify({ code: accessCode }) });
  if (!response.ok) throw new Error(denied(response, true));
  const reader = response.body?.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024) throw new Error('The sender returned an invalid session.');
      chunks.push(value);
    }
  } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
  const { session: token } = JSON.parse(await new Blob(chunks).text());
  if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) throw new Error('The sender returned an invalid session.');
  return token;
}

async function receive(link, token, privateKey, signal) {
  const response = await fetch(`${link}/encrypted`, { ...options, signal,
    headers: { 'X-FolderDrop-Session': token } });
  if (!response.ok) {
    if ([401, 403, 404, 410].includes(response.status)) session = undefined;
    throw new Error(denied(response));
  }
  const length = Number(response.headers.get('Content-Length'));
  if (!response.body || response.headers.get('Content-Type') !== 'application/octet-stream') {
    throw new Error('The sender returned an invalid encrypted archive.');
  }
  if (length > LIMIT + OVERHEAD) throw new Error(denied({ status: 413 }));
  let received = 0;
  const bounded = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > LIMIT + OVERHEAD) return controller.error(new Error(denied({ status: 413 })));
      if (length > 0) progress.value = Math.min(received / length, 1);
      controller.enqueue(chunk);
    }
  }), { signal });
  const decrypt = new Decrypter();
  decrypt.addIdentity(privateKey);
  const chunks = [];
  let plaintext = 0;
  try {
    const stream = await decrypt.decrypt(bounded);
    await stream.pipeTo(new WritableStream({
      write(chunk) {
        plaintext += chunk.byteLength;
        if (plaintext > LIMIT) throw new Error(denied({ status: 413 }));
        chunks.push(chunk);
      }
    }), { signal });
    if (plaintext !== stream.size(received) || (length && length !== received)) throw new Error('Incomplete transfer.');
    const zip = new Blob(chunks, { type: 'application/zip' });
    const prefix = [...new Uint8Array(await zip.slice(0, 4).arrayBuffer())];
    if (prefix.join(',') !== '80,75,3,4') throw new Error('Invalid ZIP.');
    return zip;
  } catch (failure) {
    if (received > LIMIT + OVERHEAD || plaintext > LIMIT) throw new Error(denied({ status: 413 }));
    if (signal.aborted) throw failure;
    throw new Error('Could not verify the ZIP. Check the decryption key and retry in this tab.');
  }
}

cancel.onclick = () => transfer?.abort();
delivery.oninput = () => { session = undefined; clearSave(); };
form.onsubmit = async event => {
  event.preventDefault();
  if (submit.disabled) return;
  submit.disabled = true;
  cancel.hidden = false;
  error.hidden = true;
  clearSave();
  transfer = new AbortController();
  const signal = transfer.signal;
  let failed;
  try {
    const link = deliveryUrl(delivery.value.trim());
    const privateKey = key.value.trim();
    try {
      if (!/^AGE-SECRET-KEY-1[0-9A-Z]{58}$/.test(privateKey)) throw new Error();
      await identityToRecipient(privateKey);
    } catch { throw new Error('Enter the full decryption key from the sender.'); }
    if (!session || session.link !== link) {
      status.textContent = 'Checking the one-time code…';
      const accessCode = code.value.trim();
      if (!/^[0-9a-f\s-]{20,32}$/i.test(accessCode)) throw new Error('Enter the one-time access code from the sender.');
      session = { link, token: await redeem(link, accessCode, signal) };
    }
    status.textContent = 'Downloading and decrypting on this device…';
    progress.removeAttribute('value');
    progress.hidden = false;
    const zip = await receive(link, session.token, privateKey, signal);
    savedUrl = URL.createObjectURL(zip);
    save.href = savedUrl;
    save.hidden = false;
    key.value = '';
    code.value = '';
    session = undefined;
    status.textContent = 'ZIP verified. Save it to this device.';
    save.focus();
  } catch (failure) {
    status.textContent = '';
    failed = signal.aborted ? 'Download cancelled. You can retry in this tab.' :
      failure instanceof TypeError ? 'Could not connect. Check that the sender is still sharing and has enabled this web receiver.' : failure.message;
  } finally {
    transfer.abort();
    transfer = undefined;
    progress.hidden = true;
    cancel.hidden = true;
    submit.disabled = false;
    if (failed) showError(failed);
  }
};
