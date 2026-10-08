/**
 * A proposal's target_file is resolved before the system/user boundary check. Reviewer
 * output writes it absolute, `~/…`, or relative; a relative `LIFEOS/…` target is relative to
 * the harness root (the CLAUDE.md pointer convention). Joining it to LIFEOS_DIR produced
 * `…/LIFEOS/LIFEOS/USER/…` and the boundary refused two real proposals (reviewer run
 * 2026-10-08T00-18-29-167Z, dispatch.log: both EWRITE_FAILED on that doubled path). That
 * run is the negative control; this test pins the resolution rules.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveProposalTargetForBoundary } from "./MemorySystem";

const roots = { claudeRoot: "/r/.claude", lifeosDir: "/r/.claude/LIFEOS" };

describe("proposal target resolution for the boundary check", () => {
  test("a LIFEOS/-relative target resolves against the harness root, not LIFEOS_DIR", () => {
    expect(resolveProposalTargetForBoundary("LIFEOS/USER/CONFIG/OPERATIONAL_RULES.md", roots))
      .toBe("/r/.claude/LIFEOS/USER/CONFIG/OPERATIONAL_RULES.md");
    expect(resolveProposalTargetForBoundary("LIFEOS/USER/CONFIG/OPERATIONAL_RULES.md", roots))
      .not.toContain("/LIFEOS/LIFEOS/");
  });
  test("a USER/-relative target still resolves against LIFEOS_DIR", () => {
    expect(resolveProposalTargetForBoundary("USER/PROJECTS.md", roots)).toBe("/r/.claude/LIFEOS/USER/PROJECTS.md");
  });
  test("absolute and ~/ targets pass through", () => {
    expect(resolveProposalTargetForBoundary("/abs/x.md", roots)).toBe("/abs/x.md");
    expect(resolveProposalTargetForBoundary("~/x.md", roots)).toBe(join(homedir(), "x.md"));
  });
  test("surrounding whitespace is ignored", () => {
    expect(resolveProposalTargetForBoundary("  LIFEOS/USER/PROJECTS.md \n", roots)).toBe("/r/.claude/LIFEOS/USER/PROJECTS.md");
  });
});
