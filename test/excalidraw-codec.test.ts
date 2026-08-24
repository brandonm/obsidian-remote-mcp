// ABOUTME: Tests for src/excalidraw.ts — the compressed-json codec's chunking shape and round-trip,
// splice-not-rebuild preservation of the wrapper's side sections, the ## Text Elements section
// (parse / splice / order-preserving sync), and scene construction from a node-edge spec.
//
// The load-bearing property most of these pin is byte-identity: reading a drawing and writing it
// straight back must produce the original bytes exactly. This vault is mirrored by a sync sidecar,
// so a write that changes nothing semantically but reshuffles the file still costs a replication
// round-trip to every device — and any drift between this module's output and the plugin's is a
// bug that shows up as an endless diff.
import { describe, expect, test } from 'bun:test';
import {
  DrawingSpecError,
  applyTextOverrides,
  NotADrawingError,
  buildSceneFromSpec,
  compressScene,
  createDrawingMarkdown,
  decompressScene,
  isCompressedMarkdown,
  isDrawingMarkdown,
  tombstoneRemoved,
  outlineScene,
  parseTextElements,
  readScene,
  spliceScene,
  spliceTextElement,
  syncTextElements,
  type ExcalidrawScene,
} from '../src/excalidraw.js';

// A scene with enough shape to exercise the parts that matter: a container with bound text, an
// arrow bound at both ends, and an erased element that must survive every round-trip.
function sampleScene(): ExcalidrawScene {
  return {
    type: 'excalidraw',
    version: 2,
    source: 'https://excalidraw.com',
    elements: [
      {
        id: 'aaaaaaaa',
        type: 'rectangle',
        x: 0,
        y: 0,
        width: 100,
        height: 60,
        isDeleted: false,
        boundElements: [{ id: 'cccccccc', type: 'text' }],
      },
      {
        id: 'bbbbbbbb',
        type: 'rectangle',
        x: 200,
        y: 0,
        width: 100,
        height: 60,
        isDeleted: false,
        boundElements: [],
      },
      {
        id: 'cccccccc',
        type: 'text',
        x: 10,
        y: 20,
        width: 80,
        height: 25,
        isDeleted: false,
        containerId: 'aaaaaaaa',
        text: 'source',
        rawText: 'source',
        originalText: 'source',
      },
      {
        id: 'dddddddd',
        type: 'arrow',
        x: 100,
        y: 30,
        width: 100,
        height: 0,
        isDeleted: false,
        points: [
          [0, 0],
          [100, 0],
        ],
        startBinding: { elementId: 'aaaaaaaa', focus: 0, gap: 4 },
        endBinding: { elementId: 'bbbbbbbb', focus: 0, gap: 4 },
      },
      {
        id: 'eeeeeeee',
        type: 'freedraw',
        x: 5,
        y: 5,
        width: 10,
        height: 10,
        isDeleted: true,
        boundElements: [],
      },
    ],
    appState: { theme: 'dark', gridSize: 20, viewBackgroundColor: '#ffffff' },
    files: {},
  };
}

// A drawing file shaped like the plugin's own output, including the two side sections that live
// only in the markdown and are destroyed by any writer that rebuilds the wrapper from a scene.
function sampleDrawing(scene: ExcalidrawScene = sampleScene()): string {
  const payload = compressScene(JSON.stringify(scene, null, '\t'));
  return (
    '---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\nproject: ledger\n\n---\n' +
    'Some prose the author wrote above the drawing data.\n\n' +
    '# Excalidraw Data\n\n' +
    '## Text Elements\nsource ^cccccccc\n\n' +
    '## Element Links\naaaaaaaa: [[Some Note]]\n\n' +
    '## Embedded Files\nffffffff: [[diagram.png]]\n\n' +
    `%%\n## Drawing\n\`\`\`compressed-json\n${payload}\n\`\`\`\n%%`
  );
}

