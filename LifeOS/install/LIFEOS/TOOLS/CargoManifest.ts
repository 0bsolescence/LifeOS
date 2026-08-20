/**
 * CargoManifest.ts — deterministic write-path for "land your cargo".
 *
 * The 2026-08-16 amnesia incident: a landing report was narrated in conversation and
 * never written to disk, so the next morning's summons read a two-day-old handoff file
 * as the freshest record. This tool makes the landing report a file, every time.
 *
 * Usage:
 *   bun LIFEOS/TOOLS/CargoManifest.ts <manifest.json>
 *   bun LIFEOS/TOOLS/CargoManifest.ts --latest        # print newest handoff by mtime
 *
 * manifest.json shape:
 * {
 *   "node": "l7440",
 *   "landed":       [{ "what": "wrenchmark rename/wrenchmark", "sha": "1f59b4a", "evidence": "pushed, 0 dirty" }],
 *   "checkpointed": [{ "what": "...", "resume": "path or command to resume from" }],
 *   "wedged":       [{ "what": "...", "last_known": "..." }],
 *   "waiting_on_principal": ["..."],
 *   "in_flight": "ONE line naming what's in flight"
 * }
 *
 * All three landing states render even when empty — an absent section is
 * indistinguishable from an unasked question, and that is the failure mode.
 * Postcondition printed: path, bytes, row counts. Exit 1 on any shortfall.
 */

import { readFileSync, writeFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const WORK = join(homedir(), ".claude", "LIFEOS", "MEMORY", "WORK");

interface Row { what: string; sha?: string; evidence?: string; resume?: string; last_known?: string }
interface Manifest {
  node: string;
  landed: Row[];
  checkpointed: Row[];
  wedged: Row[];
  waiting_on_principal: string[];
  in_flight: string;
}

function latest(): void {
  const files = readdirSync(WORK)
    .filter((f) => /^session-handoff-\d{8}\.md$/.test(f))
    .map((f) => ({ f, m: statSync(join(WORK, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (files.length === 0) { console.error("no handoff files"); process.exit(1); }
  console.log(join(WORK, files[0].f));
  process.exit(0);
}

function main(): void {
  const arg = process.argv[2];
  if (!arg) { console.error("usage: CargoManifest.ts <manifest.json> | --latest"); process.exit(1); }
  if (arg === "--latest") latest();

  const m: Manifest = JSON.parse(readFileSync(arg, "utf8"));
  for (const k of ["node", "landed", "checkpointed", "wedged", "waiting_on_principal", "in_flight"] as const) {
    if (m[k] === undefined) { console.error(`manifest missing required key: ${k}`); process.exit(1); }
  }

  const now = new Date();
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, "");
  const path = join(WORK, `session-handoff-${ymd}.md`);

  const rows = (rs: Row[], cols: (keyof Row)[]): string =>
    rs.length === 0
      ? "- (none)\n"
      : rs.map((r) => `- ${cols.map((c) => r[c]).filter(Boolean).join(" · ")}`).join("\n") + "\n";

  const body = [
    `# Cargo manifest — ${now.toISOString()} (${m.node})`,
    ``,
    `> Written by CargoManifest.ts. The three landing states below are exhaustive by`,
    `> construction: a raven absent from all three did not land and must be treated as`,
    `> WEDGED (idle-without-report doctrine — silence is a claim of nothing).`,
    ``,
    `## LANDED (complete, evidence in hand)`,
    ``,
    rows(m.landed, ["what", "sha", "evidence"]),
    `## CHECKPOINTED (incomplete, resume point on disk)`,
    ``,
    rows(m.checkpointed, ["what", "resume"]),
    `## WEDGED (no answer inside the deadline)`,
    ``,
    rows(m.wedged, ["what", "last_known"]),
    `## Waiting on the principal`,
    ``,
    m.waiting_on_principal.length === 0 ? "- (none)\n" : m.waiting_on_principal.map((w) => `- ${w}`).join("\n") + "\n",
    `## In flight`,
    ``,
    `${m.in_flight}`,
    ``,
  ].join("\n");

  writeFileSync(path, body);

  if (!existsSync(path)) { console.error("POSTCONDITION FAIL: file absent after write"); process.exit(1); }
  const bytes = statSync(path).size;
  if (bytes < 200) { console.error(`POSTCONDITION FAIL: ${bytes} bytes is too small to be a real manifest`); process.exit(1); }
  console.log(`WROTE ${path}`);
  console.log(`bytes=${bytes} landed=${m.landed.length} checkpointed=${m.checkpointed.length} wedged=${m.wedged.length} waiting=${m.waiting_on_principal.length}`);
}

main();
