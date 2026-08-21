/**
 * DiskGuard Pulse module — deterministic disk-usage threshold check.
 *
 * Two disk-exhaustion incidents on one node came from snap-managed docker data
 * hiding at /var/snap/docker/common/var-lib-docker: invisible to
 * `docker system df` (the daemon doesn't account for the snap data root) and
 * to unprivileged `du`. This module makes that class of blindness impossible
 * to miss: it checks `df` on the root filesystem against warn/critical
 * thresholds and sizes a watch list of paths that always includes every
 * /var/snap/<name>/common present on the host.
 *
 * Honesty contract: a watch path the process cannot fully read reports
 * "unreadable without privilege" (verified: false) — never a fabricated 0.
 * A partial `du` (some subtrees denied) reports its bytes as a floor, not a
 * fact. A `du` that outruns its timeout says so.
 *
 * Config ([diskguard] in PULSE.toml — all optional):
 *   enabled = true
 *   warn_percent = 80          # health goes yellow at/above this root usage
 *   critical_percent = 90      # health goes red at/above this root usage
 *   watch_paths = []           # extra paths, merged with /var/snap/<name>/common discovery
 *   check_interval_seconds = 300
 *   du_timeout_ms = 30000      # per watch path
 *
 * Route: GET /api/diskguard → { checkedAt, status, thresholds, root, watchPaths }
 *        GET /api/diskguard?refresh=1 forces a fresh check
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfigToml } from "../lib";

const MODULE_NAME = "diskguard";
const PULSE_DIR = join(import.meta.dir, "..");
const SNAP_ROOT = "/var/snap";

// ── Types ──

export interface DiskGuardConfig {
  warnPercent: number;
  criticalPercent: number;
  watchPaths: string[];
  checkIntervalSeconds: number;
  duTimeoutMs: number;
}

export type UsageLevel = "ok" | "warn" | "critical";

export interface DfEntry {
  filesystem: string;
  sizeKb: number;
  usedKb: number;
  availKb: number;
  usedPercent: number;
  mount: string;
}

export interface WatchPathReport {
  path: string;
  present: boolean;
  /** Bytes on disk. null when the size could not be established at all. */
  bytes: number | null;
  human: string | null;
  /** True only when du traversed the whole tree cleanly. */
  verified: boolean;
  /** Why bytes is null or unverified. null on a clean read. */
  note: string | null;
}

interface CmdResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// ── Pure logic (exported for tests — no I/O in anything below) ──

const DEFAULTS: DiskGuardConfig = {
  warnPercent: 80,
  criticalPercent: 90,
  watchPaths: [],
  checkIntervalSeconds: 300,
  duTimeoutMs: 30_000,
};

/**
 * Fold the [diskguard] TOML section and the discovered snap common dirs into
 * a validated config. Nonsense thresholds fall back to defaults rather than
 * silently disabling the guard (warn must sit below critical, both in 1..100).
 */
export function resolveConfig(
  section: Record<string, unknown> | undefined,
  discoveredSnapDirs: string[],
): DiskGuardConfig {
  const s = section ?? {};
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  let warn = num(s.warn_percent, DEFAULTS.warnPercent);
  let critical = num(s.critical_percent, DEFAULTS.criticalPercent);
  if (warn < 1 || warn > 100 || critical < 1 || critical > 100 || warn >= critical) {
    warn = DEFAULTS.warnPercent;
    critical = DEFAULTS.criticalPercent;
  }
  const extra = Array.isArray(s.watch_paths)
    ? s.watch_paths.filter((p): p is string => typeof p === "string" && p.startsWith("/"))
    : [];
  return {
    warnPercent: warn,
    criticalPercent: critical,
    watchPaths: [...new Set([...discoveredSnapDirs, ...extra])],
    checkIntervalSeconds: Math.max(30, num(s.check_interval_seconds, DEFAULTS.checkIntervalSeconds)),
    duTimeoutMs: Math.max(1_000, num(s.du_timeout_ms, DEFAULTS.duTimeoutMs)),
  };
}

/**
 * Parse `df -P -k` output. POSIX -P guarantees one line per filesystem with
 * six columns; filesystem names and mount points may both contain spaces, so
 * anchor on the four numeric columns in the middle.
 */