describe('the compressed-json codec', () => {
  test('round-trips arbitrary JSON', () => {
    const json = JSON.stringify({ hello: 'world', nested: [1, 2, 3], unicode: '⚠ ✓ é' });
    expect(decompressScene(compressScene(json))).toBe(json);
  });

  test('wraps the payload in 256-character chunks separated by a blank line', () => {
    // The plugin's writer shape. Decoding strips newlines so the wrapping is cosmetic, but
    // matching it exactly is what keeps a rewritten file byte-identical to a plugin-written one.
    // Deliberately low-redundancy: a run of repeated characters compresses to under one chunk
    // and would never exercise the wrapping at all.
    const noisy = Array.from({ length: 400 }, (_, i) => ({ [`k${i}`]: `${i * 7919}-${(i * 31).toString(36)}` }));
    const blob = compressScene(JSON.stringify(noisy));
    const chunks = blob.split('\n\n');
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(0, -1)) expect(chunk.length).toBe(256);
    expect(chunks.at(-1)!.length).toBeLessThanOrEqual(256);
    expect(blob).not.toMatch(/\n\n$/);
  });

  test('decoding tolerates any newline wrapping, since it strips them first', () => {
    const json = JSON.stringify({ a: 1 });
    const blob = compressScene(json);
    expect(decompressScene(blob.replace(/\n/g, ''))).toBe(json);
    expect(decompressScene(blob.replace(/(.{40})/g, '$1\n'))).toBe(json);
  });

  test('a corrupt payload is refused rather than returning empty', () => {
    expect(() => decompressScene('not-a-real-blob!!')).toThrow(/could not be decompressed/);
  });

  test('detects compressed vs plain storage from the fence, not the payload', () => {
    expect(isCompressedMarkdown(sampleDrawing())).toBe(true);
    expect(isCompressedMarkdown('## Drawing\n```json\n{}\n```\n')).toBe(false);
  });
});

describe('reading and splicing a scene', () => {
  test('reads the scene back out of a drawing', () => {
    const scene = readScene(sampleDrawing(), 'Test.md');
    expect(scene.elements).toHaveLength(5);
    expect(scene.appState.theme).toBe('dark');
  });

  test('read then write is byte-identical', () => {
    const md = sampleDrawing();
    expect(spliceScene(md, readScene(md, 'Test.md'), 'Test.md')).toBe(md);
  });

  test('a splice preserves everything outside the Drawing block', () => {
    const md = sampleDrawing();
    const scene = readScene(md, 'Test.md');
    scene.elements[0]!.x = 999;
    const updated = spliceScene(md, scene, 'Test.md');

    // The side channels the scene JSON knows nothing about.
    expect(updated).toContain('## Element Links\naaaaaaaa: [[Some Note]]');
    expect(updated).toContain('## Embedded Files\nffffffff: [[diagram.png]]');
    expect(updated).toContain('project: ledger');
    expect(updated).toContain('Some prose the author wrote above the drawing data.');
    expect(updated).toContain('## Text Elements\nsource ^cccccccc');
    expect(readScene(updated, 'Test.md').elements[0]!.x).toBe(999);
  });

  test('erased elements and appState survive a round-trip', () => {
    // A rebuild-style writer resurrects isDeleted strokes as live art and flattens appState;
    // a splice cannot, because it never reconstructs either.
    const md = sampleDrawing();
    const scene = readScene(spliceScene(md, readScene(md, 'T.md'), 'T.md'), 'T.md');
    expect(scene.elements.filter(e => e.isDeleted)).toHaveLength(1);
    expect(scene.appState).toEqual({ theme: 'dark', gridSize: 20, viewBackgroundColor: '#ffffff' });
  });

  test('a note with no Drawing block is refused', () => {
    expect(() => readScene('---\ntitle: plain\n---\n\nJust a note.\n', 'Plain.md')).toThrow(
      NotADrawingError,
    );
  });

  test('an unparseable Drawing block does not echo its contents into the error', () => {
    const broken = sampleDrawing().replace(
      /```compressed-json\n[\s\S]*?\n```/,
      '```json\n{ "elements": [ BROKEN_SECRET_TOKEN\n```',
    );
    // The audit logger records error messages verbatim, so nothing from the file may appear.
    expect(() => readScene(broken, 'Broken.md')).toThrow(/not valid JSON/);
    try {
      readScene(broken, 'Broken.md');
    } catch (e) {
      expect((e as Error).message).not.toContain('BROKEN_SECRET_TOKEN');
    }
  });

  test('drawings are detected by frontmatter, not by filename', () => {
    expect(isDrawingMarkdown(sampleDrawing())).toBe(true);
    expect(isDrawingMarkdown('---\ntags: [note]\n---\n\nbody\n')).toBe(false);
    // A truthiness check: the plugin stops treating the file as a drawing when the key is blank.
    expect(isDrawingMarkdown('---\nexcalidraw-plugin:\n---\n\nbody\n')).toBe(false);
  });
});

