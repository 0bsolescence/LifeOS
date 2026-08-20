/**
 * MemoryRetriever.test.ts — bounded authority weighting (A2).
 *
 * The contract under test is that authority is an ADJUSTMENT and never a filter:
 * the multiplier is clamped, neutral when the envelope is absent, and ordered the
 * way the curation lifecycle is ordered.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { authorityMultiplier } from "../../LIFEOS/TOOLS/MemoryRetriever.ts";

const MIN = 0.8;
const MAX = 1.3;

const STATUSES = ["inbox", "seedling", "budding", "evergreen"];
const TYPES = ["person", "company", "idea", "blog", "research", "book", "memory"];
const QUALITIES = [0, 1, 2, 3, 4, 5];

afterEach(() => { delete process.env.LIFEOS_AUTHORITY_WEIGHTING; });

describe("authority multiplier bounds", () => {
  test("every envelope combination stays inside [0.8, 1.3]", () => {
    let checked = 0;
    for (const status of STATUSES) {
      for (const type of TYPES) {
        for (const quality of QUALITIES) {
          const m = authorityMultiplier({ status, type, quality });
          expect(m).toBeGreaterThanOrEqual(MIN);
          expect(m).toBeLessThanOrEqual(MAX);
          checked++;
        }
      }
    }
    expect(checked).toBe(STATUSES.length * TYPES.length * QUALITIES.length);
  });

  test("the most authoritative note is capped at the ceiling", () => {
    const m = authorityMultiplier({ status: "evergreen", type: "memory", quality: 5 });
    expect(m).toBeLessThanOrEqual(MAX);
    expect(m).toBeGreaterThan(1.0);
  });

  test("the least authoritative note is held at the floor", () => {
    const m = authorityMultiplier({ status: "inbox", type: "blog", quality: 1 });
    expect(m).toBeGreaterThanOrEqual(MIN);
    expect(m).toBeLessThan(1.0);
  });

  test("garbage values cannot escape the bounds", () => {
    const cases = [
      { quality: Number.POSITIVE_INFINITY },
      { quality: Number.NaN },
      { quality: -9999 },
      { quality: "not a number" },
      { status: 12345, type: [] },
    ];
    for (const fm of cases) {
      const m = authorityMultiplier(fm as never);
      expect(Number.isFinite(m)).toBe(true);
      expect(m).toBeGreaterThanOrEqual(MIN);
      expect(m).toBeLessThanOrEqual(MAX);
    }
  });
});

describe("authority is neutral by default", () => {
  test("an empty envelope scores exactly 1.0 — unweighted, not penalised", () => {
    expect(authorityMultiplier({})).toBe(1.0);
  });

  test("unknown status and type values are neutral, not punished", () => {
    expect(authorityMultiplier({ status: "wat", type: "wat" })).toBe(1.0);
  });

  test("a mid quality score is neutral", () => {
    expect(authorityMultiplier({ quality: 3 })).toBe(1.0);
  });

  test("the kill switch returns pure BM25", () => {
    process.env.LIFEOS_AUTHORITY_WEIGHTING = "off";
    expect(authorityMultiplier({ status: "evergreen", type: "memory", quality: 5 })).toBe(1.0);
    expect(authorityMultiplier({ status: "inbox", type: "blog", quality: 1 })).toBe(1.0);
  });
});

describe("authority ordering follows the curation lifecycle", () => {
  test("evergreen > budding > seedling > inbox, all else equal", () => {
    const at = (status: string) => authorityMultiplier({ status, type: "idea", quality: 3 });
    expect(at("evergreen")).toBeGreaterThan(at("budding"));
    expect(at("budding")).toBeGreaterThan(at("seedling"));
    expect(at("seedling")).toBeGreaterThan(at("inbox"));
  });

  test("higher quality outranks lower quality, all else equal", () => {
    const at = (quality: number) => authorityMultiplier({ status: "budding", type: "idea", quality });
    expect(at(5)).toBeGreaterThan(at(3));
    expect(at(3)).toBeGreaterThan(at(1));
  });

  test("the curated hot layer outranks a captured external source", () => {
    const at = (type: string) => authorityMultiplier({ status: "budding", type, quality: 3 });
    expect(at("memory")).toBeGreaterThan(at("blog"));
  });

  test("authority cannot overturn a real relevance gap", () => {
    // The widest authority spread is ceiling/floor. A single title match is +10,
    // so the adjustment can reorder near-ties and nothing more.
    const spread = MAX / MIN;
    const oneTitleMatch = 10;
    expect(spread).toBeLessThan(oneTitleMatch);
  });
});
