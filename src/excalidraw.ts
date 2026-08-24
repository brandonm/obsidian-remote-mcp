// ABOUTME: Pure text and scene operations on the Obsidian Excalidraw plugin's markdown wrapper —
// the compressed-json codec, Drawing-block splicing, the ## Text Elements section, scene outlining,
// and building elements from a node/edge spec. No filesystem access and no vault-root dependency;
// vault.ts wraps these with I/O, locking and atomic writes, exactly as it does src/frontmatter.ts.
//
// The wrapper this module reads and writes (verified byte-for-byte against plugin 2.26.4):
//
//   ---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\n
//   ==⚠  Switch to EXCALIDRAW VIEW …⚠== …\n\n\n
//   # Excalidraw Data\n\n
//   ## Text Elements\n<text> ^<8-char id>\n\n…
//   ## Element Links\n…            (optional)
//   ## Embedded Files\n…           (optional)
//   %%\n## Drawing\n```compressed-json\n<payload>\n```\n%%      ← no trailing newline
//
// Two properties of that layout drive every design decision below:
//
//   1. `## Text Elements` OUTRANKS the JSON. On load the plugin's updateSceneTextElements()
//      overwrites each text element's text from this section and recomputes its geometry. Writing
//      new text into the compressed scene while leaving the section stale means the edit is
//      silently discarded the next time the drawing is opened. So every scene write here also
//      refreshes the section (writeScene), and a text-only edit touches ONLY the section
//      (spliceTextElement) without decompressing anything.
//
//   2. The wrapper carries state the scene JSON does not — ## Element Links, ## Embedded Files
//      (vault image references and LaTeX), the note's own frontmatter and prose. Rebuilding the
//      file from a scene object destroys all of it. Every write here is a splice into the
//      existing text; only createDrawingMarkdown builds a file from nothing.
import LZString from 'lz-string';

// --- Types -------------------------------------------------------------------

export interface ExcalidrawElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  [key: string]: unknown;
}

export interface ExcalidrawScene {
  type: string;
  version: number;
  source: string;
  elements: ExcalidrawElement[];
  appState: Record<string, unknown>;
  files?: Record<string, unknown>;
}

// Thrown when a file doesn't carry a Drawing block. Message names the path only — the audit
// logger records error text verbatim, so nothing from the note body may appear here.
export class NotADrawingError extends Error {
  constructor(relativePath: string) {
    super(
      `"${relativePath}" is not an Excalidraw drawing — no "## Drawing" block with ` +
        `\`\`\`compressed-json or \`\`\`json was found. Use vault_read for ordinary notes.`,
    );
    this.name = 'NotADrawingError';
  }
}

// Thrown when a caller's drawing spec is malformed. `detail` carries anything derived from
// caller-supplied labels; it is handed to the agent as a separate content block and never
// reaches the log. The message itself carries positions and counts only.
export class DrawingSpecError extends Error {
  constructor(
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'DrawingSpecError';
  }
}

// --- The compressed-json codec ----------------------------------------------