describe('the ## Text Elements section', () => {
  test('parses single-line and multi-line entries', () => {
    const md = sampleDrawing().replace(
      '## Text Elements\nsource ^cccccccc\n',
      '## Text Elements\nsource ^cccccccc\n\ntransaction\nrule ^ttttttt1\n',
    );
    const parsed = parseTextElements(md);
    expect(parsed.get('cccccccc')).toBe('source');
    expect(parsed.get('ttttttt1')).toBe('transaction\nrule');
  });

  test('stops at the next section rather than swallowing Element Links', () => {
    expect([...parseTextElements(sampleDrawing()).keys()]).toEqual(['cccccccc']);
  });

  test('splicing text leaves the compressed scene byte-for-byte untouched', () => {
    const md = sampleDrawing();
    const updated = spliceTextElement(md, 'cccccccc', 'destination');
    const fence = (s: string) => s.slice(s.indexOf('%%\n## Drawing'));
    expect(fence(updated)).toBe(fence(md));
    expect(parseTextElements(updated).get('cccccccc')).toBe('destination');
    expect(updated).toContain('## Element Links\naaaaaaaa: [[Some Note]]');
  });

  test('splicing an unknown element id is refused', () => {
    expect(() => spliceTextElement(sampleDrawing(), 'zzzzzzzz', 'x')).toThrow(DrawingSpecError);
  });

  test('text that would split the wrapper is refused', () => {
    for (const bad of ['before\n%% hidden', 'a ```fence', 'x\n## Drawing', 'text ^abcd1234']) {
      expect(() => spliceTextElement(sampleDrawing(), 'cccccccc', bad)).toThrow(DrawingSpecError);
    }
  });

  test('syncing a scene whose text is unchanged is a no-op', () => {
    const md = sampleDrawing();
    expect(syncTextElements(md, readScene(md, 'T.md'))).toBe(md);
  });

  test('sync keeps the on-disk order of existing entries and appends new ones', () => {
    // The plugin's section order is not scene order — rewriting in scene order reorders
    // same-text entries and produces a diff for a write that changed nothing.
    const scene = sampleScene();
    scene.elements.push(
      { id: 'ffffff11', type: 'text', x: 0, y: 0, width: 10, height: 10, isDeleted: false, rawText: 'second' },
      { id: 'ffffff22', type: 'text', x: 0, y: 0, width: 10, height: 10, isDeleted: false, rawText: 'third' },
    );
    const md = syncTextElements(sampleDrawing(), scene);
    expect([...parseTextElements(md).keys()]).toEqual(['cccccccc', 'ffffff11', 'ffffff22']);

    // Reordering the scene must not reorder the file.
    const reordered = { ...scene, elements: [...scene.elements].reverse() };
    expect([...parseTextElements(syncTextElements(md, reordered)).keys()]).toEqual([
      'cccccccc',
      'ffffff11',
      'ffffff22',
    ]);
  });

  test('sync drops entries whose element is gone and updates changed text', () => {
    const scene = sampleScene();
    scene.elements.find(e => e.id === 'cccccccc')!.rawText = 'renamed';
    const md = syncTextElements(sampleDrawing(), scene);
    expect(parseTextElements(md).get('cccccccc')).toBe('renamed');

    const emptied = { ...scene, elements: scene.elements.filter(e => e.type !== 'text') };
    expect(parseTextElements(syncTextElements(md, emptied)).size).toBe(0);
  });
});

