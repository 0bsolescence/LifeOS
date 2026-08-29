#!/usr/bin/env bun
/**
 * SyncUser — multi-machine sync for the LifeOS USER zone.
 *
 * LifeOS ships no multi-machine story: nothing in DOCUMENTATION addresses running
 * two nodes, so a second install diverges immediately with no reconciliation path.
 * This syncs the state that SHOULD be shared and deliberately refuses to touch the
 * state that must stay per-machine.
 *
 * SHARED (git, private remote)        MACHINE-LOCAL (never synced)
 *   USER/          identity, TELOS      MEMORY/WORK           shared (ruled 2026-08-29)
 *   MEMORY/KNOWLEDGE  curated notes     MEMORY/STATE          runtime state
 *   MEMORY/LEARNING   lessons           MEMORY/OBSERVABILITY  this host's telemetry
 *   SYNAPSE/*.toml    config            MEMORY/VOICE          local playback
 *                                       MEMORY/SKILLS         local skill state
 *                                       MEMORY/UPGRADES       local queue
 *                                       SYNAPSE/amber.db      binary, conflict-prone
 *
 * KNOWLEDGE and LEARNING live in the config dir and are symlinked back into the
 * harness tree, the same pattern LinkUser already uses for USER. `doctor` verifies
 * those links, because a broken one silently splits your memory in two.
 *
 * Conflicts are surfaced, never auto-resolved. A rebase conflict in your own TELOS
 * is a decision, not a merge strategy.
 *
 * Usage:
 *   SyncUser.ts status          what would sync, and whether the remote has moved
 *   SyncUser.ts doctor          verify symlinks + that no machine-local dir got captured
 *   SyncUser.ts sync [-m msg]   pull --rebase, commit, push. Halts loudly on conflict.
 */

import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

const HOME = process.env.HOME || "";
const CONFIG_DIR = process.env.LIFEOS_CONFIG_DIR || join(HOME, ".config", "LIFEOS");
const HARNESS_MEMORY = join(HOME, ".claude", "LIFEOS", "MEMORY");

const LINKED = ["KNOWLEDGE", "LEARNING", "WORK"];
const MACHINE_LOCAL = ["STATE", "OBSERVABILITY", "VOICE", "SKILLS", "UPGRADES"];

function git(args: string[], cwd = CONFIG_DIR): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}

function requireRepo(): void {
  if (!existsSync(join(CONFIG_DIR, ".git"))) {
    console.error(`❌ ${CONFIG_DIR} is not a git repo. Initialise it and add a PRIVATE remote first.`);
    process.exit(1);
  }
}

function cmdDoctor(): void {
  let bad = 0;
  console.log(`LifeOS sync doctor — ${hostname()}\n`);

  for (const d of LINKED) {
    const link = join(HARNESS_MEMORY, d);
    const want = join(CONFIG_DIR, "MEMORY", d);
    let ok = false, detail = "missing";
    if (existsSync(link)) {
      try {
        if (lstatSync(link).isSymbolicLink()) {
          const target = readlinkSync(link);
          ok = target === want;
          detail = ok ? `-> ${target}` : `-> ${target} (expected ${want})`;
        } else {
          detail = "is a real directory, NOT a symlink — this host's notes are not being synced";
        }
      } catch { detail = "unreadable"; }
    }
    console.log(`${ok ? "✅" : "❌"} MEMORY/${d} ${detail}`);
    if (!ok) bad++;
  }

  // A machine-local dir that ended up inside the synced tree is the failure mode
  // that quietly makes two nodes fight over runtime state.
  for (const d of MACHINE_LOCAL) {
    const captured = existsSync(join(CONFIG_DIR, "MEMORY", d));
    if (captured) { console.log(`❌ MEMORY/${d} is inside the synced tree — it must stay machine-local`); bad++; }
  }
  if (!bad) console.log(`✅ no machine-local tree captured (${MACHINE_LOCAL.join(", ")})`);

  const remote = git(["remote", "get-url", "origin"]);
  console.log(remote.code === 0 ? `✅ remote: ${remote.out}` : "❌ no origin remote configured");
  if (remote.code !== 0) bad++;

  console.log(`\n${bad === 0 ? "sync layout healthy" : `${bad} problem(s)`}`);
  process.exit(bad === 0 ? 0 : 1);
}

