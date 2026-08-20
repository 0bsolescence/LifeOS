/**
 * CargoManifest.ts — deterministic write-path for "land your cargo".
 *
 * The 2026-08-16 amnesia incident: a landing report was narrated in conversation and
 * never written to disk, so the next morning's summons read a two-day-old handoff file
 * as the freshest record. This tool makes the landing report a file, every time.
 *
 * Usage:
 *   bun LIFEOS/TOOLS/CargoManifest.ts <manifest.json>
 *   bun LIFEOS/TOOLS/CargoManifest.ts --latest                 # ACCEPT the newest open handoff
 *   bun LIFEOS/TOOLS/CargoManifest.ts --latest --peek          # read-only, mutates nothing
 *   bun LIFEOS/TOOLS/CargoManifest.ts --latest --accepted-by <node> --session <id>
 *
 * manifest.json shape (every list accepts plain strings OR objects):
 * {
 *   "node": "l7440",
 *   "from_node": "l7440",                 // optional; defaults to node
 *   "landed":       ["free text", { "what": "…", "sha": "1f59b4a", "evidence": "pushed, 0 dirty" }],
 *   "checkpointed": [{ "what": "…", "resume": "path or command to resume from" }],
 *   "wedged":       [{ "what": "…", "last_known": "…" }],
 *   "open_questions": ["…"],              // optional
 *   "next_steps":     ["…"],              // optional
 *   "files_touched":  ["…"],              // optional
 *   "waiting_on_principal": ["…"],
 *   "in_flight": "ONE line naming what's in flight"
 * }
 *
 * ============================================================================
 * THE HANDOFF LIFECYCLE (A1, 2026-08-20)
 * ============================================================================
 *
 * Modelled on ai-memory's Handoff protocol. Each manifest carries a typed state in
 * YAML frontmatter: open → accepted → (or) expired.
 *
 *   open      written, never consumed
 *   accepted  consumed by a summons; carries accepted_by / accepted_at / accepted_session
 *   expired   superseded by a newer handoff from the same node before anyone read it
 *
 * `--latest` is therefore an ACCEPT operation, not a peek: it returns the newest OPEN
 * manifest, marks it accepted, and expires every older open manifest from the same
 * node. A stale handoff can no longer shadow a newer one — the guarantee moves out of
 * doctrine ("read by mtime, not by filename") and into the schema, which is the
 * incident class LifeOS paid for on 2026-08-16.
 *
 * Backward compatibility: a manifest with no frontmatter is treated as `open`, and its
 * node is recovered from the `# Cargo manifest — <iso> (<node>)` heading. The eight
 * pre-lifecycle handoffs on disk therefore participate correctly on first run.
 *
 * Use `--peek` when you want to look without consuming (debugging, a second raven
 * cross-checking). `--peek` never writes.
 *
 * ============================================================================
 * WHY EMPTY ROWS ARE A HARD ERROR (bug fix, 2026-08-20)
 * ============================================================================
 *
 * session-handoff-20260820.md rendered ten empty "- " bullets under LANDED and six
 * under CHECKPOINTED. The input manifest passed those lists as arrays of STRINGS while
 * the renderer indexed each entry with object keys (what/sha/evidence) — every lookup
 * returned undefined, `.filter(Boolean)` dropped them all, and the join produced an
 * empty bullet. Ten landings were silently destroyed while the file still looked
 * well-formed.
 *
 * Two defences now: strings are accepted as first-class rows, and a row that carries
 * data but renders to nothing is a POSTCONDITION FAIL rather than a blank bullet.
 * Silent data loss in the record is the failure mode this whole tool exists to prevent.
 *
 * All three landing states render even when empty — an absent section is
 * indistinguishable from an unasked question, and that is the failure mode.
 * Postcondition printed: path, bytes, row counts. Exit 1 on any shortfall.
 */

import { readFileSync, writeFileSync, statSync, readdirSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname } from "node:os";

const HOME = process.env.HOME ?? homedir();
const WORK = process.env.LIFEOS_WORK_DIR ?? join(HOME, ".claude", "LIFEOS", "MEMORY", "WORK");

/**
 * Legacy `session-handoff-YYYYMMDD.md`, lifecycle `…-YYYYMMDD-HHMMSS.md`, and the
 * millisecond form used only to break a same-second collision, all match.
 */
const HANDOFF_RE = /^session-handoff-\d{8}(?:-\d{6}(?:\d{3})?)?\.md$/;