// Fresh regex per call. These are /g, and a module-level /g regex carries lastIndex between
// exec() calls — a stateful global that turns "read two drawings in one process" into a
// silent miss on the second. Constructing per call costs nothing and removes the whole
// class of bug.
const drawingRegex = (compressed: boolean): RegExp =>
  compressed
    ? /(\n##? Drawing\n[^`]*(?:```compressed-json\n))([\s\S]*?)(```\n)/gm
    : /(\n##? Drawing\n[^`]*(?:```json\n))([\s\S]*?)(```\n)/gm;

export function isCompressedMarkdown(md: string): boolean {
  return /```compressed-json\n/m.test(md);
}

// Strip newlines, then base64-LZ decode. Stripping \n and \r is the ONLY preprocessing the
// plugin does — the payload is wrapped for readability and the wrapping is cosmetic. Note
// that any other injected whitespace makes the decode return null rather than throw.
export function decompressScene(payload: string): string {
  const json = LZString.decompressFromBase64(payload.replace(/[\n\r]/g, ''));
  if (json === null || json === '') {
    throw new Error('Drawing payload could not be decompressed (corrupt or truncated block).');
  }
  return json;
}

// 256-character chunks joined by a BLANK line, with the trailing separator trimmed. Matches
// the plugin's own writer, so a round-trip through this module is byte-identical and produces
// no spurious Obsidian Sync diff.
export function compressScene(json: string): string {
  const encoded = LZString.compressToBase64(json);
  let out = '';
  for (let i = 0; i < encoded.length; i += 256) {
    out += `${encoded.slice(i, i + 256)}\n\n`;
  }
  return out.trim();
}

// Parse the scene out of a drawing's markdown. Handles both compressed and plain storage;
// the plugin picks between them from its `compress` setting and either may appear on disk.
export function readScene(md: string, relativePath: string): ExcalidrawScene {
  const compressed = isCompressedMarkdown(md);
  const match = drawingRegex(compressed).exec(md);
  if (!match) throw new NotADrawingError(relativePath);

  let scene: ExcalidrawScene;
  try {
    scene = JSON.parse(compressed ? decompressScene(match[2]!) : match[2]!) as ExcalidrawScene;
  } catch (e) {
    // JSON.parse quotes the offending source back in its message, and that message would be
    // written to the audit log — so it is replaced, not forwarded. Same discipline as
    // FrontmatterParseError in src/frontmatter.ts.
    throw new Error(
      `"${relativePath}" has a Drawing block that is not valid JSON (${match[2]!.length} bytes). ` +
        `The file may be corrupt; open it in Obsidian to check.`,
    );
  }
  if (!scene || !Array.isArray(scene.elements)) {
    throw new Error(`"${relativePath}" has a Drawing block with no elements array.`);
  }
  return scene;
}

// Splice a scene back into the drawing's markdown, touching ONLY the fenced payload. The
// storage form (compressed vs plain) is inherited from what is already on disk — switching it
// would cause the plugin to rewrite the whole file on its next save.
export function spliceScene(md: string, scene: ExcalidrawScene, relativePath: string): string {
  const compressed = isCompressedMarkdown(md);
  const regex = drawingRegex(compressed);
  if (!regex.test(md)) throw new NotADrawingError(relativePath);

  // Tab indent, matching the plugin. Two-space indent parses identically but breaks
  // byte-identity against every file the plugin has written.
  const json = JSON.stringify(scene, null, '\t');
  return md.replace(drawingRegex(compressed), (_all, head: string, _payload, tail: string) => {
    // Group 2 owned the newline that ended the payload, so it has to be put back: compressScene
    // returns a trimmed blob, and the closing fence must start on its own line.
    return head + (compressed ? compressScene(json) : json) + '\n' + tail;
  });
}

// --- The ## Text Elements section -------------------------------------------

export const TEXT_ELEMENTS_HEADING = '## Text Elements';

// The plugin's own scan: text runs from the end of the previous entry up to the whitespace
// before `^<id>`, and ids are exactly 8 characters. Multi-line text is normal and supported —
// "transaction\nrule ^txUeBaMc" is one element whose text contains a newline.
const ANCHOR_SCAN = (): RegExp => /\s\^(.{8})[\n]+/g;

// How far the plugin advances past a matched anchor: one whitespace, the caret, the 8-character
// id, and the two newlines its writer always emits. Any newlines beyond those two belong to the
// NEXT entry's text — `lastIndex` would swallow them and silently drop a leading blank line from
// every following label. Clamped with min() so a hand-edited single-newline separator degrades
// to lastIndex rather than over-advancing past the next entry's first character.
const advancePast = (match: RegExpExecArray, scan: RegExp): number =>
  Math.min(scan.lastIndex, match.index + 12);

// Only the wrapper's own structural sections end the text list. A generic `##? ` search would
// also stop at a *label* whose line happens to start with "## " — assertSafeElementText rejects
// new ones, but a file written by hand or by an older plugin may already contain one, and
// truncating there silently hides every later label and duplicates them on the next write.
// Anchored with /m so it can match at offset 0, which is the empty-section case.
const SECTION_TERMINATOR =
  /^(?:##? Element Links\n|##? Embedded [Ff]iles\n|##? Drawing\n|%%\n)/m;

// Bounds of the `## Text Elements` body: from just after the heading line to just past the last
// entry anchor. Returns null when the heading is absent.
//
// The end is derived from the anchors rather than from the next heading, because both naive
// alternatives corrupt files. Searching for `\n##? ` misses a terminator sitting at offset 0 —
// an EMPTY text list, which the plugin emits for any drawing with no labels (an annotated
// screenshot, an unlabelled sketch) — and the bounds then swallow the following section, so a
// write deletes `## Embedded Files`, `## Element Links`, or the `%%` that hides the scene.
function textElementsBounds(md: string): { start: number; end: number } | null {
  // `# Text Elements` is legal too: every section regex in the plugin is `##?`-tolerant, and
  // drawingRegex above accepts `# Drawing` for the same reason. Matching only `##` here would
  // make syncTextElements a silent no-op on a legacy file while the scene was still rewritten.
  const heading = /^##? Text Elements\n/m.exec(md);
  if (!heading) return null;
  const start = heading.index + heading[0].length;

  const rest = md.slice(start);
  const terminator = SECTION_TERMINATOR.exec(rest);
  const limit = terminator ? start + terminator.index : md.length;

  const body = md.slice(start, limit);
  const scan = ANCHOR_SCAN();
  let end = start;
  let match: RegExpExecArray | null;
  while ((match = scan.exec(body)) !== null) end = start + advancePast(match, scan);
  return { start, end };
}

export function parseTextElements(md: string): Map<string, string> {
  const out = new Map<string, string>();
  const bounds = textElementsBounds(md);
  if (!bounds) return out;

  const section = md.slice(bounds.start, bounds.end);
  const scan = ANCHOR_SCAN();
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = scan.exec(section)) !== null) {
    out.set(match[1]!, section.slice(cursor, match.index));
    cursor = advancePast(match, scan);
  }
  return out;
}

// Characters that would break the section parser if they appeared inside an element's text.
// Checked before any write so a bad label is rejected instead of splitting the wrapper.
export function assertSafeElementText(text: string, label: string): void {
  const problem =
    /\n%%/.test(`\n${text}`) ? '%% (markdown comment fence)'
    : text.includes('```') ? '``` (code fence)'
    : /\n#{1,6} /.test(`\n${text}`) ? 'a markdown heading line'
    // Run the parser's own regex over the text as it will be written — always followed by a
    // newline, whether by renderTextElements or by the ` ^id\n` spliceTextElement puts after it.
    // A `$`-anchored test would catch only a trailing anchor and miss an interior one, which
    // splits a single entry in two: the leading line is dropped and a phantom block reference
    // is left in the note. Reusing ANCHOR_SCAN keeps the guard from drifting from the parser.
    : ANCHOR_SCAN().test(`${text}\n`) ? 'a ^block-reference (whitespace, "^", then 8 characters at a line end)'
    : null;
  if (problem) {
    throw new DrawingSpecError(
      `${label} contains ${problem}, which would split the drawing's markdown wrapper. ` +
        `Remove it and retry.`,
    );
  }
}

// Replace one element's text in the ## Text Elements section, leaving the compressed scene
// untouched. This is the safest edit the server can make to a drawing: the section outranks
// the JSON on load, so the plugin pushes the new text into the scene itself and recomputes
// the element's geometry with real font metrics.
export function spliceTextElement(md: string, elementId: string, text: string): string {
  assertSafeElementText(text, 'Replacement text');
  const bounds = textElementsBounds(md);
  if (!bounds) {
    throw new DrawingSpecError(`This drawing has no ${TEXT_ELEMENTS_HEADING} section to edit.`);
  }

  const section = md.slice(bounds.start, bounds.end);
  const scan = ANCHOR_SCAN();
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = scan.exec(section)) !== null) {
    if (match[1] === elementId) {
      const updated = section.slice(0, cursor) + text + section.slice(match.index);
      return md.slice(0, bounds.start) + updated + md.slice(bounds.end);
    }
    cursor = advancePast(match, scan);
  }
  throw new DrawingSpecError(
    `No text element with id "${elementId}" in this drawing. Call vault_excalidraw_read and use ` +
      `the id shown as "(text <id>)" on the element's outline line — a shape's own bracketed id ` +
      `is the container, not the text, and is also 8 characters.`,
  );
}

