/**
 * InstallEngine — shared install logic for the LifeOS bare-skill installer.
 *
 * This is a standalone install engine, reshaped for the bare-skill context
 * from the now-retired pre-6.x GUI installer engine (detect logic + types):
 * no web/electron wizard, no separate types module, plus
 * the bare-skill extras the wizard never needed — harness detection (the skill
 * installs into Claude Code / Hermes / Cursor / OpenClaw) and dev-tree refusal
 * (never mutate the author's source repo).
 *
 * All detection here is READ-ONLY and non-destructive. The 7 setup Tools import
 * from this one sibling module (flat 2-level skill structure forbids a lib/ dir).
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// ── Types (inlined — the skill ships without the engine's types.ts) ──

export type Platform = "darwin" | "linux" | "windows";

export interface OsInfo {
  platform: Platform;
  arch: string;
  version: string;
  name: string;
}

export interface ToolInfo {
  installed: boolean;
  version?: string;
  path?: string;
}

export type Harness = "claude-code" | "opencode" | "hermes" | "cursor" | "openclaw" | "unknown";

export interface HarnessInfo {
  name: Harness;
  /** Where this harness loads skills from (absolute), if known. */
  skillsDir?: string;
  /** The config root the harness resolves (e.g. ~/.claude). */
  configRoot?: string;
  /**
   * "detected" = the harness binary was found on PATH; "assumed" = inferred
   * from a config dir alone, or the clean-machine default. The Setup workflow
   * must confirm an "assumed" harness with the user before branching (#1448 —
   * a leftover ~/.claude dir sent an OpenCode install down the Claude Code path).
   */
  confidence: "detected" | "assumed";
}

export interface EnvDetection {
  os: OsInfo;
  harness: HarnessInfo;
  /** Has a graphical session (vs headless/SSH) — gates GUI-dependent steps. */
  display: boolean;
  /** Running inside an SSH session. */
  ssh: boolean;
  bun: ToolInfo;
  git: ToolInfo;
  /**
   * A prior LifeOS install is present. Keyed on `<configRoot>/LIFEOS/VERSION`,
   * which only DeployCore writes — settings.json exists on any harness that has
   * ever run, LifeOS or not (public issue #1727, @rpriven).
   */
  existingInstall: boolean;
  /**
   * This IS the author's live source tree — refuse all mutation. Marker: the
   * private maintenance skill (`skills/_LIFEOS`) only exists in the source repo,
   * never in a public install.
   */
  isDevTree: boolean;
  settingsExists: boolean;
  claudeMdExists: boolean;
  homeDir: string;
  configRoot: string;
  timezone: string;
}

// ── Low-level probes (from engine detect.ts, unchanged) ──

function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
  } catch {
    return null;
  }
}

export function detectOS(): OsInfo {
  const platform: Platform =
    process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch;
  let version = "";
  let name = "";
  if (platform === "darwin") {
    version = tryExec("sw_vers -productVersion") || "";
    name = `macOS ${version}`.trim();
  } else if (platform === "linux") {
    name = tryExec("cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d '\"'") || "Linux";
    version = tryExec("uname -r") || "";
  } else {
    name = "Windows";
    version = tryExec("ver") || "";
  }
  return { platform, arch, version, name };
}

export function detectTool(name: string, versionCmd: string): ToolInfo {
  const path = tryExec(`command -v ${name}`);
  if (!path) return { installed: false };
  const out = tryExec(versionCmd);
  const m = out?.match(/(\d+\.\d+[.\d]*)/);
  return { installed: true, version: m?.[1] || out || undefined, path };
}

// ── Harness detection (NEW — bare-skill needs to know where it landed) ──

/**
 * Detect which harness is hosting this install and where it loads skills from.
 * Signal strength (#1448): config dir + harness binary on PATH beats config dir
 * alone beats binary alone — a leftover ~/.claude dir on a machine without the
 * claude CLI must not out-rank a live OpenCode install. Anything short of a
 * binary match is reported as confidence "assumed", never as fact.
 */
