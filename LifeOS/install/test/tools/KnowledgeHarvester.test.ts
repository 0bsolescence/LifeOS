/**
 * KnowledgeHarvester.test.ts — access reinforcement in the seedling sweep (A4).
 *
 * Driven through the real CLI (`status` → getArchiveStats) against a fixture
 * LIFEOS_DIR, so the threshold, the trailing window and the log parsing are all
 * exercised as they actually run. Nothing here touches the live corpus.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TOOL = join(import.meta.dir, "..", "..", "LIFEOS", "TOOLS", "KnowledgeHarvester.ts");

const THRESHOLD = 3;
const WINDOW_DAYS = 90;

let lifeos: string;
let ideas: string;
let obs: string;

beforeEach(() => {
  lifeos = mkdtempSync(join(tmpdir(), "knowledge-harvester-"));
  ideas = join(lifeos, "MEMORY", "KNOWLEDGE", "Ideas");
  obs = join(lifeos, "MEMORY", "OBSERVABILITY");
  mkdirSync(ideas, { recursive: true });
  mkdirSync(obs, { recursive: true });
});
afterEach(() => { rmSync(lifeos, { recursive: true, force: true }); });

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

/** A low-quality note old enough that age alone would archive it. */
function seedling(slug: string, opts: { ageDays?: number; quality?: number } = {}) {
  const fm = [
    `---`,
    `id: ${slug}`,
    `type: idea`,
    `title: ${slug}`,
    `quality: ${opts.quality ?? 1}`,
    `created: ${daysAgo(opts.ageDays ?? WINDOW_DAYS + 30)}`,
    `---`,
    ``,
    `Body of ${slug}.`,
    ``,
  ].join("\n");
  writeFileSync(join(ideas, `${slug}.md`), fm);
}

/** Append `count` retrieval rows naming `slug`, `ageDays` old. */
function retrievals(slug: string, count: number, ageDays = 1) {
  const rows = Array.from({ length: count }, () =>
    JSON.stringify({ ts: daysAgo(ageDays), query_hash: "abc", returned_count: 1, slugs: [slug] }),
  );
  writeFileSync(join(obs, "memory-retrievals.jsonl"), rows.join("\n") + "\n");
}

function status() {
  const proc = Bun.spawnSync(["bun", TOOL, "status"], {
    env: { ...process.env, LIFEOS_DIR: lifeos },
  });
  return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
}

/** The `status` report lists stale seedlings by `Domain/slug`. */
function isStale(out: string, slug: string): boolean {
  return out.includes(`Ideas/${slug}`);
}

describe("access reinforcement", () => {
  test("an old, unreferenced, never-retrieved seedling is still stale", () => {
    seedling("never-touched");

    const r = status();

    expect(r.code).toBe(0);
    expect(isStale(r.out, "never-touched")).toBe(true);
  });

  test("a seedling retrieved at the threshold is spared", () => {
    seedling("keeps-getting-pulled");
    retrievals("keeps-getting-pulled", THRESHOLD);

    const r = status();

    expect(r.code).toBe(0);
    expect(isStale(r.out, "keeps-getting-pulled")).toBe(false);
  });

  test("retrievals below the threshold do not spare it", () => {
    seedling("barely-touched");
    retrievals("barely-touched", THRESHOLD - 1);

    const r = status();

    expect(isStale(r.out, "barely-touched")).toBe(true);
  });

  test("retrievals outside the trailing window do not count", () => {
    seedling("used-long-ago");
    retrievals("used-long-ago", THRESHOLD + 5, WINDOW_DAYS + 10);

    const r = status();

    expect(isStale(r.out, "used-long-ago")).toBe(true);
  });

  test("one retrieval row counts once even if it names the note repeatedly", () => {
    seedling("repeated-in-one-row");
    writeFileSync(
      join(obs, "memory-retrievals.jsonl"),
      JSON.stringify({ ts: daysAgo(1), slugs: ["repeated-in-one-row", "repeated-in-one-row", "repeated-in-one-row"] }) + "\n",
    );

    const r = status();

    expect(isStale(r.out, "repeated-in-one-row")).toBe(true);
  });

  test("note identity is matched through paths, filenames and objects", () => {
    seedling("written-as-a-path");
    const rows = [
      JSON.stringify({ ts: daysAgo(1), slugs: ["Ideas/written-as-a-path.md"] }),
      JSON.stringify({ ts: daysAgo(2), returned: [{ slug: "WRITTEN-AS-A-PATH" }] }),
      JSON.stringify({ ts: daysAgo(3), items: [{ path: "/abs/Ideas/written-as-a-path.md" }] }),
    ];
    writeFileSync(join(obs, "memory-retrievals.jsonl"), rows.join("\n") + "\n");

    const r = status();

    expect(isStale(r.out, "written-as-a-path")).toBe(false);
  });
});

describe("reinforcement degrades safely", () => {
  test("an absent retrieval log leaves age-only behaviour unchanged", () => {
    seedling("no-log-at-all");

    const r = status();

    expect(r.code).toBe(0);
    expect(isStale(r.out, "no-log-at-all")).toBe(true);
  });

  test("torn and malformed lines are skipped, valid rows still count", () => {
    seedling("survives-a-torn-log");
    const rows = [
      "{not json at all",
      "",
      JSON.stringify({ ts: daysAgo(1), slugs: ["survives-a-torn-log"] }),
      '{"ts": "2026-08-19T00:00:00Z", "slugs": ["survives-a-torn-log"',
      JSON.stringify({ ts: daysAgo(2), slugs: ["survives-a-torn-log"] }),
      JSON.stringify({ ts: daysAgo(3), slugs: ["survives-a-torn-log"] }),
    ];
    writeFileSync(join(obs, "memory-retrievals.jsonl"), rows.join("\n") + "\n");

    const r = status();

    expect(r.code).toBe(0);
    expect(isStale(r.out, "survives-a-torn-log")).toBe(false);
  });

  test("rows with a missing or malformed timestamp cannot reinforce (codex P2)", () => {
    // An unbounded row would otherwise spare the note forever, defeating the window.
    seedling("no-timestamp");
    const rows = [
      JSON.stringify({ slugs: ["no-timestamp"] }),
      JSON.stringify({ ts: "not a date", slugs: ["no-timestamp"] }),
      JSON.stringify({ ts: 1755600000000, slugs: ["no-timestamp"] }),
      JSON.stringify({ ts: null, slugs: ["no-timestamp"] }),
    ];
    writeFileSync(join(obs, "memory-retrievals.jsonl"), rows.join("\n") + "\n");

    const r = status();

    expect(r.code).toBe(0);
    expect(isStale(r.out, "no-timestamp")).toBe(true);
  });

  test("summary rows with no note identity are ignored rather than crashing", () => {
    seedling("summary-only");
    const rows = Array.from({ length: 10 }, () =>
      // The row shape MemoryStatus.ts documents today — no per-note identity.
      JSON.stringify({ ts: daysAgo(1), query_hash: "abc", top_score: 9.1, returned_count: 3, duration_ms: 12 }),
    );
    writeFileSync(join(obs, "memory-retrievals.jsonl"), rows.join("\n") + "\n");

    const r = status();

    expect(r.code).toBe(0);
    expect(isStale(r.out, "summary-only")).toBe(true);
  });

  test("reinforcement only spares — a fresh high-quality note is never made stale by it", () => {
    seedling("good-and-fresh", { ageDays: 5, quality: 5 });

    const r = status();

    expect(r.code).toBe(0);
    expect(isStale(r.out, "good-and-fresh")).toBe(false);
  });
});
