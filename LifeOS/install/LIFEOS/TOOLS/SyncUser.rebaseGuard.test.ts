/**
 * SyncUser.ts must refuse to create ordinary commits while git reports an active
 * rebase. Origin: a field node, 2026-10-06 22:00 → 23:01 — a halted rebase, then the
 * next hourly `sync` committed the conflicted tree WITH markers (74f3fc95), and the
 * hook layer loaded a DA_MEMORY.md carrying `<<<<<<<` for six hours. The negative
 * control against the unpatched tool (2026-10-07 08:5x) reproduced it: HEAD
 * advanced and the commit carried a marker line.
 *
 * The test builds a scratch repo with a real conflicting rebase (so
 * `.git/rebase-merge` exists), runs the tool as a subprocess with LIFEOS_CONFIG_DIR
 * pointed at it, and asserts the postcondition (HEAD unchanged), never the exit code
 * alone.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
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
    const r = sh([process.execPath, TOOL, "sync"], repo, { LIFEOS_CONFIG_DIR: repo });
    const after = git(["rev-parse", "HEAD"], repo).out.trim();
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("REBASE IN PROGRESS");
    expect(after).toBe(before);                       // the postcondition, not the exit code
    expect(r.out).not.toContain("committed:");        // the defect's tell, absent
    expect(existsSync(join(repo, ".git", "rebase-merge"))).toBe(true); // the rebase is left for a human
  });

  test("pull: refuses the same way", () => {
    const before = git(["rev-parse", "HEAD"], repo).out.trim();
    const r = sh([process.execPath, TOOL, "pull"], repo, { LIFEOS_CONFIG_DIR: repo });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("REBASE IN PROGRESS");
    expect(git(["rev-parse", "HEAD"], repo).out.trim()).toBe(before);
  });

  test("control: after `git rebase --abort` the guard no longer fires", () => {
    git(["rebase", "--abort"], repo);
    expect(existsSync(join(repo, ".git", "rebase-merge"))).toBe(false);
    const r = sh([process.execPath, TOOL, "status"], repo, { LIFEOS_CONFIG_DIR: repo });
    expect(r.err).not.toContain("REBASE IN PROGRESS");
  });
});

/**
 * `.git` is a FILE in a linked worktree or a `--separate-git-dir` repo, so a check that
 * assumes `<repo>/.git/rebase-merge` misses a live rebase there. Cross-vendor review
 * finding (2026-10-07); the negative control against the path-based check reproduced
 * it: the tool committed a marker and then reported "nothing changed locally".
 */
describe("the check asks git where its state lives (.git may be a file)", () => {
  let root2 = "";
  let repo2 = "";

  beforeAll(() => {
    root2 = mkdtempSync(join(tmpdir(), "syncuser-guard-sepgit-"));
    repo2 = join(root2, "repo");
    git(["init", "-q", "--bare", "remote.git"], root2);
    git(["clone", "-q", `--separate-git-dir=${join(root2, "gitdir")}`, join(root2, "remote.git"), "repo"], root2);
    git(["commit", "-q", "--allow-empty", "-m", "base"], repo2);
    writeFileSync(join(repo2, "f.txt"), "A\n");
    git(["add", "f.txt"], repo2);
    git(["commit", "-q", "-m", "add f"], repo2);
    git(["branch", "-M", "master"], repo2);
    git(["push", "-q", "-u", "origin", "master"], repo2);
    git(["checkout", "-q", "-b", "side"], repo2);
    writeFileSync(join(repo2, "f.txt"), "side\n");
    git(["commit", "-qam", "side edit"], repo2);
    git(["checkout", "-q", "master"], repo2);
    writeFileSync(join(repo2, "f.txt"), "master\n");
    git(["commit", "-qam", "master edit"], repo2);
    git(["checkout", "-q", "side"], repo2);
    sh(["git", "rebase", "master"], repo2, { GIT_EDITOR: "true" });
    if (!statSync(join(repo2, ".git")).isFile()) throw new Error("fixture: .git should be a file here");
    if (!existsSync(join(root2, "gitdir", "rebase-merge"))) throw new Error("fixture did not enter a rebase");
  });
  afterAll(() => { if (root2) rmSync(root2, { recursive: true, force: true }); });

  test("sync refuses and HEAD does not move when .git is a file", () => {
    const before = git(["rev-parse", "HEAD"], repo2).out.trim();
    const r = sh([process.execPath, TOOL, "sync"], repo2, { LIFEOS_CONFIG_DIR: repo2 });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("REBASE IN PROGRESS");
    expect(git(["rev-parse", "HEAD"], repo2).out.trim()).toBe(before);
    expect(r.out).not.toContain("committed:");
  });
});
