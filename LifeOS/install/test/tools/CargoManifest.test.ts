/**
 * CargoManifest.test.ts — the landing-report write path and the handoff lifecycle.
 *
 * Subprocess tests: the tool is a CLI that exits with process.exit, so the contract
 * under test is (argv, LIFEOS_WORK_DIR) → (files on disk, stdout, exit code).
 *
 * Zero external deps, per the testing doctrine's harness rule.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TOOL = join(import.meta.dir, "..", "..", "LIFEOS", "TOOLS", "CargoManifest.ts");

let work: string;

beforeEach(() => { work = mkdtempSync(join(tmpdir(), "cargo-manifest-")); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

function run(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(["bun", TOOL, ...args], {
    env: { ...process.env, LIFEOS_WORK_DIR: work, LIFEOS_NODE: "test-node", ...env },
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function write(manifest: unknown) {
  const p = join(work, "manifest.json");
  writeFileSync(p, JSON.stringify(manifest));
  return run([p]);
}

function manifests(): string[] {
  return readdirSync(work).filter((f) => f.startsWith("session-handoff-")).sort();
}

function only(): string {
  const files = manifests();
  expect(files.length).toBe(1);
  return readFileSync(join(work, files[0]), "utf8");
}

function frontmatter(raw: string): Record<string, string> {
  const end = raw.indexOf("\n---\n", 4);
  const fm: Record<string, string> = {};
  for (const line of raw.slice(4, end).split("\n")) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) fm[m[1]] = m[2].trim();
  }
  return fm;
}

/** Place a handoff on disk at a chosen age, optionally pre-lifecycle (no frontmatter). */
function seed(name: string, opts: { node?: string; state?: string; ageMinutes: number; legacy?: boolean }) {
  const body = [
    `# Cargo manifest — 2026-08-20T05:23:36.863Z (${opts.node ?? "l7440"})`,
    ``,
    `## LANDED (complete, evidence in hand)`,
    ``,
    `- something real`,
    ``,
  ].join("\n");
  const fm = opts.legacy
    ? ""
    : `---\nhandoff: pai-handoff-v1\nnode: ${opts.node ?? "l7440"}\nfrom_node: ${opts.node ?? "l7440"}\ncreated: 2026-08-20T05:23:36.863Z\nstate: ${opts.state ?? "open"}\naccepted_by: \naccepted_at: \naccepted_session: \n---\n`;
  const p = join(work, name);
  writeFileSync(p, fm + body);
  const when = new Date(Date.now() - opts.ageMinutes * 60_000);
  utimesSync(p, when, when);
  return p;
}

function stateOf(file: string): string {
  const raw = readFileSync(join(work, file), "utf8");
  return raw.startsWith("---\n") ? (frontmatter(raw).state || "open") : "open";
}

const BASE = {
  node: "l7440",
  landed: [] as unknown[],
  checkpointed: [] as unknown[],
  wedged: [] as unknown[],
  waiting_on_principal: [] as string[],
  in_flight: "Nothing running.",
};

// ============================================================================
// Bug fix — empty bullets
// ============================================================================