const FRONTMATTER_MARK = "pai-handoff-v1";

type State = "open" | "accepted" | "expired";

interface Row { what?: string; sha?: string; evidence?: string; resume?: string; last_known?: string }
type RowInput = string | Row;

interface Manifest {
  node: string;
  from_node?: string;
  landed: RowInput[];
  checkpointed: RowInput[];
  wedged: RowInput[];
  waiting_on_principal: string[];
  in_flight: string;
  open_questions?: string[];
  next_steps?: string[];
  files_touched?: string[];
}

interface Frontmatter {
  handoff?: string;
  node?: string;
  from_node?: string;
  created?: string;
  state?: string;
  accepted_by?: string | null;
  accepted_at?: string | null;
  accepted_session?: string | null;
}

interface Handoff {
  path: string;
  file: string;
  mtimeMs: number;
  fm: Frontmatter;
  body: string;
}

// ============================================================================
// Frontmatter — deliberately minimal, zero-dep. Flat `key: value` only.
// ============================================================================

function parseFrontmatter(raw: string): { fm: Frontmatter; body: string } {
  if (!raw.startsWith("---\n")) return { fm: {}, body: raw };
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return { fm: {}, body: raw };
  const fm: Frontmatter = {};
  for (const line of raw.slice(4, end).split("\n")) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!m) continue;
    const value = m[2].trim();
    (fm as Record<string, string | null>)[m[1]] = value === "" ? null : value;
  }
  return { fm, body: raw.slice(end + 5) };
}