// Render a section body from an ordered list of [id, text] pairs.
function renderTextElements(entries: [string, string][]): string {
  if (entries.length === 0) return '';
  return `${entries.map(([id, text]) => `${text} ^${id}\n`).join('\n')}\n`;
}

// Rewrite the ## Text Elements section to match the scene. Called on every full-scene write:
// leaving the section stale would mean the plugin overwrites the new text with the old on the
// next open. Only the section body is replaced — ## Element Links, ## Embedded Files, the
// note's frontmatter and any prose are outside these bounds and survive untouched.
//
// Entries already on disk keep their position and only their text is refreshed; new elements
// are appended and removed ones dropped. Rewriting in scene order instead would reorder
// same-text entries on files the plugin happens to have written in a different order (2 of the
// 7 drawings this was tested against), producing a diff — and a sync round-trip to every
// device — for a write that changed nothing.
export function syncTextElements(md: string, scene: ExcalidrawScene): string {
  const bounds = textElementsBounds(md);
  if (!bounds) return md;

  const fromScene = new Map<string, string>();
  for (const el of scene.elements) {
    if (el.type === 'text' && !el.isDeleted) fromScene.set(el.id, textOf(el));
  }

  const entries: [string, string][] = [];
  for (const id of parseTextElements(md).keys()) {
    const text = fromScene.get(id);
    if (text !== undefined) {
      entries.push([id, text]);
      fromScene.delete(id);
    }
  }
  for (const [id, text] of fromScene) entries.push([id, text]);

  return md.slice(0, bounds.start) + renderTextElements(entries) + md.slice(bounds.end);
}

// The text a text element carries. `rawText` is the plugin's own field and holds the
// pre-transclusion source, which is what belongs in the markdown section; the Excalidraw
// fields are the fallback for elements the plugin has not annotated yet.
function textOf(el: ExcalidrawElement): string {
  return (el.rawText as string) ?? (el.originalText as string) ?? (el.text as string) ?? '';
}

// --- Reading a scene: the outline -------------------------------------------

// Types that read as "a box you can point an arrow at".
const SHAPE_TYPES = new Set(['rectangle', 'ellipse', 'diamond', 'image', 'embeddable', 'frame']);

// How far from a shape's edge an unbound arrow endpoint may sit and still be read as pointing
// at it. Hand-drawn diagrams routinely have arrows that were never bound; without this the
// outline reports a wall of unconnected arrows and the agent learns nothing about structure.
const GEOMETRIC_BIND_TOLERANCE = 100;

interface OutlineOptions {
  maxElements?: number;
  // The `## Text Elements` section, which OUTRANKS the scene JSON: on load the plugin copies
  // text out of it into the elements. Passing it makes the outline report what Obsidian will
  // actually show — without it, a label changed via spliceTextElement reads as stale until
  // Obsidian next opens the file and pushes the section into the scene.
  //
  // Deliberately an outline-time overlay rather than something readScene applies, so the scene
  // this module hands back stays exactly what is on disk and a no-op write remains byte-identical.
  textOverrides?: Map<string, string>;
}

