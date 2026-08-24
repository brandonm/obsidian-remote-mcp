// ABOUTME: Fails CI when the docs drift from the code — environment variables the server reads
// but AGENTS.md does not list, and MCP tools it registers but AGENTS.md does not mention.
//
// This exists because both kinds of drift are invisible in review. A new env var is added in one
// file and the table three hundred lines away in AGENTS.md stays as it was; nothing breaks, no test
// fails, and the only symptom is an operator who cannot find the knob. AGENTS.md is also the file
// loaded into an agent's context every session, so a gap there is a gap in what the agent knows
// about its own server.
//
// Two scanning subtleties, both learned from real misses in this repo:
//
//  1. Not every env var is read as `process.env.NAME`. The periodic-note templates live in a map of
//     string literals (`daily: 'DAILY_NOTE_PATH_TEMPLATE'`) and are looked up indirectly, so a scan
//     for `process.env\.\w+` reports five documented-but-unused false positives. Env-var-shaped
//     string literals are therefore collected too.
//  2. Some names are genuinely internal and should never appear in an operator-facing table.
//     Those are listed in INTERNAL below, explicitly, so that skipping one is a decision someone
//     wrote down rather than an oversight.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');
const DOC = path.join(ROOT, 'AGENTS.md');

// Read by the code but deliberately absent from the operator-facing table.
const INTERNAL = new Set([
  // Set by the test script, not by anyone running the server.
  'VAULT_MCP_TEST',
  // Standard, and not ours to document.
  'NODE_ENV',
]);

// Names that look like env vars in source but are not: enum members, header names, and so on.
// Kept empty on purpose — add here only with a reason, since every entry is a hole in the check.
const NOT_ENV_VARS = new Set<string>();

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const sources = walk(SRC).map(f => ({ file: path.relative(ROOT, f), text: readFileSync(f, 'utf-8') }));
const doc = readFileSync(DOC, 'utf-8');

// --- Environment variables ---------------------------------------------------

const envUsed = new Map<string, string>(); // name -> first file it appears in
for (const { file, text } of sources) {
  // Direct reads.
  for (const m of text.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) {
    if (!envUsed.has(m[1]!)) envUsed.set(m[1]!, file);
  }
  for (const m of text.matchAll(/process\.env\[\s*['"`]([A-Z_][A-Z0-9_]*)['"`]\s*\]/g)) {
    if (!envUsed.has(m[1]!)) envUsed.set(m[1]!, file);
  }
  // Indirect: an env-var-shaped string literal, which is how the periodic-note templates are
  // referenced. Requires an underscore so single-word constants like 'GET' are not swept up.
  for (const m of text.matchAll(/['"`]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)['"`]/g)) {
    if (!envUsed.has(m[1]!)) envUsed.set(m[1]!, file);
  }
}

// The table rows look like: | `VAULT_PATH` | no | ... |
const envDocumented = new Set(
  [...doc.matchAll(/^\|\s*`([A-Z_][A-Z0-9_]*)`/gm)].map(m => m[1]!),
);

const problems: string[] = [];

for (const [name, file] of [...envUsed].sort()) {
  if (INTERNAL.has(name) || NOT_ENV_VARS.has(name)) continue;
  if (!envDocumented.has(name)) {
    // Only flag names that are actually reached through process.env somewhere; a bare string
    // literal on its own is not evidence of an env var.
    const reallyEnv = sources.some(
      s =>
        s.text.includes(`process.env.${name}`) ||
        new RegExp(`process\\.env\\[[^\\]]*${name}`).test(s.text) ||
        // The indirect map case: the literal exists AND something indexes process.env dynamically.
        (s.text.includes(`'${name}'`) && /process\.env\[/.test(s.text)),
    );
    if (reallyEnv) problems.push(`env: ${name} is read in ${file} but has no row in AGENTS.md`);
  }
}

for (const name of [...envDocumented].sort()) {
  if (!envUsed.has(name)) {
    problems.push(`env: ${name} is documented in AGENTS.md but never read in src/`);
  }
}

// --- MCP tools ---------------------------------------------------------------

const toolsRegistered = new Set<string>();
for (const { text } of sources) {
  for (const m of text.matchAll(/registerLogged\(\s*\w+\s*,\s*['"`](vault_[a-z0-9_]+)['"`]/g)) {
    toolsRegistered.add(m[1]!);
  }
}

for (const name of [...toolsRegistered].sort()) {
  if (!doc.includes(name)) {
    problems.push(`tool: ${name} is registered but never mentioned in AGENTS.md`);
  }
}

// --- Report ------------------------------------------------------------------

if (problems.length > 0) {
  console.error(`docs check failed — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    '\nUpdate AGENTS.md (CLAUDE.md is a symlink to it). If a name is genuinely internal,\n' +
      'add it to INTERNAL in scripts/check-docs.ts with a reason rather than deleting the check.',
  );
  process.exit(1);
}

console.log(
  `docs check passed — ${envUsed.size} env names scanned, ` +
    `${envDocumented.size} documented, ${toolsRegistered.size} tools registered.`,
);