describe('building a scene from a node/edge spec', () => {
  const spec = {
    nodes: [{ label: 'Alpha' }, { label: 'Beta', shape: 'ellipse' as const }, { label: 'Gamma' }],
    edges: [
      { from: 'Alpha', to: 'Beta', label: 'one' },
      { from: 'Beta', to: 'Gamma' },
    ],
  };

  test('every element id is 8 characters and unique', () => {
    // Text element ids must equal their ^anchor, and the plugin's parser consumes exactly 8.
    const { elements } = buildSceneFromSpec(spec);
    expect(elements.every(e => e.id.length === 8)).toBe(true);
    expect(new Set(elements.map(e => e.id)).size).toBe(elements.length);
  });

  test('arrows are bound at both ends and back-referenced by both shapes', () => {
    // restore() repairs a text container from containerId but will NOT add a missing arrow entry
    // to a shape's boundElements — without it the arrow detaches on the first drag.
    const { elements } = buildSceneFromSpec(spec);
    const byId = new Map(elements.map(e => [e.id, e]));
    const arrows = elements.filter(e => e.type === 'arrow');
    expect(arrows).toHaveLength(2);

    for (const arrow of arrows) {
      for (const side of ['startBinding', 'endBinding'] as const) {
        const shape = byId.get((arrow[side] as { elementId: string }).elementId);
        expect(shape).toBeDefined();
        expect(shape!.boundElements as { id: string; type: string }[]).toContainEqual({
          id: arrow.id,
          type: 'arrow',
        });
      }
    }
  });

  test('node labels become text bound into their container, both directions', () => {
    const { elements } = buildSceneFromSpec(spec);
    const byId = new Map(elements.map(e => [e.id, e]));
    const labels = elements.filter(e => e.type === 'text' && e.containerId);
    expect(labels.length).toBeGreaterThanOrEqual(3);
    for (const label of labels) {
      const container = byId.get(label.containerId as string)!;
      expect(container.boundElements as { id: string; type: string }[]).toContainEqual({
        id: label.id,
        type: 'text',
      });
    }
  });

  test('layers advance along the flow direction', () => {
    const byLabel = (scene: ExcalidrawScene, text: string) => {
      const label = scene.elements.find(e => e.type === 'text' && e.rawText === text)!;
      return scene.elements.find(e => e.id === label.containerId)!;
    };
    const right = buildSceneFromSpec({ ...spec, direction: 'right' });
    expect(byLabel(right, 'Alpha').x).toBeLessThan(byLabel(right, 'Beta').x);
    expect(byLabel(right, 'Beta').x).toBeLessThan(byLabel(right, 'Gamma').x);

    const down = buildSceneFromSpec({ ...spec, direction: 'down' });
    expect(byLabel(down, 'Alpha').y).toBeLessThan(byLabel(down, 'Beta').y);
  });

  test('a cycle terminates instead of spinning', () => {
    const scene = buildSceneFromSpec({
      nodes: [{ label: 'A' }, { label: 'B' }],
      edges: [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'A' },
      ],
    });
    expect(scene.elements.filter(e => e.type === 'arrow')).toHaveLength(2);
  });

  test('an edge naming an unknown node is refused, with the labels kept out of the message', () => {
    try {
      buildSceneFromSpec({ nodes: [{ label: 'Alpha' }], edges: [{ from: 'Alpha', to: 'Nowhere' }] });
      throw new Error('expected a DrawingSpecError');
    } catch (e) {
      expect(e).toBeInstanceOf(DrawingSpecError);
      // Positions in the message (which the audit log records), labels only in the detail
      // block (which it does not).
      expect((e as Error).message).toContain('edges[0].to');
      expect((e as Error).message).not.toContain('Nowhere');
      expect((e as DrawingSpecError).detail).toContain('Nowhere');
    }
  });

  test('an empty node list is refused', () => {
    expect(() => buildSceneFromSpec({ nodes: [] })).toThrow(DrawingSpecError);
  });

  test('a label that would split the wrapper is refused', () => {
    expect(() => buildSceneFromSpec({ nodes: [{ label: 'oops\n%%' }] })).toThrow(DrawingSpecError);
  });
});

describe('creating a new drawing file', () => {
  test('the generated file parses back to the same scene', () => {
    const scene = buildSceneFromSpec({
      nodes: [{ label: 'One' }, { label: 'Two' }],
      edges: [{ from: 'One', to: 'Two' }],
    });
    const md = createDrawingMarkdown(scene);
    expect(readScene(md, 'New.md').elements).toHaveLength(scene.elements.length);
  });

  test('the header matches the plugin byte-for-byte, with parsed left unquoted', () => {
    const md = createDrawingMarkdown(buildSceneFromSpec({ nodes: [{ label: 'One' }] }));
    // getTextMode() does a literal substring search for this; a YAML round-trip that emitted
    // `excalidraw-plugin: "parsed"` would silently drop the file back to raw text mode.
    expect(md).toContain('---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\n');
    expect(md).toContain('# Excalidraw Data\n\n## Text Elements\n');
    expect(md.endsWith('\n```\n%%')).toBe(true);
    expect(md.endsWith('\n')).toBe(false);
  });

  test('every text element gets an anchor in the section', () => {
    const scene = buildSceneFromSpec({
      nodes: [{ label: 'One' }, { label: 'Two' }],
      edges: [{ from: 'One', to: 'Two', label: 'edge' }],
    });
    const md = createDrawingMarkdown(scene);
    const anchors = [...parseTextElements(md).keys()].sort();
    const textIds = scene.elements.filter(e => e.type === 'text').map(e => e.id).sort();
    expect(anchors).toEqual(textIds);
  });

  test('a new file round-trips byte-identically through read and splice', () => {
    const md = createDrawingMarkdown(buildSceneFromSpec({ nodes: [{ label: 'One' }] }));
    expect(spliceScene(md, readScene(md, 'New.md'), 'New.md')).toBe(md);
  });
});

