// ABOUTME: MCP tools for Obsidian Excalidraw drawings — read (outline / scene / text), create from
// a node-edge spec, replace a scene, and retitle a single text element. Registered from
// registerTools() alongside the vault_* family; the format work lives in src/excalidraw.ts and the
// locking, atomic writes and read-only enforcement in src/vault.ts.
//
// Why these exist when vault_read already returns the file: a drawing's scene is LZ-compressed
// base64 inside the markdown, so vault_read hands an agent ~6,100 tokens of noise for a diagram
// whose structure fits in ~650. And vault_update on a drawing is a data-loss primitive — it would
// rebuild the wrapper and drop `## Element Links`, `## Embedded Files` and the note's frontmatter.
//
// Every payload argument here is named `content` on purpose. The audit logger redacts by exact key
// name (REDACTED_FIELDS in src/log.ts already lists `content`), so drawing text and scene JSON are
// recorded as `<redacted:object>` and never land in logs/tool-calls.jsonl. Renaming these to
// `scene` or `spec` would silently start writing note content to disk.
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import * as vault from './vault.js';
import * as excalidraw from './excalidraw.js';
import { registerLogged, type ToolResult } from './log.js';

// Shared failure mapping. Everything here returns a friendly isError result rather than throwing,
// because the kit writes a thrown handler's `.message` to the audit log verbatim — the same reason
// AmbiguousHeadingError keeps note text out of its message. `detail` is content-derived and is
// therefore returned to the agent as a second content block instead of being folded into the text
// the logger records.
function drawingError(e: unknown, path: string): ToolResult {
  if (
    e instanceof excalidraw.NotADrawingError ||
    e instanceof vault.ConcurrentEditError ||
    e instanceof vault.VaultPolicyError ||
    e instanceof vault.NoteExistsError
  ) {
    return { content: [{ type: 'text', text: e.message }], isError: true };
  }
  if (e instanceof excalidraw.DrawingSpecError) {
    const content: ToolResult['content'] = [{ type: 'text', text: e.message }];
    if (e.detail) content.push({ type: 'text', text: e.detail });
    return { content, isError: true };
  }
  if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
    return {
      content: [{ type: 'text', text: `No note at ${path}. Check the path with vault_search_title.` }],
      isError: true,
    };
  }
  throw e;
}

// The node/edge spec an agent writes. Deliberately not the raw Excalidraw element schema: that
// would put the model in charge of points arrays, binding focus/gap, bound-text centring and the
// boundElements back-references, and Excalidraw's restore() repairs only one of those. A missing
// arrow entry in a shape's boundElements is not repaired — the arrow just stops following the
// shape when it is dragged. Layout, ids, bindings and back-references are all derived here.
const drawingSpecSchema = z.object({
  nodes: z
    .array(
      z.object({
        id: z
          .string()
          .optional()
          .describe('Optional stable key for edges to reference. Defaults to the label.'),
        label: z.string().describe('Text shown in the shape. Use \\n for a line break.'),
        shape: z
          .enum(['rectangle', 'ellipse', 'diamond'])
          .optional()
          .describe('Shape to draw. Default rectangle.'),
        strokeColor: z.string().optional().describe('Outline colour, e.g. "#1971c2". Default near-black.'),
        backgroundColor: z
          .string()
          .optional()
          .describe('Fill colour, e.g. "#ffec99". Default transparent.'),
      }),
    )
    .min(1)
    .max(200)
    .describe('The boxes in the diagram.'),
  edges: z
    .array(
      z.object({
        from: z.string().describe("Source node's id, or its label when it has no id."),
        to: z.string().describe("Target node's id, or its label when it has no id."),
        label: z.string().optional().describe('Optional text on the arrow.'),
        style: z.enum(['solid', 'dashed', 'dotted']).optional().describe('Line style. Default solid.'),
      }),
    )
    .max(400)
    .optional()
    .describe('Arrows between nodes. Bound at both ends, so they follow the shapes when dragged.'),
  direction: z
    .enum(['right', 'down'])
    .optional()
    .describe('Layout flow. "right" lays layers left-to-right (default), "down" top-to-bottom.'),
});

