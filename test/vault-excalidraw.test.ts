// ABOUTME: Tests for the drawing helpers in vault.ts — read, scene replacement, text-only edit,
// create-without-clobber — plus the guards that matter on a write path: VAULT_READ_ONLY,
// optimistic versioning against a concurrent edit, .mcpignore, and refusing to treat an ordinary
// note as a drawing.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  buildSceneFromSpec,
  compressScene,
  parseTextElements,
  readScene,
} from '../src/excalidraw.js';

let vault: typeof import('../src/vault.js');
let vaultPath: string;

const DRAWING = 'Diagrams/Flow.md';

// A drawing carrying the side sections a rebuild-style writer would destroy, so every write test
// doubles as a check that they survived.
function drawingFile(): string {
  const scene = buildSceneFromSpec({
    nodes: [{ label: 'Alpha' }, { label: 'Beta' }],
    edges: [{ from: 'Alpha', to: 'Beta' }],
  });
  const payload = compressScene(JSON.stringify(scene, null, '\t'));
  const anchors = scene.elements
    .filter(e => e.type === 'text')
    .map(e => `${e.rawText as string} ^${e.id}\n`)
    .join('\n');
  return (
    '---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\nproject: ledger\n\n---\n' +
    '# Excalidraw Data\n\n' +
    `## Text Elements\n${anchors}\n` +
    '## Embedded Files\nffffffff: [[picture.png]]\n\n' +
    `%%\n## Drawing\n\`\`\`compressed-json\n${payload}\n\`\`\`\n%%`
  );
}

// VAULT_ROOT is resolved at module-init time, so the vault must exist before the import and the
// module needs a unique query string to stay isolated from the other test files.
beforeAll(async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'orm-excalidraw-'));
  vaultPath = path.join(base, 'vault');
  await mkdir(path.join(vaultPath, 'Diagrams'), { recursive: true });
  await mkdir(path.join(vaultPath, 'Private'), { recursive: true });
  await writeFile(path.join(vaultPath, DRAWING), drawingFile());
  await writeFile(path.join(vaultPath, 'Private', 'Secret.md'), drawingFile());
  await writeFile(path.join(vaultPath, 'Diagrams', 'Plain.md'), '---\ntitle: x\n---\n\nnot a drawing\n');
  await writeFile(path.join(vaultPath, '.mcpignore'), 'Private\n');

  process.env.VAULT_PATH = vaultPath;
  process.env.VAULT_MCP_TEST = '1';
  vault = await import(`../src/vault.js?vault-excalidraw-test=${Date.now()}`);
});

afterEach(async () => {
  delete process.env.VAULT_READ_ONLY;
  await writeFile(path.join(vaultPath, DRAWING), drawingFile());
});

afterAll(async () => {
  delete process.env.VAULT_READ_ONLY;
  await rm(path.dirname(vaultPath), { recursive: true, force: true });
});

describe('readDrawing', () => {
  test('returns the scene, the raw markdown and a version', async () => {
    const { scene, markdown, version } = await vault.readDrawing(DRAWING);
    expect(scene.elements.length).toBeGreaterThan(0);
    expect(markdown).toContain('## Embedded Files');
    expect(version).toMatch(/^[0-9a-f]{16}$/);
  });

  test('an ordinary note is not read as a drawing', async () => {
    await expect(vault.readDrawing('Diagrams/Plain.md')).rejects.toThrow(/not an Excalidraw drawing/);
  });

  test('.mcpignore still applies', async () => {
    await expect(vault.readDrawing('Private/Secret.md')).rejects.toThrow(vault.VaultPolicyError);
  });

  test('dot-paths are still refused', async () => {
    await expect(vault.readDrawing('.obsidian/whatever.md')).rejects.toThrow(vault.VaultPolicyError);
  });
});