describe('outlining a scene', () => {
  test('resolves bound arrows to the shapes they connect, and carries each endpoint id', () => {
    const outline = outlineScene(sampleScene());
    expect(outline).toContain('"source"');
    // Endpoints print their shape id. Labels are not unique in real drawings, so a label-only
    // rendering leaves duplicate-labelled edges genuinely unresolvable.
    expect(outline).toMatch(/arrow: \[\w+\] "source" → \[\w+\] rectangle/);
    // A real binding is not a guess and must not be marked as one.
    expect(outline).not.toContain('~inferred');
  });

  test('resolves an unbound arrow geometrically, and marks it as inferred', () => {
    // Hand-drawn diagrams routinely have arrows that were never bound; without the fallback the
    // outline reports a wall of unconnected arrows and says nothing about structure. But a
    // proximity guess is a reading of the picture, not a fact stored in the file, so it is
    // labelled — otherwise an agent restates it as a relationship the drawing never asserted.
    const scene = sampleScene();
    const arrow = scene.elements.find(e => e.type === 'arrow')!;
    delete arrow.startBinding;
    delete arrow.endBinding;
    const outline = outlineScene(scene);
    expect(outline).toMatch(/arrow: \[\w+\] "source" ~inferred → \[\w+\] rectangle[^\n]*~inferred/);
    expect(outline).toContain('~inferred = endpoint resolved by proximity');
  });

  test('a multi-line label prints its break as \\n, not as a space', () => {
    // The outline is the source an agent copies a label from before handing it back to
    // vault_excalidraw_set_text, whose `content` takes \\n for a break. Collapsing the newline
    // to a space here made that round trip silently flatten two-line labels — an edit that
    // reports success and quietly changes something nobody asked to change.
    const scene = sampleScene();
    const text = scene.elements.find(e => e.id === 'cccccccc')!;
    text.text = 'transaction\nrule';
    text.rawText = 'transaction\nrule';
    text.originalText = 'transaction\nrule';

    const outline = outlineScene(scene);
    expect(outline).toContain('"transaction\\nrule"');
    expect(outline).not.toContain('"transaction rule"');
  });

  test('erased elements are excluded but counted', () => {
    const outline = outlineScene(sampleScene());
    expect(outline).toContain('4 elements');
    expect(outline).toContain('1 erased');
  });

  test('an oversized scene degrades to a summary instead of a huge result', () => {
    const scene = sampleScene();
    expect(outlineScene(scene, { maxElements: 2 })).toContain('Too large to outline');
  });
});

describe('the markdown text section outranks the scene, on read as well as write', () => {
  test('outline reports the section text when the two disagree', () => {
    // Mirrors what Obsidian does on load. A label changed by spliceTextElement never touches
    // the compressed scene, so without this overlay the reader would report stale text and an
    // agent would believe its own edit had not landed.
    const md = spliceTextElement(sampleDrawing(), 'cccccccc', 'renamed-in-markdown');
    const scene = readScene(md, 'T.md');
    expect(outlineScene(scene)).toContain('"source"');
    expect(outlineScene(scene, { textOverrides: parseTextElements(md) })).toContain(
      '"renamed-in-markdown"',
    );
  });

  test('the overlay does not alter the scene, so a write stays byte-identical', () => {
    const md = spliceTextElement(sampleDrawing(), 'cccccccc', 'renamed-in-markdown');
    const scene = readScene(md, 'T.md');
    outlineScene(scene, { textOverrides: parseTextElements(md) });
    expect(spliceScene(md, scene, 'T.md')).toBe(md);
  });
});