export function outlineScene(scene: ExcalidrawScene, options: OutlineOptions = {}): string {
  const maxElements = options.maxElements ?? 500;
  const overrides = options.textOverrides;
  const effectiveText = (el: ExcalidrawElement): string => overrides?.get(el.id) ?? textOf(el);
  const live = scene.elements.filter(e => !e.isDeleted);
  const deletedCount = scene.elements.length - live.length;

  const counts = new Map<string, number>();
  for (const el of live) counts.set(el.type, (counts.get(el.type) ?? 0) + 1);
  const breakdown = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${n} ${type}`)
    .join(', ');

  const sections: string[] = [
    `${live.length} elements (${breakdown})${deletedCount > 0 ? ` · ${deletedCount} erased` : ''}`,
  ];

  if (live.length > maxElements) {
    return `${sections[0]}\n\nToo large to outline (cap ${maxElements}). Raise max_elements, or read format="scene" and inspect the JSON directly.`;
  }

  const byId = new Map(live.map(e => [e.id, e]));
  const shapes = live.filter(e => SHAPE_TYPES.has(e.type));
  // A frame is a canvas-spanning container, not an arrow target. The rectangular-distance
  // formula correctly scores 0 for a point inside it, so a frame would beat every real shape
  // and collapse the whole Connections listing onto itself. An explicit binding to a frame
  // still resolves, via byId.
  const bindCandidates = shapes.filter(e => e.type !== 'frame');

  // A shape's label is the text element bound into it, carried with its own id: `set_text`
  // keys on the TEXT element, not the container, and both are 8 characters — so printing only
  // the container's id sends the agent back with an id that can never match.
  const labelByShape = new Map<string, { id: string; text: string }>();
  for (const el of live) {
    if (el.type !== 'text') continue;
    const container = el.containerId as string | undefined;
    if (container && byId.has(container)) {
      labelByShape.set(container, { id: el.id, text: effectiveText(el) });
    }
  }

  const oneLine = (text: string): string => text.replace(/\n/g, ' ');

  const describe = (el: ExcalidrawElement | undefined): string => {
    if (!el) return 'nothing';
    const label = labelByShape.get(el.id);
    if (label) return `"${oneLine(label.text)}"`;
    return `${el.type} at (${Math.round(el.x)}, ${Math.round(el.y)})`;
  };

  if (shapes.length > 0) {
    const lines = shapes.map(el => {
      const label = labelByShape.get(el.id);
      const size = `${Math.round(el.width)}×${Math.round(el.height)} at (${Math.round(el.x)}, ${Math.round(el.y)})`;
      const link = el.link ? ` → ${String(el.link)}` : '';
      const text = label ? ` "${oneLine(label.text)}" (text ${label.id})` : '';
      return `  [${el.id}] ${el.type}${text} — ${size}${link}`;
    });
    sections.push(`Shapes:\n${lines.join('\n')}`);
  }

  const connectors = live.filter(e => e.type === 'arrow' || e.type === 'line');
  if (connectors.length > 0) {
    const lines = connectors.map(el => {
      const from = resolveEndpoint(el, 'start', bindCandidates, byId);
      const to = resolveEndpoint(el, 'end', bindCandidates, byId);
      const label = labelByShape.get(el.id);
      const arrowText = label ? ` "${oneLine(label.text)}" (text ${label.id})` : '';
      return `  [${el.id}] ${el.type}${arrowText}: ${describe(from)} → ${describe(to)}`;
    });
    sections.push(`Connections:\n${lines.join('\n')}`);
  }

  // Standalone labels, titles and canvas notes — plus any text whose container was erased.
  // Testing `byId` rather than the mere presence of containerId matters: a dangling binding
  // would otherwise be skipped here AND by labelByShape above, so the text is counted in the
  // header, still rendered by Obsidian, and invisible to the agent reading the drawing.
  const loose = live.filter(e => e.type === 'text' && !byId.has((e.containerId as string) ?? ''));
  if (loose.length > 0) {
    const lines = loose.map(el => {
      const dangling = el.containerId ? ' (container missing)' : '';
      return `  [${el.id}] "${oneLine(effectiveText(el))}" at (${Math.round(el.x)}, ${Math.round(el.y)})${dangling}`;
    });
    sections.push(`Text:\n${lines.join('\n')}`);
  }

  const groups = new Map<string, number>();
  for (const el of live) {
    for (const g of (el.groupIds as string[] | undefined) ?? []) {
      groups.set(g, (groups.get(g) ?? 0) + 1);
    }
  }
  if (groups.size > 0) {
    sections.push(
      `Groups: ${[...groups.values()].map(n => `${n} elements`).join(', ')} (${groups.size} group${groups.size === 1 ? '' : 's'})`,
    );
  }

  const files = Object.keys(scene.files ?? {});
  if (files.length > 0) {
    sections.push(`Embedded files: ${files.length} (ids: ${files.slice(0, 8).join(', ')})`);
  }

  return sections.join('\n\n');
}

// Read-only view of a scene with the `## Text Elements` section applied — what Obsidian will
// actually render. Returns a copy on purpose: readScene stays byte-faithful to what is on disk,
// so a no-op write is still byte-identical, and only callers that are *displaying* the scene
// (vault_excalidraw_read format="scene") pay for the overlay.
export function applyTextOverrides(
  scene: ExcalidrawScene,
  overrides: Map<string, string>,
): ExcalidrawScene {
  if (overrides.size === 0) return scene;
  return {
    ...scene,
    elements: scene.elements.map(el => {
      const text = overrides.get(el.id);
      if (text === undefined || el.type !== 'text') return el;
      return { ...el, text, rawText: text, originalText: text };
    }),
  };
}

// Which shape a connector's end points at: its binding if it has one, otherwise the nearest
// shape to the endpoint's absolute position.
function resolveEndpoint(
  connector: ExcalidrawElement,
  which: 'start' | 'end',
  shapes: ExcalidrawElement[],
  byId: Map<string, ExcalidrawElement>,
): ExcalidrawElement | undefined {
  const binding = connector[`${which}Binding`] as { elementId?: string } | null | undefined;
  if (binding?.elementId) {
    const bound = byId.get(binding.elementId);
    if (bound) return bound;
  }

  const points = connector.points as [number, number][] | undefined;
  if (!points || points.length === 0) return undefined;
  const point = which === 'start' ? points[0]! : points[points.length - 1]!;
  const px = connector.x + point[0];
  const py = connector.y + point[1];

  let best: ExcalidrawElement | undefined;
  let bestDistance = GEOMETRIC_BIND_TOLERANCE;
  for (const shape of shapes) {
    const dx = Math.max(shape.x - px, 0, px - (shape.x + shape.width));
    const dy = Math.max(shape.y - py, 0, py - (shape.y + shape.height));
    const distance = Math.hypot(dx, dy);
    // Tie-break on area: several shapes can score 0 when they overlap, and the tighter one is
    // the one the arrow is actually pointing at.
    const area = shape.width * shape.height;
    if (distance < bestDistance || (distance === bestDistance && best && area < best.width * best.height)) {
      bestDistance = distance;
      best = shape;
    }
  }
  return best;
}

// --- Building elements ------------------------------------------------------

// Block-reference-safe alphabet. Every id this module mints is 8 characters because a text
// element's id must equal its `^anchor` in the markdown section, and the plugin's parser
// consumes exactly 8. Non-text elements get 8 too, for consistency with what the plugin
// itself writes (it mixes 8-char ids of its own with Excalidraw's native 21-char nanoids).
const ID_ALPHABET = '1234567890abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function randomInt(max: number): number {
  return Math.floor(Math.random() * max);
}