describe('writeDrawingScene', () => {
  test('replaces the scene and leaves the rest of the file alone', async () => {
    const replacement = buildSceneFromSpec({ nodes: [{ label: 'Only' }] });
    await vault.writeDrawingScene(DRAWING, replacement);

    const md = await readFile(path.join(vaultPath, DRAWING), 'utf-8');
    expect(md).toContain('## Embedded Files\nffffffff: [[picture.png]]');
    expect(md).toContain('project: ledger');
    // The LIVE scene is exactly the replacement. Dropped elements are still in the file as
    // tombstones (see the next test), so count what survives rather than the raw array.
    const live = readScene(md, DRAWING).elements.filter(e => !e.isDeleted);
    expect(live).toHaveLength(replacement.elements.length);
  });

  test('elements the replacement drops are written back as isDeleted tombstones', async () => {
    // Omitting an element is not deleting it, and the difference only appears in a running
    // Obsidian: the plugin's merge for an open view removes only ids flagged isDeleted, so a
    // merely-absent element is restored from the view's memory on its next autosave and the
    // "replacement" silently unions the old canvas with the new one.
    const before = readScene(await readFile(path.join(vaultPath, DRAWING), 'utf-8'), DRAWING);
    const beforeIds = before.elements.filter(e => !e.isDeleted).map(e => e.id);
    expect(beforeIds.length).toBeGreaterThan(0);

    const replacement = buildSceneFromSpec({ nodes: [{ label: 'Only' }] });
    await vault.writeDrawingScene(DRAWING, replacement);

    const after = readScene(await readFile(path.join(vaultPath, DRAWING), 'utf-8'), DRAWING);
    const dead = new Map(after.elements.filter(e => e.isDeleted).map(e => [e.id, e]));
    for (const id of beforeIds) {
      expect(dead.has(id)).toBe(true);
    }
    // Tombstones must not leak into the text section, or the next load resurrects their labels.
    const afterMd = await readFile(path.join(vaultPath, DRAWING), 'utf-8');
    for (const id of beforeIds) {
      expect(afterMd).not.toContain(`^${id}`);
    }
  });

  test('the ## Text Elements section is refreshed to match the new scene', async () => {
    // The section outranks the JSON on load: leaving it stale means the plugin overwrites the
    // new text with the old the next time the drawing is opened.
    const replacement = buildSceneFromSpec({ nodes: [{ label: 'Renamed' }] });
    await vault.writeDrawingScene(DRAWING, replacement);

    const md = await readFile(path.join(vaultPath, DRAWING), 'utf-8');
    expect([...parseTextElements(md).values()]).toEqual(['Renamed']);
    const textId = replacement.elements.find(e => e.type === 'text')!.id;
    expect(parseTextElements(md).has(textId)).toBe(true);
  });

  test('writing back an unchanged scene leaves the file byte-identical', async () => {
    // A no-op write must not churn the file: this vault is mirrored by a sync sidecar, and a
    // gratuitous diff costs a replication round-trip to every device.
    const before = await readFile(path.join(vaultPath, DRAWING), 'utf-8');
    const { scene } = await vault.readDrawing(DRAWING);
    await vault.writeDrawingScene(DRAWING, scene);
    expect(await readFile(path.join(vaultPath, DRAWING), 'utf-8')).toBe(before);
  });

  test('refuses to write when VAULT_READ_ONLY is set', async () => {
    process.env.VAULT_READ_ONLY = 'true';
    await expect(
      vault.writeDrawingScene(DRAWING, buildSceneFromSpec({ nodes: [{ label: 'X' }] })),
    ).rejects.toThrow(/read-only mode/);
  });

  test('rejects a stale base_version instead of overwriting', async () => {
    const { version } = await vault.readDrawing(DRAWING);
    await vault.writeDrawingScene(DRAWING, buildSceneFromSpec({ nodes: [{ label: 'First' }] }));
    await expect(
      vault.writeDrawingScene(DRAWING, buildSceneFromSpec({ nodes: [{ label: 'Second' }] }), version),
    ).rejects.toThrow(vault.ConcurrentEditError);

    const md = await readFile(path.join(vaultPath, DRAWING), 'utf-8');
    expect([...parseTextElements(md).values()]).toEqual(['First']);
  });

  test('accepts a current base_version', async () => {
    const { version } = await vault.readDrawing(DRAWING);
    const result = await vault.writeDrawingScene(
      DRAWING,
      buildSceneFromSpec({ nodes: [{ label: 'Fresh' }] }),
      version,
    );
    expect(result.version).not.toBe(version);
  });

  test('refuses to write a scene into an ordinary note', async () => {
    await expect(
      vault.writeDrawingScene('Diagrams/Plain.md', buildSceneFromSpec({ nodes: [{ label: 'X' }] })),
    ).rejects.toThrow(/not an Excalidraw drawing/);
    expect(await readFile(path.join(vaultPath, 'Diagrams', 'Plain.md'), 'utf-8')).toContain(
      'not a drawing',
    );
  });
});