describe('regressions from the adversarial review', () => {
  // An empty text list is what the plugin writes for any drawing with no labels — an annotated
  // screenshot, an unlabelled sketch. A `\n##? ` terminator search cannot match at offset 0, so
  // the section bounds ran on into whatever followed and a write deleted it.
  describe('an empty ## Text Elements section does not swallow the next section', () => {
    const cases: [string, string][] = [
      ['bare %%', '## Text Elements\n%%\n## Drawing\n```json\n{}\n```\n%%'],
      [
        'Embedded Files',
        '## Text Elements\n## Embedded Files\nd0b1: [[Pasted Image.png]]\n\n%%\n## Drawing\n```json\n{}\n```\n%%',
      ],
      [
        'Element Links',
        '## Text Elements\n## Element Links\nimg00001: [[Spec note]]\n\n%%\n## Drawing\n```json\n{}\n```\n%%',
      ],
    ];

    for (const [name, tail] of cases) {
      test(`survives a scene write — ${name}`, () => {
        const md = `---\n\nexcalidraw-plugin: parsed\n\n---\n# Excalidraw Data\n\n${tail}`;
        const emptyScene: ExcalidrawScene = {
          type: 'excalidraw',
          version: 2,
          source: 'https://excalidraw.com',
          elements: [],
          appState: {},
          files: {},
        };
        const after = syncTextElements(md, emptyScene);
        expect(after).toBe(md);
        expect(parseTextElements(md).size).toBe(0);
      });
    }

    test('a new text element is added without eating the following section', () => {
      const md =
        '---\n\nexcalidraw-plugin: parsed\n\n---\n# Excalidraw Data\n\n' +
        '## Text Elements\n## Embedded Files\nd0b1: [[Pasted Image.png]]\n\n%%\n## Drawing\n```json\n{}\n```\n%%';
      const scene = sampleScene();
      const after = syncTextElements(md, scene);
      expect(after).toContain('## Embedded Files\nd0b1: [[Pasted Image.png]]');
      expect(after).toContain('source ^cccccccc');
      expect(after).toContain('%%\n## Drawing');
    });
  });

  test('a label whose line starts with a heading marker does not truncate the section', () => {
    // assertSafeElementText rejects new ones, but a hand-edited or older-plugin file can already
    // contain one, and truncating there hides every later label and duplicates them on write.
    const md = sampleDrawing().replace(
      '## Text Elements\nsource ^cccccccc\n',
      '## Text Elements\n## not a heading, a label ^tttttt11\n\nsecond ^tttttt22\n',
    );
    expect([...parseTextElements(md).keys()]).toEqual(['tttttt11', 'tttttt22']);
  });

  test('a single-hash "# Text Elements" section is found, not silently skipped', () => {
    // readScene tolerates `# Drawing`, so the write path has to tolerate the matching heading —
    // otherwise syncTextElements is a no-op while the scene is rewritten anyway, and the file is
    // left with a stale section that then overrides the new scene on load.
    const md = sampleDrawing().replace('## Text Elements\n', '# Text Elements\n');
    expect(parseTextElements(md).get('cccccccc')).toBe('source');
    expect(spliceTextElement(md, 'cccccccc', 'renamed')).toContain('renamed ^cccccccc');
  });

  test('an interior ^block-reference is refused, not just a trailing one', () => {
    // The parser matches an anchor anywhere a newline follows, so an interior one splits a single
    // entry in two: the leading line is dropped and a phantom block reference is left behind.
    for (const bad of ['Total ^Q1FY2026\nrevenue', 'Merchant ^abcdefgh\nnormalized name']) {
      expect(() => spliceTextElement(sampleDrawing(), 'cccccccc', bad)).toThrow(DrawingSpecError);
      expect(() => buildSceneFromSpec({ nodes: [{ label: bad }] })).toThrow(DrawingSpecError);
    }
  });

  test('a label beginning with a blank line round-trips instead of losing it', () => {
    // The plugin advances a fixed 12 past an anchor; lastIndex would swallow extra newlines and
    // silently drop a leading blank line from every entry after the first.
    const md = sampleDrawing().replace(
      '## Text Elements\nsource ^cccccccc\n',
      '## Text Elements\nfirst ^tttttt11\n\n\nsecond ^tttttt22\n',
    );
    const parsed = parseTextElements(md);
    expect(parsed.get('tttttt11')).toBe('first');
    expect(parsed.get('tttttt22')).toBe('\nsecond');
  });

  describe('the spec refuses to guess', () => {
    test('duplicate node keys are rejected rather than silently orphaned', () => {
      // Keeping the first is the silent-wrong outcome: every box is drawn so the diagram looks
      // complete, but the duplicate can never be reached by an arrow.
      try {
        buildSceneFromSpec({
          nodes: [{ label: 'Queue' }, { label: 'Worker' }, { label: 'Queue' }],
          edges: [{ from: 'Worker', to: 'Queue' }],
        });
        throw new Error('expected a DrawingSpecError');
      } catch (e) {
        expect(e).toBeInstanceOf(DrawingSpecError);
        expect((e as Error).message).toContain('nodes[2] repeats nodes[0]');
        // Keys are caller content; they belong in detail, not in the logged message.
        expect((e as Error).message).not.toContain('Queue');
        expect((e as DrawingSpecError).detail).toContain('Queue');
      }
    });

    test('distinct ids let the same label appear twice', () => {
      const scene = buildSceneFromSpec({
        nodes: [
          { id: 'q1', label: 'Queue' },
          { id: 'q2', label: 'Queue' },
        ],
        edges: [{ from: 'q1', to: 'q2' }],
      });
      expect(scene.elements.filter(e => e.type === 'rectangle')).toHaveLength(2);
      expect(scene.elements.filter(e => e.type === 'arrow')).toHaveLength(1);
    });

    test('a self-edge is rejected rather than drawn backwards through its own box', () => {
      expect(() =>
        buildSceneFromSpec({ nodes: [{ label: 'Loop' }], edges: [{ from: 'Loop', to: 'Loop' }] }),
      ).toThrow(/point a node at itself/);
    });
  });

  test('the outline carries the bound text element id, which is what set_text needs', () => {
    // The container and its label are different elements and both ids are 8 characters, so
    // printing only the container's id hands the agent an id that can never match.
    const outline = outlineScene(sampleScene());
    const match = /\[aaaaaaaa\] rectangle "source" \(text (\w{8})\)/.exec(outline);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('cccccccc');
  });

  test('a canvas-spanning frame does not swallow every unbound arrow endpoint', () => {
    const scene = sampleScene();
    scene.elements.unshift({
      id: 'frame001',
      type: 'frame',
      x: -1000,
      y: -1000,
      width: 4000,
      height: 4000,
      isDeleted: false,
      boundElements: [],
    });
    const arrow = scene.elements.find(e => e.type === 'arrow')!;
    delete arrow.startBinding;
    delete arrow.endBinding;
    // A point inside the frame scores distance 0 and would beat every real shape.
    expect(outlineScene(scene)).toMatch(/arrow: \[\w+\] "source" ~inferred → \[\w+\] rectangle/);
  });

  test('text whose container was erased still appears, flagged', () => {
    const scene = sampleScene();
    scene.elements = scene.elements.filter(e => e.id !== 'aaaaaaaa');
    const outline = outlineScene(scene);
    expect(outline).toContain('[cccccccc] "source"');
    expect(outline).toContain('(container missing)');
  });

  test('applyTextOverrides returns a copy, leaving the scene byte-faithful', () => {
    const scene = sampleScene();
    const overlaid = applyTextOverrides(scene, new Map([['cccccccc', 'renamed']]));
    expect(overlaid.elements.find(e => e.id === 'cccccccc')!.text).toBe('renamed');
    expect(scene.elements.find(e => e.id === 'cccccccc')!.text).toBe('source');
  });
});

