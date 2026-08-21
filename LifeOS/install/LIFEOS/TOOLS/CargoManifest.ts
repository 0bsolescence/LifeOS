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

import {
  readFileSync, writeFileSync, statSync, readdirSync, existsSync,
  renameSync, linkSync, unlinkSync,
} from "node:fs";
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
// Concurrency
//
// Two ravens landing or summoning at the same moment on one node is ordinary in
// this estate, and both races lose records (codex review, 2026-08-20):
//
//   accept   two --latest runs both read a manifest as open, both accept it, and
//            the second write silently replaces the first acceptor of record.
//   publish  two landings in the same second both pass an existsSync check and
//            the second rename clobbers the first manifest.
//
// Both are solved with link(), which is atomic and fails rather than overwrites
// when the name is taken. Publish uses it to claim a filename; accept uses it as
// a compare-and-set on a per-manifest claim marker.
//
// An earlier revision serialised accept with a lock file instead. That was wrong,
// and three audit passes were spent proving it: a lock needs a staleness rule so
// an abandoned one cannot wedge the morning summons, and breaking a stale lock
// safely needs a compare-and-swap on the lock's identity that POSIX does not
// offer. Whatever the recovery does — unlink, or rename-and-inode-check — a
// third process can claim the momentarily vacant path and end up sharing the
// lock with a live owner. The claim marker has no such rule to get wrong: it is
// created atomically, it is never removed, and there is nothing to time out.
// ============================================================================

const CLAIM_ATTEMPTS = 5;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isEexist(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === "EEXIST";
}

/** The durable marker that one process, once, won the right to accept this manifest. */
function claimPath(h: Handoff): string {
  return join(WORK, `.accepted-${h.file}`);
}

function isClaimed(h: Handoff): boolean {
  return existsSync(claimPath(h));
}

/**
 * The open manifests that may still be accepted.
 *
 * A per-manifest claim alone is not enough: with two open handoffs from one node, a
 * second run could see the newest one claimed, skip it, and accept its predecessor
 * before the first run expired it — two ACCEPTEDs, one of them a stale handoff, which
 * is the exact shadowing this lifecycle exists to prevent (codex review, 2026-08-20).
 *
 * A claim therefore consumes the whole node, not one file: once any manifest from node
 * N is claimed, every earlier manifest from N is ineligible, because the accept in
 * flight will expire them. If that accept crashed before writing, the predecessors stay
 * ineligible — the same outcome as the completed accept, which is the consistent one.
 *
 * A manifest whose node cannot be determined is blocked by any claim at all, matching
 * the expiry rule: an un-attributable handoff is the dangerous case, not the safe one.
 */
/**
 * Immutable ordering timestamp for claim barriers. mtime is mutated by the
 * accept itself (writeState's rename), so an accept racing a fresh publish
 * could stamp the CLAIMED manifest newer than the genuinely newer open one and
 * hide it forever (codex review, 2026-08-21). Frontmatter `created` is written
 * once at publish; the filename timestamp is the fallback; mtime is last resort
 * for legacy files that carry neither.
 */
function orderMs(h: Handoff): number {
  const fm = h.fm.created ? Date.parse(h.fm.created) : NaN;
  if (Number.isFinite(fm)) return fm;
  const m = h.file.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (m) {
    // stampNow() writes filenames from toISOString() — UTC. Parse them as UTC
    // or a non-UTC host inflates the barrier by its offset (codex, 2026-08-21).
    const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
    if (Number.isFinite(t)) return t;
  }
  return h.mtimeMs;
}

function eligibleOpen(all: Handoff[]): Handoff[] {
  const claimedAt = new Map<string, number>();
  let unattributedClaim = -Infinity;
  for (const h of all) {
    if (!isClaimed(h)) continue;
    const n = nodeOf(h);
    if (n === null) unattributedClaim = Math.max(unattributedClaim, orderMs(h));
    else claimedAt.set(n, Math.max(claimedAt.get(n) ?? -Infinity, orderMs(h)));
  }
  const anyClaim = Math.max(unattributedClaim, ...claimedAt.values());

  return all.filter((h) => {
    if (stateOf(h) !== "open" || isClaimed(h)) return false;
    const n = nodeOf(h);
    const barrier = n === null ? anyClaim : Math.max(claimedAt.get(n) ?? -Infinity, unattributedClaim);
    return orderMs(h) > barrier;
  // The caller accepts [0] and expires the rest, so the ranking must ride the
  // same immutable order as the barrier — an mtime scrambled by restore/sync/
  // touch must not decide which handoff wins (codex review, 2026-08-21).
  }).sort((a, b) => orderMs(b) - orderMs(a) || b.file.localeCompare(a.file));
}

/**
 * Atomically claim the right to accept `h`. Exactly one caller can win, because
 * link() either creates the marker or fails with EEXIST — there is no window in
 * which two processes both believe they hold it.
 *
 * The marker is never deleted: its existence is the record that this manifest was
 * consumed. If a run dies between claiming and writing the frontmatter, the manifest
 * stays open on disk but claimed, and later runs pass over it to the next open one
 * rather than re-accepting it. Nothing is lost — `--peek` still shows it — and no
 * staleness rule is needed, which is the point.
 */
