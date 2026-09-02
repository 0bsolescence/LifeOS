#!/usr/bin/env bun
/**
 * DeployCore — LifeOS Core deploy step (Setup step 4.5). Lays down the two
 * things the bare skill SHIPS in its install payload but no prior Setup step
 * installed: the functional skills library and the LIFEOS runtime tree
 * (Algorithm, documentation, tools, Pulse, statusline, version, user-templates).
 * Without it a fresh install has exactly one skill, no runtime, and the active
 * `@LIFEOS/DOCUMENTATION/ARCHITECTURE_SUMMARY.md` import in CLAUDE.md dangles.
 *
 * Every install copy goes through InstallEngine.copyMissing — recursive,
 * existsSync-guarded, NEVER overwrites a populated target. So it is idempotent:
 * a second `--apply` copies 0. Dry-run by default (`--apply` to mutate); REFUSES
 * the author's live source tree (`--allow-dev` to override; exit 2). A required
 * payload source dir that is ABSENT is a LOUD blocker that fails the run
 * (exit 1) — never a silent ok (matches DeployComponents' failure contract).
 *
 * `--update` is the other half: bring an already-populated tree current with
 * the payload. Same trees (skills, runtime, hook files, dependency manifests),
 * same skips (USER, MEMORY, node_modules, .git), through InstallEngine.copyChanged
 * — sha256 compare after rendering the identity placeholders the install
 * substituted, overwrite on difference with the prior content preserved aside,
 * skip any destination that is a symlink (an overlay or shared dir belongs to
 * its own lane), report orphans and never delete them. Install mode never
 * overwrites; update mode never runs on an undeployed tree. Both are dry-run
 * by default and both assert the postcondition by count (update: every write
 * read back at the intended hash), never by exit code.
 *
 * Targets the config-root runtime at the ALL-CAPS `<configRoot>/LIFEOS/` so it
 * matches the `@LIFEOS/...` imports in CLAUDE.md (NOT mixed-case `LifeOS`).
 *
 * Usage:
 *   bun DeployCore.ts [--config-root <dir>] [--skill-root <dir>] [--apply] [--allow-dev]
 *   (dry-run by default — reports the plan per target without writing)
 *   bun DeployCore.ts --update [--apply] [--backup-dir <dir> | --no-backup] [--no-render]
 *   (dry-run by default — hashes every payload file against the deployed tree and
 *    reports added/updated/unchanged/skippedSymlink/orphans exactly, writing nothing)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { copyChanged, copyMissing, detectDevTree, readIdentityVars, type CopyChangedResult, type TemplateVars } from "./InstallEngine";

// Runtime top-level entries this tool does NOT deploy:
//  - USER           shipped separately as a scaffold (ScaffoldUser) + symlinked (LinkUser)
//  - MEMORY         per-install state, never shipped — but scaffoldMemory() creates the
//                   empty tree at install so ISASync/hooks/memory writes have a home
//                   (this is where EmitSkill's "MEMORY scaffolded fresh at setup" becomes true)
//  - node_modules / .git  never deploy
// copyMissing's own SKIP_DIRS covers MEMORY when nested, but these
// are TOP-LEVEL entries of the runtime payload, so we filter them here explicitly.
const RUNTIME_SKIP = new Set(["USER", "MEMORY", "node_modules", ".git"]);

function arg(a: string[], flag: string): string | undefined {
  const i = a.indexOf(flag);
  return i >= 0 && a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : undefined;
}

interface SkillConflict {
  payload: string;
  existing: string;
  detail: string;
}

interface DeployResult {
  what: "skills" | "runtime" | "hooks" | "memory" | "dependencies" | "nested-dependencies";
  src: string;
  dst: string;
  present: boolean;
  copied: number;
  actions: string[];
  blockers: string[];
  failures: string[];
  /** Skills NOT deployed because a pre-existing user skill collides case-insensitively. */
  conflicts?: SkillConflict[];
  /** Exact-name dirs that already existed and were merged file-additively (prior install / re-run). */
  mergedExisting?: string[];
}

