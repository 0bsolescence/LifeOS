/** MemoryReviewer.status.test.ts — every exit path leaves a terminal row; overlapping runs do not dispatch twice.
 *  Runs against a temp observability root (LIFEOS_REVIEWER_OBS_DIR) so nothing live is touched. */
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "reviewer-status-"));
process.env.LIFEOS_REVIEWER_OBS_DIR = root;
const { review, acquireRunLock, releaseRunLock, takeOverStaleLock } = await import("./MemoryReviewer");
const LOG = join(root, "reviewer-runs.jsonl");
const LOCK = join(root, "reviewer-runs/.run.lock");
const rows = () => (existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

function transcript(): string {
  const p = join(root, "t.jsonl");
  writeFileSync(p, [
    JSON.stringify({ type: "user", timestamp: "2026-09-25T20:00:00Z", message: { role: "user", content: "hello there, a question about the adapter" } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-09-25T20:00:05Z", message: { role: "assistant", content: [{ type: "text", text: "an answer about the adapter with enough text to count" }] } }),
  ].join("\n") + "\n");
  return p;
}

describe("run lock", () => {
  test("fresh lock held by a live pid refuses a second run; own pid releases", () => {
    mkdirSync(join(root, "reviewer-runs"), { recursive: true });
    writeFileSync(LOCK, JSON.stringify({ pid: process.pid, runId: "other", started: new Date().toISOString() }));
    // own pid → treated as not-alive-other → takeover allowed (same process cannot overlap itself)
    expect(acquireRunLock("me", LOCK).ok).toBe(true);
    releaseRunLock(LOCK);
    expect(existsSync(LOCK)).toBe(false);
  });
  test("stale lock (dead pid) is taken over", () => {
    writeFileSync(LOCK, JSON.stringify({ pid: 999999, runId: "dead", started: new Date().toISOString() }));
    expect(acquireRunLock("me", LOCK).ok).toBe(true);
    releaseRunLock(LOCK);
  });
  test("lock by a live foreign pid inside the window refuses", () => {
    writeFileSync(LOCK, JSON.stringify({ pid: 1, runId: "init", started: new Date().toISOString() }));
    const r = acquireRunLock("me", LOCK);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.holder.pid).toBe(1);
    writeFileSync(LOCK, "{}"); // clear for the next tests (not ours to release: foreign pid)
    try { require("node:fs").unlinkSync(LOCK); } catch {}
  });
});

describe("terminal rows", () => {
  test("mocked completed run: a started row then a completed row with status", async () => {
    const r = await review({ input: transcript(), mockInferenceResponse: '{"items":[]}', dryRun: true, turns: 2 });
    expect(r.ok).toBe(true);
    expect(r.status).toBe("completed");
    const mine = rows().filter((x) => x.runId === r.runId);
    expect(mine.map((x) => x.status)).toEqual(["started", "completed"]);
    expect(typeof mine[0].pid).toBe("number");
    expect(existsSync(LOCK)).toBe(false);
  });
  test("parse failure leaves a failed row", async () => {
    const r = await review({ input: transcript(), mockInferenceResponse: "not json at all", dryRun: true, turns: 2 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("failed");
    const mine = rows().filter((x) => x.runId === r.runId);
    expect(mine.map((x) => x.status)).toEqual(["started", "failed"]);
  });
  test("overlap: a live foreign lock yields a skipped-overlap row and no started row", async () => {
    writeFileSync(LOCK, JSON.stringify({ pid: 1, runId: "init-run", started: new Date().toISOString() }));
    const r = await review({ input: transcript(), mockInferenceResponse: '{"items":[]}', dryRun: true, turns: 2 });
    expect(r.status).toBe("skipped-overlap");
    const mine = rows().filter((x) => x.runId === r.runId);
    expect(mine.map((x) => x.status)).toEqual(["skipped-overlap"]);
    try { require("node:fs").unlinkSync(LOCK); } catch {}
  });
  test("empty transcript: skipped row carries status", async () => {
    const p = join(root, "empty.jsonl"); writeFileSync(p, "");
    const r = await review({ input: p, mockInferenceResponse: '{"items":[]}', dryRun: true, turns: 2 });
    expect(r.status).toBe("skipped");
  });
});

// ── Codex maintenance review 2026-09-25: exclusivity, ownership, attribution, real signals ──
const MOD = join(import.meta.dir, "MemoryReviewer.ts");
const childEnv = { ...process.env, LIFEOS_REVIEWER_OBS_DIR: root };
function holderChild(runId: string, holdMs: number) {
  // A separate process that takes the lock through the real API and holds it.
  const src = `const m = await import(${JSON.stringify(MOD)}); const r = m.acquireRunLock(${JSON.stringify(runId)}, ${JSON.stringify(LOCK)}); console.log(JSON.stringify(r)); await new Promise((res) => setTimeout(res, ${holdMs}));`;
  return Bun.spawn(["bun", "-e", src], { env: childEnv, stdout: "pipe", stderr: "pipe" });
}
async function firstLine(p: ReturnType<typeof holderChild>): Promise<any> {
  const reader = p.stdout.getReader(); let buf = "";
  while (!buf.includes("\n")) { const { value, done } = await reader.read(); if (done) break; buf += new TextDecoder().decode(value); }
  reader.releaseLock();
  return JSON.parse(buf.split("\n")[0]);
}
const clearLock = () => { try { require("node:fs").unlinkSync(LOCK); } catch {} };

describe("run lock: O_EXCL across processes", () => {
  test("a live child holding the lock refuses; once its pid is dead the lock is taken", async () => {
    clearLock();
    const child = holderChild("child-run", 30_000);
    expect((await firstLine(child)).ok).toBe(true);
    const r = acquireRunLock("me", LOCK);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.holder.runId).toBe("child-run"); expect(r.holder.pid).toBe(child.pid); }
    child.kill("SIGKILL"); // our own launch handle
    await child.exited;
    const t = acquireRunLock("me", LOCK);
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.takeover).toMatch(/dead/);
    releaseRunLock(LOCK, "me");
    expect(existsSync(LOCK)).toBe(false);
  }, 20_000);

  test("four processes racing for a free lock: exactly one wins", async () => {
    clearLock();
    const kids = [0, 1, 2, 3].map((i) => holderChild(`racer-${i}`, 3_000));
    const results = await Promise.all(kids.map(firstLine));
    expect(results.filter((x) => x.ok).length).toBe(1);
    for (const k of kids) k.kill("SIGKILL");
    await Promise.all(kids.map((k) => k.exited));
    clearLock();
  }, 20_000);

  test("release by the right pid but another runId leaves the lock alone", () => {
    clearLock();
    expect(acquireRunLock("owner-run", LOCK).ok).toBe(true);
    releaseRunLock(LOCK, "someone-else");
    expect(existsSync(LOCK)).toBe(true);
    releaseRunLock(LOCK, "owner-run");
    expect(existsSync(LOCK)).toBe(false);
  });
});

describe("hung holder, pre-start failure, same-process overlap", () => {
  test("a live pid holding the lock for over 30 min is taken over and the takeover is on the rows", async () => {
    clearLock();
    const sleeper = Bun.spawn(["sleep", "30"]);
    mkdirSync(join(root, "reviewer-runs"), { recursive: true });
    writeFileSync(LOCK, JSON.stringify({ pid: sleeper.pid, runId: "hung-run", started: new Date(Date.now() - 31 * 60_000).toISOString() }));
    const r = await review({ input: transcript(), mockInferenceResponse: '{"items":[]}', dryRun: true, turns: 2 });
    sleeper.kill("SIGKILL"); await sleeper.exited;
    expect(r.status).toBe("completed");
    const mine = rows().filter((x) => x.runId === r.runId);
    expect(mine.map((x) => x.status)).toEqual(["started", "completed"]);
    expect(mine[0].error).toMatch(/hung-run.*hung/);
    expect(mine[1].note).toMatch(/hung-run.*hung/);
    expect(existsSync(LOCK)).toBe(false);
  }, 20_000);

  test("an exception before the started row still leaves a failed row with the real runId", async () => {
    clearLock();
    const r = await review({ input: root /* a directory: EISDIR */, mockInferenceResponse: '{"items":[]}', dryRun: true, turns: 2 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe("failed");
    expect(r.runId).not.toBe("unknown");
    const mine = rows().filter((x) => x.runId === r.runId);
    expect(mine.map((x) => x.status)).toEqual(["failed"]);
    expect(mine[0].error).toMatch(/EISDIR|directory/i);
    expect(existsSync(LOCK)).toBe(false);
  });

  test("two review() calls in one process: the second skips; each run keeps its own terminal row", async () => {
    clearLock();
    process.env.LIFEOS_REVIEWER_TEST_SLEEP_MS = "300";
    const a = review({ input: transcript(), mockInferenceResponse: '{"items":[]}', dryRun: true, turns: 2 });
    await Bun.sleep(100);
    delete process.env.LIFEOS_REVIEWER_TEST_SLEEP_MS;
    const b = await review({ input: transcript(), mockInferenceResponse: '{"items":[]}', dryRun: true, turns: 2 });
    const ra = await a;
    expect(b.status).toBe("skipped-overlap");
    expect(ra.status).toBe("completed");
    expect(ra.runId).not.toBe(b.runId);
    expect(rows().filter((x) => x.runId === ra.runId).map((x) => x.status)).toEqual(["started", "completed"]);
    expect(rows().filter((x) => x.runId === b.runId).map((x) => x.status)).toEqual(["skipped-overlap"]);
    expect(existsSync(LOCK)).toBe(false);
  });
});

describe("a real SIGTERM mid-run", () => {
  test("the child exits 143 and leaves an interrupted row for its runId", async () => {
    clearLock();
    const t = transcript();
    const src = `const m = await import(${JSON.stringify(MOD)}); await m.review({ input: ${JSON.stringify(t)}, mockInferenceResponse: '{"items":[]}', dryRun: true, turns: 2 });`;
    const child = Bun.spawn(["bun", "-e", src], { env: { ...childEnv, LIFEOS_REVIEWER_TEST_SLEEP_MS: "15000" }, stdout: "pipe", stderr: "pipe" });
    let started: any = null;
    for (let i = 0; i < 100 && !started; i++) { await Bun.sleep(100); started = rows().find((x) => x.status === "started" && x.pid === child.pid); }
    expect(started).toBeTruthy();
    child.kill("SIGTERM"); // our own launch handle
    expect(await child.exited).toBe(143);
    const mine = rows().filter((x) => x.runId === started.runId);
    expect(mine.map((x) => x.status)).toEqual(["started", "interrupted"]);
    expect(mine[1].error).toMatch(/SIGTERM/);
    expect(existsSync(LOCK)).toBe(false);
  }, 30_000);
});

// ── Stale-lock takeover is serialised by a takeover mutex (2026-09-25; closes the check-then-unlink race and the rename gap) ──
async function deadPid(): Promise<number> {
  const p = Bun.spawn(["true"]); await p.exited; return p.pid; // a pid we launched and that has exited
}
describe("stale takeover: serialised, never moves a lock that is not the stale one", () => {
  test("two processes contending for a dead-pid lock: exactly one runs", async () => {
    for (let round = 0; round < 3; round++) {
      clearLock();
      mkdirSync(join(root, "reviewer-runs"), { recursive: true });
      writeFileSync(LOCK, JSON.stringify({ pid: await deadPid(), runId: `dead-run-${round}`, started: new Date().toISOString() }));
      const t = transcript();
      const before = rows().length;
      const src = `const m = await import(${JSON.stringify(MOD)}); const r = await m.review({ input: ${JSON.stringify(t)}, mockInferenceResponse: '{"items":[]}', dryRun: true, turns: 2 }); console.log(r.status);`;
      const kids = [0, 1].map(() => Bun.spawn(["bun", "-e", src], { env: { ...childEnv, LIFEOS_REVIEWER_TEST_SLEEP_MS: "1500" }, stdout: "pipe", stderr: "pipe" }));
      const outs = await Promise.all(kids.map(async (k) => { await k.exited; return (await new Response(k.stdout).text()).trim(); }));
      const fresh = rows().slice(before);
      expect(fresh.filter((x) => x.status === "started").length).toBe(1);
      expect(outs.sort()).toEqual(["completed", "skipped-overlap"]);
      expect(existsSync(LOCK)).toBe(false);
      expect(require("node:fs").readdirSync(join(root, "reviewer-runs")).filter((f: string) => f.endsWith(".takeover"))).toEqual([]);
    }
  }, 60_000);

  test("a contender that finds the stale lock already gone refuses", () => {
    clearLock();
    expect(takeOverStaleLock(LOCK, JSON.stringify({ pid: 1, runId: "gone", started: "x" }))).toBe(false);
    expect(existsSync(LOCK)).toBe(false);
  });

  test("Codex interleaving: A took over; B (judged the old lock) refuses and never moves A's lock, so C cannot slip in", async () => {
    clearLock();
    const stale = JSON.stringify({ pid: 999999, runId: "judged-stale", started: new Date().toISOString() });
    writeFileSync(LOCK, stale);
    // A: judges, takes over, creates its fresh lock.
    expect(takeOverStaleLock(LOCK, stale)).toBe(true);
    expect(acquireRunLock("A-run", LOCK).ok).toBe(true);
    const aLock = readFileSync(LOCK, "utf8");
    // B resumes with its old judgment: it must refuse without touching the path.
    expect(takeOverStaleLock(LOCK, stale)).toBe(false);
    expect(readFileSync(LOCK, "utf8")).toBe(aLock);
    // C arrives from another process: the path was never absent, and A (this live process) holds it.
    const cProc = holderChild("C-run", 0);
    const c = await firstLine(cProc);
    await cProc.exited;
    expect(c.ok).toBe(false);
    expect(c.holder.runId).toBe("A-run");
    expect(JSON.parse(readFileSync(LOCK, "utf8")).runId).toBe("A-run");
    releaseRunLock(LOCK, "A-run");
    expect(existsSync(LOCK)).toBe(false);
  });

  test("a takeover mutex held by a live taker refuses; one left by a dead process is cleared", async () => {
    clearLock();
    const MUTEX = `${LOCK}.takeover`;
    const stale = JSON.stringify({ pid: 999999, runId: "judged-stale", started: new Date().toISOString() });
    const sleeper = Bun.spawn(["sleep", "30"]);
    writeFileSync(LOCK, stale);
    writeFileSync(MUTEX, JSON.stringify({ pid: sleeper.pid, at: new Date().toISOString() }));
    expect(takeOverStaleLock(LOCK, stale)).toBe(false);
    expect(readFileSync(LOCK, "utf8")).toBe(stale);
    sleeper.kill("SIGKILL"); await sleeper.exited; // our own launch handle
    writeFileSync(MUTEX, JSON.stringify({ pid: await deadPid(), at: new Date().toISOString() }));
    expect(takeOverStaleLock(LOCK, stale)).toBe(true);
    expect(existsSync(LOCK)).toBe(false);
    expect(existsSync(MUTEX)).toBe(false);
  }, 20_000);

  test("a live holder is never taken before 30 min", async () => {
    clearLock();
    const sleeper = Bun.spawn(["sleep", "30"]);
    for (const ageMin of [0, 15, 29]) {
      writeFileSync(LOCK, JSON.stringify({ pid: sleeper.pid, runId: "live-run", started: new Date(Date.now() - ageMin * 60_000).toISOString() }));
      const r = acquireRunLock("me", LOCK);
      expect(r.ok).toBe(false);
      expect(JSON.parse(readFileSync(LOCK, "utf8")).runId).toBe("live-run");
    }
    sleeper.kill("SIGKILL"); await sleeper.exited; // our own launch handle
    clearLock();
  }, 20_000);
});
