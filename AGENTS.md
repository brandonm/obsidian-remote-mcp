# obsidian-remote-mcp

Remote MCP server exposing an Obsidian vault over HTTP with OAuth 2.1 (authorization code + PKCE).

References:
- MCP specification: [modelcontextprotocol.io/specification](https://modelcontextprotocol.io/specification)
- Claude Code MCP docs for server authors: [code.claude.com/docs/en/mcp#for-mcp-server-authors](https://code.claude.com/docs/en/mcp#for-mcp-server-authors)

## Stack

- **Runtime**: Bun (TypeScript, no build step)
- **Transport**: Streamable HTTP (MCP spec)
- **Auth**: OAuth 2.1 authorization code + PKCE (browser flow for Claude.ai)
- **Scaffolding**: [`mcp-server-kit`](https://github.com/nweii/mcp-server-kit) (git dependency) supplies the app factory (CORS, request logging, the bearer-gated `/health`, the `/mcp` mount), the Claude-facing OAuth module (`createAuth`, SDK-backed), the tool-result helpers, the audit-logging module, and process/shutdown helpers. The OAuth wire surface (discovery, endpoint paths, error shapes) is whatever the MCP SDK emits — notably the token endpoint is `/token`.
- **Deployment**: Docker container on a server or NAS

## File structure

```
src/
  server.ts   — Builds the app via createApp() and starts it with the kit's startServer (persists tokens on shutdown)
  app.ts      — createApp() — maps env vars to the kit's createAuth / createApp and registers the vault tools; returns { app, auth }
  vault.ts    — Vault filesystem operations, frontmatter helpers, drawing read/write, vault discovery, and config-derived defaults
  tools.ts    — MCP tool definitions (context, read, batch read, outline, read section, read attachment, frontmatter, links, create/update/edit/edit section/trash, set frontmatter, batch set frontmatter, move/rename, search title, search content, search frontmatter, tags, periodic note, clip URL, feedback)
  excalidraw.ts       — Pure format ops for Obsidian Excalidraw drawings: the compressed-json codec, Drawing-block and ## Text Elements splicing, scene outlining, node/edge → scene
  excalidraw-tools.ts — The vault_excalidraw_* MCP tools (read / create / update / set_text)
  lock.ts     — Per-path async mutex; serializes read-modify-write so concurrent edits to one note can't interleave
  log.ts      — Configures the kit's audit logger for this vault (LOG_DIR default ./logs; redacts note-content arg fields) and re-exports the wired helpers
test/
  server.test.ts — HTTP checks for discovery, GET /mcp, POST initialize
  excalidraw-codec.test.ts / vault-excalidraw.test.ts — drawing format ops and the vault-layer write guards
```

## Running locally

```bash
bun install
MCP_CLIENT_ID=dev bun run src/server.ts
```

OAuth discovery: `GET /.well-known/oauth-authorization-server`
Token endpoint: `POST /token`
MCP endpoint: `POST /mcp` (requires Bearer token)

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MCP_CLIENT_ID` | yes | OAuth client ID |
| `MCP_CLIENT_SECRET` | no | Optional OAuth client secret. If set on the server, clients must send the same `client_secret` to `/token`. If unset, PKCE-only clients can sign in without one. |
| `APPROVAL_PASSWORD` | yes\* | Password for the OAuth approval page: `/authorize` requires it before issuing a code. \*The server refuses to start with the approval path unguarded; this, `MCP_CLIENT_SECRET`, or `APPROVAL_OPEN=true` satisfies that check. |
| `APPROVAL_OPEN` | no | Set `true` to allow the click-to-approve approval page when a reverse proxy / zero-trust gateway already guards `/authorize`. Satisfies the startup guard in place of an approval password. |
| `MCP_BASE_URL` | yes (prod) | Public **site** URL (scheme + host, no `/mcp`). Used in OAuth discovery as the protected `resource` |
| `MCP_CLIENT_ALLOWED_REDIRECT_URIS` | no | Comma-separated allowlist of OAuth redirect URIs for the configured client. Defaults to Claude's callback URI. |
| `MCP_DCR_ENABLED` | no | `true` opens `/register` so clients that can't be pre-configured (e.g. ChatGPT) register themselves. The approval password stays the gate, so requires `APPROVAL_PASSWORD`. Default off. |
| `MCP_DCR_ALLOWED_REDIRECT_URIS` | no | Optional hardening for DCR: allowlist of callbacks self-registering clients may use (exact or host-scoped `https://host/*`). Setting it also enables DCR. |
| `VAULT_PATH` | no | Absolute vault root; overrides Obsidian config when set |
| `OBSIDIAN_VAULT_ID` | when multiple vaults | Which `vaults` entry in `obsidian.json` to use (matches id case-insensitively) |
| `VAULT_DISPLAY_NAME` | no | Optional label shown on the OAuth approval page. Defaults to the resolved vault directory name. |
| `VAULT_CONTEXT_PATH` | no | Relative path for the note returned by `vault_context`. Defaults to `AGENTS.md`, then `CLAUDE.md`. |
| `DAILY_NOTE_PATH_TEMPLATE` | no | Daily-cadence path template for `vault_periodic_note`. Defaults to `Daily/{YYYY}-{MM}-{DD}.md`. |
| `WEEKLY_NOTE_PATH_TEMPLATE` | no | Weekly-cadence path template. Opt-in; `period: weekly` errors until set. |
| `MONTHLY_NOTE_PATH_TEMPLATE` | no | Monthly-cadence path template. Opt-in; `period: monthly` errors until set. |
| `QUARTERLY_NOTE_PATH_TEMPLATE` | no | Quarterly-cadence path template. Opt-in; `period: quarterly` errors until set. |
| `YEARLY_NOTE_PATH_TEMPLATE` | no | Yearly-cadence path template. Opt-in; `period: yearly` errors until set. |
| `RESOLVE_INDEX_TTL_MS` | no | How long the bare-title → path resolver index is cached, in ms. Defaults to `30000`. Lower it if notes are created outside the server and must resolve by title immediately. |
| `WEB_CLIPPER_SETTINGS_PATH` | no | Path to the Obsidian Web Clipper settings JSON used by `vault_clip_url` (vault-relative or absolute). Unset, the server looks for `*obsidian-web-clipper-settings*.json` in the vault. |
| `VAULT_ATTACHMENT_MAX_BYTES` | no | Max bytes `vault_read_attachment` will read before rejecting. Defaults to `10485760` (10 MB). |
| `CORS_ALLOWED_ORIGINS` | no | Comma-separated browser origin allowlist. Defaults to `*`. |
| `TOKEN_STORE_PATH` | no | Path to the persisted bearer token store. Defaults to `./tokens.json`. |
| `LOG_ENABLED` | no | Set to `false` to disable tool-call logging and skip registering `vault_feedback`. Defaults to `true`. |
| `LOG_DIR` | no | Directory for JSONL logs (`tool-calls.jsonl`, `feedback.jsonl`). Defaults to `./logs`. Created on first write. Skipped when `VAULT_MCP_TEST=1` or `LOG_ENABLED=false`. |
| `MCP_STATIC_BEARER_TOKEN` | no | Optional fixed secret: requests to `/mcp` with `Authorization: Bearer <same value>` are allowed (for clients that cannot use browser OAuth). Long random string; use HTTPS. Works alongside normal OAuth tokens. |
| `VAULT_READ_ONLY` | no | Set to `true` to block all write operations (create, update, edit, move, trash) |
| `HEALTH_TOKEN` | no | Dedicated bearer for `GET /health`. Default-closed: unset → the route 404s. Sent as `Authorization: Bearer`; separate from the OAuth and static-bearer secrets. |
| `HOST` | no | Bind address (default: `0.0.0.0`, so the port is reachable inside a container). Set `127.0.0.1` when running directly on a host behind a local proxy. In Docker, restrict the published port instead — `"127.0.0.1:3456:3456"`. |
| `PORT` | no | HTTP port (default: `3456`) |

## Claude.ai custom connector (plain checklist)

1. **Public URL** — In Claude, set the connector to your MCP endpoint, e.g. `https://your-domain.com/mcp` (include `https://`).

2. **`MCP_BASE_URL`** — In your server env, set this to the **same host** as that URL, **without** the `/mcp` path — e.g. `https://your-domain.com`. Do **not** point it at a different subdomain or path than the site users use for the connector; OAuth clients compare this to the connector URL.

3. **Client ID / secret** — Set `MCP_CLIENT_ID` to the connector's client ID. `MCP_CLIENT_SECRET` is optional, but if you set it on the server, Claude must send the same value.

4. **After changing env** — Redeploy or restart the container so discovery (`/.well-known/...`) returns the new `resource` value.

`GET /mcp` returns **405** (not 404) so streamable-HTTP clients that probe for SSE know this server only answers MCP on **POST**.

## Notes

- The server is stateless — a fresh `McpServer` and transport are created per request. This is intentional and correct for this use case.
- **Concurrent edits to the same note** are handled in two layers. (1) A per-path async mutex (`lock.ts`, `withPathLock`) wraps every write that touches existing content (`appendNote`, `prependToNote`, `replaceInNote`, `editNoteSection`, `setFrontmatterProperty`, `updateNote`) so two tool calls on the same note can't interleave. Different notes never block each other. (`appendNote` takes the lock too — `O_APPEND` is atomic against other appends, but not against a read-modify-write writer that read the file before the append landed.) (2) Optimistic versioning: `vault_read` returns a content-addressed `version` (a hash of the note text, `versionOf`). `vault_update` accepts that version as `base_version`; if the note changed since the caller read it (or was deleted), the update is rejected with a `ConcurrentEditError` ("re-read and reapply") instead of silently overwriting the other session's edit. Omitting `base_version` keeps the old last-writer-wins overwrite. (A fuller version that auto-merges non-overlapping concurrent edits via line-based diff3 lives on the `archive/concurrent-edit-diff3-merge` branch.)
- **Note writes are atomic.** Every truncating write (`writeNote`, `updateNote`, `prependToNote`, `replaceInNote`, `editNoteSection`, and the move/rename link rewrite) goes through `atomicWriteFile`: content is written to a hidden temp file in the same directory, fsynced, then renamed over the target. A same-directory rename is atomic on POSIX, so a reader — Obsidian, Obsidian Sync, another tool call — never sees a half-written or zero-length file. The target's mode is preserved across the inode swap, and the temp file is removed on any failure. `appendNote` deliberately stays on `O_APPEND` — append never truncates, so it can't produce the partial-file corruption atomic-rename guards against.
- If `VAULT_PATH` is unset, the server reads `.config/obsidian/obsidian.json` (walks up from cwd and from the package directory). With a single vault entry that has a `path`, that path is used; with several, set `OBSIDIAN_VAULT_ID` to the vault id. If neither config nor `VAULT_PATH` is available, startup fails.
- The OAuth approval page uses `VAULT_DISPLAY_NAME` when set, otherwise the resolved vault directory name.
- Allowed OAuth redirect targets come from `MCP_CLIENT_ALLOWED_REDIRECT_URIS`, defaulting to Claude's callback URI.
- `vault_context` reads `VAULT_CONTEXT_PATH` when set, otherwise falls back to `AGENTS.md` and then `CLAUDE.md` if present. It also appends a folder-only tree of the vault (default depth 3, configurable per call via `max_depth`; pass 0 to skip). The tree honours `.mcpignore` and skips dotfiles. Subtrees at each level are walked in parallel, and the whole tree is bounded by a 1.5s timeout — if it can't finish in time the context note is returned without the tree.
- `vault_periodic_note` reads or creates a note for a `period` (`daily`, `weekly`, `monthly`, `quarterly`, `yearly`), each driven by its own path template env var (`DAILY_NOTE_PATH_TEMPLATE`, `WEEKLY_NOTE_PATH_TEMPLATE`, and so on). Supported tokens `{YYYY}`, `{YY}`, `{GGGG}`, `{GG}`, `{WW}`, `{Q}`, `{MM}`, `{M}`, `{DD}`, `{D}`, `{MMM}`, `{MMMM}`, `{dd}`, `{ddd}`, and `{dddd}`. Only `daily` has a built-in default; other cadences return an error naming their env var until it is set.
- CORS defaults to `*`, but `CORS_ALLOWED_ORIGINS` can restrict browser access to specific origins like `https://claude.ai`.
- All vault paths are validated against the resolved vault root to prevent directory traversal.
- **Dotfiles and dot-directories are not addressable.** The walks always skipped names beginning with a dot, but `resolveSafePath` did not, so `.trash/` (deleted notes), `.obsidian/plugins/*/data.json` (plugin API keys) and `.mcpignore` itself were readable — and writable — by direct path while being invisible to search. `resolveSafePath` now rejects any dot-segment, on both the lexical and the canonical path, with a `VaultPolicyError` of kind `dotfile`. The server's own `.trash` moves and atomic-write temp files build their paths directly and are unaffected. Note this also means `VAULT_CONTEXT_PATH` can no longer point inside a dot-directory.
- **`vault_trash` moves to `<vault root>/.trash`, and under a subpath mount that is not Obsidian's trash.** `trashNote` builds the path from `getVaultRoot()`, so when the container mounts one folder of the vault at `/vault` the trash lands in `AI/.trash/` rather than the vault's real `.trash/`. Three consequences, and they are mostly good. The deletion still propagates to every device — the sync client's `walkLocalFiles` no longer sees the note, so it deletes the remote copy. The trashed copy does **not** propagate: that walker skips any entry whose *basename* starts with a dot, at every level, before it recurses, so it never descends into `.trash` at all (this is the walker, not `_allowSyncFile`, which tests whole paths and never gets the chance). And the agent cannot undo its own deletion, because `resolveSafePath` rejects dot-segments — a deliberate asymmetry worth keeping: the user can restore, the agent cannot. The cost is discoverability. Obsidian's Deleted Files pane reads the vault root's `.trash`, so it will not list these, and recovery means reaching the NAS filesystem. Nothing is lost; it is just not where anyone would look first.
- Place a `.mcpignore` file in the vault root to block specific paths from MCP access. One relative path pattern per line; lines starting with `#` are comments. Trailing slashes are stripped — `03-Records/Journaling` blocks that folder and everything inside it. Matching folds case and normalizes to NFC: on macOS and SMB shares `private/journal.md` reaches the same file as `Private/Journal.md`, so an exact comparison could be bypassed by respelling the path. On a case-sensitive volume this can over-block two folders differing only in case, which is the intended direction to err.
- **Path containment resolves symlinks.** `resolveSafePath` checks twice: lexically (catching `../`, and the only check possible for a file that doesn't exist yet), then canonically against `realpath` of the deepest existing ancestor. Without the second check any symlink inside the vault satisfied "inside the vault root" while the read or write followed it anywhere on the host. The `.mcpignore` test runs on the canonical relative path too, so a link into an ignored folder is tested by where it lands. Symlinks that stay inside the vault keep working; `walkVaultFiles` skips symlinks entirely, so bulk searches never read through one.
- Tokens persist to `TOKEN_STORE_PATH` (default `./tokens.json`) and expire after 30 days.
- When logging is enabled (default), every tool call is recorded to `LOG_DIR/tool-calls.jsonl` with `{ ts, tool, args, ok, duration_ms, error? }`. The `error` field captures the suggestion text returned to the client on `isError` responses, so review can show both the failure and what the agent was told to try next.
- **Error text is a logging surface, not just an agent-facing one.** The kit's `registerLogged` writes the first content block of an `isError` result *and* the `.message` of any exception thrown out of a handler. Anything either of those carries lands on disk, which is why `AmbiguousHeadingError` keeps its section previews out of `message` (they go to the agent in a second content block via `candidatesText()`) and why `parseFrontmatter` re-throws js-yaml failures as `FrontmatterParseError` with the reason and line number only — js-yaml's own message quotes the offending source line back. Any new error message built from note text must do the same.
- Args are summarized before logging: strings over 80 chars become `<str:Nchars>`, and the fields `content`, `value`, `template`, and `find` are always redacted to `<redacted:Nchars>` regardless of length so note bodies and frontmatter values never land on disk. Tool names, paths, and structural args remain visible.
- Agents can call `vault_feedback` to log a structured note when they get stuck or want a tool that doesn't exist; entries land in `LOG_DIR/feedback.jsonl`. The tool is only registered when logging is enabled. Feedback fields (`goal`, `attempted`, `stuck_on`, `suggested_tool`) are agent-authored and stored verbatim.
- No automatic rotation — log files grow forever. Mount `LOG_DIR` as a persistent volume in production and rotate or truncate manually if size becomes a concern.
- Set `LOG_ENABLED=false` to disable both — useful for forks that don't want disk writes recording agent activity, or for ephemeral deployments without a persistent volume.
- `setFrontmatterProperty` (and the `vault_set_frontmatter_property` tool) does a textual single-key splice on the frontmatter block instead of round-tripping the whole block through js-yaml. Untouched keys keep their on-disk byte form — including bare `YYYY-MM-DD` dates (which the YAML parser would otherwise normalize to full ISO datetimes), quoting style, key order, blank lines, and comments. JSON-shaped frontmatter (`---\n{ ... }\n---`) falls back to parse-and-reserialize, which converts to YAML — matching Obsidian's own behavior documented at `help.obsidian.md/properties#JSON+properties`. Values that arrive as JSON-stringified arrays or objects (e.g. from a client whose schema lost the array shape) are defensively parsed back; literal strings that happen to start with `[` or `{` but aren't valid JSON pass through unchanged.
- `vault_search_frontmatter` finds notes by a frontmatter property. `match_type` is `exact` (equals), `contains` (case-insensitive substring), or `exists` (property present, value ignored). For a list-valued property the predicate runs per element, so it is real membership — `exact: draft` matches `tags: [draft, idea]` — rather than a substring test against the stringified list. A property js-yaml parsed into a `Date` (an unquoted ISO-8601 scalar like `2026-01-15`) is matched by its `YYYY-MM-DD` UTC calendar date, not the timezone-shifted `String(Date)` form, so `exact: 2026-01-15` matches and the day never drifts; non-ISO date conventions stay plain strings and match verbatim. It is a single stateless walk that parses each note's frontmatter, keeping the per-request, no-index design. Every search/index/scan in `vault.ts` (content, filename, title, frontmatter, tags, the resolver and link-graph indices, rewrite-target collection) shares one traversal — `walkVaultFiles` — which skips dotfiles, honours `.mcpignore`, and reads `.md` by default, so the ignore policy is enforced in one place for all of them.
- `vault_batch_read` reads several notes in one call (paths or bare titles, resolved like `vault_read`); entries that can't be resolved are reported under "missing" without failing the rest. `include_content: false` returns only each note's frontmatter, for cheap triage before opening bodies. `vault_batch_frontmatter_update` sets frontmatter on several notes; each note's fields are applied in one locked read-modify-write via `setFrontmatterProperties` — the multi-key generalization of `setFrontmatterProperty`, which now delegates to it so the splice + lock logic has one implementation. Both batch tools are per-item and non-transactional (one bad note is reported, the rest still run) and capped at 50 entries.
- The OAuth approval page must be guarded, and the server refuses to start otherwise: the kit's `createAuth` throws at construction (in `createApp`, so `server.ts` exits before listening) when the approval page is unguarded. Any one of three satisfies the check: `APPROVAL_PASSWORD` (a password on `/authorize`, compared constant-time, re-rendering the page with a 401 on a wrong guess), `MCP_CLIENT_SECRET` (which guards token exchange instead), or `APPROVAL_OPEN=true` (for deployments fronted by a reverse proxy / zero-trust gateway). There is no username — the password is the whole secret.
- **Excalidraw drawings are handled by `excalidraw.ts` / `excalidraw-tools.ts`, not the generic note tools.** The plugin stores a drawing as an ordinary `.md` note — `excalidraw-plugin: parsed` frontmatter, a `## Text Elements` section of plain-text labels, optional `## Element Links` and `## Embedded Files`, then a `%%`-hidden `## Drawing` block holding the scene as ```compressed-json. That payload is `LZString.compressToBase64` output re-wrapped into 256-character chunks joined by a **blank** line and trimmed; decoding strips `\n`/`\r` and decodes, so the wrapping is cosmetic on read but reproducing it exactly is what keeps a rewritten file byte-identical to a plugin-written one. `JSON.stringify(scene, null, '\t')` — tab indent — for the same reason. Verified byte-for-byte against every drawing in the reference vault under plugin 2.26.4.
- **Two invariants govern every drawing write.** (1) **Splice, never rebuild.** The wrapper carries state the scene JSON does not — Element Links, Embedded Files (vault image references *and* LaTeX), the note's own frontmatter, any prose. A writer that regenerates the file from a scene object silently deletes all of it, and also resurrects `isDeleted` strokes as live art. `spliceScene` replaces only the fenced payload; only `createDrawingMarkdown` builds a file from nothing. (2) **`## Text Elements` outranks the scene JSON.** On load `updateSceneTextElements()` copies text out of that section into the elements and recomputes their geometry with `refreshTextDimensions()`, so text written into the compressed scene while the section stays stale is discarded the next time the drawing opens. `writeDrawingScene` therefore refreshes the section, `setDrawingText` edits *only* the section (the blob is never decoded — the safest edit available), and `outlineScene` takes a `textOverrides` map so reads apply the same precedence a write does. The overlay is applied at outline time rather than inside `readScene`, so the scene handed back stays exactly what is on disk and a no-op write remains byte-identical.
- **The `## Text Elements` section ends where its last anchor ends, not at the next heading.** Two naive terminators corrupt files. Searching for `\n##? ` cannot match at offset 0 — which is exactly an *empty* text list, what the plugin emits for any drawing with no labels (an annotated screenshot, an unlabelled sketch) — so the bounds ran into the following section and a write deleted `## Embedded Files`, `## Element Links`, or the `%%` that hides the scene. And a generic heading search also stops at a *label* whose line begins `## `, hiding every later label and duplicating them on the next write. `textElementsBounds` therefore limits on the wrapper's own structural sections only (`/m`-anchored, so offset 0 matches) and derives the true end from the last entry anchor. It matches `# Text Elements` as well as `##`, because `drawingRegex` already tolerates `# Drawing` and a mismatch there makes `syncTextElements` a silent no-op while the scene is rewritten anyway.
- The anchor cursor advances a fixed 12 characters (`advancePast`), not `lastIndex`: one whitespace + `^` + the 8-char id + the two newlines the plugin's writer always emits. Newlines beyond those two belong to the *next* entry's text, so `lastIndex` silently drops a leading blank line from every following label. Clamped with `min()` so a hand-edited single-newline separator degrades rather than over-advancing.
- `assertSafeElementText` runs `ANCHOR_SCAN()` over `` `${text}\n` `` rather than a `$`-anchored test, because the text is always written followed by a newline. A `$` anchor catches only a *trailing* `^block-reference` and misses an interior one, which splits a single entry in two — the leading line is dropped and a phantom block reference is left in the note. Reusing the parser's own regex keeps the guard from drifting from what it protects.
- **The outline names every connection endpoint by id, not by label, and marks the ones it guessed.** Labels are not unique — the reference vault has drawings where `transaction` and `book Expenses` each name several distinct boxes, and a label-only rendering left 68% of one drawing's edges unresolvable and two of seven drawings not reconstructible from tool output at all. Endpoints therefore print as `[id] "label"`, matching the id-first shape of the `Shapes:` lines so the two sections can be read against each other. An endpoint recovered by the geometric fallback rather than a stored binding is suffixed `~inferred`, with the marker explained in the section header: that arrow has no binding, will not follow its shape when dragged, and the connection is this module's reading of the picture rather than something the file asserts.
- **The outline escapes a label's line breaks as `\n` rather than collapsing them to spaces.** The outline is where an agent reads a label before handing it back to `vault_excalidraw_set_text`, whose `content` takes `\n` for a break — so collapsing here made the round trip silently flatten every two-line label. That is the worst shape of bug this tool can have: a write that reports success, changes something the caller never asked to change, and looks like a no-op in the only diff they can see.
- **The outline prints two ids per labelled element**, `[shape]` and `(text <id>)`, because `setDrawingText` keys on the *text* element and a container's id is a different 8-character string — so printing only the container's id handed agents an id that could never match while sailing past the schema's length check. `vault_excalidraw_set_text`'s error names the right one.
- `buildSceneFromSpec` refuses duplicate node keys and self-edges instead of proceeding. Both were silent-wrong: a duplicate key kept the first node, so every box was still drawn but the duplicate could never be reached by an arrow, and a self-edge drew an arrow backwards through its own box with both bindings on one element and the arrow listed twice in its `boundElements`. Same message discipline as the unknown-endpoint error — indices in `.message`, caller-supplied keys in `detail`.
- `vault_excalidraw_update` is annotated `destructiveHint: true`. It replaces the whole scene, so images, embeds, frames and freehand strokes are discarded — the *note* is preserved (frontmatter, prose, Element Links, Embedded Files) but the canvas is not, and the tool description says so rather than implying otherwise.
- The geometric endpoint fallback excludes frames and tie-breaks on area. A frame spans the canvas, and the rectangular-distance formula correctly scores 0 for a point inside it, so a single frame otherwise collapsed every unbound arrow onto itself. Text whose `containerId` names a deleted element is listed under `Text:` as `(container missing)` rather than being skipped by both the label pass and the loose-text pass and vanishing from the outline entirely.
- `syncTextElements` preserves the on-disk order of entries already present and appends only new ones. The plugin's section order is not scene order — rewriting in scene order reorders same-text entries on 2 of the 7 reference drawings, producing a diff, and an Obsidian Sync replication to every device, for a write that changed nothing.
- Text element ids must be exactly 8 block-ref-safe characters and must equal their `^anchor`: the section parser is `/\s\^(.{8})[\n]+/g`, so a 7- or 9-character id shifts the cursor and eats into the *next* element's text. `newElementId` mints 8 characters and dedupes within the scene.
- `buildSceneFromSpec` takes a node/edge description rather than raw `elements[]`, because Excalidraw's `restore()` repairs only *one* of the bookkeeping obligations: a text container is recovered from `containerId`, but a missing arrow entry in a shape's `boundElements` is not — the arrow simply detaches the first time the shape is dragged. Layout, ids, both binding directions and the back-references are all derived. Text sizing is approximate (real metrics need a DOM) and is corrected by the plugin on first open, so it affects box padding only.
- **Layout correctness is not format correctness, and only rendering finds the difference.** `buildSceneFromSpec`'s first version drew every edge as a straight line between the two shapes' facing edges. That parses, round-trips and passes every format test — and draws a layer-skipping arrow straight through whatever sits in the gap, which reads as touching it, so the diagram asserts a relationship that does not exist. Two passes prevent it: a barycentre sweep orders each layer near the average position of its predecessors (one sweep, in dependency order — iterating to a fixed point can oscillate on a cyclic graph, and the sort is stable so declaration order still decides where nothing points at a node), and `clearanceWaypoints` bends any edge spanning more than one layer around the intervening band. **Two** waypoints, not one: a single mid-path bend still leaves the diagonal approach legs clipping the boxes nearest each end (verified — `A→E` over `B,C,D` crossed 2 boxes with one bend, 0 with two). Adjacent-layer edges stay straight, because a needless bend reads as meaningful. A routed edge's label rides the detour; the straight-line midpoint is inside the box the arrow was routed around. `test/excalidraw-codec.test.ts` pins this with a geometric crossing check over five graph shapes in both directions.
- Text sizing here is an approximation (real metrics need a DOM) and the plugin corrects it on first open — confirmed live: a two-line label written as `104 × 25` came back from Obsidian's own save as `112.1 × 50`. It affects box padding only, never correctness.
- Drawing tool payload arguments are all named `content` deliberately: `REDACTED_FIELDS` in `log.ts` already lists that name, so scene JSON and drawing text are recorded as `<redacted:object>`. Renaming them to `scene` or `spec` would silently start writing note content to `logs/tool-calls.jsonl`. The same discipline applies to error text — `DrawingSpecError` keeps caller labels out of `.message` and carries them in a separate `detail` field the tool layer returns as a second content block.
- **Drawing writes race Obsidian itself, not just other MCP callers — but the plugin reconciles rather than clobbers.** `ExcalidrawFileManager.modifyEventHandler` is wired to `vault.on("modify")`, so an external write to an open drawing always reaches it; the plugin's own saves set a `preventReload` semaphore to skip themselves, and ours, being external, do not — but that flag is a 2000 ms window (`PREVENT_RELOAD_TIMEOUT`), not a tag on a particular write, so an external write whose modify event lands inside it is consumed as though it were the plugin's own: neither reloaded nor merged, and then overwritten by the next autosave. It then branches on how recently that view saved. Past `3e5` ms — five minutes — with no `MarkdownView` of the same file focused, it does a hard `reload(true, file)` and the on-disk write wins outright — unless `reload()` finds `semaphores.saving` already true, in which case it returns early and the external change is simply lost. Inside that window it calls `synchronizeWithData()`, which re-reads the file through the same `loadData(…, getTextMode(n))` path that gives `## Text Elements` its precedence, merges, and force-flushes an autosave if the view is dirty. So the ordinary case for an agent write — a drawing sitting open in a background tab — is safe, and the real hazard is narrow: a drawing being *actively edited right now*. `autosaveIntervalDesktop` is 60000 ms, but an active dirty view re-arms its timer at 1000 ms. `withPathLock` and `atomicWriteFile` defend against none of this; `base_version` (via `versionOf` over the whole file text) is the honest mitigation, converting the race into a rejected write instead of a lost one. Verified against plugin 2.26.4.
- **`synchronizeWithData` merges element-wise by `id`, resolved on Excalidraw's monotonic `version` counter.** The incoming on-disk element wins iff `disk.version > memory.version`, or the versions match and the serialized element differs; otherwise the in-memory element stands. Ids the in-memory scene lacks are inserted; ids the incoming data lists in `deletedElements` are dropped. Two consequences, opposite in sign. `setDrawingText` usually survives, and it is worth knowing why it is narrow rather than robust: it edits only the markdown, and `loadData`'s `updateSceneTextElements` folds that text into the incoming element *without bumping its `version`*, so the tie breaks on "versions equal, serialization differs" and disk wins. If the user has touched that same element in the open view its in-memory `version` is now higher, neither branch fires, and the text edit is silently discarded. It is still the safest write available — just not unconditional. `writeDrawingScene` is *not*: elements present in memory but merely **omitted** from the replacement scene are never matched and never deleted, so a whole-scene replace against a recently-saved open view can union the old canvas with the new one instead of replacing it. This is why `writeDrawingScene` runs the replacement through `tombstoneRemoved` first: every element the new scene drops is written back carrying `isDeleted: true` and a bumped `version`, so the merge sees a deletion instead of an absence. Already-dead elements pass through untouched and an unchanged element set returns the scene object itself, so a no-op write stays byte-identical. Closing the drawing first, or passing `base_version` and taking the rejection, is still the stronger move. And note what the merge path does *not* refresh: `save()` rebuilds the note's header from `this.data`, which only `reload()` ever re-reads, so an external edit to a drawing's frontmatter or prose is silently reverted the next time an open view saves. `vault_set_frontmatter_property` on an open drawing is therefore as unsafe as a scene write, despite touching none of the scene.
- The plugin keeps a per-save backup, but it is not a vault-level one and must not be relied on as a safety net for external writers. On each save the *previous* `lastSavedData` is stashed via `getImageCache().addBAKToCache(path, data)` into an IndexedDB object store, and only when the scene had elements. Recovery is always prompted, never automatic: `BACKUP_AVAILABLE` on a load failure, and `BACKUP_SAVE_AS_FILE` when a drawing loads with zero elements and the stashed copy is longer than what is on disk — which is exactly the shape a corrupted `compressed-json` block takes. It lives in one device's browser profile, covers only drawings that device has opened and saved, and does not sync. A local undo, not a backup.
- **Both sync paths merge Excalidraw drawings as text, and that is the largest standing risk to a drawing.** Obsidian Sync's own conflict resolution defaults to "Automatically merge", which for Markdown means Google's diff-match-patch; `.canvas` files are explicitly excluded and get last-modified-wins instead, but an Excalidraw drawing is a `.md` file, so it lands in the character-merge bucket with no such protection. The headless client (`CONFLICT_STRATEGY`, default `merge`) runs the same algorithm class. Interleaving two LZString base64 payloads character-by-character is not a merge in any meaningful sense. The failure that matters is not the loud one — a payload that fails to decompress surfaces an error and can reach the backup prompt — but the quiet one, where the merged base64 still decodes into structurally valid JSON with a plausible element count, so nothing throws, no prompt fires, and the drawing is simply wrong. Set conflict resolution to "Create conflict file" (`CONFLICT_STRATEGY=conflict` on the headless side): a `(Conflicted copy …)` note is recoverable, a character-merged scene is not. Obsidian Sync version history — one month on Standard, twelve on Plus, and drawings count as notes — is the only recovery path that is actually off-device.
- `editNoteSection` and `readNoteSection` are asymmetric on duplicate headings, by design. **Writes refuse to guess**: `editNoteSection` throws an `AmbiguousHeadingError` (carrying every match's line number and a one-line preview) and points the caller at `vault_edit` with a find-anchored `replace` on text unique to the target section. **Reads return everything**: `readNoteSection` joins all matching sections with `<!-- match N of M (line X) -->` labels so the agent can tell candidates apart. The asymmetry tracks the difference in stakes — a write to the wrong section is data loss; a read of all candidates is a couple extra tokens.

## CI and publishing

Two workflows, in `.github/workflows/`.

`ci.yml` runs on every push and pull request: install (with `frozenLockfile`, so a stale `bun.lock`
fails loudly), typecheck, `bun test`, and a documentation-drift check. The typecheck covers `src/`,
`scripts/` and `test/`; `@types/bun` is a devDependency so `bun:test` resolves, and the three
`TS2307`s from `web-clipper-headless` reaching for the uninstalled optional peer `obsidian-clipper/api`
are counted and ignored rather than hidden. `scripts/typecheck.ts` exists rather than an inline
`tsc | grep` because that form reports success when tsc cannot run at all — no output, no match, the
`||` branch fires — and a gate that passes when the checker is missing is worse than no gate. It deliberately does not
build the image — a Docker build is minutes that tell you nothing a failing test would not have
told you first, and CI only gets read if it stays fast. `bun audit` runs advisory-only, so a new
transitive advisory is visible without blocking an unrelated fix.

`publish.yml` runs CI first, then builds and pushes to GHCR tagged both `sha-<short>` and the branch
name, smoke-tests the published image by starting it and requiring `POST /mcp` to answer 401, and
then **repins `docker-compose.yml` and `.env.example` to the sha it just published**. That last step
is the point of the workflow. Every stale-image incident here has had the same shape: an image is
built and pushed, `docker compose pull` runs on the NAS, and nothing changes — because the compose
default and the `.env` pin still name an older sha. Publish and repin are one operation or they
drift. The repin commit is pushed with `GITHUB_TOKEN`, and pushes made with that token do not
trigger workflows, so it cannot loop.

`scripts/check-docs.ts` is what keeps this file honest. It fails when an environment variable is
read in `src/` but has no row in the table above, when a documented variable is no longer read, or
when a registered tool is missing from the roster below. Two scanning subtleties, both from real
misses: not every variable is read as `process.env.NAME` — the periodic-note templates live in a map
of string literals and are looked up indirectly — and a few names are genuinely internal, so they
are listed explicitly in `INTERNAL` rather than silently skipped.

## Tools

The full registered roster, 27 tools. `scripts/check-docs.ts` fails CI when a tool is registered
and missing here, so this list cannot quietly fall behind the code.

| Tool | Kind | What it does |
|------|------|--------------|
| `vault_context` | read | Vault context — the context note plus a folder tree |
| `vault_read` | read | Read a note in full, or list one folder level |
| `vault_batch_read` | read | Read several notes at once; `include_content: false` for triage |
| `vault_outline` | read | Heading outline of a note |
| `vault_read_section` | read | One section under a heading; returns every match when ambiguous |
| `vault_read_attachment` | read | Read a non-markdown attachment, capped by `VAULT_ATTACHMENT_MAX_BYTES` |
| `vault_frontmatter` | read | Parsed frontmatter for a note |
| `vault_links` | read | Outgoing links and backlinks |
| `vault_search_title` | read | Find notes by filename |
| `vault_search_content` | read | Full-text search across note bodies |
| `vault_search_frontmatter` | read | Find notes by a frontmatter property (`exact` / `contains` / `exists`) |
| `vault_tags` | read | List tags, or the notes carrying one |
| `vault_create` | write | Create a note; refuses to overwrite |
| `vault_update` | write | Replace a note's body; takes `base_version` |
| `vault_edit` | write | Find-and-replace within a note |
| `vault_edit_section` | write | Replace one section; refuses on an ambiguous heading |
| `vault_set_frontmatter_property` | write | Single-key frontmatter splice, preserving byte form |
| `vault_batch_frontmatter_update` | write | Frontmatter across several notes, per-item and non-transactional |
| `vault_move` | write | Move or rename, rewriting inbound links |
| `vault_trash` | write (destructive) | Move a note to `.trash` — see the subpath caveat above |
| `vault_periodic_note` | write | Read or create the note for a period |
| `vault_clip_url` | write | Clip a URL using a Web Clipper template |
| `vault_feedback` | write | Log a structured note when a tool is missing or stuck; needs `LOG_ENABLED` |
| `vault_excalidraw_read` | read | Drawing as outline / text / scene |
| `vault_excalidraw_create` | write | New drawing from a node-edge spec |
| `vault_excalidraw_update` | write (destructive) | Replace a whole scene; discards images, frames, freedraw |
| `vault_excalidraw_set_text` | write | Retitle one text element — the safest drawing write |

## Tests

```bash
bun test
```

Uses a temporary `VAULT_PATH` and `VAULT_MCP_TEST=1` (see `package.json` `test` script). Covers discovery metadata, `GET /mcp` → 405 with a valid token, and a minimal `POST ... initialize` MCP round-trip.

## Dependency advisories

`bun audit` runs in CI advisory-only, because a new advisory against a transitive dependency should
be visible without blocking an unrelated fix. It is not noise to be ignored, though — as of the last
sweep it reported eleven, and the two that mattered were direct and reachable:

- `js-yaml` 4.3.0 → **4.3.1**. Quadratic CPU consumption resolving `!!omap`. This server parses YAML
  frontmatter on every note read, so it was the one advisory sitting directly in a hot path.
- `hono` 4.12.32 → **4.13.3**. ReDoS in the CORS middleware via `Access-Control-Request-Headers`, on
  a service published to the internet through cloudflared.
- `ip-address` → pinned to **10.5.0** via `overrides`. Arrives through `express-rate-limit`; the
  high finding is an SSRF/trust-boundary bypass from decoding leading-zero octets as decimal.

Three remain, and all three are accepted deliberately rather than outstanding:

- `defuddle` (high) and `dompurify` (moderate) reach the lockfile through `web-clipper-headless`,
  which the Dockerfile installs with `--omit=optional` and therefore **does not ship**. Verified by
  installing the image's dependency set and confirming neither package is present.
- `@hono/node-server` is a path traversal **on Windows** via an encoded backslash. The image is
  Linux.

Worth knowing when reading that list: `bun audit` resolves against the lockfile, not against what a
given install actually produced, so it reports clipper packages even for a production install that
omits them. Checking `node_modules` is what settles whether an advisory is real for the deployment.

## Install policy

`bunfig.toml` gates installs. Don't remove it.

- New package versions younger than 3 days aren't eligible — defends against malicious-publish supply-chain attacks (the May 2026 npm incident and its family).
- `frozenLockfile = true` — commit `bun.lock` and never run `--no-frozen-lockfile` unless you have a reason.
  (`@types/bun` was added that way, deliberately: `bun add` cannot write the lockfile while the
  bunfig flag is set, and neither `--no-frozen-lockfile` nor `BUN_CONFIG_FROZEN_LOCKFILE=false`
  overrides it — the flag has to be flipped in `bunfig.toml` for the add and flipped back.)
- `exact = true` — `bun add <pkg>` saves the version without a caret.