export function newElementId(used: Set<string>): string {
  for (;;) {
    let id = '';
    for (let i = 0; i < 8; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
}

// Fields every element carries. Excalidraw's restore() fills most defaults, but a scene written
// straight to disk is read by the plugin before restore in some paths, so they are all written.
function elementBase(id: string, now: number): Record<string, unknown> {
  return {
    id,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: randomInt(2 ** 31),
    version: 1,
    versionNonce: randomInt(2 ** 31),
    isDeleted: false,
    boundElements: [],
    updated: now,
    link: null,
    locked: false,
  };
}

// Excalifont at the default size. Real metrics need a DOM, but the plugin recomputes every text
// element's width and height with refreshTextDimensions() when it loads the file, so an
// approximation here only affects the initial box padding — never correctness.
const FONT_SIZE = 20;
const LINE_HEIGHT = 1.25;
const CHAR_WIDTH_RATIO = 0.58;
const BOX_PADDING = 24;
const MIN_BOX_WIDTH = 140;
const MIN_BOX_HEIGHT = 60;

function measureText(text: string): { width: number; height: number } {
  const lines = text.split('\n');
  const longest = lines.reduce((n, line) => Math.max(n, line.length), 0);
  return {
    width: longest * FONT_SIZE * CHAR_WIDTH_RATIO,
    height: lines.length * FONT_SIZE * LINE_HEIGHT,
  };
}

// --- The node/edge spec -----------------------------------------------------

export interface NodeSpec {
  id?: string;
  label: string;
  shape?: 'rectangle' | 'ellipse' | 'diamond';
  strokeColor?: string;
  backgroundColor?: string;
}

export interface EdgeSpec {
  from: string;
  to: string;
  label?: string;
  style?: 'solid' | 'dashed' | 'dotted';
}

export interface DrawingSpec {
  nodes: NodeSpec[];
  edges?: EdgeSpec[];
  direction?: 'right' | 'down';
}

const LAYER_GAP = 120;
const SIBLING_GAP = 40;
// How far outside an intervening layer a routed edge passes.
const ROUTE_CLEARANCE = 34;

// Turn a node/edge description into a laid-out Excalidraw scene with correct two-sided
// bindings. The alternative — handing an agent the raw element schema — puts it in charge of
// points arrays, binding focus/gap, bound-text centering and the boundElements back-references,
// and Excalidraw's restore() repairs only ONE of those (text containers, from containerId). A
// missing arrow entry in a shape's boundElements is not repaired: the arrow simply stops
// following the shape when it is dragged. So the spec owns that bookkeeping instead.
export function buildSceneFromSpec(spec: DrawingSpec): ExcalidrawScene {
  const nodes = spec.nodes ?? [];
  if (nodes.length === 0) {
    throw new DrawingSpecError('A drawing needs at least one node.');
  }
  const edges = spec.edges ?? [];
  const direction = spec.direction ?? 'right';

  // Node keys are caller-supplied and may be labels, so they never appear in an error message —
  // positions and counts go in the message, the offending keys go in `detail` for the agent.
  const keyToIndex = new Map<string, number>();
  const collisions: [number, number][] = [];
  nodes.forEach((node, i) => {
    const key = node.id ?? node.label;
    if (key === undefined || key === '') {
      throw new DrawingSpecError(`nodes[${i}] has no label and no id.`);
    }
    if (keyToIndex.has(key)) collisions.push([keyToIndex.get(key)!, i]);
    else keyToIndex.set(key, i);
  });

  // Refuse rather than keep the first, matching this repo's rule that writes don't guess (see
  // AmbiguousHeadingError in vault.ts). Keeping the first is the silent-wrong outcome: every
  // node is still drawn, so the diagram looks complete, but the duplicate can never be reached
  // by an arrow and sits orphaned in the first column while its edges all bind to the original.
  if (collisions.length > 0) {
    throw new DrawingSpecError(
      `${collisions.length} node key collision(s): ${collisions
        .map(([first, repeat]) => `nodes[${repeat}] repeats nodes[${first}]`)
        .join(', ')}. A node's key is its "id", or its "label" when it has no id, and edges ` +
        `address nodes by key — so a repeated key can never be reached by an arrow. Give each ` +
        `colliding node a distinct "id".`,
      `Colliding keys: ${collisions
        .map(([first, repeat]) => `nodes[${repeat}] = "${nodes[repeat]!.id ?? nodes[repeat]!.label}" (already used by nodes[${first}])`)
        .join('; ')}`,
    );
  }

  // A self-edge would build an arrow from a shape's right edge back to its own left edge —
  // drawn backwards through the box with zero height, both bindings on one element, and that
  // element listing the same arrow twice in boundElements.
  const selfEdges = edges.map((e, i) => (e.from === e.to ? i : -1)).filter(i => i >= 0);
  if (selfEdges.length > 0) {
    throw new DrawingSpecError(
      `${selfEdges.length} edge(s) point a node at itself (${selfEdges.map(i => `edges[${i}]`).join(', ')}). ` +
        `Self-loops aren't supported by the layout — draw the loop by hand in Obsidian, or model ` +
        `it as two nodes.`,
    );
  }

  const unknown: string[] = [];
  edges.forEach((edge, i) => {
    for (const side of ['from', 'to'] as const) {
      if (!keyToIndex.has(edge[side])) unknown.push(`edges[${i}].${side}`);
    }
  });
  if (unknown.length > 0) {
    throw new DrawingSpecError(
      `${unknown.length} edge endpoint(s) reference a node that isn't in the nodes list ` +
        `(${unknown.join(', ')}). Endpoints match a node's "id", or its "label" when it has no id.`,
      `Unmatched endpoints: ${unknown
        .map(u => {
          const [, idx, side] = /edges\[(\d+)\]\.(from|to)/.exec(u)!;
          return `${u} = "${edges[Number(idx)]![side as 'from' | 'to']}"`;
        })
        .join('; ')}\n\nKnown node keys: ${[...keyToIndex.keys()].map(k => `"${k}"`).join(', ')}`,
    );
  }

  for (const [i, node] of nodes.entries()) assertSafeElementText(node.label, `nodes[${i}].label`);
  for (const [i, edge] of edges.entries()) {
    if (edge.label) assertSafeElementText(edge.label, `edges[${i}].label`);
  }

  // Longest-path layering. Relaxed at most nodes.length times so a cycle terminates rather
  // than spinning; on a cycle the back-edge simply stops pushing its target further right.
  const layer = new Array<number>(nodes.length).fill(0);
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false;
    for (const edge of edges) {
      const from = keyToIndex.get(edge.from)!;
      const to = keyToIndex.get(edge.to)!;
      if (from !== to && layer[to]! <= layer[from]!) {
        layer[to] = layer[from]! + 1;
        moved = true;
      }
    }
    if (!moved) break;
  }

  const sizes = nodes.map(node => {
    const measured = measureText(node.label);
    return {
      width: Math.max(MIN_BOX_WIDTH, Math.round(measured.width + BOX_PADDING * 2)),
      height: Math.max(MIN_BOX_HEIGHT, Math.round(measured.height + BOX_PADDING)),
    };
  });

  const byLayer = new Map<number, number[]>();
  nodes.forEach((_, i) => {
    const list = byLayer.get(layer[i]!) ?? [];
    list.push(i);
    byLayer.set(layer[i]!, list);
  });

  const depths = [...byLayer.keys()].sort((a, b) => a - b);

  // Barycentre ordering: put each node near the average position of the nodes that point at it.
  // Without it the cross-axis order is declaration order, which sends edges diagonally across the
  // diagram and puts crossings where the routing pass then has to work around them. One sweep in
  // dependency order is enough at this scale and, unlike iterating to a fixed point, cannot
  // oscillate on a cyclic graph.
  const predecessors = new Map<number, number[]>();
  for (const edge of edges) {
    const from = keyToIndex.get(edge.from)!;
    const to = keyToIndex.get(edge.to)!;
    if (layer[from]! < layer[to]!) predecessors.set(to, [...(predecessors.get(to) ?? []), from]);
  }
  const orderInLayer = new Array<number>(nodes.length).fill(0);
  for (const depth of depths) {
    const members = byLayer.get(depth)!;
    const barycentre = (i: number): number => {
      const preds = predecessors.get(i) ?? [];
      if (preds.length === 0) return Number.POSITIVE_INFINITY; // unanchored: keep at the end
      return preds.reduce((sum, p) => sum + orderInLayer[p]!, 0) / preds.length;
    };
    const scored = members.map((i, position) => ({ i, score: barycentre(i), position }));
    // Stable on ties and on unanchored nodes, so declaration order still decides where nothing else does.
    scored.sort((a, b) => a.score - b.score || a.position - b.position);
    const sorted = scored.map(e => e.i);
    byLayer.set(depth, sorted);
    sorted.forEach((i, position) => (orderInLayer[i] = position));
  }

  // Along-axis offset for each layer, plus the cross-axis stacking within it.
  const positions = new Array<{ x: number; y: number }>(nodes.length);
  let along = 0;
  for (const depth of depths) {
    const members = byLayer.get(depth)!;
    const extent = members.reduce(
      (sum, i) => sum + (direction === 'right' ? sizes[i]!.height : sizes[i]!.width) + SIBLING_GAP,
      -SIBLING_GAP,
    );
    let across = -extent / 2;
    let thickest = 0;
    for (const i of members) {
      positions[i] =
        direction === 'right'
          ? { x: along, y: Math.round(across) }
          : { x: Math.round(across), y: along };
      across += (direction === 'right' ? sizes[i]!.height : sizes[i]!.width) + SIBLING_GAP;
      thickest = Math.max(thickest, direction === 'right' ? sizes[i]!.width : sizes[i]!.height);
    }
    along += thickest + LAYER_GAP;
  }

  // Cross-axis extent of each layer, for routing an edge that skips over one.
  const layerSpan = new Map<number, { min: number; max: number }>();
  for (const depth of depths) {
    for (const i of byLayer.get(depth)!) {
      const lo = direction === 'right' ? positions[i]!.y : positions[i]!.x;
      const hi = lo + (direction === 'right' ? sizes[i]!.height : sizes[i]!.width);
      const span = layerSpan.get(depth);
      layerSpan.set(depth, span ? { min: Math.min(span.min, lo), max: Math.max(span.max, hi) } : { min: lo, max: hi });
    }
  }

  const now = Date.now();
  const used = new Set<string>();
  const elements: ExcalidrawElement[] = [];
  const shapeIds: string[] = [];
  const shapeById = new Map<string, ExcalidrawElement>();

  nodes.forEach((node, i) => {
    const shapeId = newElementId(used);
    const textId = newElementId(used);
    const { width, height } = sizes[i]!;
    const { x, y } = positions[i]!;
    const measured = measureText(node.label);

    const shape: ExcalidrawElement = {
      ...elementBase(shapeId, now),
      type: node.shape ?? 'rectangle',
      x,
      y,
      width,
      height,
      strokeColor: node.strokeColor ?? '#1e1e1e',
      backgroundColor: node.backgroundColor ?? 'transparent',
      // type 3 is Excalidraw's adaptive-radius rounding — what the UI's rounded rectangle uses.
      roundness: (node.shape ?? 'rectangle') === 'rectangle' ? { type: 3 } : null,
      boundElements: [{ id: textId, type: 'text' }],
    } as ExcalidrawElement;

    const text: ExcalidrawElement = {
      ...elementBase(textId, now),
      type: 'text',
      x: Math.round(x + (width - measured.width) / 2),
      y: Math.round(y + (height - measured.height) / 2),
      width: Math.round(measured.width),
      height: Math.round(measured.height),
      text: node.label,
      rawText: node.label,
      originalText: node.label,
      fontSize: FONT_SIZE,
      // 5 is Excalifont, the plugin's default hand-drawn face in 2.x.
      fontFamily: 5,
      textAlign: 'center',
      verticalAlign: 'middle',
      containerId: shapeId,
      autoResize: true,
      lineHeight: LINE_HEIGHT,
    } as ExcalidrawElement;

    elements.push(shape, text);
    shapeIds.push(shapeId);
    shapeById.set(shapeId, shape);
  });

  for (const edge of edges) {
    const fromShape = shapeById.get(shapeIds[keyToIndex.get(edge.from)!]!)!;
    const toShape = shapeById.get(shapeIds[keyToIndex.get(edge.to)!]!)!;
    const arrowId = newElementId(used);

    const start =
      direction === 'right'
        ? { x: fromShape.x + fromShape.width, y: fromShape.y + fromShape.height / 2 }
        : { x: fromShape.x + fromShape.width / 2, y: fromShape.y + fromShape.height };
    const end =
      direction === 'right'
        ? { x: toShape.x, y: toShape.y + toShape.height / 2 }
        : { x: toShape.x + toShape.width / 2, y: toShape.y };

    // An edge that skips a layer would otherwise be drawn as a straight line straight THROUGH
    // whatever sits in the gap — boxes and their labels alike. Give it a waypoint clearing the
    // intervening band, on whichever side is closer to the endpoints.
    const via = clearanceWaypoints(
      start,
      end,
      layer[keyToIndex.get(edge.from)!]!,
      layer[keyToIndex.get(edge.to)!]!,
      layerSpan,
      direction,
    );
    const path = [start, ...via, end];
    const xs = path.map(p => p.x);
    const ys = path.map(p => p.y);

    const arrow: ExcalidrawElement = {
      ...elementBase(arrowId, now),
      type: 'arrow',
      x: Math.round(start.x),
      y: Math.round(start.y),
      width: Math.round(Math.max(...xs) - Math.min(...xs)),
      height: Math.round(Math.max(...ys) - Math.min(...ys)),
      roundness: { type: 2 },
      points: path.map(p => [Math.round(p.x - start.x), Math.round(p.y - start.y)]),
      lastCommittedPoint: null,
      // Legacy focus/gap binding. Excalidraw migrates it to the newer orbit/fixedPoint form on
      // restore, and every version understands it; focus 0 aims at the shape's centre, which is
      // what a layered graph wants.
      startBinding: { elementId: fromShape.id, focus: 0, gap: 4 },
      endBinding: { elementId: toShape.id, focus: 0, gap: 4 },
      startArrowhead: null,
      endArrowhead: 'arrow',
      elbowed: false,
      strokeStyle: edge.style ?? 'solid',
    } as ExcalidrawElement;

    // The back-references. restore() will not add these, and without them the arrow detaches
    // the first time the user drags either shape.
    for (const shape of [fromShape, toShape]) {
      (shape.boundElements as { id: string; type: string }[]).push({ id: arrowId, type: 'arrow' });
    }

    elements.push(arrow);

    if (edge.label) {
      const labelId = newElementId(used);
      const measured = measureText(edge.label);
      // On the waypoint when there is one: the straight-line midpoint of a layer-skipping edge
      // sits inside the box the arrow was just routed around.
      const anchor =
        via.length > 0
          ? { x: (via[0]!.x + via[via.length - 1]!.x) / 2, y: (via[0]!.y + via[via.length - 1]!.y) / 2 }
          : { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
      elements.push({
        ...elementBase(labelId, now),
        type: 'text',
        x: Math.round(anchor.x - measured.width / 2),
        y: Math.round(anchor.y - measured.height / 2),
        width: Math.round(measured.width),
        height: Math.round(measured.height),
        text: edge.label,
        rawText: edge.label,
        originalText: edge.label,
        fontSize: FONT_SIZE,
        fontFamily: 5,
        textAlign: 'center',
        verticalAlign: 'middle',
        containerId: arrowId,
        autoResize: true,
        lineHeight: LINE_HEIGHT,
      } as ExcalidrawElement);
      (arrow.boundElements as { id: string; type: string }[]).push({ id: labelId, type: 'text' });
    }
  }

  return {
    type: 'excalidraw',
    version: 2,
    source: EXCALIDRAW_SOURCE,
    elements,
    appState: { theme: 'light', viewBackgroundColor: '#ffffff', gridSize: null },
    files: {},
  };
}

// Where a layer-skipping edge should bend so it misses what lies between its endpoints.
// Returns [] when the layers are adjacent (nothing in the way), when the gap is empty, or when
// the straight line already clears the band.
//
// The straight-line alternative is not a cosmetic problem: an arrow drawn through a box reads as
// touching it, so the diagram asserts a relationship that does not exist.
//
// TWO waypoints, not one. A single mid-path bend still leaves the diagonal approach legs sweeping
// across the intervening layers — enough for a one-layer skip, but a longer one clips the boxes
// nearest each end. Bending immediately after the source and immediately before the target keeps
// both diagonals inside the inter-layer gutters, which by construction hold nothing.
function clearanceWaypoints(
  start: { x: number; y: number },
  end: { x: number; y: number },
  fromLayer: number,
  toLayer: number,
  layerSpan: Map<number, { min: number; max: number }>,
  direction: 'right' | 'down',
): { x: number; y: number }[] {
  const lo = Math.min(fromLayer, toLayer);
  const hi = Math.max(fromLayer, toLayer);
  if (hi - lo < 2) return [];

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let depth = lo + 1; depth < hi; depth++) {
    const span = layerSpan.get(depth);
    if (!span) continue;
    min = Math.min(min, span.min);
    max = Math.max(max, span.max);
  }
  if (min === Number.POSITIVE_INFINITY) return [];

  const crossOf = (p: { x: number; y: number }) => (direction === 'right' ? p.y : p.x);
  const alongOf = (p: { x: number; y: number }) => (direction === 'right' ? p.x : p.y);

  // If the straight line already misses the band, leave it straight — a needless bend reads as
  // meaningful.
  const mid = (crossOf(start) + crossOf(end)) / 2;
  if (mid < min - ROUTE_CLEARANCE || mid > max + ROUTE_CLEARANCE) return [];

  // Around whichever side is nearer, so the detour stays small.
  const cross = mid - min < max - mid ? min - ROUTE_CLEARANCE : max + ROUTE_CLEARANCE;
  // Inside the gutter on each side: far enough from the endpoint to have turned before reaching
  // the next layer, near enough that the leg cannot reach the layer beyond it.
  const inset = LAYER_GAP * 0.4;
  const at = (along: number) =>
    direction === 'right' ? { x: along, y: cross } : { x: cross, y: along };
  return [at(alongOf(start) + inset), at(alongOf(end) - inset)];
}

// --- Creating a new drawing file --------------------------------------------

// Left as the generic Excalidraw source rather than a plugin release tag. The plugin derives a
// saved-version by splitting `source` at its own release prefix and may run format migrations
// off it; claiming to be a specific plugin build this server has never run is how you get a
// migration skipped.
const EXCALIDRAW_SOURCE = 'https://excalidraw.com';

// Byte-exact reproduction of the header the plugin writes, including the two spaces after the
// warning glyph and the two blank lines before the data heading. `excalidraw-plugin: parsed`
// must stay unquoted: getTextMode() does a literal substring search for it, and a YAML
// round-trip that emits `excalidraw-plugin: "parsed"` silently drops the file back to raw mode.
const DRAWING_HEADER =
  '---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\n' +
  '==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== ' +
  "You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. " +
  "For more info check in plugin settings under 'Saving'\n\n\n" +
  '# Excalidraw Data\n\n';

// Build a complete drawing file. Only used for new files — an existing drawing is always
// spliced, never rebuilt, because the wrapper carries state the scene does not.
export function createDrawingMarkdown(scene: ExcalidrawScene, compressed = true): string {
  const json = JSON.stringify(scene, null, '\t');
  const payload = compressed ? compressScene(json) : json;
  const fence = compressed ? 'compressed-json' : 'json';
  return (
    DRAWING_HEADER +
    `${TEXT_ELEMENTS_HEADING}\n${renderTextElements(
      scene.elements.filter(e => e.type === 'text' && !e.isDeleted).map(e => [e.id, textOf(e)]),
    )}` +
    `%%\n## Drawing\n\`\`\`${fence}\n${payload}\n\`\`\`\n%%`
  );
}

// True when a note is an Excalidraw drawing. Matches the plugin's own detection, which is by
// frontmatter and not by filename — your drawings are plain `*.md`, not `*.excalidraw.md`.
export function isDrawingMarkdown(md: string): boolean {
  return /^---\n[\s\S]*?\nexcalidraw-plugin:[ \t]*\S/m.test(md.slice(0, 2000));
}
