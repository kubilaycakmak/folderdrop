import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { serve } from '../../src/daemon.js';
import { demoManifest, fixtures } from '../../demo/fixtures.js';

async function product(use) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'folderdrop-browser-'));
  let running;
  try {
    const demo = await fixtures(path.join(directory, 'demo'));
    running = await serve(path.join(directory, 'data'), 0);
    await use({ ...running, ...demo });
  } finally {
    await running?.close();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
}

const install = test.extend({ folderdrop: async ({}, use) => product(use) });
const screenshots = process.env.FOLDERDROP_SCREENSHOTS === '1';
async function screenshot(page, name) {
  if (!screenshots) return;
  const folder = path.resolve('docs/screenshots');
  await fs.mkdir(folder, { recursive: true });
  await page.screenshot({ path: path.join(folder, `${name}.png`), fullPage: true, animations: 'disabled' });
}

install('administrator can curate, preview, share, and revoke a restricted recipient link', async ({ folderdrop: f, page, browser }) => {
  const { url } = f.admin.launch(f.source);
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Files in this folder' })).toBeVisible();
  await page.getByRole('button', { name: 'Choose folder', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Photography', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Use this folder' }).click();
  await expect(page.getByRole('heading', { name: 'Files in this folder' })).toBeVisible();
  await page.getByRole('button', { name: 'Select all' }).click();
  await page.getByRole('button', { name: 'Add selected files' }).click();
  await expect(page.getByText('7 selected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Continue to presentation' }).click();
  await page.getByLabel('Delivery title').fill('Field Notes Studio');
  await page.getByLabel('Introduction').fill('Review the selected autumn collection assets.');
  await page.getByLabel('Cover image').selectOption({ label: 'Ridge study.jpg' });
  await page.getByText('Ridge study.jpg', { exact: true }).last().click();
  await page.getByRole('textbox', { name: 'Description', exact: true }).fill('Primary landscape study.');
  await page.getByRole('button', { name: 'Continue to access' }).click();
  await page.getByLabel('Receive files in a separate inbox').check();
  await page.getByLabel('Inbox folder').fill(f.inbox);
  await page.getByRole('button', { name: 'Save & review' }).click();
  const [preview] = await Promise.all([page.waitForEvent('popup'), page.getByRole('link', { name: 'Preview delivery' }).click()]);
  await expect(preview.getByRole('heading', { name: 'Field Notes Studio' })).toBeVisible();
  await expect(preview.getByText('Recipient preview', { exact: true })).toBeVisible();
  await preview.close();
  await expect(page.getByText('Starts a 127.0.0.1 address that opens only on this computer.')).toBeVisible();
  await page.getByLabel('Network mode').selectOption('public');
  await expect(page.getByRole('button', { name: 'Start public tunnel' })).toBeVisible();
  await expect(page.getByText('Creates a temporary HTTPS address', { exact: false })).toBeVisible();
  await expect(page.getByText('Cloudflare terminates HTTPS', { exact: false })).toBeVisible();
  await page.getByLabel('Network mode').selectOption('local');
  await page.getByRole('button', { name: 'Start local sharing' }).click();
  await expect(page.getByRole('button', { name: 'Stop sharing' })).toBeVisible();
  await screenshot(page, 'workspace');
  await page.getByRole('button', { name: 'Issue access code' }).click();
  await page.getByLabel('Recipient name').fill('Design reviewer');
  await page.getByLabel('Send files', { exact: true }).check();
  await page.getByText('Choose allowed files').click();
  await page.getByRole('checkbox', { name: 'Project notes/Editable project.proj' }).uncheck();
  await page.getByRole('button', { name: 'Generate code' }).click();
  const code = await page.getByRole('textbox', { name: 'One-time access code' }).inputValue();
  const link = await page.getByLabel('Recipient link', { exact: true }).inputValue();
  await expect(page.getByText('This link only opens on this computer.', { exact: false })).toBeVisible();
  const recipient = await browser.newContext({ viewport: { width: 440, height: 850 } });
  try {
    const receiver = await recipient.newPage();
    await receiver.goto(link);
    await expect(receiver.getByRole('heading', { name: 'Open your delivery' })).toBeVisible();
    await screenshot(receiver, 'access-code');
    await receiver.getByLabel('Access code').fill('00000-00000-00000-00000');
    await receiver.getByRole('button', { name: 'Open delivery' }).click();
    await expect(receiver.getByRole('alert')).toContainText('did not match');
    await receiver.getByLabel('Access code').fill(code);
    await receiver.getByRole('button', { name: 'Open delivery' }).click();
    await expect(receiver.getByRole('heading', { name: 'Field Notes Studio' })).toBeVisible();
    await receiver.getByRole('searchbox').fill('Editable');
    await expect(receiver.getByRole('heading', { name: 'No matching files' })).toBeVisible();
    await receiver.getByRole('button', { name: 'Send files' }).click();
    await receiver.locator('input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Approved.') });
    await receiver.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(receiver.getByText('Saved in inbox', { exact: true })).toBeVisible();
    expect(await fs.readFile(path.join(f.inbox, 'notes.txt'), 'utf8')).toBe('Approved.');
    const other = await browser.newContext();
    try {
      const again = await other.newPage();
      await again.goto(link);
      await again.getByLabel('Access code').fill(code);
      await again.getByRole('button', { name: 'Open delivery' }).click();
      await expect(again.getByRole('alert')).toContainText('already been used');
    } finally { await other.close(); }
    await page.getByRole('button', { name: 'Close dialog' }).click();
    await page.getByRole('button', { name: 'Revoke delivery' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Revoke delivery' }).click();
    await expect(page.getByText('Revoked', { exact: true }).first()).toBeVisible();
    const shareId = new URL(link).pathname.split('/')[2];
    expect(f.app.inspect(shareId).revoked).toBe(true);
    expect(f.app.network.status(shareId).addresses).toEqual([]);
    await expect(receiver.getByRole('heading', { name: 'Delivery unavailable' })).toBeVisible({ timeout: 7000 });
    await page.getByRole('button', { name: 'Quit FolderDrop', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Quit FolderDrop' }).click();
    await expect(page.getByRole('heading', { name: 'FolderDrop has quit' })).toBeVisible();
  } finally { await recipient.close(); }
});

install('recipient gallery, list, breadcrumbs, safe previews, codec fallback and native downloads', async ({ folderdrop: f, page }) => {
  let delivery = await f.app.call('create', demoManifest(f.source, f.inbox));
  delivery = await f.app.call('edit', { id: delivery.id, revision: delivery.revision, presentation: { cover: delivery.items[0].id } });
  await f.app.call('start', { id: delivery.id, mode: 'local' });
  const grant = await f.app.call('issue', { id: delivery.id });
  const link = grant.links[0];
  await page.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }); });
  await page.goto(link);
  await page.getByLabel('Access code').fill(grant.code);
  await page.getByRole('button', { name: 'Open delivery' }).click();
  await expect(page.getByRole('heading', { name: 'Field Notes Studio' })).toBeVisible();
  await expect(page.locator('.cover-art img')).toBeVisible();
  await expect(page.locator('.file-thumb img')).toHaveCount(2);
  await screenshot(page, 'recipient-gallery');
  await page.getByRole('button', { name: 'Lookbook.pdf', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Page 1 of 2' })).toBeVisible({ timeout: 18000 });
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Page 2 of 2' })).toBeVisible({ timeout: 18000 });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'List view' }).click();
  await expect(page.getByRole('button', { name: 'List view' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: /Project notes/ }).click();
  await expect(page.getByRole('navigation', { name: 'Delivery folders' }).getByText('Project notes')).toBeVisible();
  await page.getByRole('button', { name: 'Read me.txt', exact: true }).click();
  await expect(page.getByText('The selected artwork', { exact: false })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Editable project.proj', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Preview unavailable' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download original', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('searchbox').fill('Ambient');
  await page.getByRole('button', { name: 'Ambient tone.wav', exact: true }).click();
  await expect(page.locator('dialog audio')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('searchbox').fill('Palette motion');
  await page.getByRole('button', { name: 'Palette motion.webm', exact: true }).click();
  await expect(page.locator('dialog video')).toBeVisible();
  await expect.poll(() => page.locator('dialog video').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(1);
  await page.keyboard.press('Escape');
  await page.getByRole('searchbox').fill('Ambient');
  await page.evaluate(() => { HTMLMediaElement.prototype.canPlayType = () => ''; });
  await page.getByRole('button', { name: 'Ambient tone.wav', exact: true }).click();
  await expect(page.getByText('This browser does not support the media format or codec.')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('searchbox').fill('read me');
  const original = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download original Read me.txt' }).click();
  expect((await original).suggestedFilename()).toBe('Read me.txt');
  await page.getByRole('checkbox', { name: 'Select Read me.txt' }).check();
  const zip = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download ZIP' }).click();
  expect((await zip).suggestedFilename()).toBe('delivery.zip');
});