export function parseDfPosix(output: string): DfEntry[] {
  const entries: DfEntry[] = [];
  for (const line of output.split("\n").slice(1)) {
    const m = line.match(/^(.+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/);
    if (!m) continue;
    entries.push({
      filesystem: m[1].trim(),
      sizeKb: parseInt(m[2], 10),
      usedKb: parseInt(m[3], 10),
      availKb: parseInt(m[4], 10),
      // Trust df's own Capacity%, which accounts for reserved blocks — the
      // number that actually reaches 100% when writes start failing.
      usedPercent: parseInt(m[5], 10),
      mount: m[6].trim(),
    });
  }
  return entries;
}

export function classifyPercent(usedPercent: number, cfg: DiskGuardConfig): UsageLevel {
  if (usedPercent >= cfg.criticalPercent) return "critical";
  if (usedPercent >= cfg.warnPercent) return "warn";
  return "ok";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const PERMISSION_RE = /permission denied|cannot read directory|cannot access|operation not permitted/i;

/**
 * Turn a `du -sk <path>` result into an honest report. The failure modes are
 * distinct and must stay distinct:
 *  - clean exit            → verified size
 *  - partial traversal     → du prints a size AND permission errors: the size
 *                            is a floor (what unprivileged traversal could
 *                            see), never the number that filled the disk
 *  - nothing readable      → no size at all: "unreadable without privilege"
 *  - timeout               → no claim about size
 */
export function interpretDu(res: CmdResult, path: string): WatchPathReport {
  const base = { path, present: true };
  if (res.timedOut) {
    return { ...base, bytes: null, human: null, verified: false, note: "du timed out — size unverified" };
  }
  const sizeMatch = res.stdout.match(/^(\d+)\s/m);
  const kb = sizeMatch ? parseInt(sizeMatch[1], 10) : null;
  const denied = PERMISSION_RE.test(res.stderr);
  if (res.exitCode === 0 && kb !== null) {
    return { ...base, bytes: kb * 1024, human: formatBytes(kb * 1024), verified: true, note: null };
  }
  if (denied && kb !== null) {
    return {
      ...base,
      bytes: kb * 1024,
      human: formatBytes(kb * 1024),
      verified: false,
      note: "partial — some entries unreadable without privilege; true size is at least this",
    };
  }
  if (denied) {
    return { ...base, bytes: null, human: null, verified: false, note: "unreadable without privilege" };
  }
  const firstErr = res.stderr.split("\n").find((l) => l.trim()) ?? `du exited ${res.exitCode}`;
  return { ...base, bytes: null, human: null, verified: false, note: firstErr.trim() };
}

/** Every /var/snap/<name>/common present on this host. Empty where /var/snap is absent (macOS). */
export function discoverSnapCommonDirs(snapRoot: string = SNAP_ROOT): string[] {
  try {
    return readdirSync(snapRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(snapRoot, e.name, "common"))
      .filter((p) => existsSync(p))
      .sort();
  } catch {
    return [];
  }
}

// ── Runtime ──

interface CheckReport {
  checkedAt: string;
  status: UsageLevel | "unknown";
  thresholds: { warnPercent: number; criticalPercent: number };
  root: (DfEntry & { level: UsageLevel }) | null;
  rootNote: string | null;
  watchPaths: WatchPathReport[];
}

const state: { running: boolean; config: DiskGuardConfig; report: CheckReport | null; timer: Timer | null } = {
  running: false,
  config: DEFAULTS,
  report: null,
  timer: null,
};

async function runCmd(cmd: string[], timeoutMs: number): Promise<CmdResult> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr, timedOut };
}

function loadConfigFromToml(): DiskGuardConfig {
  let section: Record<string, unknown> | undefined;
  try {
    const raw = readFileSync(join(PULSE_DIR, "PULSE.toml"), "utf8");
    section = parseConfigToml(raw).diskguard as Record<string, unknown> | undefined;
  } catch {
    section = undefined;
  }
  return resolveConfig(section, discoverSnapCommonDirs());
}

async function runCheck(): Promise<CheckReport> {
  const cfg = state.config;
  const checkedAt = new Date().toISOString();

  let root: CheckReport["root"] = null;
  let rootNote: string | null = null;
  const dfRes = await runCmd(["df", "-P", "-k", "/"], 10_000);
  const entries = parseDfPosix(dfRes.stdout);
  if (dfRes.exitCode === 0 && entries.length > 0) {
    root = { ...entries[0], level: classifyPercent(entries[0].usedPercent, cfg) };
  } else {
    rootNote = dfRes.timedOut
      ? "df timed out — root usage unverified"
      : `df failed (exit ${dfRes.exitCode}) — root usage unverified`;
  }

  const watchPaths: WatchPathReport[] = [];
  for (const p of cfg.watchPaths) {
    if (!existsSync(p)) {
      watchPaths.push({ path: p, present: false, bytes: null, human: null, verified: false, note: "path not present on this host" });
      continue;
    }
    watchPaths.push(interpretDu(await runCmd(["du", "-s", "-k", p], cfg.duTimeoutMs), p));
  }

  const report: CheckReport = {
    checkedAt,
    status: root ? root.level : "unknown",
    thresholds: { warnPercent: cfg.warnPercent, criticalPercent: cfg.criticalPercent },
    root,
    rootNote,
    watchPaths,
  };
  state.report = report;
  return report;
}

export async function start(): Promise<void> {
  state.config = loadConfigFromToml();
  state.running = true;
  // First check off the boot path — a slow du must not delay server startup.
  runCheck().catch((err) => console.error(`[${MODULE_NAME}] initial check failed: ${err}`));
  state.timer = setInterval(() => {
    runCheck().catch((err) => console.error(`[${MODULE_NAME}] check failed: ${err}`));
  }, state.config.checkIntervalSeconds * 1000);
  console.log(
    `[${MODULE_NAME}] started — warn ${state.config.warnPercent}% / critical ${state.config.criticalPercent}%, watching ${state.config.watchPaths.length} path(s)`,
  );
}

export async function stop(): Promise<void> {
  state.running = false;
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

export function health(): { status: string; details?: Record<string, unknown> } {
  if (!state.running) return { status: "stopped" };
  const r = state.report;
  if (!r) return { status: "healthy", details: { note: "first check pending" } };
  // warn → yellow, critical → red on the dashboard; ok/unknown stay green with
  // unknown carrying its note so an unverifiable root read is visible, not silent.
  const status = r.status === "warn" ? "warn" : r.status === "critical" ? "critical" : "healthy";
  return {
    status,
    details: {
      rootUsedPercent: r.root?.usedPercent ?? null,
      rootNote: r.rootNote,
      unverifiedWatchPaths: r.watchPaths.filter((w) => w.present && !w.verified).length,
      checkedAt: r.checkedAt,
    },
  };
}

export async function handleRequest(req: Request, pathname: string): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const sub = pathname.replace(/^\/api\/diskguard/, "") || "/";
  if (sub === "/" || sub === "/state") {
    const refresh = new URL(req.url).searchParams.get("refresh") === "1";
    const report = !state.report || refresh ? await runCheck() : state.report;
    return Response.json(report);
  }
  if (sub === "/status" || sub === "/health") return Response.json(health());
  return null;
}