describe('setDrawingText', () => {
  test('changes one label without touching the compressed scene', async () => {
    const before = await readFile(path.join(vaultPath, DRAWING), 'utf-8');
    const targetId = [...parseTextElements(before).keys()][0]!;

    await vault.setDrawingText(DRAWING, targetId, 'Renamed');

    const after = await readFile(path.join(vaultPath, DRAWING), 'utf-8');
    const fence = (s: string) => s.slice(s.indexOf('%%\n## Drawing'));
    expect(fence(after)).toBe(fence(before));
    expect(parseTextElements(after).get(targetId)).toBe('Renamed');
  });

  test('an unknown element id is refused', async () => {
    await expect(vault.setDrawingText(DRAWING, 'zzzzzzzz', 'x')).rejects.toThrow(
      /No text element with id/,
    );
  });

  test('refuses to write when VAULT_READ_ONLY is set', async () => {
    process.env.VAULT_READ_ONLY = 'true';
    await expect(vault.setDrawingText(DRAWING, 'zzzzzzzz', 'x')).rejects.toThrow(/read-only mode/);
  });

  test('honours base_version', async () => {
    const { version } = await vault.readDrawing(DRAWING);
    const targetId = [...parseTextElements(await readFile(path.join(vaultPath, DRAWING), 'utf-8')).keys()][0]!;
    await vault.setDrawingText(DRAWING, targetId, 'One');
    await expect(vault.setDrawingText(DRAWING, targetId, 'Two', version)).rejects.toThrow(
      vault.ConcurrentEditError,
    );
  });
});

describe('createDrawing', () => {
  test('writes a new drawing that reads back', async () => {
    const scene = buildSceneFromSpec({
      nodes: [{ label: 'New' }, { label: 'Thing' }],
      edges: [{ from: 'New', to: 'Thing' }],
    });
    const { path: written } = await vault.createDrawing('Diagrams/Made.md', scene);
    expect(written).toBe('Diagrams/Made.md');

    const read = await vault.readDrawing(written);
    expect(read.scene.elements).toHaveLength(scene.elements.length);
    await rm(path.join(vaultPath, written));
  });

  test('appends .md when the caller omits it', async () => {
    const { path: written } = await vault.createDrawing(
      'Diagrams/NoExtension',
      buildSceneFromSpec({ nodes: [{ label: 'X' }] }),
    );
    expect(written).toBe('Diagrams/NoExtension.md');
    await rm(path.join(vaultPath, written));
  });

  test('refuses to overwrite an existing note', async () => {
    await expect(
      vault.createDrawing(DRAWING, buildSceneFromSpec({ nodes: [{ label: 'X' }] })),
    ).rejects.toThrow(vault.NoteExistsError);
    expect(await readFile(path.join(vaultPath, DRAWING), 'utf-8')).toContain('## Embedded Files');
  });

  test('refuses to write when VAULT_READ_ONLY is set', async () => {
    process.env.VAULT_READ_ONLY = 'true';
    await expect(
      vault.createDrawing('Diagrams/Blocked.md', buildSceneFromSpec({ nodes: [{ label: 'X' }] })),
    ).rejects.toThrow(/read-only mode/);
  });
});

describe('concurrent writes to one drawing', () => {
  test('interleaved scene writes do not lose or corrupt the file', async () => {
    // Both writers read-modify-write the same path; without the per-path lock one would read
    // stale bytes and clobber the other's splice, or worse, splice into a half-written file.
    await Promise.all(
      ['A', 'B', 'C', 'D'].map(label =>
        vault.writeDrawingScene(DRAWING, buildSceneFromSpec({ nodes: [{ label }] })),
      ),
    );

    const md = await readFile(path.join(vaultPath, DRAWING), 'utf-8');
    const labels = [...parseTextElements(md).values()];
    expect(labels).toHaveLength(1);
    expect(['A', 'B', 'C', 'D']).toContain(labels[0]);
    expect(md).toContain('## Embedded Files\nffffffff: [[picture.png]]');
    expect(readScene(md, DRAWING).elements.length).toBeGreaterThan(0);
  });
});