describe('layout: an arrow must not be drawn through a box', () => {
  // A crossing is not cosmetic — an arrow drawn through a box reads as touching it, so the
  // diagram asserts a relationship that does not exist. Found by rendering in Obsidian, not by
  // any unit test: coordinates that parse are not coordinates that read correctly.
  const boxTypes = new Set(['rectangle', 'ellipse', 'diamond']);

  function crossings(scene: ExcalidrawScene): string[] {
    const boxes = scene.elements.filter(e => boxTypes.has(e.type));
    const found: string[] = [];
    for (const arrow of scene.elements.filter(e => e.type === 'arrow')) {
      const pts = (arrow.points as [number, number][]).map(p => ({ x: arrow.x + p[0], y: arrow.y + p[1] }));
      const ends = [
        (arrow.startBinding as { elementId: string } | undefined)?.elementId,
        (arrow.endBinding as { elementId: string } | undefined)?.elementId,
      ];
      for (let i = 0; i < pts.length - 1; i++) {
        for (const box of boxes) {
          if (ends.includes(box.id)) continue;
          for (let t = 0; t <= 1; t += 0.01) {
            const x = pts[i]!.x + (pts[i + 1]!.x - pts[i]!.x) * t;
            const y = pts[i]!.y + (pts[i + 1]!.y - pts[i]!.y) * t;
            if (x > box.x + 2 && x < box.x + box.width - 2 && y > box.y + 2 && y < box.y + box.height - 2) {
              found.push(`${arrow.id} through ${box.id}`);
              t = 2;
            }
          }
        }
      }
    }
    return found;
  }

  const skipping = {
    nodes: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }, { label: 'E' }],
    edges: [
      { from: 'A', to: 'B' },
      { from: 'B', to: 'C' },
      { from: 'C', to: 'D' },
      { from: 'D', to: 'E' },
      { from: 'A', to: 'E', label: 'skip' },
    ],
  };

  for (const direction of ['right', 'down'] as const) {
    test(`an edge skipping three layers is routed around them (${direction})`, () => {
      const scene = buildSceneFromSpec({ ...skipping, direction });
      expect(crossings(scene)).toEqual([]);
      // Two waypoints: one bend still lets the diagonal approach legs clip the end boxes.
      const skip = scene.elements.filter(e => e.type === 'arrow' && (e.points as unknown[]).length > 2);
      expect(skip).toHaveLength(1);
      expect(skip[0]!.points as unknown[]).toHaveLength(4);
    });
  }

  test('adjacent-layer edges stay straight — a needless bend reads as meaningful', () => {
    const scene = buildSceneFromSpec({
      nodes: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
      edges: [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'C' },
      ],
    });
    for (const arrow of scene.elements.filter(e => e.type === 'arrow')) {
      expect(arrow.points as unknown[]).toHaveLength(2);
    }
  });

  test("a routed edge's label rides the detour instead of landing on the box", () => {
    const scene = buildSceneFromSpec(skipping);
    const byId = new Map(scene.elements.map(e => [e.id, e]));
    const label = scene.elements.find(e => e.type === 'text' && e.rawText === 'skip')!;
    const arrow = byId.get(label.containerId as string)!;
    const detourY = arrow.y + (arrow.points as [number, number][])[1]![1];
    expect(Math.abs(label.y + label.height / 2 - detourY)).toBeLessThan(30);

    for (const box of scene.elements.filter(e => boxTypes.has(e.type))) {
      const inside =
        label.x + label.width / 2 > box.x &&
        label.x + label.width / 2 < box.x + box.width &&
        label.y + label.height / 2 > box.y &&
        label.y + label.height / 2 < box.y + box.height;
      expect(inside).toBe(false);
    }
  });

  test('barycentre ordering puts a node near what points at it', () => {
    // Declaration order alone sends edges diagonally across the diagram; the sweep is stable, so
    // where nothing points at a node its declared position still decides.
    const scene = buildSceneFromSpec({
      nodes: [
        { id: 'top', label: 'top' },
        { id: 'bottom', label: 'bottom' },
        { id: 'fromBottom', label: 'fromBottom' },
        { id: 'fromTop', label: 'fromTop' },
      ],
      edges: [
        { from: 'bottom', to: 'fromBottom' },
        { from: 'top', to: 'fromTop' },
      ],
    });
    const at = (text: string) => {
      const label = scene.elements.find(e => e.type === 'text' && e.rawText === text)!;
      return scene.elements.find(e => e.id === label.containerId)!.y;
    };
    expect(at('top') < at('bottom')).toBe(true);
    // Layer 1 is re-ordered to follow layer 0 rather than keeping declaration order.
    expect(at('fromTop') < at('fromBottom')).toBe(true);
  });
});

