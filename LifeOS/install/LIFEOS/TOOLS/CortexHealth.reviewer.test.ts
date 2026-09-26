/** CortexHealth.reviewer.test.ts — reviewer-run evidence classification against temp-dir fixtures. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectCortexEvidence, DEFAULT_CORTEX_THRESHOLDS } from "./CortexHealth";

const T0 = Date.parse("2026-09-25T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const slug = (ms: number) => iso(ms).replace(/[:.]/g, "-");
const MIN = 60_000;
const summary = { total: 0, by_type: {}, succeeded: 0, failed: 0, failures: [], skipped_guard: 0, skips: [], proposals_auto_applied: 0, proposals_auto_apply_failed: 0 };
const success = (ms: number, extra: Record<string, unknown> = {}) => ({ ts: iso(ms), ok: true, runId: slug(ms), transcript: "/t.jsonl", exchanges: 2, inference_duration_ms: 10, parse_ok: true, dispatch_summary: summary, status: "completed", ...extra });
const skip = (ms: number, status = "skipped", extra: Record<string, unknown> = {}) => ({ ts: iso(ms), ok: true, runId: slug(ms), transcript: null, exchanges: 0, inference_duration_ms: 0, parse_ok: true, skipped: true, status, error: "skipped: x", ...extra });
const started = (ms: number) => ({ ts: iso(ms), status: "started", runId: slug(ms), transcript: "/t.jsonl", exchanges: 2, pid: 4242 });

function reviewer(rows: unknown[], nowMs: number, opts: { rawLines?: string[]; dirs?: number[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cortex-reviewer-"));
  const obs = join(root, "LIFEOS/MEMORY/OBSERVABILITY");
  mkdirSync(join(obs, "reviewer-runs"), { recursive: true });
  for (const d of opts.dirs ?? []) mkdirSync(join(obs, "reviewer-runs", slug(d)), { recursive: true });
  writeFileSync(join(obs, "reviewer-runs.jsonl"), [...rows.map((r) => JSON.stringify(r)), ...(opts.rawLines ?? [])].join("\n") + "\n");
  return collectCortexEvidence({ root, nowMs }).reviewer!;
}

describe("reviewer evidence", () => {
  test("a reconstructed row for an old run appended last does not outrank a newer success", () => {
    const r = reviewer([success(T0 + 10 * MIN), { ...success(T0, { status: "failed", ok: false, reconstructed: true, note: "reconciled", error: "dispatch threw: x" }) }], T0 + 20 * MIN);
    expect(r.status).toBe("ok");
    expect(r.runId).toBe(slug(T0 + 10 * MIN));
  });

  test("an orphaned started row outranks a later skipped-overlap: interrupted", () => {
    const r = reviewer([success(T0 - 60 * MIN), started(T0), skip(T0 + MIN, "skipped-overlap")], T0 + 20 * MIN, { dirs: [T0] });
    expect(r.status).toBe("interrupted");
    expect(r.runId).toBe(slug(T0));
  });

  test("an orphaned started row followed by a later run that ran is superseded", () => {
    const r = reviewer([started(T0), success(T0 + 15 * MIN)], T0 + 20 * MIN);
    expect(r.status).toBe("ok");
  });

  test("a directory without a row, then a skip: the skip does not hide it", () => {
    const r = reviewer([success(T0 - 60 * MIN), skip(T0 + MIN, "skipped-overlap")], T0 + 20 * MIN, { dirs: [T0] });
    expect(r.status).toBe("never-started");
  });

  test("a malformed timestamp is invalid evidence, not dropped", () => {
    const r = reviewer([success(T0)], T0 + MIN, { rawLines: [JSON.stringify({ ts: "bad", runId: "bad", ok: false, status: "failed" })] });
    expect(r.status).toBe("invalid");
    expect(r.error).toMatch(/line 2/);
  });

  test("contradictory status on a success row is invalid", () => {
    expect(reviewer([success(T0, { status: "failed" })], T0 + MIN).status).toBe("invalid");
  });

  test("a skip carrying status interrupted, reconstructed [], note 42 is invalid", () => {
    expect(reviewer([skip(T0, "interrupted", { reconstructed: [], note: 42 })], T0 + MIN).status).toBe("invalid");
  });

  test("bad metadata types alone are invalid", () => {
    expect(reviewer([success(T0, { reconstructed: "yes" })], T0 + MIN).status).toBe("invalid");
    expect(reviewer([success(T0, { note: 7 })], T0 + MIN).status).toBe("invalid");
    expect(reviewer([success(T0, { status: "bogus" })], T0 + MIN).status).toBe("invalid");
  });

  test("a started row inside the grace window is running", () => {
    const r = reviewer([success(T0 - 60 * MIN), started(T0)], T0 + DEFAULT_CORTEX_THRESHOLDS.reviewerRunGraceMs - 1);
    expect(r.status).toBe("running");
  });

  test("a started run inside grace with a later overlap skip is still running", () => {
    expect(reviewer([started(T0), skip(T0 + MIN, "skipped-overlap")], T0 + 2 * MIN).status).toBe("running");
  });

  test("a run directory with no rows at all past grace is never-started", () => {
    const r = reviewer([], T0 + 20 * MIN, { dirs: [T0] });
    expect(r.status).toBe("never-started");
  });

  test("a valid skip is skipped; a valid overlap skip is skipped", () => {
    expect(reviewer([skip(T0)], T0 + MIN).status).toBe("skipped");
    expect(reviewer([skip(T0, "skipped-overlap")], T0 + MIN).status).toBe("skipped");
  });
});
