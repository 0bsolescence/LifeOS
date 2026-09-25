/** MemoryReviewer.status.test.ts — every exit path leaves a terminal row; overlapping runs do not dispatch twice.
 *  Runs against a temp observability root (LIFEOS_REVIEWER_OBS_DIR) so nothing live is touched. */
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "reviewer-status-"));
process.env.LIFEOS_REVIEWER_OBS_DIR = root;
const { review, acquireRunLock, releaseRunLock } = await import("./MemoryReviewer");
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