/**
 * (a) skills library: install/skills/<Skill> → configRoot/skills/<Skill>,
 * deployed PER SKILL DIRECTORY with case-insensitive collision detection
 * (public issue #1506, @mygirleatsmayo). On default macOS APFS, a payload
 * `Research/` resolves into a pre-existing user `research/` — one file-level
 * copyMissing would merge LifeOS files into the user's skill while skipping
 * its own SKILL.md, leaving OUR skill headless and THEIR dir polluted, with a
 * clean-looking report. A skill is atomic: it deploys whole into a dir we
 * created, or not at all.
 *
 *  - no entry with the same lowercased name → deploy (copyMissing)
 *  - EXACT-name dir already present → file-additive merge, reported in
 *    mergedExisting (keeps re-runs idempotent for prior LifeOS installs)
 *  - case-VARIANT name present (research vs Research) → foreign dir: SKIP the
 *    whole skill, record a conflict, tell the user how to resolve
 */
function deploySkills(payloadInstall: string, configRoot: string, apply: boolean): DeployResult {
  const src = join(payloadInstall, "skills");
  const dst = join(configRoot, "skills");
  const r: DeployResult = { what: "skills", src, dst, present: existsSync(src), copied: 0, actions: [], blockers: [], failures: [], conflicts: [], mergedExisting: [] };
  if (!r.present) {
    r.blockers.push(`skills payload missing: ${src} — the bare-skill payload is unpopulated (run EmitSkill, or point --skill-root at a staged release)`);
    return r;
  }
  const existingByLower = new Map<string, string>();
  if (existsSync(dst)) {
    for (const e of readdirSync(dst)) existingByLower.set(e.toLowerCase(), e);
  }
  for (const entry of readdirSync(src, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = entry.name;
    const es = join(src, name);
    const ed = join(dst, name);
    const match = existingByLower.get(name.toLowerCase());
    if (match !== undefined && match !== name) {
      r.conflicts!.push({
        payload: name,
        existing: match,
        detail: `pre-existing '${match}' collides case-insensitively with payload '${name}' — skill NOT deployed, existing dir untouched. Resolve by renaming/moving '${join(dst, match)}', then re-run.`,
      });
      continue;
    }
    if (match === name && entry.isDirectory()) r.mergedExisting!.push(name);
    if (!apply) {
      r.actions.push(`copyMissing ${es} → ${ed}${match === name ? " (exists — file-additive merge, never overwrites)" : ""}`);
      continue;
    }
    const { copied, failures } = copyMissing(es, ed);
    r.copied += copied;
    r.failures.push(...failures);
  }
  return r;
}

/** (b) runtime: install/LIFEOS/<entry> → configRoot/LIFEOS/<entry>, skipping RUNTIME_SKIP. */
function deployRuntime(payloadInstall: string, configRoot: string, apply: boolean): DeployResult {
  // Prefer canonical all-caps LIFEOS (matches @LIFEOS/... imports on case-sensitive FS);
  // fall back to the legacy mixed-case dir so pre-fix tarballs still install.
  const src = existsSync(join(payloadInstall, "LIFEOS")) ? join(payloadInstall, "LIFEOS") : join(payloadInstall, "LifeOS");
  const dst = join(configRoot, "LIFEOS");
  const r: DeployResult = { what: "runtime", src, dst, present: existsSync(src), copied: 0, actions: [], blockers: [], failures: [] };
  if (!r.present) {
    r.blockers.push(`runtime payload missing: ${src} — the bare-skill payload is unpopulated (run EmitSkill, or point --skill-root at a staged release)`);
    return r;
  }
  // Iterate top-level entries so USER (and the other skips) are excluded while the
  // rest of the runtime is copied via the shared, never-overwrite copyMissing.
  const entries = readdirSync(src, { withFileTypes: true })
    .filter((e) => !RUNTIME_SKIP.has(e.name))
    .map((e) => e.name)
    .sort();
  if (entries.length === 0) {
    r.blockers.push(`runtime payload at ${src} has nothing to deploy after skipping ${[...RUNTIME_SKIP].join(", ")}`);
    return r;
  }
  for (const name of entries) {
    const es = join(src, name);
    const ed = join(dst, name);
    if (!apply) {
      r.actions.push(`copyMissing ${es} → ${ed}`);
      continue;
    }
    const { copied, failures } = copyMissing(es, ed);
    r.copied += copied;
    r.failures.push(...failures);
  }
  return r;
}

// MEMORY is NOT shipped in the payload (per-install state), but the runtime writes
// to it immediately (ISASync → WORK + STATE, hooks → OBSERVABILITY, memory loop →
// KNOWLEDGE/LEARNING). Without the tree a fresh install throws on first write. This
// makes EmitSkill's "MEMORY scaffolded fresh at setup" claim actually true.
const MEMORY_SUBDIRS = ["WORK", "KNOWLEDGE", "LEARNING", "STATE", "OBSERVABILITY", "SKILLS"];

/** (c) MEMORY scaffold: create the empty per-install state dirs (never overwrites). */
function scaffoldMemory(configRoot: string, apply: boolean): DeployResult {
  const dst = join(configRoot, "LIFEOS", "MEMORY");
  const r: DeployResult = { what: "memory", src: "(scaffold — not shipped)", dst, present: true, copied: 0, actions: [], blockers: [], failures: [] };
  for (const sub of MEMORY_SUBDIRS) {
    const d = join(dst, sub);
    if (existsSync(d)) continue;
    if (!apply) { r.actions.push(`mkdir -p ${d}`); continue; }
    try {
      mkdirSync(d, { recursive: true });
      r.copied++;
    } catch (err) {
      r.failures.push(`mkdir ${d}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Generate KNOWLEDGE/_schema.md so the Cortex skill's documented contract
  // exists on a fresh install — SKILL.md points at it five times, but nothing
  // shipped or generated it (public issue #1583, @elhoim). Derived from
  // KnowledgeSchema.ts, the same generated-doc pattern as ARCHITECTURE_SUMMARY.md.
  // Skipped quietly when the runtime tools aren't deployed yet (dry-run planning
  // still records the action).
  const schemaDoc = join(dst, "KNOWLEDGE", "_schema.md");
  const generator = join(configRoot, "LIFEOS", "TOOLS", "GenerateKnowledgeSchemaDoc.ts");
  if (!existsSync(schemaDoc) && existsSync(generator)) {
    if (!apply) {
      r.actions.push(`bun ${generator}`);
    } else {
      const proc = Bun.spawnSync(["bun", generator], { stdout: "pipe", stderr: "pipe" });
      if (proc.exitCode === 0) r.copied++;
      else r.failures.push(`GenerateKnowledgeSchemaDoc exited ${proc.exitCode}: ${proc.stderr.toString().trim()}`);
    }
  }
  return r;
}

/**
 * (d) shared runtime deps: install/package.json → configRoot/package.json, then
 * `bun install` in configRoot. Several deployed hooks/TOOLS scripts (e.g.
 * hooks/lib/identity.ts, LIFEOS/TOOLS/Banner.ts) import npm packages (yaml)
 * that resolve via node_modules walked up from configRoot — without this step
 * those scripts throw "Cannot find package" on first run after a fresh install.
 */
function deployDependencies(payloadInstall: string, configRoot: string, apply: boolean): DeployResult {
  const src = join(payloadInstall, "package.json");
  const dst = join(configRoot, "package.json");
  const r: DeployResult = { what: "dependencies", src, dst, present: existsSync(src), copied: 0, actions: [], blockers: [], failures: [] };
  if (!r.present) {
    r.blockers.push(`dependency manifest missing: ${src} — point --skill-root at a staged release`);
    return r;
  }
  if (!apply) {
    r.actions.push(`copyMissing ${src} → ${dst}`, `bun install --cwd ${configRoot}`);
    return r;
  }
  const { copied, failures } = copyMissing(src, dst);
  r.copied = copied;
  r.failures = failures;
  if (failures.length === 0) {
    const proc = Bun.spawnSync(["bun", "install"], { cwd: configRoot, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) {
      r.failures.push(`bun install --cwd ${configRoot} exited ${proc.exitCode}: ${proc.stderr.toString().trim()}`);
    } else {
      r.actions.push(`bun install --cwd ${configRoot}`);
    }
  }
  return r;
}

/**
 * (e) nested runtime deps (public PR #1581, @elhoim): several directories
 * INSIDE the deployed runtime tree ship their OWN package.json (LIFEOS/PULSE,
 * LIFEOS/PULSE/Observability, LIFEOS/TOOLS, ...) — declaring a dependency
 * there does not make bun/node resolve it. Module resolution stops walking up
 * at the first ancestor directory that owns a package.json, so the shared
 * configRoot/node_modules deployDependencies() just installed never satisfies
 * these. This is exactly why a fresh install died with `Cannot find package
 * 'smol-toml'` on `bun run pulse.ts`: LIFEOS/PULSE/package.json lists
 * smol-toml correctly, but nothing ever ran `bun install` inside LIFEOS/PULSE/.
 * Walk the deployed runtime tree for every package.json (skipping
 * node_modules/.git) and `bun install --cwd` each one. The Observability
 * dashboard additionally needs a build — it ships as a Next.js static export
 * (Observability/out/index.html); building it here does automatically what
 * pulse.ts otherwise reports as a copy-paste fix command, so a fresh Pulse
 * doesn't 503 until a human intervenes.
 */
function findNestedDependencyDirs(runtimeDst: string, skip: Set<string> = new Set()): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir) || skip.has(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (entry.isFile() && entry.name === "package.json") {
        found.push(dir);
      }
    }
  };
  walk(runtimeDst);
  return found.sort();
}

function deployNestedDependencies(payloadInstall: string, configRoot: string, apply: boolean): DeployResult {
  const runtimeDst = join(configRoot, "LIFEOS");
  const skillsDst = join(configRoot, "skills");
  const r: DeployResult = {
    what: "nested-dependencies", src: runtimeDst, dst: runtimeDst,
    present: existsSync(runtimeDst), copied: 0, actions: [], blockers: [], failures: [],
  };
  if (!r.present) return r; // runtime not deployed yet — deployRuntime() already reports that blocker

  // Walk skills/ alongside LIFEOS/ — skills ship nested package.json manifests
  // too (Apify, Evals, Prompting templates, Art/Remotion tools), and installing
  // only the runtime tree left them import-broken. Public issue #1605, @cristbc.
  //
  // Scoped to the skills THIS payload ships, per skill dir (ported from public
  // PR #1739, @elhoim): configRoot/skills also holds the principal's own
  // pre-existing skills — running `bun install` in those mutates dirs we never
  // deployed (and whose install we don't own), and any failure there fails OUR
  // deploy. Skills we skipped on a case-insensitive collision are excluded for
  // the same reason (not in the payload-name → deployed-dir set we created).
  const payloadSkills = join(payloadInstall, "skills");
  // The deployed LifeOS skill carries a second full copy of this very payload
  // under <skill>/install — walking it re-installs every payload skill a second
  // time, into a tree nothing imports from.
  const nestedPayload = join(skillsDst, basename(dirname(payloadInstall)), "install");
  const ownSkillDirs = existsSync(payloadSkills)
    ? readdirSync(payloadSkills, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(skillsDst, e.name))
        .filter(existsSync)
    : [];
  const dirs = [
    ...findNestedDependencyDirs(runtimeDst),
    ...ownSkillDirs.flatMap((d) => findNestedDependencyDirs(d, new Set([nestedPayload]))),
  ];
  for (const dir of dirs) {
    const isObservability = dir === join(runtimeDst, "PULSE", "Observability");
    const needsBuild = isObservability && !existsSync(join(dir, "out", "index.html"));

    if (!apply) {
      r.actions.push(`bun install --cwd ${dir}`);
      if (needsBuild) r.actions.push(`bun run build --cwd ${dir}`);
      continue;
    }

    const proc = Bun.spawnSync(["bun", "install"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) {
      r.failures.push(`bun install --cwd ${dir} exited ${proc.exitCode}: ${proc.stderr.toString().trim()}`);
      continue;
    }
    r.copied++;
    r.actions.push(`bun install --cwd ${dir}`);

    // Build the Observability dashboard once its deps resolve — see comment above.
    if (needsBuild) {
      const build = Bun.spawnSync(["bun", "run", "build"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      if (build.exitCode !== 0) {
        r.failures.push(`bun run build --cwd ${dir} exited ${build.exitCode}: ${build.stderr.toString().trim()}`);
      } else {
        r.actions.push(`bun run build --cwd ${dir}`);
      }
    }
  }
  return r;
}

// ── Update mode (--update) ────────────────────────────────────────────────────
//
// Install mode above is additive by contract and stays untouched. Update mode
// is the other half: bring a POPULATED deployed tree current with the payload
// it came from. Same three trees the install lays down, same skips, one new
// rule — a destination that is a symlink belongs to whoever linked it and is
// never written through or replaced (InstallEngine.copyChanged states the full
// rule set). Dry-run by default; `--apply` writes; the postcondition is the
// read-back hash count, and `ok` requires verified === added + updated.

// Payload files the NODE owns once installed. Update mode hashes and reports
// them (so upstream movement is visible) but never writes them:
//  - PULSE/PULSE.toml            seeded config, edited in place (voice engine, modules)
//  - DOCUMENTATION/ARCHITECTURE_SUMMARY.md   regenerated on the node by a SessionEnd hook
//  - bun.lock (any dir)          rewritten by the node's own `bun install`
// Paths are configRoot-relative; names match at any depth.
const UPDATE_PROTECTED_PATHS = new Set([
  "LIFEOS/PULSE/PULSE.toml",
  "LIFEOS/DOCUMENTATION/ARCHITECTURE_SUMMARY.md",
]);
const UPDATE_PROTECTED_NAMES = new Set(["bun.lock"]);
function protectedUnder(prefix: string): (rel: string) => boolean {
  return (rel) => UPDATE_PROTECTED_PATHS.has(`${prefix}/${rel}`) || UPDATE_PROTECTED_NAMES.has(basename(rel));
}

interface UpdateContext {
  apply: boolean;
  vars?: TemplateVars;
  backupDir?: string;
}

interface UpdateResult extends DeployResult {
  added: string[];
  updated: Array<{ path: string; before: string; after: string }>;
  unchanged: number;
  skippedSymlink: string[];
  orphans: string[];
  skippedProtected: Array<{ path: string; differs: boolean }>;
  verified: number;
}

function emptyUpdate(what: DeployResult["what"], src: string, dst: string): UpdateResult {
  return { what, src, dst, present: existsSync(src), copied: 0, actions: [], blockers: [], failures: [], added: [], updated: [], unchanged: 0, skippedSymlink: [], orphans: [], skippedProtected: [], verified: 0 };
}

function fold(r: UpdateResult, c: CopyChangedResult): void {
  r.added.push(...c.added);
  r.updated.push(...c.updated);
  r.unchanged += c.unchanged;
  r.skippedSymlink.push(...c.skippedSymlink);
  r.orphans.push(...c.orphans);
  r.skippedProtected.push(...c.skippedProtected);
  r.verified += c.verified;
  r.failures.push(...c.failures);
  r.copied += c.added.length + c.updated.length;
}

/** (a') skills: per payload skill dir, same case-insensitive collision rule as install. */
function updateSkills(payloadInstall: string, configRoot: string, ctx: UpdateContext): UpdateResult {
  const src = join(payloadInstall, "skills");
  const dst = join(configRoot, "skills");
  const r = emptyUpdate("skills", src, dst);
  r.conflicts = [];
  if (!r.present) {
    r.blockers.push(`skills payload missing: ${src} — point --skill-root at the payload tree`);
    return r;
  }
  const existingByLower = new Map<string, string>();
  if (existsSync(dst)) {
    for (const e of readdirSync(dst)) existingByLower.set(e.toLowerCase(), e);
  }
  for (const entry of readdirSync(src, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = entry.name;
    const match = existingByLower.get(name.toLowerCase());
    if (match !== undefined && match !== name) {
      r.conflicts.push({
        payload: name,
        existing: match,
        detail: `pre-existing '${match}' collides case-insensitively with payload '${name}' — skill NOT updated, existing dir untouched. Resolve by renaming/moving '${join(dst, match)}', then re-run.`,
      });
      continue;
    }
    r.actions.push(`copyChanged ${join(src, name)} → ${join(dst, name)}`);
    fold(r, copyChanged(join(src, name), join(dst, name), { vars: ctx.vars, backupDir: ctx.backupDir && join(ctx.backupDir, "skills", name), dryRun: !ctx.apply, protect: protectedUnder(`skills/${name}`) }));
  }
  return r;
}

/** (b') runtime: install/LIFEOS/<entry> → configRoot/LIFEOS/<entry>, RUNTIME_SKIP excluded, symlinks skipped. */
function updateRuntime(payloadInstall: string, configRoot: string, ctx: UpdateContext): UpdateResult {
  const src = existsSync(join(payloadInstall, "LIFEOS")) ? join(payloadInstall, "LIFEOS") : join(payloadInstall, "LifeOS");
  const dst = join(configRoot, "LIFEOS");
  const r = emptyUpdate("runtime", src, dst);
  if (!r.present) {
    r.blockers.push(`runtime payload missing: ${src} — point --skill-root at the payload tree`);
    return r;
  }
  if (!existsSync(dst)) {
    r.blockers.push(`${dst} is not deployed — update mode brings a populated tree current; run the install (--apply without --update) first`);
    return r;
  }
  const entries = readdirSync(src, { withFileTypes: true })
    .filter((e) => !RUNTIME_SKIP.has(e.name))
    .map((e) => e.name)
    .sort();
  for (const name of entries) {
    r.actions.push(`copyChanged ${join(src, name)} → ${join(dst, name)}`);
    fold(r, copyChanged(join(src, name), join(dst, name), { vars: ctx.vars, backupDir: ctx.backupDir && join(ctx.backupDir, "LIFEOS", name), dryRun: !ctx.apply, protect: protectedUnder(`LIFEOS/${name}`) }));
  }
  return r;
}

/**
 * (f') hook FILES: install/hooks → configRoot/hooks. The install copies these
 * with force:false (InstallHooks, Setup step 7) and the wiring in settings.json
 * is that tool's job — this leg only keeps the bodies current. A hook the
 * owner declined never gets wired by an update; a hook that was wired gets its
 * current body. Wiring drift is reported by InstallHooks' own dry-run.
 */
function updateHooks(payloadInstall: string, configRoot: string, ctx: UpdateContext): UpdateResult {
  const src = join(payloadInstall, "hooks");
  const dst = join(configRoot, "hooks");
  const r = emptyUpdate("hooks", src, dst);
  if (!r.present) {
    r.blockers.push(`hooks payload missing: ${src} — point --skill-root at the payload tree`);
    return r;
  }
  if (!existsSync(dst)) {
    r.actions.push(`${dst} absent — hooks were never installed on this tree (declined or pre-step-7); nothing to update`);
    return r;
  }
  r.actions.push(`copyChanged ${src} → ${dst}`);
  fold(r, copyChanged(src, dst, { vars: ctx.vars, backupDir: ctx.backupDir && join(ctx.backupDir, "hooks"), dryRun: !ctx.apply, protect: protectedUnder("hooks") }));
  return r;
}

/**
 * (d') shared runtime deps in update mode: the manifest is brought current with
 * copyChanged, and `bun install` runs only when it changed or node_modules is
 * absent — a no-change run spawns nothing.
 */
function updateDependencies(payloadInstall: string, configRoot: string, ctx: UpdateContext): UpdateResult {
  const src = join(payloadInstall, "package.json");
  const dst = join(configRoot, "package.json");
  const r = emptyUpdate("dependencies", src, dst);
  if (!r.present) {
    r.blockers.push(`dependency manifest missing: ${src} — point --skill-root at the payload tree`);
    return r;
  }
  fold(r, copyChanged(src, dst, { backupDir: ctx.backupDir && join(ctx.backupDir, "package.json.d"), dryRun: !ctx.apply }));
  const needsInstall = r.added.length + r.updated.length > 0 || !existsSync(join(configRoot, "node_modules"));
  if (!needsInstall) return r;
  if (!ctx.apply) { r.actions.push(`bun install --cwd ${configRoot}`); return r; }
  if (r.failures.length > 0) return r;
  const proc = Bun.spawnSync(["bun", "install"], { cwd: configRoot, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) r.failures.push(`bun install --cwd ${configRoot} exited ${proc.exitCode}: ${proc.stderr.toString().trim()}`);
  else r.actions.push(`bun install --cwd ${configRoot}`);
  return r;
}

/** (e') nested deps in update mode: only dirs whose package.json moved, or that have no node_modules yet. */
function updateNestedDependencies(payloadInstall: string, configRoot: string, ctx: UpdateContext, changedPaths: Set<string>): UpdateResult {
  const runtimeDst = join(configRoot, "LIFEOS");
  const skillsDst = join(configRoot, "skills");
  const r = emptyUpdate("nested-dependencies", runtimeDst, runtimeDst);
  if (!r.present) return r;
  const payloadSkills = join(payloadInstall, "skills");
  const nestedPayload = join(skillsDst, basename(dirname(payloadInstall)), "install");
  const ownSkillDirs = existsSync(payloadSkills)
    ? readdirSync(payloadSkills, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(skillsDst, e.name))
        .filter(existsSync)
    : [];
  const dirs = [
    ...findNestedDependencyDirs(runtimeDst),
    ...ownSkillDirs.flatMap((d) => findNestedDependencyDirs(d, new Set([nestedPayload]))),
  ].filter((dir) => changedPaths.has(join(dir, "package.json")) || !existsSync(join(dir, "node_modules")));
  for (const dir of dirs) {
    if (!ctx.apply) { r.actions.push(`bun install --cwd ${dir}`); continue; }
    const proc = Bun.spawnSync(["bun", "install"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) { r.failures.push(`bun install --cwd ${dir} exited ${proc.exitCode}: ${proc.stderr.toString().trim()}`); continue; }
    r.copied++;
    r.actions.push(`bun install --cwd ${dir}`);
  }
  return r;
}

function runUpdate(payloadInstall: string, configRoot: string, a: string[], apply: boolean): void {
  const versionFile = join(payloadInstall, "LIFEOS", "VERSION");
  const version = existsSync(versionFile) ? readFileSync(versionFile, "utf-8").trim() : "";
  const noRender = a.includes("--no-render");
  const identity = noRender ? undefined : readIdentityVars(configRoot, version);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const backupDir = a.includes("--no-backup")
    ? undefined
    : arg(a, "--backup-dir") || join(configRoot, "LIFEOS", "MEMORY", "STATE", "deploy-updates", stamp);
  const ctx: UpdateContext = { apply, vars: identity?.vars, backupDir };

  // Rendering is what keeps an update idempotent against a substituted tree.
  // Missing identity is a blocker, not a fallback: writing raw tokens over a
  // rendered tree would un-name the owner's system and call it an update.
  const blockersEarly: string[] = [];
  if (identity && identity.missing.length > 0) {
    blockersEarly.push(`identity vars unavailable (${identity.missing.join(", ")}) from ${identity.source} — refusing to render; pass --no-render only for a tree that was never substituted`);
  }

  const results: UpdateResult[] = [];
  if (blockersEarly.length === 0) {
    results.push(updateSkills(payloadInstall, configRoot, ctx));
    results.push(updateRuntime(payloadInstall, configRoot, ctx));
    results.push(updateHooks(payloadInstall, configRoot, ctx));
    results.push(updateDependencies(payloadInstall, configRoot, ctx));
    const changedPaths = new Set<string>(results.flatMap((r) => [...r.added, ...r.updated.map((u) => u.path)]));
    results.push(updateNestedDependencies(payloadInstall, configRoot, ctx, changedPaths));
  }
  const memory = scaffoldMemory(configRoot, apply);

  const blockers = [...blockersEarly, ...results.flatMap((r) => r.blockers), ...memory.blockers];
  const failures = [...results.flatMap((r) => r.failures), ...memory.failures];
  const added = results.reduce((n, r) => n + r.added.length, 0);
  const updated = results.reduce((n, r) => n + r.updated.length, 0);
  const unchanged = results.reduce((n, r) => n + r.unchanged, 0);
  const skippedSymlink = results.reduce((n, r) => n + r.skippedSymlink.length, 0);
  const orphans = results.reduce((n, r) => n + r.orphans.length, 0);
  const protectedAll = results.flatMap((r) => r.skippedProtected);
  const protectedDrift = protectedAll.filter((p) => p.differs).map((p) => p.path);
  const verified = results.reduce((n, r) => n + r.verified, 0);
  const skillConflicts = results.find((r) => r.what === "skills")?.conflicts ?? [];
  // The postcondition: every write read back at the intended hash. Not the exit code.
  const postconditionMet = !apply || verified === added + updated;
  if (apply && !postconditionMet) failures.push(`postcondition: verified ${verified} != added ${added} + updated ${updated}`);
  const ok = blockers.length === 0 && failures.length === 0;

  const notes: string[] = [];
  if (skillConflicts.length > 0) notes.push(`⚠️ ${skillConflicts.length} skill(s) NOT updated — case-insensitive name collision (see skillConflicts).`);
  if (!apply) notes.push("dry-run — re-run with --update --apply to write (counts above are exact: every file was hashed)");
  if (apply && backupDir && updated > 0) notes.push(`prior content of ${updated} overwritten file(s) preserved under ${backupDir}`);
  if (protectedDrift.length > 0) notes.push(`${protectedDrift.length} node-owned file(s) differ from the payload and were NOT written (see protectedDrift) — merge by hand if the upstream change matters`);

  console.log(JSON.stringify({
    ok,
    mode: "update",
    dryRun: !apply,
    configRoot,
    payloadInstall,
    payloadVersion: version || undefined,
    identitySource: identity?.source,
    rendered: !noRender,
    backupDir: apply && updated > 0 ? backupDir : undefined,
    summary: { added, updated, unchanged, skippedSymlink, orphans, protected: protectedAll.length, protectedDrift: protectedDrift.length, verified },
    protectedDrift,
    skillConflicts,
    blockers,
    failures,
    results: results.map((r) => ({
      what: r.what, src: r.src, dst: r.dst, present: r.present,
      added: r.added, updated: r.updated, unchanged: r.unchanged,
      skippedSymlink: r.skippedSymlink, orphans: r.orphans, skippedProtected: r.skippedProtected, verified: r.verified,
      actions: r.actions, blockers: r.blockers, failures: r.failures,
    })),
    memory,
    note: notes.length > 0 ? notes.join(" | ") : undefined,
  }, null, 2));
  process.exit(ok ? 0 : 1);
}

function main(): void {
  const a = process.argv.slice(2);
  const home = process.env.HOME || homedir();
  const configRoot = arg(a, "--config-root") || process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const skillRoot = arg(a, "--skill-root") || join(import.meta.dir, "..");
  const payloadInstall = join(skillRoot, "install");
  const apply = a.includes("--apply");
  const allowDev = a.includes("--allow-dev");
  const update = a.includes("--update");

  if (detectDevTree(configRoot) && !allowDev) {
    console.log(JSON.stringify({
      ok: false,
      refused: "dev-tree",
      detail: `${configRoot} is a LifeOS source tree (dev-tree marker present) — refusing to deploy core. Use --allow-dev only in a sandbox.`,
    }, null, 2));
    process.exit(2);
  }

  if (update) {
    runUpdate(payloadInstall, configRoot, a, apply);
    return;
  }

  const results = [
    deploySkills(payloadInstall, configRoot, apply),
    deployRuntime(payloadInstall, configRoot, apply),
    scaffoldMemory(configRoot, apply),
    deployDependencies(payloadInstall, configRoot, apply),
    deployNestedDependencies(payloadInstall, configRoot, apply),
  ];

  // A missing required payload source (blocker) or a copy failure is a hard
  // failure, not a silent success — `ok` requires both lists empty.
  const blockers = results.flatMap((r) => r.blockers);
  const failures = results.flatMap((r) => r.failures);
  const ok = blockers.length === 0 && failures.length === 0;
  const skillsResult = results.find((r) => r.what === "skills");
  const skillsCopied = skillsResult?.copied ?? 0;
  const runtimeCopied = results.find((r) => r.what === "runtime")?.copied ?? 0;
  const skillConflicts = skillsResult?.conflicts ?? [];

  const notes: string[] = [];
  if (skillConflicts.length > 0) {
    notes.push(`⚠️ ${skillConflicts.length} skill(s) NOT deployed — case-insensitive name collision with pre-existing skills (see skillConflicts). SURFACE THIS TO THE USER: their dirs were left untouched, and the colliding LifeOS skills are not installed until resolved.`);
  }
  if (!apply) notes.push("dry-run — re-run with --apply to deploy (a blocked source fails the run in both modes)");

  console.log(JSON.stringify({
    ok,
    dryRun: !apply,
    configRoot,
    payloadInstall,
    skillsDst: join(configRoot, "skills"),
    runtimeDst: join(configRoot, "LIFEOS"),
    skillsCopied,
    runtimeCopied,
    skillConflicts,
    blockers,
    failures,
    results,
    note: notes.length > 0 ? notes.join(" | ") : undefined,
  }, null, 2));
  process.exit(ok ? 0 : 1);
}

main();