describe("empty-bullet defect", () => {
  test("string rows render as content, not bare dashes (the 2026-08-20 regression)", () => {
    const landed = Array.from({ length: 10 }, (_, i) => `landing number ${i} with real content`);
    const r = write({ ...BASE, landed, checkpointed: ["a checkpoint", "another checkpoint"] });

    expect(r.code).toBe(0);
    const md = only();
    for (const line of md.split("\n")) expect(line).not.toMatch(/^-\s*$/);
    expect(md).toContain("- landing number 0 with real content");
    expect(md).toContain("- landing number 9 with real content");
    expect(md.match(/^- landing number/gm)?.length).toBe(10);
    expect(r.stdout).toContain("landed=10");
    expect(r.stdout).toContain("checkpointed=2");
  });

  test("object rows still render, joined by the separator", () => {
    const r = write({
      ...BASE,
      landed: [{ what: "spine leg A", sha: "5fa3d55", evidence: "199 tests green" }],
      checkpointed: [{ what: "terraform apply", resume: "infra/dashboard.tf" }],
      wedged: [{ what: "attorney reply", last_known: "emailed Monday" }],
    });

    expect(r.code).toBe(0);
    const md = only();
    expect(md).toContain("- spine leg A · 5fa3d55 · 199 tests green");
    expect(md).toContain("- terraform apply · infra/dashboard.tf");
    expect(md).toContain("- attorney reply · emailed Monday");
  });

  test("blank entries are dropped rather than rendered", () => {
    const r = write({ ...BASE, landed: ["real one", "", "   ", {}], checkpointed: [] });

    expect(r.code).toBe(0);
    const md = only();
    for (const line of md.split("\n")) expect(line).not.toMatch(/^-\s*$/);
    expect(md).toContain("- real one");
    expect(r.stdout).toContain("landed=1");
    expect(r.stdout).toContain("dropped=3");
  });

  test("a row carrying data under unknown keys is a hard error, never a blank bullet", () => {
    const r = write({ ...BASE, landed: [{ summary: "this key is not one we render", commit: "abc1234" }] });

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("POSTCONDITION FAIL");
    expect(r.stderr).toContain("landed[0]");
    expect(r.stderr).toContain("summary");
    expect(manifests().length).toBe(0);
  });

  test("empty sections still render, marked (none)", () => {
    const r = write({ ...BASE });

    expect(r.code).toBe(0);
    const md = only();
    expect(md).toContain("## LANDED (complete, evidence in hand)\n\n- (none)");
    expect(md).toContain("## CHECKPOINTED (incomplete, resume point on disk)\n\n- (none)");
    expect(md).toContain("## WEDGED (no answer inside the deadline)\n\n- (none)");
  });
});

// ============================================================================
// A1 — typed schema
// ============================================================================

