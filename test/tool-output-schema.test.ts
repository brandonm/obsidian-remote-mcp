// ABOUTME: Pins the structured-output contract — tools with a stable result shape declare an
// outputSchema in tools/list and return matching structuredContent from tools/call, while
// amorphous text-only tools (note bodies) declare no outputSchema. Uses the static bearer so the
// OAuth flow stays out of scope.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Express } from 'express';

let createApp: () => { app: Express };
let vaultPath: string;

const BEARER = 'output-schema-test-bearer';

async function listen(app: Express): Promise<{ base: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('could not get listen address'));
        return;
      }
      resolve({
        base: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((res, rej) => server.close(err => (err ? rej(err) : res()))),
      });
    });
    server.on('error', reject);
  });
}

// POST a JSON-RPC message to /mcp; parse the JSON (or first SSE data line).
async function mcp(base: string, method: string, params: unknown, id = 1) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${BEARER}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await res.text();
  const line = text.split('\n').find(l => l.startsWith('data: '));
  const payload = line ? line.slice(6) : text;
  return JSON.parse(payload) as any;
}

beforeAll(async () => {
  vaultPath = await mkdtemp(path.join(os.tmpdir(), 'orm-output-schema-test-'));
  await mkdir(path.join(vaultPath, 'Notes'), { recursive: true });
  await writeFile(
    path.join(vaultPath, 'Notes', 'Alpha.md'),
    '---\nstatus: draft\ntags: [demo]\n---\n\nLinks to [[Beta]].\n',
  );
  await writeFile(path.join(vaultPath, 'Notes', 'Beta.md'), 'Beta body.\n');
  process.env.VAULT_PATH = vaultPath;
  process.env.MCP_CLIENT_ID = 'output-schema-client';
  process.env.MCP_BASE_URL = 'https://example.test';
  process.env.MCP_STATIC_BEARER_TOKEN = BEARER;
  process.env.APPROVAL_OPEN = 'true';
  process.env.VAULT_MCP_TEST = '1';
  createApp = (await import('../src/app.js')).createApp;
});

afterAll(async () => {
  delete process.env.MCP_STATIC_BEARER_TOKEN;
  await rm(vaultPath, { recursive: true, force: true });
});

describe('outputSchema declarations in tools/list', () => {
  test('structured tools declare one; note-body tools do not', async () => {
    const { app } = createApp();
    const { base, close } = await listen(app);
    try {
      const body = await mcp(base, 'tools/list', {});
      const tools: Array<{ name: string; outputSchema?: unknown }> = body.result?.tools ?? [];
      const byName = new Map(tools.map(t => [t.name, t]));
      for (const name of [
        'vault_search_title',
        'vault_search_content',
        'vault_search_frontmatter',
        'vault_frontmatter',
        'vault_links',
        'vault_tags',
      ]) {
        expect(byName.get(name)?.outputSchema).toBeDefined();
      }
      // Amorphous outputs stay text-only.
      for (const name of ['vault_read', 'vault_read_section', 'vault_context', 'vault_batch_read']) {
        expect(byName.get(name)?.outputSchema).toBeUndefined();
      }
    } finally {
      await close();
    }
  });
});

describe('structuredContent from tools/call', () => {
  test('vault_search_title returns object-rooted items alongside the text block', async () => {
    const { app } = createApp();
    const { base, close } = await listen(app);
    try {
      const body = await mcp(base, 'tools/call', {
        name: 'vault_search_title',
        arguments: { title: 'Alpha' },
      });
      const result = body.result;
      expect(result.structuredContent).toEqual({ items: [{ path: 'Notes/Alpha.md' }] });
      expect(result.content[0].text).toBe('Notes/Alpha.md');
    } finally {
      await close();
    }
  });

  test('vault_frontmatter returns the resolved path and frontmatter map', async () => {
    const { app } = createApp();
    const { base, close } = await listen(app);
    try {
      const body = await mcp(base, 'tools/call', {
        name: 'vault_frontmatter',
        arguments: { path: 'Alpha' },
      });
      const sc = body.result.structuredContent;
      expect(sc.path).toBe('Notes/Alpha.md');
      expect(sc.frontmatter).toEqual({ status: 'draft', tags: ['demo'] });
    } finally {
      await close();
    }
  });

  test('vault_links returns outgoing links with resolved paths', async () => {
    const { app } = createApp();
    const { base, close } = await listen(app);
    try {
      const body = await mcp(base, 'tools/call', {
        name: 'vault_links',
        arguments: { path: 'Alpha' },
      });
      const sc = body.result.structuredContent;
      expect(sc.path).toBe('Notes/Alpha.md');
      expect(sc.outgoing).toEqual([{ title: 'Beta', path: 'Notes/Beta.md' }]);
      expect(sc.backlinks).toBeUndefined();
    } finally {
      await close();
    }
  });

  test('vault_tags single-tag mode returns notes; empty results still return structuredContent', async () => {
    const { app } = createApp();
    const { base, close } = await listen(app);
    try {
      const tagged = await mcp(base, 'tools/call', { name: 'vault_tags', arguments: { tag: 'demo' } });
      expect(tagged.result.structuredContent.notes).toEqual(['Notes/Alpha.md']);

      const empty = await mcp(base, 'tools/call', {
        name: 'vault_search_content',
        arguments: { query: 'no-such-text-anywhere' },
      });
      expect(empty.result.structuredContent).toEqual({ items: [] });
      expect(empty.result.content[0].text).toBe('No matches found.');
    } finally {
      await close();
    }
  });
});