function cmdStatus(): void {
  requireRepo();
  const dirty = git(["status", "--porcelain"]).out;
  console.log(`host: ${hostname()}`);
  console.log(`repo: ${CONFIG_DIR}`);
  console.log(`local changes: ${dirty ? dirty.split("\n").length + " file(s)" : "none"}`);
  if (dirty) console.log(dirty.split("\n").map(l => "  " + l).join("\n"));
  git(["fetch", "--quiet"]);
  const counts = git(["rev-list", "--left-right", "--count", "HEAD...@{u}"]).out;
  if (counts) {
    const [ahead, behind] = counts.split(/\s+/);
    console.log(`ahead: ${ahead}  behind: ${behind}`);
  }
}


function cmdPull(): void {
  requireRepo();
  const dirty = git(["status", "--porcelain"]).out;
  if (dirty) {
    // Refuse rather than stash: unattended code must never touch uncommitted user work.
    console.error(`local changes present on ${hostname()} — not pulling. Run 'sync' deliberately.`);
    console.error(dirty.split("\n").map(l => "  " + l).join("\n"));
    process.exit(1);
  }
  const r = git(["pull", "--rebase"]);
  if (r.code !== 0) { console.error(`pull failed:\n${r.err || r.out}`); process.exit(1); }
  console.log(`${hostname()}: ${r.out.split("\n").slice(-1)[0] || "up to date"}`);
}

function cmdSync(): void {
  requireRepo();
  const msgFlag = process.argv.indexOf("-m");
  const msg = msgFlag >= 0 ? process.argv[msgFlag + 1] : `sync from ${hostname()}`;

  // Git does not track empty directories, so an empty LEARNING/ never reaches the
  // second node and its symlink dangles there. Keepfiles make the layout survive a
  // clone. (Found by `doctor` on the first real two-node round trip.)
  for (const d of LINKED) {
    const dir = join(CONFIG_DIR, "MEMORY", d);
    const keep = join(dir, ".gitkeep");
    if (existsSync(dir) && !existsSync(keep)) {
      Bun.write(keep, "# keeps this dir in git; empty dirs are not tracked\n");
    }
  }

  // Commit local work FIRST so the rebase has something coherent to replay.
  if (git(["status", "--porcelain"]).out) {
    git(["add", "-A"]);
    const c = git(["-c", "user.name=LifeOS", "-c", "user.email=lifeos@localhost", "commit", "-m", msg]);
    if (c.code !== 0) { console.error(`❌ commit failed:\n${c.err || c.out}`); process.exit(1); }
    console.log(`committed: ${msg}`);
  } else {
    console.log("nothing local to commit");
  }

  const pull = git(["pull", "--rebase"]);
  if (pull.code !== 0) {
    console.error("❌ REBASE CONFLICT — halting. Your files are untouched on disk.\n");
    console.error(pull.err || pull.out);
    console.error("\nResolve deliberately, then re-run:");
    console.error(`  cd ${CONFIG_DIR} && git status`);
    console.error("  # edit the conflicted files, then: git add -A && git rebase --continue");
    console.error("  # or abandon this pull entirely: git rebase --abort");
    process.exit(1);
  }
  console.log(pull.out.split("\n").slice(-2).join("\n") || "up to date");

  const push = git(["push"]);
  if (push.code !== 0) { console.error(`❌ push failed:\n${push.err || push.out}`); process.exit(1); }
  console.log(`✅ synced from ${hostname()}`);
}

switch (process.argv[2]) {
  case "doctor": cmdDoctor(); break;
  case "status": cmdStatus(); break;
  case "pull": cmdPull(); break;
  case "sync": cmdSync(); break;
  default:
    console.log(`SyncUser — multi-machine sync for the LifeOS USER zone

  SyncUser.ts status   what would sync; how far ahead/behind the remote is
  SyncUser.ts doctor   verify symlinks and that no machine-local tree got captured
  SyncUser.ts pull     pull only, never commits. Refuses if the tree is dirty.
  SyncUser.ts sync     commit, pull --rebase, push. Halts loudly on conflict.

shared:        USER/, MEMORY/KNOWLEDGE, MEMORY/LEARNING, SYNAPSE config
machine-local: MEMORY/{${MACHINE_LOCAL.join(",")}}, SYNAPSE/amber.db
repo:          ${CONFIG_DIR}`);
}
