import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { client, request } from './daemon.js';
import { problem } from './errors.js';
import { VERSION } from './version.js';

const id = z.string().max(80);
const revision = z.number().int().positive();
const string = z.string().max(4096);
const lifetime = z.union([z.string().max(40), z.number().int(), z.null()]).optional();
const manifest = {
  roots: z.array(z.object({ path: string, label: z.string().max(240) })).max(32).optional(),
  items: z.array(z.object({ id: id.optional(), root: z.number().int(), relative: string,
    path: string.optional(), description: z.string().max(1500).optional() })).max(1000).optional(),
  presentation: z.object({ title: z.string().max(120).optional(), intro: z.string().max(3000).optional(),
    theme: z.enum(['paper', 'midnight', 'grove']).optional(), cover: id.nullable().optional() }).optional(),
  expires: lifetime,
  inbox: z.object({ path: string, types: z.array(z.string().max(80)).max(32).optional(), maxFile: z.number().optional(),
    maxTotal: z.number().optional(), maxFiles: z.number().optional(), concurrency: z.number().optional() }).nullable().optional()
};
const profile = {
  label: z.string().max(80).optional(), items: z.array(id).max(1000).nullable().optional(), expires: lifetime,
  preview: z.boolean().optional(), download: z.boolean().optional(), upload: z.boolean().optional(),
  browseInbox: z.boolean().optional(), limit: z.number().int().nullable().optional()
};
const binding = { host: z.string().max(64).optional(), port: z.number().int().optional() };
const page = { offset: z.number().int().min(0).max(10000).default(0), limit: z.number().int().min(1).max(50).default(20) };
const slice = (all, input) => ({ total: all.length, offset: input.offset, results: all.slice(input.offset, input.offset + input.limit) });
const summary = ({ items, recipients, versions, transfers, ...rest }) => ({
  ...rest, items: items.length, recipients: recipients.length, versions, transfers: transfers?.length
});

export async function mcp(directory) {
  const server = new McpServer({ name: 'folderdrop', version: VERSION });
  const call = async (action, input) => request(await client(directory), action, input);
  function register(name, description, schema, handler, options = {}) {
    server.registerTool(name, { description, inputSchema: z.object(schema), annotations: options }, async input => {
      try {
        const result = await handler(input);
        const data = Array.isArray(result) ? { results: result } : result;
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
      } catch (error) {
        const safe = problem(error);
        return { isError: true, content: [{ type: 'text', text: safe.message }], structuredContent: { code: safe.code, error: safe.message } };
      }
    });
  }
  const read = { readOnlyHint: true };
  register('list_deliveries', 'Find local FolderDrop deliveries and check listener status.', page, async input => slice(await call('list', {}), input), read);
  register('inspect_delivery', 'Inspect delivery settings, source roots, connection, and snapshot storage.', { id },
    async input => summary(await call('inspect', input)), read);
  register('scan_folder', 'List candidate source files in an explicitly provided local folder.', { path: string, ...page }, async input => {
    const result = await call('scan', input);
    return { root: result.root, skipped: result.skipped, ...slice(result.files, input) };
  }, read);
  register('list_manifest', 'List curated live items or items of a specific immutable version.', { id, version: id.optional(), ...page }, async input => {
    return { ...slice(await call('version-items', input), input), available: true };
  }, read);
  register('create_delivery', 'Create a local draft delivery from curated source roots and files.', manifest,
    async input => summary(await call('create', input)));
  register('edit_delivery', 'Edit a delivery using its current revision. Changes to a live manifest invalidate affected sessions.', { id, revision, ...manifest },
    async input => summary(await call('edit', input)));
  register('list_recipients', 'List access profile summaries and redemption status without credentials.', { id, ...page },
    async input => slice((await call('inspect', input)).recipients.map(({ items, ...entry }) => ({ ...entry, items: items.length })), input), read);
  register('list_recipient_items', 'List the exact item IDs approved in a recipient manifest.', { id, recipient, ...page }, async input => {
    const { recipients } = await call('inspect', input);
    const record = recipients.find(entry => entry.id === input.recipient);
    if (!record) return { total: 0, results: [], available: false };
    return { ...slice(record.items, input), available: true };
  }, read);
  register('issue_access_code', 'Issue a one-time access code. Encrypted deliveries also return a decryption key to send separately using a trusted channel.',
    { id, version: id.nullable().optional(), encrypted: z.boolean().optional(), ...profile }, input => call('issue', input));
  register('rotate_access_code', 'End a recipient session and intentionally generate a new one-time code.', { id, recipient }, input => call('rotate', input));
  register('update_recipient', 'Edit an access profile and invalidate the current session, streams, and grants.', { id, recipient, ...profile }, input => call('update-recipient', input));
  for (const action of ['revoke', 'remove']) {
    register(`${action}_recipient`, `${action === 'revoke' ? 'Permanently revoke' : 'Remove and invalidate'} a recipient link.`,
      { id, recipient }, input => call(`${action}-recipient`, input), { destructiveHint: true });
  }
  register('create_snapshot', 'Copy authorized originals into a distinct immutable version and set it as the default for new links.',
    { id, revision }, async input => summary(await call('snapshot', input)));
  register('set_default_version', 'Choose the version for new links. Use null for live files.', { id, revision, version: id.nullable() },
    async input => summary(await call('set-version', input)));
  register('remove_snapshot', 'Delete an unused snapshot and its owned copy.', { id, version: id },
    async input => summary(await call('remove-version', input)), { destructiveHint: true });
  register('start_sharing', 'Start a loopback or LAN recipient listener.', { id, mode: z.enum(['local', 'lan']), ...binding },
    async input => summary(await call('start', input)));
  register('start_self_hosted_sharing', 'Explicitly start the HTTPS reverse-proxy origin for a configured external URL.', { id, external: string, ...binding },
    async input => summary(await call('start', { ...input, mode: 'self-hosted' })), { openWorldHint: true });
  register('start_public_sharing', 'Explicitly create a Cloudflare Quick Tunnel for one delivery. The operator must authorize public exposure.',
    { id, confirmPublic: z.literal(true) }, async input => summary(await call('start', { ...input, mode: 'public' })), { openWorldHint: true });
  register('verify_self_hosted_origin', 'Probe the configured external HTTPS endpoint from this host.', { id }, input => call('verify', input), { openWorldHint: true });
  register('get_recipient_links', 'Request the currently usable addresses for an existing recipient profile.', { id, recipient }, async input => {
    const { links } = await call('links', input);
    return { links };
  }, read);
  for (const action of ['stop', 'revoke', 'remove']) {
    register(`${action}_delivery`, `${action === 'stop' ? 'Stop the listener and interrupt transfers' :
      action === 'revoke' ? 'Permanently revoke the delivery and its links' : 'Remove a stopped delivery and owned snapshots'}.`,
    { id }, async input => {
      const data = await call(action, input);
      return action === 'remove' ? data : summary(data);
    }, { destructiveHint: action !== 'stop' });
  }
  register('transfer_status', 'Read active transfer progress.', { id: id.optional() }, input => call('transfers', input), read);
  register('diagnostics', 'Check runtime, capabilities, and local Cloudflare provider installation without creating a tunnel.',
    {}, input => call('diagnostics', input), read);
  await server.connect(new StdioServerTransport());
}

const recipient = z.string().max(80);