export function registerExcalidrawTools(server: McpServer): void {
  registerLogged(
    server,
    'vault_excalidraw_read',
    {
      annotations: { readOnlyHint: true, openWorldHint: false },
      title: 'Read Excalidraw drawing',
      description:
        'Read an Obsidian Excalidraw drawing as structure rather than raw text. Use this instead of vault_read for any note with `excalidraw-plugin` frontmatter — vault_read returns the scene as a page of compressed base64. ' +
        'format="outline" (default) lists shapes with their labels, ids and positions, and resolves every arrow to the shapes it connects; format="text" returns just the drawing\'s text labels; format="scene" returns the raw Excalidraw JSON for when you need coordinates or element internals. ' +
        'Each outline line carries two ids: the leading [bracketed] one identifies the shape, and "(text <id>)" identifies its label — vault_excalidraw_set_text takes the *text* id. Both are 8 characters, so passing the shape id fails. ' +
        'The returned version can be passed as base_version to vault_excalidraw_update or vault_excalidraw_set_text so a concurrent edit is rejected rather than overwritten.',
      inputSchema: z.object({
        path: z.string().describe('Vault-relative path to the drawing note (e.g. "AI/Notes/diagram.md")'),
        format: z
          .enum(['outline', 'text', 'scene'])
          .optional()
          .default('outline')
          .describe('outline = shapes + connections (cheapest, carries element ids); text = labels only; scene = raw JSON.'),
        max_elements: z
          .number()
          .optional()
          .default(500)
          .describe('Refuse to outline scenes larger than this rather than returning an unusably long result.'),
      }),
    },
    async ({ path, format, max_elements }) => {
      try {
        const { scene, markdown, version } = await vault.readDrawing(path);

        const overrides = excalidraw.parseTextElements(markdown);

        let body: string;
        if (format === 'scene') {
          // Overlaid for the same reason the outline is: the markdown section outranks the JSON,
          // so the raw element text can contradict what Obsidian renders after any set_text.
          body = JSON.stringify(excalidraw.applyTextOverrides(scene, overrides), null, 1);
        } else if (format === 'text') {
          const entries = [...overrides];
          body =
            entries.length === 0
              ? '(no text elements)'
              : entries.map(([id, text]) => `[${id}] ${text.replace(/\n/g, ' ')}`).join('\n');
        } else {
          // Overlay the markdown text section, which Obsidian treats as authoritative. Without
          // it a label just changed by vault_excalidraw_set_text would read back stale, because
          // that tool deliberately never rewrites the compressed scene.
          body = excalidraw.outlineScene(scene, { maxElements: max_elements, textOverrides: overrides });
        }

        return {
          content: [
            { type: 'text', text: `${path}\n\n${body}` },
            {
              type: 'text',
              text: `(version: ${version} — pass as base_version to vault_excalidraw_update or vault_excalidraw_set_text)`,
            },
          ],
        };
      } catch (e) {
        return drawingError(e, path);
      }
    },
  );

  registerLogged(
    server,
    'vault_excalidraw_create',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      title: 'Create Excalidraw drawing',
      description:
        'Create a new Excalidraw drawing from a set of nodes and arrows. Positions, ids, arrow bindings and the markdown wrapper are all generated — describe the graph, not the geometry. ' +
        'The result is a normal Obsidian note that opens in the Excalidraw editor and is fully editable by hand afterwards. Refuses to overwrite an existing note. ' +
        'Text sizing is approximate here; Obsidian recomputes it with real font metrics the first time the drawing is opened.',
      inputSchema: z.object({
        path: z
          .string()
          .describe('Vault-relative path for the new note. ".md" is appended if you leave it off.'),
        content: drawingSpecSchema.describe('The diagram: nodes, edges, and an optional layout direction.'),
      }),
    },
    async ({ path, content }) => {
      try {
        const scene = excalidraw.buildSceneFromSpec(content as excalidraw.DrawingSpec);
        const { path: written } = await vault.createDrawing(path, scene);
        const shapes = content.nodes.length;
        const arrows = content.edges?.length ?? 0;
        return {
          content: [
            {
              type: 'text',
              text: `Created ${written} — ${shapes} shape${shapes === 1 ? '' : 's'}, ${arrows} arrow${arrows === 1 ? '' : 's'}. Open it in Obsidian to edit.`,
            },
          ],
        };
      } catch (e) {
        return drawingError(e, path);
      }
    },
  );

  registerLogged(
    server,
    'vault_excalidraw_update',
    {
      // Destructive: a full-scene replacement throws away every element on the canvas, including
      // images and freehand strokes this tool cannot re-create. Clients use this annotation to
      // decide whether to confirm with the user first, and they should.
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      title: 'Replace Excalidraw drawing scene',
      description:
        'Replace the whole contents of an existing drawing with a new set of nodes and arrows. EVERYTHING currently on the canvas is discarded — including images, embeds, frames and freehand strokes, which this tool cannot re-create. Read the drawing first: if the outline lists image, embeddable, frame or freedraw elements, edit it in Obsidian instead. ' +
        'The note itself is kept: frontmatter, prose, "## Element Links" and "## Embedded Files" are untouched, because only the scene block is rewritten. ' +
        'To change one label in place use vault_excalidraw_set_text, which is far safer. ' +
        'Pass base_version from vault_excalidraw_read so the write is rejected if the drawing changed under you. Close the drawing in Obsidian first — an open Excalidraw view autosaves every 60 seconds and can overwrite an external write.',
      inputSchema: z.object({
        path: z.string().describe('Vault-relative path to the existing drawing'),
        content: drawingSpecSchema.describe('The replacement diagram: nodes, edges, optional direction.'),
        base_version: z
          .string()
          .optional()
          .describe('Version from your last vault_excalidraw_read. When set, the write is rejected if the drawing changed since.'),
      }),
    },
    async ({ path, content, base_version }) => {
      try {
        const scene = excalidraw.buildSceneFromSpec(content as excalidraw.DrawingSpec);
        const { version } = await vault.writeDrawingScene(path, scene, base_version);
        return {
          content: [{ type: 'text', text: `Updated ${path}. New version: ${version}` }],
        };
      } catch (e) {
        return drawingError(e, path);
      }
    },
  );

  registerLogged(
    server,
    'vault_excalidraw_set_text',
    {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      title: 'Retitle an Excalidraw element',
      description:
        'Change the text of one element in a drawing, leaving every shape, position and arrow exactly as it is. ' +
        'This is the safest edit available on a drawing: the text lives in a plain-markdown section that Obsidian treats as authoritative, so the compressed scene is never rewritten and nothing else can be disturbed. Prefer it over vault_excalidraw_update for fixing a label or a typo. ' +
        'element_id is the *text* element id: the one shown as "(text <id>)" on an outline line, or the bracketed id in format="text". A shape\'s own leading [id] is the container and will not match, even though it is also 8 characters.',
      inputSchema: z.object({
        path: z.string().describe('Vault-relative path to the drawing'),
        element_id: z
          .string()
          .length(8)
          .describe('8-character TEXT element id — the "(text <id>)" value on the outline line, not the shape\'s leading [id]'),
        content: z.string().describe('Replacement text. Use \\n for a line break.'),
        base_version: z
          .string()
          .optional()
          .describe('Version from your last vault_excalidraw_read. When set, the write is rejected if the drawing changed since.'),
      }),
    },
    async ({ path, element_id, content, base_version }) => {
      try {
        const { version } = await vault.setDrawingText(path, element_id, content, base_version);
        return {
          content: [{ type: 'text', text: `Updated element ${element_id} in ${path}. New version: ${version}` }],
        };
      } catch (e) {
        return drawingError(e, path);
      }
    },
  );
}