export function detectHarness(home: string): HarnessInfo {
  const candidates: Array<{ name: Harness; root: string; skills: string; bin: string }> = [
    { name: "claude-code", root: process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"), skills: "skills", bin: "claude" },
    { name: "opencode", root: process.env.OPENCODE_CONFIG_DIR || join(home, ".config", "opencode"), skills: "skills", bin: "opencode" },
    { name: "hermes", root: join(home, ".hermes"), skills: "skills", bin: "hermes" },
    { name: "cursor", root: join(home, ".cursor"), skills: "skills", bin: "cursor" },
    { name: "openclaw", root: join(home, ".openclaw"), skills: "skills", bin: "openclaw" },
  ];
  const hasBin = (c: (typeof candidates)[number]) => !!tryExec(`command -v ${c.bin}`);
  const info = (c: (typeof candidates)[number], confidence: HarnessInfo["confidence"]): HarnessInfo => ({
    name: c.name,
    configRoot: c.root,
    skillsDir: join(c.root, c.skills),
    confidence,
  });
  for (const c of candidates) {
    if (existsSync(c.root) && hasBin(c)) return info(c, "detected");
  }
  for (const c of candidates) {
    if (existsSync(c.root)) return info(c, "assumed");
  }
  for (const c of candidates) {
    if (hasBin(c)) return info(c, "detected");
  }
  // Default assumption when nothing is present yet (a clean machine pre-bootstrap).
  return { name: "claude-code", configRoot: join(home, ".claude"), skillsDir: join(home, ".claude", "skills"), confidence: "assumed" };
}

/**
 * Dev-tree refusal marker. The private maintenance skill (`skills/_LIFEOS`) exists
 * ONLY in the author's source repo — never in a public install (release tooling
 * strips all `_ALLCAPS` skills). Its presence means "this is the live source;
 * do not mutate." A `.git` remote check is a secondary signal but `<your-release-skill>` alone
 * is decisive and cheap.
 */
export function detectDevTree(configRoot: string): boolean {
  return existsSync(join(configRoot, "skills", "_LIFEOS"));
}

// ── Composite env detection (the DetectEnv Tool payload) ──

export function detectEnv(): EnvDetection {
  const home = homedir();
  const os = detectOS();
  const harness = detectHarness(home);
  const configRoot = harness.configRoot || join(home, ".claude");
  const settingsPath = join(configRoot, "settings.json");
  const claudeMdPath = join(configRoot, "CLAUDE.md");
  const ssh = !!(process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.SSH_CLIENT);
  // GUI session: macOS always has one locally; Linux needs DISPLAY/WAYLAND and not pure-SSH.
  const display =
    os.platform === "darwin" ? !ssh : !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY) && !ssh;

  return {
    os,
    harness,
    display,
    ssh,
    bun: detectTool("bun", "bun --version"),
    git: detectTool("git", "git --version"),
    // public issue #1727, @rpriven — LifeOS-specific marker, not settings.json.
    existingInstall: existsSync(join(configRoot, "LIFEOS", "VERSION")),
    isDevTree: detectDevTree(configRoot),
    settingsExists: existsSync(settingsPath),
    claudeMdExists: existsSync(claudeMdPath),
    homeDir: home,
    configRoot,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

// ── Existing-content + API-key scan (from engine detect.ts, inlined types) ──

export interface ApiKeyScan {
  elevenLabs?: string;
  anthropic?: string;
  openai?: string;
  google?: string;
  perplexity?: string;
}

/**
 * Scan shell rc files + config dirs for API-key VALUES. Returns provider → key.
 * Only well-formed assignments are accepted (no `$VAR` indirection, no
 * obvious placeholders). Read-only.
 */
export function scanApiKeys(home: string, configDir: string): ApiKeyScan {
  const candidates = [
    join(home, ".zshenv"),
    join(home, ".zshrc"),
    join(home, ".zprofile"),
    join(home, ".bashrc"),
    join(home, ".bash_profile"),
    join(home, ".profile"),
    join(configDir, ".env"),
    join(configDir, "credentials.env"),
    join(home, ".config", "LIFEOS", ".env"),
  ];
  const patterns: Array<[keyof ApiKeyScan, RegExp]> = [
    ["elevenLabs", /(?:^|\n)\s*(?:export\s+)?ELEVENLABS_API_KEY\s*=\s*["']?([^"'\s#]+)/],
    ["anthropic", /(?:^|\n)\s*(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*["']?([^"'\s#]+)/],
    ["openai", /(?:^|\n)\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*["']?([^"'\s#]+)/],
    ["google", /(?:^|\n)\s*(?:export\s+)?(?:GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENAI_API_KEY)\s*=\s*["']?([^"'\s#]+)/],
    ["perplexity", /(?:^|\n)\s*(?:export\s+)?PERPLEXITY_API_KEY\s*=\s*["']?([^"'\s#]+)/],
  ];
  const placeholder = /^(your-key-here|sk-xxxxxxxx|xxxxx|REPLACE_ME|TODO)/i;
  const found: ApiKeyScan = {};
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const [provider, regex] of patterns) {
      if (found[provider]) continue;
      const m = content.match(regex);
      if (!m) continue;
      const value = m[1];
      if (value.startsWith("$")) continue;
      if (placeholder.test(value)) continue;
      if (value.length < 12) continue;
      found[provider] = value;
    }
  }
  return found;
}

function fileExists(root: string, rel: string): boolean {
  return existsSync(join(root, rel));
}

export interface ExistingUserContent {
  telosPresent: boolean;
  identityPresent: boolean;
  contactsPresent: boolean;
  projectsPresent: boolean;
  /** True if the user config tree already holds real (non-template) content. */
  populated: boolean;
}

/**
 * Read-only scan of a user config tree for already-present content, so setup
 * can branch on "populated tree" vs "fresh scaffold" without overwriting.
 */
export function detectExistingUserContent(paiUserDir: string): ExistingUserContent {
  // Covers both the current single-file schema (TELOS/TELOS.md) and the legacy
  // split layout (TELOS/MISSION.md, TELOS/GOALS.md).
  const telosPresent =
    fileExists(paiUserDir, "TELOS/TELOS.md") ||
    fileExists(paiUserDir, "TELOS/MISSION.md") ||
    fileExists(paiUserDir, "TELOS/GOALS.md");
  const identityPresent =
    fileExists(paiUserDir, "PRINCIPAL/PRINCIPAL_IDENTITY.md") ||
    fileExists(paiUserDir, "PRINCIPAL_IDENTITY.md") ||
    fileExists(paiUserDir, "DIGITAL_ASSISTANT/DA_IDENTITY.md");
  const contactsPresent = fileExists(paiUserDir, "CONTACTS.md");
  const projectsPresent = fileExists(paiUserDir, "PROJECTS.md");
  return {
    telosPresent,
    identityPresent,
    contactsPresent,
    projectsPresent,
    populated: telosPresent || identityPresent,
  };
}

// ── Settings.json hook inspection (read-only; InstallHooks does the writes) ──

export interface SettingsHookScan {
  exists: boolean;
  hookEventCount: number;
  hookEntryCount: number;
}

/**
 * Read-only count of existing hooks in a harness settings.json, so ScanConflicts
 * can report what's already wired before InstallHooks proposes a merge.
 */
export function scanSettingsHooks(settingsPath: string): SettingsHookScan {
  if (!existsSync(settingsPath)) return { exists: false, hookEventCount: 0, hookEntryCount: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {
    return { exists: true, hookEventCount: 0, hookEntryCount: 0 };
  }
  if (typeof parsed !== "object" || parsed === null) return { exists: true, hookEventCount: 0, hookEntryCount: 0 };
  const hooks = (parsed as Record<string, unknown>).hooks;
  if (typeof hooks !== "object" || hooks === null) return { exists: true, hookEventCount: 0, hookEntryCount: 0 };
  const events = Object.keys(hooks as Record<string, unknown>);
  let entries = 0;
  for (const ev of events) {
    const bucket = (hooks as Record<string, unknown>)[ev];
    if (Array.isArray(bucket)) entries += bucket.length;
  }
  return { exists: true, hookEventCount: events.length, hookEntryCount: entries };
}

// ════════════════════════════════════════════════════════════════════
//  Mutating helpers (used by ScaffoldUser / LinkUser / ActivateImports /
//  InstallHooks). Each is purpose-built for the bare-skill installer but
//  follows the proven logic from the legacy engine actions.ts.
// ════════════════════════════════════════════════════════════════════

import { cpSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Extended 2026-07-25 (Forge finding, v7.15.0 re-audit). The set stopped at .ts,
// so every Pulse component and the built Next bundle were invisible to
// substitution — a fresh install shipped a dashboard rendering
// `desc="scored against TELOS — is this good for what {{ PRINCIPAL_NAME }} is
// actually doing?"` to the user, both in src and in the served
// out/_next/static chunk. .css carries them too (Valkyrie voice notes).
const TEMPLATE_EXTENSIONS = new Set([
  ".md", ".json", ".txt", ".ts", ".toml", ".yaml", ".yml", ".sh",
  ".tsx", ".jsx", ".js", ".css",
]);
const SKIP_DIRS = new Set(["node_modules", ".git", "MEMORY"]);

/**
 * Extension of a path's BASENAME, lowercased; "" when there is none.
 *
 * Was `filePath.slice(filePath.lastIndexOf("."))`, which searches the whole path:
 * for `~/.claude/skills/Fabric/Patterns/raycast/yt` that returns
 * ".claude/skills/Fabric/Patterns/raycast/yt" — the dot in `.claude`. Harmless by
 * accident (no such key in the set, so extension-less files were skipped), but it
 * would have mis-typed any file under a dotted directory the moment the set grew.
 */
function fileExtension(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/**
 * Recursive, existsSync-GUARDED copy. Copies only files/dirs absent at dst —
 * NEVER overwrites a populated target. Returns count + any failures. (Ported
 * from engine actions.ts copyMissing.)
 */
export function copyMissing(src: string, dst: string): { copied: number; failures: string[] } {
  const failures: string[] = [];
  let copied = 0;
  const walk = (s: string, d: string): void => {
    if (!existsSync(s)) return;
    const stat = lstatSync(s);
    if (stat.isFile()) {
      if (!existsSync(d)) {
        try {
          mkdirSync(dirname(d), { recursive: true });
          cpSync(s, d);
          copied++;
        } catch (err) {
          failures.push(`${s} → ${d}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return;
    }
    for (const entry of readdirSync(s, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const sp = join(s, entry.name);
      const dp = join(d, entry.name);
      if (entry.isDirectory()) {
        if (!existsSync(dp)) mkdirSync(dp, { recursive: true });
        walk(sp, dp);
      } else if (entry.isFile() && !existsSync(dp)) {
        try {
          cpSync(sp, dp);
          copied++;
        } catch (err) {
          failures.push(`${sp} → ${dp}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  };
  walk(src, dst);
  return { copied, failures };
}

// ── Update mode: copyChanged ──
//
// copyMissing above is deliberately additive: it is the INSTALL primitive and
// must never clobber what a prior install (or the owner) put in place. That
// same guarantee is what makes it useless for keeping a deployed tree current:
// a payload file that CHANGED between releases never reaches a populated
// target — "a second --apply copies 0" is true whether or not the payload
// moved. Measured on one estate (2026-08-30): an in-place 7.28.3→7.40.4 would
// add 160 files, silently skip 499 modified ones, and exit 0.
//
// copyChanged is the UPDATE primitive. Rules, in order, per payload entry:
//   1. SKIP_DIRS (node_modules, .git, MEMORY) are never entered.
//   2. A destination that is a SYMLINK — file or directory — is skipped whole.
//      A link in the deployed tree is owned by whoever placed it (a per-file
//      overlay into the owner's private tools, a shared MEMORY dir, the USER
//      zone) and is kept current by that owner's own lane; the payload never
//      writes through it and never replaces it.
//   3. Payload content is RENDERED first (identity placeholders substituted,
//      template extensions only — the same tokens and file set as
//      substituteTree) so a tree that was substituted at install compares
//      equal to the payload it came from. Without this every one of the ~117
//      placeholder-bearing files would read as changed on every run, and the
//      overwrite would re-introduce the raw tokens.
//   4. Missing → added. Byte-identical (sha256) → unchanged, no write.
//      Different → the prior content is preserved under `backupDir` at its
//      dst-relative path (archive-then-burn), then the rendered payload is
//      written atomically (tmp + rename, payload mode preserved).
//   5. Every write is read back and re-hashed; `verified` counts the files
//      whose on-disk hash equals the intended one. A caller asserts
//      verified === added + updated, never the exit code.
//   6. Files present in dst but absent from the payload are reported as
//      `orphans` and NEVER removed — the deployed tree legitimately carries
//      generated files, lockfiles, archived copies and owner additions.
//   7. A path the caller marks PROTECTED (`opts.protect`) is hashed and
//      reported — with whether it differs — but never written. This is for
//      payload files the node owns after install: config seeded once and then
//      edited in place, and derived files the node regenerates itself.
//
// Nothing in the payload is ever treated as owner-owned by name: a name the
// payload ships is fork-owned, and a local edit to it is drift this primitive
// corrects (and preserves aside). Owner content belongs in USER, MEMORY, or a
// symlinked overlay — the three places this never writes.

export interface CopyChangedOptions {
  /** Identity vars rendered into template-extension payload files before compare and write. */
  vars?: TemplateVars;
  /** Receives the prior content of every overwritten file at its dst-relative path, before the write. */
  backupDir?: string;
  /** Report only: hashes and classifies every file, writes nothing (no backup either). */
  dryRun?: boolean;
  /** dst-relative path (from the copyChanged root) → true to report-but-never-write. */
  protect?: (rel: string) => boolean;
}

export interface CopyChangedResult {
  /** dst paths created (absent before). */
  added: string[];
  /** dst paths overwritten, with sha256 before and after. */
  updated: Array<{ path: string; before: string; after: string }>;
  unchanged: number;
  /** dst entries skipped because they are symlinks (overlay-/owner-owned). */
  skippedSymlink: string[];
  /** dst entries skipped by name (SKIP_DIRS). */
  skippedDir: string[];
  /** dst files (or dirs, trailing "/") with no payload counterpart — reported, never removed. */
  orphans: string[];
  /** Protected paths encountered; `differs` says whether the payload has moved away from the node's copy. */
  skippedProtected: Array<{ path: string; differs: boolean }>;
  /** Writes whose read-back hash equals the intended hash (0 on dry run). */
  verified: number;
  failures: string[];
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Render a payload file exactly as substituteTree would after the copy: only
 * properly delimited identity tokens, only in template-extension files. Binary
 * and non-template files pass through byte-for-byte.
 */
function renderPayloadFile(srcPath: string, vars: TemplateVars | undefined): Buffer {
  const raw = readFileSync(srcPath);
  if (!vars || !TEMPLATE_EXTENSIONS.has(fileExtension(srcPath))) return raw;
  let text = raw.toString("utf-8");
  for (const [placeholder, value] of Object.entries(vars)) {
    if (!/^\{\{[A-Z0-9_]+\}\}$/.test(placeholder)) continue;
    if (!text.includes(placeholder)) continue;
    text = text.split(placeholder).join(value);
  }
  return Buffer.from(text, "utf-8");
}

/** Atomic replace: sibling tmp at the payload's mode, then rename over the target. */
function writeAtomic(dst: string, content: Buffer, mode: number): void {
  mkdirSync(dirname(dst), { recursive: true });
  const tmp = `${dst}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, content, { mode });
    renameSync(tmp, dst);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* the original failure is what the caller needs */ }
    throw err;
  }
}

export function copyChanged(src: string, dst: string, opts: CopyChangedOptions = {}): CopyChangedResult {
  const r: CopyChangedResult = { added: [], updated: [], unchanged: 0, skippedSymlink: [], skippedDir: [], orphans: [], skippedProtected: [], verified: 0, failures: [] };
  const fail = (what: string, err: unknown): void => {
    r.failures.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
  };

  const placeFile = (sp: string, dp: string, rel: string): void => {
    let rendered: Buffer;
    try { rendered = renderPayloadFile(sp, opts.vars); } catch (err) { fail(`read ${sp}`, err); return; }
    const after = sha256(rendered);
    let before: string | undefined;
    if (existsSync(dp)) {
      const st = lstatSync(dp);
      if (st.isSymbolicLink()) { r.skippedSymlink.push(dp); return; }
      if (!st.isFile()) { r.failures.push(`${dp}: destination is neither a file nor a symlink — not touched`); return; }
      try { before = sha256(readFileSync(dp)); } catch (err) { fail(`read ${dp}`, err); return; }
      if (opts.protect?.(rel)) { r.skippedProtected.push({ path: dp, differs: before !== after }); return; }
      if (before === after) { r.unchanged++; return; }
    }
    if (before === undefined) r.added.push(dp);
    else r.updated.push({ path: dp, before, after });
    if (opts.dryRun) return;
    try {
      if (before !== undefined && opts.backupDir) {
        const bk = join(opts.backupDir, rel);
        mkdirSync(dirname(bk), { recursive: true });
        cpSync(dp, bk);
      }
      writeAtomic(dp, rendered, statSync(sp).mode & 0o777);
      if (sha256(readFileSync(dp)) === after) r.verified++;
      else r.failures.push(`${dp}: read-back hash differs from the intended content`);
    } catch (err) {
      fail(`${sp} → ${dp}`, err);
    }
  };

  const walk = (s: string, d: string, rel: string): void => {
    if (!existsSync(s)) return;
    if (lstatSync(s).isFile()) { placeFile(s, d, rel); return; }
    if (existsSync(d) && lstatSync(d).isSymbolicLink()) { r.skippedSymlink.push(d); return; }
    const srcEntries = readdirSync(s, { withFileTypes: true });
    const names = new Set<string>();
    for (const entry of srcEntries) {
      names.add(entry.name);
      const sp = join(s, entry.name);
      const dp = join(d, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (SKIP_DIRS.has(entry.name)) { r.skippedDir.push(dp); continue; }
      if (entry.isDirectory()) {
        if (existsSync(dp) && lstatSync(dp).isSymbolicLink()) { r.skippedSymlink.push(dp); continue; }
        if (!opts.dryRun && !existsSync(dp)) {
          try { mkdirSync(dp, { recursive: true }); } catch (err) { fail(`mkdir ${dp}`, err); continue; }
        }
        walk(sp, dp, childRel);
      } else if (entry.isFile()) {
        placeFile(sp, dp, childRel);
      }
      // a symlink or special file INSIDE the payload is not something we ship; ignored
    }
    // Orphan scan: what dst holds that the payload does not. Reported only.
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (names.has(entry.name) || SKIP_DIRS.has(entry.name) || entry.isSymbolicLink()) continue;
      if (/\.tmp\.\d+\.\d+$/.test(entry.name)) continue;
      r.orphans.push(entry.isDirectory() ? `${join(d, entry.name)}/` : join(d, entry.name));
    }
  };

  walk(src, dst, "");
  return r;
}

/**
 * The identity vars an update must render — read from the canonical
 * `<configRoot>/LIFEOS/USER/CONFIG/LIFEOS_CONFIG.toml` (the same source the
 * hook layer's identity loader reads first) plus the payload's VERSION file.
 * A minimal section/key reader on purpose: this module imports nothing outside
 * node builtins, and the four keys it needs are flat strings.
 *
 * Tokens are assembled from bare keys, never written literally — see the note
 * on IDENTITY_PLACEHOLDER_KEYS.
 */
export function readIdentityVars(configRoot: string, version: string): { vars: TemplateVars; source: string; missing: string[] } {
  const source = join(configRoot, "LIFEOS", "USER", "CONFIG", "LIFEOS_CONFIG.toml");
  const missing: string[] = [];
  const sections = new Map<string, Map<string, string>>();
  if (existsSync(source)) {
    let current = "";
    for (const rawLine of readFileSync(source, "utf-8").split("\n")) {
      const line = rawLine.trim();
      const sec = line.match(/^\[([A-Za-z0-9_.-]+)\]/);
      if (sec) { current = sec[1]; if (!sections.has(current)) sections.set(current, new Map()); continue; }
      const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*"((?:[^"\\]|\\.)*)"/);
      if (kv && current) sections.get(current)!.set(kv[1], kv[2]);
    }
  } else {
    missing.push(source);
  }
  const get = (section: string, key: string): string | undefined => sections.get(section)?.get(key);
  const token = (k: string): string => "{{" + k + "}}";
  const vars: TemplateVars = {};
  const principal = get("principal", "name");
  const da = get("da", "name");
  if (principal) {
    vars[token("PRINCIPAL_NAME")] = principal;
    vars[token("PRINCIPAL_FULL_NAME")] = get("principal", "full_name") || principal;
  } else {
    missing.push("[principal] name");
  }
  if (da) {
    vars[token("DA_NAME")] = da;
    vars[token("DA_FULL_NAME")] = get("da", "full_name") || da;
  } else {
    missing.push("[da] name");
  }
  const primaryVoice = get("da.voices.main", "voice_id");
  const secondaryVoice = get("da.voices.algorithm", "voice_id");
  if (primaryVoice) vars[token("PRIMARY_VOICE_ID")] = primaryVoice;
  if (secondaryVoice) vars[token("SECONDARY_VOICE_ID")] = secondaryVoice;
  if (version) vars[token("LIFEOS_VERSION")] = version;
  else missing.push("payload VERSION");
  return { vars, source, missing };
}

export interface TemplateVars {
  [placeholder: string]: string;
}

/**
 * Walk a tree and replace `{{PLACEHOLDER}}` tokens in template-extension files.
 * Atomic per-file (tmp + rename). Skips node_modules/.git/LIFEOS_INSTALL/MEMORY.
 * (Simplified from engine actions.ts substituteTemplates.)
 */
export function substituteTree(rootDir: string, vars: TemplateVars): { scanned: number; modified: number; applied: number } {
  let scanned = 0;
  let modified = 0;
  let applied = 0;
  const entries = Object.entries(vars);
  const processFile = (filePath: string): void => {
    if (!TEMPLATE_EXTENSIONS.has(fileExtension(filePath))) return;
    scanned++;
    const before = readFileSync(filePath, "utf-8");
    let after = before;
    for (const [placeholder, value] of entries) {
      // Only substitute properly-delimited {{TOKEN}} placeholders. A caller
      // passing a bare key (e.g. "HOME") would otherwise rewrite every HOME
      // substring across settings AND source — `const HOME` became
      // `const /home/<user>` and corrupted 146 .ts files on one install
      // (public issue #1484, @docxology).
      if (!/^\{\{[A-Z0-9_]+\}\}$/.test(placeholder)) continue;
      const parts = after.split(placeholder);
      applied += parts.length - 1;
      after = parts.join(value);
    }
    if (after !== before) {
      // Preserve the original mode: writeFileSync creates the tmp at umask
      // default (0644) and renameSync replaces the inode, so without this every
      // substituted hook lost its exec bit — 10 wired hooks silently dead on a
      // fresh install (public issue #1803, @mark-219).
      const mode = statSync(filePath).mode & 0o7777;
      const tmp = filePath + ".lifeos.tmp";
      writeFileSync(tmp, after, { mode });
      renameSync(tmp, filePath);
      modified++;
    }
  };
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      // Never substitute into the redistribution payload: rendering the nested
      // skills/LifeOS/install/ copy bakes THIS user's identity into ~121
      // template files that must stay generic for the next install.
      // (public issue #1828, @Piroshki, root cause @DRAZY)
      if (entry.name === "install" && dir.endsWith(join("skills", "LifeOS"))) continue;
      const child = join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) processFile(child);
    }
  };
  if (existsSync(rootDir) && lstatSync(rootDir).isFile()) processFile(rootDir);
  else walk(rootDir);
  return { scanned, modified, applied };
}

/**
 * Identity placeholders the release sanitizer emits and `substituteTree` is
 * expected to fill. Scoped deliberately: the payload legitimately contains other
 * `{{TOKEN}}` forms (Art's thumbnail templating, Fabric pattern bodies, prose
 * about placeholders), so a blanket `{{[A-Z_]+}}` sweep is noise, not a signal.
 */
// Assembled from bare keys, never written as literal `{{KEY}}` tokens: this
// file lives under skills/LifeOS/Tools in the installed tree, so substituteTree
// walks it too. Written literally, the list itself was substituted and the
// checker went hunting for the owner's real name across the whole tree — 275
// false survivors on a clean install (2026-09-01).
const IDENTITY_PLACEHOLDER_KEYS = [
  "DA_NAME", "DA_FULL_NAME", "PRINCIPAL_NAME", "PRINCIPAL_FULL_NAME",
  "PRIMARY_VOICE_ID", "SECONDARY_VOICE_ID", "LIFEOS_VERSION",
] as const;
const IDENTITY_PLACEHOLDERS = IDENTITY_PLACEHOLDER_KEYS.map((k) => "{{" + k + "}}");

/**
 * Post-substitution verification: report any identity placeholder still present
 * in the installed tree.
 *
 * Why this exists (Forge finding D, 2026-07-25 v7.15.0 audit): `substituteTree`
 * has no code caller. The install is AI-driven by design — `Workflows/Setup.md`
 * step 34 instructs the agent to call it — so a skipped or mis-rooted step ships
 * a system that addresses its owner as `{{ PRINCIPAL_NAME }}` with nothing failing.
 * The old engine's `runSurvivingPlaceholdersCheck` covered this and was lost when
 * `engine/actions.ts` was retired; this restores it against the current engine.
 * Verification, not mutation: the caller decides whether to re-run substitution
 * or abort.
 */
export function checkSurvivingPlaceholders(rootDir: string): {
  passed: boolean; files: Array<{ file: string; placeholder: string; count: number }>; total: number;
} {
  const files: Array<{ file: string; placeholder: string; count: number }> = [];
  let total = 0;
  const processFile = (filePath: string): void => {
    if (!TEMPLATE_EXTENSIONS.has(fileExtension(filePath))) return;
    let src: string;
    try { src = readFileSync(filePath, "utf-8"); } catch { return; }
    for (const placeholder of IDENTITY_PLACEHOLDERS) {
      const count = src.split(placeholder).length - 1;
      if (count > 0) { files.push({ file: filePath, placeholder, count }); total += count; }
    }
  };
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const child = join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) processFile(child);
    }
  };
  if (existsSync(rootDir) && lstatSync(rootDir).isFile()) processFile(rootDir);
  else walk(rootDir);
  return { passed: total === 0, files, total };
}

/**
 * Establish the system/user separation contract: the live `<configRoot>/LIFEOS/USER`
 * becomes a SYMLINK to `<configDir>/USER` (the private user-data home). Copies any
 * live USER content into the data home first (existsSync-guarded), then replaces
 * the live dir with a symlink. Idempotent — a correct symlink is left untouched.
 * EXDEV (cross-filesystem) rename falls back to cp + rm. (Ported from engine.)
 */
/** Byte-compare two files; treats unreadable as "differs" (conservative). */
function filesDiffer(a: string, b: string): boolean {
  try {
    return !readFileSync(a).equals(readFileSync(b));
  } catch {
    return true;
  }
}

/**
 * Merge `src` into `dst` with LIVE-WINS semantics for the USER migration: a
 * missing dst file is copied; a byte-identical one is skipped; a DIFFERING one
 * is overwritten with src AFTER the displaced dst file is preserved aside as
 * `<file>.replaced-<stamp>`. Lossless in every direction — nothing is removed
 * without a recoverable copy. Symlinked entries are skipped (Dirent semantics).
 */
function mergeTree(src: string, dst: string, stamp: string): { copied: number; overwritten: number; preserved: number; failures: string[] } {
  let copied = 0;
  let overwritten = 0;
  let preserved = 0;
  const failures: string[] = [];
  const walk = (s: string, d: string): void => {
    if (!existsSync(s)) return;
    if (lstatSync(s).isFile()) {
      if (!existsSync(d)) {
        try { mkdirSync(dirname(d), { recursive: true }); cpSync(s, d); copied++; }
        catch (err) { failures.push(`${s} → ${d}: ${err instanceof Error ? err.message : String(err)}`); }
      } else if (filesDiffer(s, d)) {
        try { cpSync(d, `${d}.replaced-${stamp}`); cpSync(s, d); overwritten++; preserved++; }
        catch (err) { failures.push(`${s} → ${d}: ${err instanceof Error ? err.message : String(err)}`); }
      }
      return;
    }
    for (const entry of readdirSync(s, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const sp = join(s, entry.name);
      const dp = join(d, entry.name);
      if (entry.isDirectory()) { if (!existsSync(dp)) mkdirSync(dp, { recursive: true }); walk(sp, dp); }
      else if (entry.isFile()) walk(sp, dp);
    }
  };
  walk(src, dst);
  return { copied, overwritten, preserved, failures };
}

export function setupUserSeparation(
  configRoot: string,
  configDir: string,
): { action: "already-linked" | "linked" | "scaffolded-linked" | "link-repair-failed"; target: string; copied: number; overwritten?: number; preserved?: number; backup?: string; error?: string } {
  const liveUserDir = join(configRoot, "LIFEOS", "USER");
  const dataUserDir = join(configDir, "USER");

  // Same path on both sides (configDir resolves inside configRoot) — nothing to
  // separate; the rename-aside branch below would EEXIST on its own symlink and
  // strand the backup tree. Public issue #1694, @dissembler21-png.
  if (resolve(liveUserDir) === resolve(dataUserDir)) {
    return { action: "already-linked", target: dataUserDir, copied: 0 };
  }

  // Branch (a): inspect any symlink occupying liveUserDir. lstatSync does NOT
  // follow the link, so it sees a DANGLING link (target moved, deleted, or
  // restored from backup) that existsSync — which follows — reports as absent.
  // Without this, a dangling link fell through every branch to symlinkSync on an
  // occupied path, EEXIST'd, and returned a success-shaped "scaffolded-linked"
  // action with the error buried in it. (Forge cross-vendor audit 2026-08-11, [C])
  const liveLstat = lstatSync(liveUserDir, { throwIfNoEntry: false });
  if (liveLstat?.isSymbolicLink()) {
    let dest: string | null = null;
    try { dest = readlinkSync(liveUserDir); } catch { /* unreadable link → treat as stale */ }
    if (dest === dataUserDir && existsSync(liveUserDir)) {
      // Correct link, target present → genuine no-op.
      return { action: "already-linked", target: dataUserDir, copied: 0 };
    }
    // Wrong target, or dangling (target missing) → remove the stale link so the
    // rebuild branches below recreate it. Unlinking a symlink never touches the
    // target's contents.
    try {
      unlinkSync(liveUserDir);
    } catch (err) {
      return { action: "link-repair-failed", target: dataUserDir, copied: 0, error: `could not remove stale/dangling USER symlink at ${liveUserDir}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  mkdirSync(dataUserDir, { recursive: true });
  let copied = 0;

  // Branch (b): live USER is a real dir → migrate into the data home LOSSLESSLY,
  // then symlink. We RENAME the live dir aside (never rm) so the user's real tree
  // ALWAYS survives, then merge it into the data home with live-wins so real
  // content beats any template stub ScaffoldUser placed first. The backup is
  // retained and reported; recovery is always possible, including if the symlink
  // step itself fails. This fixes the prior copyMissing-then-rm data-loss path
  // where a divergent dest stub was kept and the user's real file destroyed.
  if (existsSync(liveUserDir) && lstatSync(liveUserDir).isDirectory()) {
    const stamp = String(Date.now());
    const backupDir = `${liveUserDir}.pre-link-backup-${stamp}`;
    try {
      renameSync(liveUserDir, backupDir);
    } catch (err) {
      return { action: "linked", target: dataUserDir, copied: 0, error: `could not move live USER aside before symlink: ${err instanceof Error ? err.message : String(err)}` };
    }
    const merged = mergeTree(backupDir, dataUserDir, stamp);
    copied = merged.copied;
    try {
      mkdirSync(dirname(liveUserDir), { recursive: true });
      // public issue #1730, @umair-a11y — "junction" lets Windows link a dir without
      // elevation; the arg is ignored on POSIX.
      symlinkSync(dataUserDir, liveUserDir, "junction");
      return { action: "linked", target: dataUserDir, copied, overwritten: merged.overwritten, preserved: merged.preserved, backup: backupDir };
    } catch (err) {
      return { action: "linked", target: dataUserDir, copied, overwritten: merged.overwritten, preserved: merged.preserved, backup: backupDir, error: `symlink creation failed (live USER preserved at ${backupDir}): ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // Branch (c): fresh install — scaffold the data home (if empty) + symlink.
  try {
    mkdirSync(dirname(liveUserDir), { recursive: true });
    // public issue #1730, @umair-a11y — see junction note above.
    symlinkSync(dataUserDir, liveUserDir, "junction");
    return { action: "scaffolded-linked", target: dataUserDir, copied };
  } catch (err) {
    return { action: "scaffolded-linked", target: dataUserDir, copied, error: `symlink creation failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Validate the symlink contract: `<configRoot>/LIFEOS/USER` is a symlink → `<configDir>/USER`.
 * (Ported from engine validate.ts runSymlinkContractCheck.)
 */
export function checkSymlinkContract(configRoot: string, configDir: string): { passed: boolean; detail: string } {
  const liveUserDir = join(configRoot, "LIFEOS", "USER");
  const expected = join(configDir, "USER");
  if (!existsSync(liveUserDir)) return { passed: false, detail: `missing: ${liveUserDir}` };
  const st = lstatSync(liveUserDir);
  if (!st.isSymbolicLink()) return { passed: false, detail: `${liveUserDir} is not a symlink (system/user separation broken)` };
  let target: string;
  try {
    target = readlinkSync(liveUserDir);
  } catch (err) {
    return { passed: false, detail: `readlink failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (target !== expected) return { passed: false, detail: `symlink points to ${target}, expected ${expected}` };
  return { passed: true, detail: `${liveUserDir} → ${expected}` };
}

// ── Hooks merge (InstallHooks core — the one genuinely-new piece) ──

type HookEntry = { type?: string; command?: string; url?: string; [k: string]: unknown };
type MatcherGroup = { matcher?: string; hooks?: HookEntry[]; [k: string]: unknown };
type HooksMap = Record<string, MatcherGroup[]>;

/**
 * Normalize a hook command for dedup: collapse the harness/PAI path-var forms to
 * a single canonical token and squeeze whitespace, so the same hook expressed as
 * `${LIFEOS_DIR}/x`, `$LIFEOS_DIR/x`, or `~/.claude/x` dedupes to one.
 */
function normalizeCommand(cmd: string): string {
  return cmd
    .replace(/\$\{?LIFEOS_DIR\}?|\$\{?CLAUDE_PROJECT_DIR\}?|\$\{?CLAUDE_PLUGIN_ROOT\}?|~\/\.claude|\$HOME\/\.claude|\$\{HOME\}\/\.claude/g, "§ROOT§")
    .replace(/\s+/g, " ")
    .trim();
}

/** Identity key for a hook entry: http → url, else normalized command. */
function hookKey(h: HookEntry): string {
  if (h.type === "http" && h.url) return `http:${h.url}`;
  if (h.command) return `cmd:${normalizeCommand(h.command)}`;
  return `raw:${JSON.stringify(h)}`;
}

/**
 * Additively merge `incoming` hooks into `existing` settings.hooks, per matcher
 * bucket, idempotent by normalized-command (and url for http). NEVER removes or
 * reorders a foreign entry. Returns the merged map + counts. Pure (no I/O).
 */
export function mergeHooks(existing: HooksMap, incoming: HooksMap): { merged: HooksMap; added: number; skipped: number } {
  // Deep-clone existing so we never mutate the caller's object.
  const merged: HooksMap = JSON.parse(JSON.stringify(existing ?? {}));
  let added = 0;
  let skipped = 0;

  for (const [event, incomingGroups] of Object.entries(incoming ?? {})) {
    if (!Array.isArray(merged[event])) merged[event] = [];
    const eventBucket = merged[event];

    for (const inGroup of incomingGroups) {
      const matcher = inGroup.matcher ?? "";
      const inHooks = Array.isArray(inGroup.hooks) ? inGroup.hooks : [];
      // Find a same-matcher group already present.
      let target = eventBucket.find((g) => (g.matcher ?? "") === matcher);
      if (!target) {
        // New matcher bucket — append a fresh group, then fill it (counts each hook as added).
        target = { matcher, hooks: [] };
        eventBucket.push(target);
      }
      if (!Array.isArray(target.hooks)) target.hooks = [];
      const present = new Set(target.hooks.map(hookKey));
      for (const h of inHooks) {
        const key = hookKey(h);
        if (present.has(key)) {
          skipped++;
        } else {
          target.hooks.push(h);
          present.add(key);
          added++;
        }
      }
    }
  }
  return { merged, added, skipped };
}

/**
 * Uncomment the identity `@`-imports in a CLAUDE.md, each guarded by existsSync
 * of its symlink-resolved target under configRoot. Lines shipped as
 * `<!-- @LIFEOS/USER/... -->` are activated to `@LIFEOS/USER/...` only when the target
 * resolves. Returns which imports were activated vs left commented.
 */
export function activateImports(claudeMdPath: string, configRoot: string): { activated: string[]; skipped: string[] } {
  const activated: string[] = [];
  const skipped: string[] = [];
  if (!existsSync(claudeMdPath)) return { activated, skipped };
  const lines = readFileSync(claudeMdPath, "utf-8").split("\n");
  // Two dormant-import conventions: the public CLAUDE.md ships `# @LIFEOS/USER/...`
  // (hash-prefixed so the @ isn't at line-start and Claude Code skips it); the
  // older form is `<!-- @LIFEOS/USER/... -->`. Activation strips the prefix so the
  // import sits at line-start and resolves.
  const commented = /^\s*#\s+(@[\w./-]+)\s*$|^\s*<!--\s*(@[\w./-]+)\s*-->\s*$/;
  const out = lines.map((line) => {
    const m = line.match(commented);
    if (!m) return line;
    const importPath = m[1] || m[2]; // e.g. @LIFEOS/USER/TELOS/PRINCIPAL_TELOS.md
    const rel = importPath.replace(/^@/, "");
    if (existsSync(join(configRoot, rel))) {
      activated.push(importPath);
      return importPath;
    }
    skipped.push(importPath);
    return line;
  });
  if (activated.length > 0) writeFileSync(claudeMdPath, out.join("\n"));
  return { activated, skipped };
}

export { resolve };