describe("typed handoff schema", () => {
  test("open_questions, next_steps and files_touched render as sections", () => {
    const r = write({
      ...BASE,
      open_questions: ["Oct-24 RattleSnake anchoring ruling"],
      next_steps: ["guided terraform apply"],
      files_touched: ["LIFEOS/TOOLS/CargoManifest.ts"],
    });

    expect(r.code).toBe(0);
    const md = only();
    expect(md).toContain("## Open questions\n\n- Oct-24 RattleSnake anchoring ruling");
    expect(md).toContain("## Next steps\n\n- guided terraform apply");
    expect(md).toContain("## Files touched\n\n- LIFEOS/TOOLS/CargoManifest.ts");
    expect(r.stdout).toContain("questions=1");
  });

  test("the new sections are present even when the manifest omits them", () => {
    write({ ...BASE });
    const md = only();
    expect(md).toContain("## Open questions\n\n- (none)");
    expect(md).toContain("## Next steps\n\n- (none)");
    expect(md).toContain("## Files touched\n\n- (none)");
  });

  test("a fresh manifest is written open, with from_node", () => {
    const r = write({ ...BASE, node: "l7440", from_node: "l3420" });

    expect(r.code).toBe(0);
    const fm = frontmatter(only());
    expect(fm.handoff).toBe("pai-handoff-v1");
    expect(fm.state).toBe("open");
    expect(fm.node).toBe("l7440");
    expect(fm.from_node).toBe("l3420");
    expect(fm.accepted_by).toBe("");
    expect(fm.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("missing required keys are refused before anything is written", () => {
    const p = join(work, "bad.json");
    writeFileSync(p, JSON.stringify({ node: "l7440", landed: [] }));
    const r = run([p]);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("missing required key");
    expect(manifests().length).toBe(0);
  });

  test("two landings on the same day coexist instead of overwriting", () => {
    write({ ...BASE, landed: ["first landing"] });
    write({ ...BASE, landed: ["second landing"] });

    expect(manifests().length).toBe(2);
  });
});

// ============================================================================
// A1 — accept / expire lifecycle
// ============================================================================

describe("--latest accept semantics", () => {
  test("returns the newest open manifest and marks it accepted", () => {
    seed("session-handoff-20260818.md", { ageMinutes: 300 });
    seed("session-handoff-20260819.md", { ageMinutes: 200 });
    const newest = "session-handoff-20260820.md";
    seed(newest, { ageMinutes: 10 });

    const r = run(["--latest", "--session", "sess-123"]);

    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(join(work, newest));
    expect(stateOf(newest)).toBe("accepted");

    const fm = frontmatter(readFileSync(join(work, newest), "utf8"));
    expect(fm.accepted_by).toBe("test-node");
    expect(fm.accepted_session).toBe("sess-123");
    expect(fm.accepted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("older open manifests from the same node expire on accept", () => {
    seed("session-handoff-20260818.md", { ageMinutes: 300 });
    seed("session-handoff-20260819.md", { ageMinutes: 200 });
    seed("session-handoff-20260820.md", { ageMinutes: 10 });

    const r = run(["--latest"]);

    expect(r.code).toBe(0);
    expect(stateOf("session-handoff-20260820.md")).toBe("accepted");
    expect(stateOf("session-handoff-20260819.md")).toBe("expired");
    expect(stateOf("session-handoff-20260818.md")).toBe("expired");
    expect(r.stderr).toContain("expired=2");
  });

  test("a stale handoff cannot shadow a newer one — the 2026-08-16 incident class", () => {
    // Older file, newer mtime is impossible to rely on by filename alone; the lifecycle
    // is what makes the guarantee, so prove the stale one is unreachable afterwards.
    seed("session-handoff-20260816.md", { ageMinutes: 5000 });
    seed("session-handoff-20260820.md", { ageMinutes: 1 });

    run(["--latest"]);
    const second = run(["--latest", "--peek"]);

    expect(second.stdout.trim()).not.toContain("20260816");
    expect(stateOf("session-handoff-20260816.md")).toBe("expired");
  });

  test("an older manifest from a DIFFERENT node is left open", () => {
    seed("session-handoff-20260819.md", { node: "l3420", ageMinutes: 200 });
    seed("session-handoff-20260820.md", { node: "l7440", ageMinutes: 10 });

    const r = run(["--latest"]);

    expect(r.code).toBe(0);
    expect(stateOf("session-handoff-20260820.md")).toBe("accepted");
    expect(stateOf("session-handoff-20260819.md")).toBe("open");
    expect(r.stderr).toContain("expired=0");
  });

  test("an accept's own mtime bump cannot hide a concurrently published newer handoff", () => {
    // codex review 2026-08-21 (P1): writeState's rewrite stamps the accepted file
    // with a fresher mtime than a handoff published while the accept was in
    // flight. Ordering must ride the immutable `created`, not mtime.
    seed("session-handoff-20260819.md", { ageMinutes: 200 });
    run(["--latest"]); // accept rewrites the file — now the newest mtime in WORK

    const late = join(work, "session-handoff-20260821.md");
    writeFileSync(late, [
      "---", "handoff: pai-handoff-v1", "node: l7440", "from_node: l7440",
      "created: 2026-08-21T09:00:00.000Z", "state: open",
      "accepted_by: ", "accepted_at: ", "accepted_session: ", "---",
      "# Cargo manifest — 2026-08-21T09:00:00.000Z (l7440)", "",
      "## LANDED (complete, evidence in hand)", "", "- something real", "",
    ].join("\n"));
    const older = new Date(Date.now() - 120_000);
    utimesSync(late, older, older);

    const r = run(["--latest"]);

    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(late);
    expect(stateOf("session-handoff-20260821.md")).toBe("accepted");
  });

  test("accepting is single-use: a second call finds nothing open and says so", () => {
    seed("session-handoff-20260820.md", { ageMinutes: 10 });

    const first = run(["--latest"]);
    const second = run(["--latest"]);

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(second.stderr).toContain("no open handoff");
    expect(second.stdout.trim()).toBe(join(work, "session-handoff-20260820.md"));
    // The acceptor of record does not change on a re-read.
    expect(stateOf("session-handoff-20260820.md")).toBe("accepted");
  });

  test("--peek mutates nothing", () => {
    seed("session-handoff-20260819.md", { ageMinutes: 200 });
    seed("session-handoff-20260820.md", { ageMinutes: 10 });

    const before = readdirSync(work).map((f) => readFileSync(join(work, f), "utf8"));
    const r = run(["--latest", "--peek"]);
    const after = readdirSync(work).map((f) => readFileSync(join(work, f), "utf8"));

    expect(r.code).toBe(0);
    expect(after).toEqual(before);
    expect(stateOf("session-handoff-20260820.md")).toBe("open");
    expect(stateOf("session-handoff-20260819.md")).toBe("open");
    expect(r.stderr).toContain("PEEK");
  });

  test("an empty work directory is a non-zero exit, not a silent empty answer", () => {
    const r = run(["--latest"]);

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no handoff files");
  });

  test("a manifest written this run is the one --latest hands back", () => {
    seed("session-handoff-20260819.md", { ageMinutes: 200 });
    const w = write({ ...BASE, landed: ["today's landing"] });
    expect(w.code).toBe(0);

    const r = run(["--latest"]);

    expect(r.code).toBe(0);
    expect(readFileSync(r.stdout.trim(), "utf8")).toContain("today's landing");
    expect(stateOf("session-handoff-20260819.md")).toBe("expired");
  });
});

// ============================================================================
// Concurrency (codex review findings, both P1)
// ============================================================================

async function runAsync(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", TOOL, ...args], {
    env: { ...process.env, LIFEOS_WORK_DIR: work, LIFEOS_NODE: "test-node", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("concurrent accepts", () => {
  test("exactly one of several simultaneous --latest runs accepts the manifest", async () => {
    seed("session-handoff-20260820.md", { ageMinutes: 10 });

    const results = await Promise.all(Array.from({ length: 6 }, () => runAsync(["--latest"])));

    const accepted = results.filter((r) => r.stderr.includes("ACCEPTED"));
    const sawNoneOpen = results.filter((r) => r.stderr.includes("no open handoff"));
    expect(accepted.length).toBe(1);
    expect(accepted.length + sawNoneOpen.length).toBe(6);
    for (const r of results) expect(r.code).toBe(0);
    expect(stateOf("session-handoff-20260820.md")).toBe("accepted");
  });

  test("the acceptor of record is not overwritten by a losing run", async () => {
    seed("session-handoff-20260820.md", { ageMinutes: 10 });

    const results = await Promise.all([
      runAsync(["--latest", "--accepted-by", "node-a", "--session", "sess-a"]),
      runAsync(["--latest", "--accepted-by", "node-b", "--session", "sess-b"]),
      runAsync(["--latest", "--accepted-by", "node-c", "--session", "sess-c"]),
    ]);

    const winner = results.find((r) => r.stderr.includes("ACCEPTED"));
    expect(winner).toBeDefined();

    const fm = frontmatter(readFileSync(join(work, "session-handoff-20260820.md"), "utf8"));
    // Whoever won, the file names that one acceptor and one session — never a mix.
    expect(["node-a", "node-b", "node-c"]).toContain(fm.accepted_by);
    expect(fm.accepted_session).toBe(fm.accepted_by!.replace("node-", "sess-"));
    expect(winner!.stderr).toContain(`by=${fm.accepted_by}`);
  });

  test("an accepted manifest leaves exactly one claim marker", () => {
    seed("session-handoff-20260820.md", { ageMinutes: 10 });

    const r = run(["--latest"]);

    expect(r.code).toBe(0);
    expect(readdirSync(work).filter((f) => f.startsWith(".accepted-")))
      .toEqual([".accepted-session-handoff-20260820.md"]);
  });

  test("a claim on the newest blocks its predecessors from the same node (codex P1)", () => {
    // The race: a second run must not slip in and accept the OLDER handoff while the
    // first run holds the newest and has not yet expired it.
    seed("session-handoff-20260819.md", { ageMinutes: 200 });
    seed("session-handoff-20260820.md", { ageMinutes: 10 });
    writeFileSync(join(work, ".accepted-session-handoff-20260820.md"), "node-x 2026-08-20T00:00:00Z");

    const r = run(["--latest"]);

    expect(r.code).toBe(0);
    expect(r.stderr).toContain("no open handoff");
    expect(r.stderr).not.toContain("ACCEPTED");
    expect(stateOf("session-handoff-20260819.md")).toBe("open");
  });

  test("a claim does not block a different node's handoff", () => {
    seed("session-handoff-20260819.md", { node: "l3420", ageMinutes: 200 });
    seed("session-handoff-20260820.md", { node: "l7440", ageMinutes: 10 });
    writeFileSync(join(work, ".accepted-session-handoff-20260820.md"), "l7440 2026-08-20T00:00:00Z");

    const r = run(["--latest"]);

    expect(r.code).toBe(0);
    expect(r.stderr).toContain("ACCEPTED");
    expect(r.stdout.trim()).toBe(join(work, "session-handoff-20260819.md"));
  });

  test("concurrent runs over several open handoffs from one node yield one acceptor", async () => {
    seed("session-handoff-20260818.md", { ageMinutes: 400 });
    seed("session-handoff-20260819.md", { ageMinutes: 200 });
    seed("session-handoff-20260820.md", { ageMinutes: 10 });

    const results = await Promise.all(Array.from({ length: 6 }, () => runAsync(["--latest"])));

    const accepted = results.filter((r) => r.stderr.includes("ACCEPTED"));
    expect(accepted.length).toBe(1);
    // And the one accepted is the newest — never a stale predecessor.
    expect(accepted[0].stdout.trim()).toBe(join(work, "session-handoff-20260820.md"));
    expect(stateOf("session-handoff-20260819.md")).toBe("expired");
    expect(stateOf("session-handoff-20260818.md")).toBe("expired");
  });

  test("no lock file is created — there is no staleness rule to get wrong", () => {
    seed("session-handoff-20260820.md", { ageMinutes: 10 });

    run(["--latest"]);

    expect(readdirSync(work).filter((f) => f.includes("lock"))).toEqual([]);
  });

  test("no temp files survive an accept", () => {
    seed("session-handoff-20260820.md", { ageMinutes: 10 });

    run(["--latest"]);

    expect(readdirSync(work).filter((f) => f.includes(".tmp"))).toEqual([]);
  });
});

describe("concurrent landings", () => {
  test("simultaneous landings each get their own file — none is clobbered", async () => {
    const paths = Array.from({ length: 5 }, (_, i) => {
      const p = join(work, `manifest-${i}.json`);
      writeFileSync(p, JSON.stringify({ ...BASE, landed: [`landing from raven ${i}`] }));
      return p;
    });

    const results = await Promise.all(paths.map((p) => runAsync([p])));

    for (const r of results) expect(r.code).toBe(0);
    expect(manifests().length).toBe(5);

    // Every raven's content survives — the point of the whole exercise.
    const all = manifests().map((f) => readFileSync(join(work, f), "utf8")).join("\n");
    for (let i = 0; i < 5; i++) expect(all).toContain(`landing from raven ${i}`);
  });

  test("no temp or partial files are left behind", async () => {
    const paths = Array.from({ length: 3 }, (_, i) => {
      const p = join(work, `m-${i}.json`);
      writeFileSync(p, JSON.stringify({ ...BASE, landed: [`raven ${i}`] }));
      return p;
    });

    await Promise.all(paths.map((p) => runAsync([p])));

    const leftovers = readdirSync(work).filter((f) => f.includes(".tmp") || f.startsWith(".cargo-write"));
    expect(leftovers).toEqual([]);
  });
});

// ============================================================================
// A1 — backward compatibility
// ============================================================================

describe("backward compatibility", () => {
  test("a pre-lifecycle manifest with no frontmatter counts as open", () => {
    seed("session-handoff-20260819.md", { ageMinutes: 10, legacy: true });

    const r = run(["--latest"]);

    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(join(work, "session-handoff-20260819.md"));
    expect(stateOf("session-handoff-20260819.md")).toBe("accepted");
  });

  test("accepting a legacy manifest recovers its node from the heading and keeps the body", () => {
    seed("session-handoff-20260819.md", { node: "l3420", ageMinutes: 10, legacy: true });

    run(["--latest"]);

    const raw = readFileSync(join(work, "session-handoff-20260819.md"), "utf8");
    expect(frontmatter(raw).from_node).toBe("l3420");
    expect(raw).toContain("# Cargo manifest — 2026-08-20T05:23:36.863Z (l3420)");
    expect(raw).toContain("- something real");
  });

  test("legacy files are discovered alongside second-resolution filenames", () => {
    seed("session-handoff-20260818.md", { ageMinutes: 300, legacy: true });
    seed("session-handoff-20260820-120000.md", { ageMinutes: 10 });

    const r = run(["--latest"]);

    expect(r.stdout.trim()).toBe(join(work, "session-handoff-20260820-120000.md"));
    expect(stateOf("session-handoff-20260818.md")).toBe("expired");
  });
});