function claim(h: Handoff, by: string, at: string): boolean {
  const tmp = join(WORK, `.cargo-claim-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tmp, `${by} ${at} pid=${process.pid}\n`);
  try {
    linkSync(tmp, claimPath(h));
    return true;
  } catch (e) {
    if (isEexist(e)) return false;
    throw e;
  } finally {
    try { unlinkSync(tmp); } catch { /* the link is what matters; the temp name is not */ }
  }
}

const PUBLISH_ATTEMPTS = 12;

/** `YYYYMMDD-HHMMSS`, plus milliseconds when asked. */
function stampNow(withMs: boolean): string {
  const iso = new Date().toISOString();
  const base = iso.slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  return withMs ? base + iso.slice(20, 23) : base;
}

/**
 * Publish `content` under a free filename, claiming it with link(): link is atomic and
 * fails when the name is taken, where an existsSync check followed by a rename lets two
 * concurrent landings both believe they won and one silently overwrite the other.
 *
 * The first attempt uses the readable second-resolution name. Contended attempts fall
 * back to millisecond resolution and re-read the clock each time, so a busy millisecond
 * resolves on the next one. Returns null when every attempt was taken — the caller
 * reports it, because exiting in here would skip the cleanup of the temp file.
 */
function publish(content: string): string | null {
  const tmp = join(WORK, `.cargo-write-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tmp, content);
  try {
    for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt++) {
      const candidate = join(WORK, `session-handoff-${stampNow(attempt > 0)}.md`);
      try {
        linkSync(tmp, candidate);
        return candidate;
      } catch (e) {
        if (!isEexist(e)) throw e;
      }
      if (attempt > 0) sleepSync(1); // let the clock move past the contended millisecond
    }
    return null;
  } finally {
    try { unlinkSync(tmp); } catch { /* the link is what matters; the temp name is not */ }
  }
}

// ============================================================================
// --latest: the ACCEPT operation
// ============================================================================

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

interface AcceptResult { path: string; notes: string[]; error?: string; contended?: boolean }

function latest(): void {
  if (process.argv.includes("--peek")) {
    const all = listHandoffs();
    if (all.length === 0) { console.error("no handoff files"); process.exit(1); }
    const open = eligibleOpen(all);
    const target = open[0] ?? all[0];
    console.error(
      open.length > 0
        ? `PEEK: no state changed (${open.length} open, ${all.length} total)`
        : `PEEK: no open handoff (${all.length} total, state=${stateOf(target)})`,
    );
    console.log(target.path);
    process.exit(0);
  }

  // Mutating paths return rather than exit, so their cleanup always runs.
  let result = accept();
  // Losing the claim means another run took this manifest between our read and our
  // link. Re-read and try the next open one; it is not an error, just contention.
  for (let attempt = 1; result.contended && attempt < CLAIM_ATTEMPTS; attempt++) {
    sleepSync(10);
    result = accept();
  }
  for (const note of result.notes) console.error(note);
  if (result.error) { console.error(result.error); process.exit(1); }
  console.log(result.path);
  process.exit(0);
}

function accept(): AcceptResult {
  const all = listHandoffs();
  if (all.length === 0) return { path: "", notes: [], error: "no handoff files" };

  const open = eligibleOpen(all);

  if (open.length === 0) {
    // Every handoff has already been consumed. Still hand back the newest so a summons
    // is never blanked, but say plainly that it is not a fresh record.
    const newest = all[0];
    return {
      path: newest.path,
      notes: [`WARN: no open handoff; returning newest (state=${stateOf(newest)}, accepted_by=${newest.fm.accepted_by ?? "—"})`],
    };
  }

  const chosen = open[0];
  const acceptedBy = flag("--accepted-by") ?? process.env.LIFEOS_NODE ?? hostname();
  const acceptedAt = new Date().toISOString();
  const session = flag("--session") ?? process.env.CLAUDE_SESSION_ID ?? null;

  // The single point at which one process wins. Nothing below here is reachable by a
  // second process for this manifest, so the writes need no further serialisation.
  if (!claim(chosen, acceptedBy, acceptedAt)) {
    return { path: chosen.path, notes: [], contended: true };
  }

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
    return { path: chosen.path, notes: [], error: "POSTCONDITION FAIL: chosen manifest is not accepted after write" };
  }
  const stillOpen = superseded.filter((s) => {
    const a = after.find((h) => h.path === s.path);
    return !a || stateOf(a) !== "expired";
  });
  if (stillOpen.length > 0) {
    return { path: chosen.path, notes: [], error: `POSTCONDITION FAIL: ${stillOpen.length} superseded manifest(s) did not expire` };
  }

  return {
    path: chosen.path,
    notes: [`ACCEPTED by=${acceptedBy} at=${acceptedAt} expired=${superseded.length}`],
  };
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

  const iso = new Date().toISOString();
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

  const path = publish(frontmatter + body);
  if (path === null) {
    console.error(`POSTCONDITION FAIL: no free filename after ${PUBLISH_ATTEMPTS} attempts`);
    process.exit(1);
  }

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