function renderFrontmatter(fm: Frontmatter): string {
  const order: (keyof Frontmatter)[] = [
    "handoff", "node", "from_node", "created", "state", "accepted_by", "accepted_at", "accepted_session",
  ];
  const lines = order.map((k) => `${k}: ${fm[k] ?? ""}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

/** Recover the node of a pre-lifecycle handoff from its `# Cargo manifest — <iso> (<node>)` heading. */
function nodeFromHeading(body: string): string | null {
  const m = body.match(/^#\s+Cargo manifest\s+—\s+\S+\s+\((.+)\)\s*$/m);
  return m ? m[1].trim() : null;
}

function stateOf(h: Handoff): State {
  const s = h.fm.state;
  return s === "accepted" || s === "expired" ? s : "open";
}

function nodeOf(h: Handoff): string | null {
  return h.fm.from_node ?? h.fm.node ?? nodeFromHeading(h.body);
}

function listHandoffs(): Handoff[] {
  if (!existsSync(WORK)) return [];
  return readdirSync(WORK)
    .filter((f) => HANDOFF_RE.test(f))
    .map((f) => {
      const path = join(WORK, f);
      const raw = readFileSync(path, "utf8");
      const { fm, body } = parseFrontmatter(raw);
      return { path, file: f, mtimeMs: statSync(path).mtimeMs, fm, body };
    })
    // Newest first. Filename breaks mtime ties, because two manifests written in the
    // same millisecond still have a defined order on disk.
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file));
}

/** Rewrite one handoff's frontmatter. Temp-file + rename, so a reader never sees a half-written record. */
function writeState(h: Handoff, next: Frontmatter): void {
  const fm: Frontmatter = {
    handoff: FRONTMATTER_MARK,
    node: h.fm.node ?? nodeOf(h) ?? undefined,
    from_node: h.fm.from_node ?? nodeOf(h) ?? undefined,
    created: h.fm.created ?? new Date(h.mtimeMs).toISOString(),
    accepted_by: null,
    accepted_at: null,
    accepted_session: null,
    ...next,
  };
  const tmp = `${h.path}.tmp-${process.pid}`;
  writeFileSync(tmp, renderFrontmatter(fm) + h.body);
  renameSync(tmp, h.path);
}

// ============================================================================
// --latest: the ACCEPT operation
// ============================================================================

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function latest(): void {
  const peek = process.argv.includes("--peek");
  const all = listHandoffs();
  if (all.length === 0) { console.error("no handoff files"); process.exit(1); }

  const open = all.filter((h) => stateOf(h) === "open");

  if (open.length === 0) {
    // Every handoff has already been consumed. Still hand back the newest so a summons
    // is never blanked, but say plainly that it is not a fresh record.
    const newest = all[0];
    console.error(`WARN: no open handoff; returning newest (state=${stateOf(newest)}, accepted_by=${newest.fm.accepted_by ?? "—"})`);
    console.log(newest.path);
    process.exit(0);
  }

  const chosen = open[0];
  if (peek) {
    console.error(`PEEK: no state changed (${open.length} open, ${all.length} total)`);
    console.log(chosen.path);
    process.exit(0);
  }

  const acceptedBy = flag("--accepted-by") ?? process.env.LIFEOS_NODE ?? hostname();
  const acceptedAt = new Date().toISOString();
  const session = flag("--session") ?? process.env.CLAUDE_SESSION_ID ?? null;
  const chosenNode = nodeOf(chosen);

  // Older open manifests from the same node are exactly the shadowing hazard, so they
  // expire on accept. A manifest whose node cannot be determined counts as same-node:
  // an un-attributable stale handoff is the dangerous case, not the safe one.
  const superseded = open.slice(1).filter((h) => {
    const n = nodeOf(h);
    return n === null || chosenNode === null || n === chosenNode;
  });

  // Expire the older ones FIRST. If this run dies midway the accept has not happened,
  // so the next run still finds an open manifest and retries — a crash cannot leave
  // zero open records behind.
  for (const h of superseded) {
    writeState(h, { state: "expired" });
  }
  writeState(chosen, {
    state: "accepted",
    accepted_by: acceptedBy,
    accepted_at: acceptedAt,
    accepted_session: session,
  });

  // Postcondition: re-read from disk and assert the states actually changed.
  const after = listHandoffs();
  const chosenAfter = after.find((h) => h.path === chosen.path);
  if (!chosenAfter || stateOf(chosenAfter) !== "accepted") {
    console.error("POSTCONDITION FAIL: chosen manifest is not accepted after write");
    process.exit(1);
  }
  const stillOpen = superseded.filter((s) => {
    const a = after.find((h) => h.path === s.path);
    return !a || stateOf(a) !== "expired";
  });
  if (stillOpen.length > 0) {
    console.error(`POSTCONDITION FAIL: ${stillOpen.length} superseded manifest(s) did not expire`);
    process.exit(1);
  }

  console.error(`ACCEPTED by=${acceptedBy} at=${acceptedAt} expired=${superseded.length}`);
  console.log(chosen.path);
  process.exit(0);
}

// ============================================================================
// Rendering
// ============================================================================

/** A row is renderable text or it is a defect. Returns null for a genuinely blank slot. */
function renderRow(entry: RowInput, cols: (keyof Row)[], section: string, index: number): string | null {
  if (entry === null || entry === undefined) return null;

  if (typeof entry === "string") {
    const text = entry.trim();
    return text === "" ? null : text;
  }

  if (typeof entry !== "object") {
    console.error(`POSTCONDITION FAIL: ${section}[${index}] is a ${typeof entry}, not a string or object`);
    process.exit(1);
  }

  const keys = Object.keys(entry);
  const text = cols.map((c) => entry[c]).filter((v) => typeof v === "string" && v.trim() !== "").map((v) => (v as string).trim()).join(" · ");
  if (text !== "") return text;
  if (keys.length === 0) return null;

  // The 2026-08-20 defect class: the row carried data under names the renderer does not
  // know, so it would have rendered as a bare "- ". Refuse rather than lose it.
  console.error(
    `POSTCONDITION FAIL: ${section}[${index}] has no renderable field. ` +
    `Expected any of [${cols.join(", ")}], got [${keys.join(", ")}].`,
  );
  process.exit(1);
}

function section(entries: RowInput[] | undefined, cols: (keyof Row)[], name: string): { text: string; kept: number; dropped: number } {
  const list = entries ?? [];
  const rendered: string[] = [];
  let dropped = 0;
  list.forEach((entry, i) => {
    const line = renderRow(entry, cols, name, i);
    if (line === null) { dropped++; return; }
    rendered.push(`- ${line}`);
  });
  if (dropped > 0) console.error(`WARN: dropped ${dropped} blank entr${dropped === 1 ? "y" : "ies"} from ${name}`);
  return {
    text: rendered.length === 0 ? "- (none)\n" : rendered.join("\n") + "\n",
    kept: rendered.length,
    dropped,
  };
}

function main(): void {
  const arg = process.argv[2];
  if (!arg) { console.error("usage: CargoManifest.ts <manifest.json> | --latest [--peek]"); process.exit(1); }
  if (arg === "--latest") latest();

  const m: Manifest = JSON.parse(readFileSync(arg, "utf8"));
  for (const k of ["node", "landed", "checkpointed", "wedged", "waiting_on_principal", "in_flight"] as const) {
    if (m[k] === undefined) { console.error(`manifest missing required key: ${k}`); process.exit(1); }
  }

  const now = new Date();
  const iso = now.toISOString();
  const stamp = iso.slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  // Second-resolution filename: two landings in one day used to overwrite each other,
  // which destroyed the earlier record instead of expiring it. Milliseconds are appended
  // only to break a same-second collision, so the common filename stays readable.
  let path = join(WORK, `session-handoff-${stamp}.md`);
  if (existsSync(path)) path = join(WORK, `session-handoff-${stamp}${iso.slice(20, 23)}.md`);
  if (existsSync(path)) {
    console.error(`POSTCONDITION FAIL: ${path} already exists — two manifests in the same millisecond`);
    process.exit(1);
  }
  const fromNode = m.from_node ?? m.node;

  const landed = section(m.landed, ["what", "sha", "evidence"], "landed");
  const checkpointed = section(m.checkpointed, ["what", "resume"], "checkpointed");
  const wedged = section(m.wedged, ["what", "last_known"], "wedged");
  const questions = section(m.open_questions, ["what"], "open_questions");
  const nextSteps = section(m.next_steps, ["what"], "next_steps");
  const filesTouched = section(m.files_touched, ["what"], "files_touched");
  const waiting = section(m.waiting_on_principal, ["what"], "waiting_on_principal");

  const frontmatter = renderFrontmatter({
    handoff: FRONTMATTER_MARK,
    node: m.node,
    from_node: fromNode,
    created: iso,
    state: "open",
    accepted_by: null,
    accepted_at: null,
    accepted_session: null,
  });

  const body = [
    `# Cargo manifest — ${iso} (${m.node})`,
    ``,
    `> Written by CargoManifest.ts. The three landing states below are exhaustive by`,
    `> construction: a raven absent from all three did not land and must be treated as`,
    `> WEDGED (idle-without-report doctrine — silence is a claim of nothing).`,
    ``,
    `## LANDED (complete, evidence in hand)`,
    ``,
    landed.text,
    `## CHECKPOINTED (incomplete, resume point on disk)`,
    ``,
    checkpointed.text,
    `## WEDGED (no answer inside the deadline)`,
    ``,
    wedged.text,
    `## Open questions`,
    ``,
    questions.text,
    `## Next steps`,
    ``,
    nextSteps.text,
    `## Files touched`,
    ``,
    filesTouched.text,
    `## Waiting on the principal`,
    ``,
    waiting.text,
    `## In flight`,
    ``,
    `${m.in_flight}`,
    ``,
  ].join("\n");

  // The defect that started this: a bullet with nothing after the dash. It must not be
  // possible to write one, whatever the input looked like.
  const blank = body.split("\n").findIndex((l) => /^-\s*$/.test(l));
  if (blank !== -1) { console.error(`POSTCONDITION FAIL: empty bullet at line ${blank + 1}`); process.exit(1); }

  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, frontmatter + body);
  renameSync(tmp, path);

  if (!existsSync(path)) { console.error("POSTCONDITION FAIL: file absent after write"); process.exit(1); }
  const bytes = statSync(path).size;
  if (bytes < 200) { console.error(`POSTCONDITION FAIL: ${bytes} bytes is too small to be a real manifest`); process.exit(1); }

  const written = readFileSync(path, "utf8");
  const totalIn = m.landed.length + m.checkpointed.length + m.wedged.length;
  const totalKept = landed.kept + checkpointed.kept + wedged.kept;
  if (totalIn > 0 && totalKept === 0) {
    console.error(`POSTCONDITION FAIL: ${totalIn} landing rows in, 0 rendered`);
    process.exit(1);
  }
  if (parseFrontmatter(written).fm.state !== "open") {
    console.error("POSTCONDITION FAIL: written manifest is not in state=open");
    process.exit(1);
  }

  console.log(`WROTE ${path}`);
  console.log(
    `bytes=${bytes} state=open from_node=${fromNode} ` +
    `landed=${landed.kept} checkpointed=${checkpointed.kept} wedged=${wedged.kept} ` +
    `questions=${questions.kept} next_steps=${nextSteps.kept} files_touched=${filesTouched.kept} ` +
    `waiting=${waiting.kept} dropped=${landed.dropped + checkpointed.dropped + wedged.dropped}`,
  );
}

main();
