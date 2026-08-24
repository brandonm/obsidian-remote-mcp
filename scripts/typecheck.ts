// ABOUTME: Typecheck src/ and scripts/, ignoring diagnostics that belong to dependencies.
//
// The filtering is unavoidable: web-clipper-headless is a git dependency whose TypeScript sources
// are compiled as part of our program, and it imports `obsidian-clipper/api`, an optional peer that
// is not installed. Those TS2307s are not ours and cannot be fixed from here.
//
// The filtering is also where the obvious one-liner goes wrong. This started life as
//
//     bun x tsc --noEmit -p . 2>&1 | grep -E '^(src|test)/' && exit 1 || echo ok
//
// which reports success when tsc cannot run at all: the pipeline produces no output, grep matches
// nothing, and the `||` branch fires. A gate that passes when the checker is missing is worse than
// no gate, because it is trusted. Hence a script that separates "tsc found nothing wrong with our
// code" from "tsc never ran".
//
// test/ is deliberately out of scope: `bun:test` needs bun-types, which is not a dependency here,
// so including it would report a TS2307 for every test file. The tests are covered by running
// them. Adding bun-types would let this cover them too — a lockfile change, so not done casually.
import { spawnSync } from 'node:child_process';

const OURS = /^(src|scripts)\//;

const run = spawnSync(process.execPath, ['x', 'tsc', '-p', '.'], {
  encoding: 'utf-8',
  cwd: new URL('..', import.meta.url).pathname,
});

if (run.error) {
  console.error(`typecheck: could not run tsc — ${run.error.message}`);
  process.exit(2);
}

const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
const lines = output.split('\n').filter(Boolean);

// A diagnostic line looks like `path/to/file.ts(12,34): error TS1234: ...`. If tsc produced output
// that contains no diagnostic-shaped lines at all AND exited non-zero, it failed for some other
// reason (bad config, missing binary, crash) and that must not read as a pass.
const diagnostics = lines.filter(l => /\.tsx?\(\d+,\d+\): (error|warning) TS\d+/.test(l));
if (run.status !== 0 && diagnostics.length === 0) {
  console.error(`typecheck: tsc exited ${run.status} without diagnostics — treating as failure`);
  console.error(output.trim() || '(no output)');
  process.exit(2);
}

const ours = diagnostics.filter(l => OURS.test(l));
const theirs = diagnostics.length - ours.length;

if (ours.length > 0) {
  console.error(`typecheck failed — ${ours.length} diagnostic(s) in src/ or scripts/:\n`);
  for (const l of ours) console.error(`  ${l}`);
  process.exit(1);
}

console.log(
  `typecheck passed — 0 diagnostics in src/ or scripts/` +
    (theirs > 0 ? `, ${theirs} ignored from dependencies` : ''),
);