describe('tombstoneRemoved', () => {
  test('marks dropped elements isDeleted and bumps their version', () => {
    const previous = sampleScene();
    const next = { ...previous, elements: previous.elements.filter(e => e.id === 'aaaaaaaa') };

    const result = tombstoneRemoved(previous, next);
    const byId = new Map(result.elements.map(e => [e.id, e]));

    expect(byId.get('aaaaaaaa')!.isDeleted).toBeFalsy();
    for (const id of ['bbbbbbbb', 'cccccccc', 'dddddddd']) {
      expect(byId.get(id)).toBeDefined();
      expect(byId.get(id)!.isDeleted).toBe(true);
    }
    // The merge in an open Obsidian view prefers the incoming element only when its version is
    // higher; an equal version falls back to a serialization compare the in-memory copy can win.
    const before = previous.elements.find(e => e.id === 'bbbbbbbb')!;
    const after = byId.get('bbbbbbbb')!;
    expect(after.version as number).toBeGreaterThan((before.version as number) ?? 0);
  });

  test('an unchanged element set produces no tombstones and returns the scene as-is', () => {
    const previous = sampleScene();
    const next = sampleScene();
    // Byte-identity matters here: a no-op write that grew the file would cost a sync
    // replication to every device for a change nobody made.
    expect(tombstoneRemoved(previous, next)).toBe(next);
  });

  test('already-dead elements are carried through untouched, not re-versioned', () => {
    const previous = sampleScene();
    const dead = previous.elements.find(e => e.id === 'bbbbbbbb')!;
    dead.isDeleted = true;
    dead.version = 7;
    const next = { ...previous, elements: previous.elements.filter(e => e.id !== 'bbbbbbbb') };

    const result = tombstoneRemoved(previous, next);
    const carried = result.elements.find(e => e.id === 'bbbbbbbb')!;
    expect(carried.version).toBe(7);
    expect(carried).toBe(dead);
  });
});
