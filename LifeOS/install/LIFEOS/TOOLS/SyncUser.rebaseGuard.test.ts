/**
 * SyncUser.ts must refuse to create ordinary commits while git reports an active
 * rebase. Origin: bekus-l3420, 2026-10-06 22:00 → 23:01 — a halted rebase, then the
 * next hourly `sync` committed the conflicted tree WITH markers (74f3fc95), and the
 * hook layer loaded a DA_MEMORY.md carrying `<<<<<<<` for six hours. The negative
 * control against the unpatched tool (2026-10-07 08:5x, tuf) reproduced it: HEAD
 * advanced and the commit carried a marker line.
 *
 * The test builds a scratch repo with a real conflicting rebase (so
 * `.git/rebase-merge` exists), runs the tool as a subprocess with LIFEOS_CONFIG_DIR
 * pointed at it, and asserts the postcondition (HEAD unchanged), never the exit code
 * alone.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TOOL = join(import.meta.dir, "SyncUser.ts");

function sh(args: string[], cwd: string, env: Record<string, string> = {}) {
  const p = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString() };
}
const git = (args: string[], cwd: string) =>
  sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], cwd);

let root = "";
let repo = "";

function makeRepoMidRebase(): void {
  root = mkdtempSync(join(tmpdir(), "syncuser-guard-"));
  repo = join(root, "repo");
  git(["init", "-q", "--bare", "remote.git"], root);
  git(["clone", "-q", join(root, "remote.git"), "repo"], root);
  git(["commit", "-q", "--allow-empty", "-m", "base"], repo);
  writeFileSync(join(repo, "f.txt"), "A\n");
  git(["add", "f.txt"], repo);
  git(["commit", "-q", "-m", "add f"], repo);
  git(["branch", "-M", "master"], repo);
  git(["push", "-q", "-u", "origin", "master"], repo);
  git(["checkout", "-q", "-b", "side"], repo);
  writeFileSync(join(repo, "f.txt"), "side\n");
  git(["commit", "-qam", "side edit"], repo);
  git(["checkout", "-q", "master"], repo);
  writeFileSync(join(repo, "f.txt"), "master\n");
  git(["commit", "-qam", "master edit"], repo);
  git(["checkout", "-q", "side"], repo);
  sh(["git", "rebase", "master"], repo, { GIT_EDITOR: "true" }); // conflicts by construction
  if (!existsSync(join(repo, ".git", "rebase-merge"))) throw new Error("fixture did not enter a rebase");
}

beforeAll(makeRepoMidRebase);
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe("SyncUser refuses to touch a tree with an active rebase", () => {
  test("sync: exits non-zero, names the rebase, and HEAD does not move", () => {
    const before = git(["rev-parse", "HEAD"], repo).out.trim();
    const r = sh(["bun", TOOL, "sync"], repo, { LIFEOS_CONFIG_DIR: repo });
    const after = git(["rev-parse", "HEAD"], repo).out.trim();
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("REBASE IN PROGRESS");
    expect(after).toBe(before);                       // the postcondition, not the exit code
    expect(r.out).not.toContain("committed:");        // the defect's tell, absent
    expect(existsSync(join(repo, ".git", "rebase-merge"))).toBe(true); // the rebase is left for a human
  });

  test("pull: refuses the same way", () => {
    const before = git(["rev-parse", "HEAD"], repo).out.trim();
    const r = sh(["bun", TOOL, "pull"], repo, { LIFEOS_CONFIG_DIR: repo });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("REBASE IN PROGRESS");
    expect(git(["rev-parse", "HEAD"], repo).out.trim()).toBe(before);
  });

  test("control: after `git rebase --abort` the guard no longer fires", () => {
    git(["rebase", "--abort"], repo);
    expect(existsSync(join(repo, ".git", "rebase-merge"))).toBe(false);
    const r = sh(["bun", TOOL, "status"], repo, { LIFEOS_CONFIG_DIR: repo });
    expect(r.err).not.toContain("REBASE IN PROGRESS");
  });
});
