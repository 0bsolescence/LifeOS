#!/usr/bin/env bun
/**
 * amber — Linux-native amber ledger for Synapse (the LifeOS input router).
 *
 * Upstream Synapse assumes Cloudflare D1 + a `com.lifeos.amberroute` launchd job,
 * neither of which exists on Linux. This is a local-first equivalent implementing
 * the same Capture Contract from DOCUMENTATION/Synapse/SynapseSystem.md:
 *
 *   - Write-ahead: the record hits the ledger FIRST, unconditionally, before grading.
 *   - Idempotent: dedup identity = normalized url + content hash, falling back to
 *     source + external_id. The same item from three inputs is one row.
 *   - Append-only: raw rows are immutable. Grading and routing ENRICH via a separate
 *     `grades` table; they never rewrite the capture.
 *   - Preservation is unconditional; only ROUTING depends on the score.
 *
 * Deliberately NOT replicated: the Arbol summarize/TELOS-classifier workers. Grading
 * here is explicit (`amber grade`), so an agent or a human sets the weight. The cloud
 * auto-grader is a cloud feature; this tool does not pretend otherwise.
 *
 * Storage lives in the USER zone so it survives upgrades and is sync-eligible:
 *   ~/.config/LIFEOS/SYNAPSE/amber.db   (override with LIFEOS_CONFIG_DIR)
 *
 * Usage:
 *   amber capture --kind note --content "..." [--source cli] [--url U] [--title T]
 *                 [--author A] [--privacy personal|public] [--external-id ID]
 *   amber list [--limit N] [--route R] [--ungraded] [--json]
 *   amber grade <id> --score 0-100 [--route R] [--version v1] [--summary "..."]
 *   amber route [--threshold N] [--apply]
 *   amber stats
 *   amber show <id>
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const ROUTES = [
  "knowledge", "learning", "help_understand", "project_integration", "tech_upgrade",
  "telos_modification", "work_item", "reminder", "blog_seed", "none",
] as const;
type Route = (typeof ROUTES)[number];

const CONFIG_DIR = process.env.LIFEOS_CONFIG_DIR || join(process.env.HOME || "", ".config", "LIFEOS");
const DB_DIR = join(CONFIG_DIR, "SYNAPSE");
const DB_PATH = join(DB_DIR, "amber.db");

function db(): Database {
  mkdirSync(DB_DIR, { recursive: true });
  const d = new Database(DB_PATH, { create: true });
  d.exec("PRAGMA journal_mode = WAL;");
  // Raw captures. Immutable by contract; no UPDATE path exists in this tool.
  d.exec(`
    CREATE TABLE IF NOT EXISTS captures (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      dedup_key     TEXT NOT NULL UNIQUE,
      source        TEXT NOT NULL,
      external_id   TEXT NOT NULL,
      url           TEXT,
      content       TEXT,
      content_hash  TEXT,
      captured_at   TEXT NOT NULL,
      content_kind  TEXT NOT NULL,
      title         TEXT,
      author        TEXT,
      privacy_class TEXT NOT NULL CHECK (privacy_class IN ('public','personal'))
    );`);
  // Enrichment. Grades append; the newest row per capture wins.
  d.exec(`
    CREATE TABLE IF NOT EXISTS grades (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      capture_id    INTEGER NOT NULL REFERENCES captures(id),
      score         INTEGER NOT NULL,
      route         TEXT,
      grade_version TEXT NOT NULL,
      summary       TEXT,
      graded_at     TEXT NOT NULL
    );`);
  // Every routed action is logged for audit, per the Route contract.
  d.exec(`
    CREATE TABLE IF NOT EXISTS routed_actions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      capture_id  INTEGER NOT NULL REFERENCES captures(id),
      route       TEXT NOT NULL,
      action      TEXT NOT NULL,
      detail      TEXT,
      acted_at    TEXT NOT NULL
    );`);
  d.exec("CREATE INDEX IF NOT EXISTS idx_grades_capture ON grades(capture_id);");
  return d;
}

/** Normalize a URL for dedup: strip tracking params, trailing slash, fragment. */
function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref$|ref_src|si$)/i.test(p)) u.searchParams.delete(p);
    }
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s.toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function arg(flag: string): string | undefined {
  const a = process.argv.slice(2);
  const i = a.indexOf(flag);
  return i >= 0 && a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : undefined;
}
const has = (flag: string) => process.argv.slice(2).includes(flag);
const out = (o: unknown) => console.log(JSON.stringify(o, null, 2));

function cmdCapture(): void {
  const content = arg("--content");
  const url = arg("--url");
  if (!content && !url) {
    out({ ok: false, error: "capture needs --content or --url (contract: url OR content required)" });
    process.exit(1);
  }
  const source = arg("--source") || "cli";
  const kind = arg("--kind") || "note";
  const privacy = (arg("--privacy") || "personal") as "public" | "personal";
  if (privacy !== "public" && privacy !== "personal") {
    out({ ok: false, error: "--privacy must be public or personal" });
    process.exit(1);
  }
  const contentHash = content ? sha(content) : null;
  // Dedup identity per contract: normalized url + content hash, else source+external_id.
  const externalId = arg("--external-id") || (url ? normalizeUrl(url) : contentHash!.slice(0, 16));
  const dedupKey = url ? `url:${normalizeUrl(url)}:${contentHash ?? ""}` : `sid:${source}:${externalId}`;
  const capturedAt = new Date().toISOString();

  const d = db();
  const existing = d.query("SELECT id FROM captures WHERE dedup_key = ?").get(dedupKey) as { id: number } | null;
  if (existing) {
    out({ ok: true, deduped: true, id: existing.id, note: "already in the ledger; nothing entering Synapse is ever lost or duplicated" });
    return;
  }
  d.query(
    `INSERT INTO captures (dedup_key, source, external_id, url, content, content_hash, captured_at, content_kind, title, author, privacy_class)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(dedupKey, source, externalId, url ?? null, content ?? null, contentHash, capturedAt, kind, arg("--title") ?? null, arg("--author") ?? null, privacy);
  const id = (d.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  out({ ok: true, id, captured_at: capturedAt, source, content_kind: kind, privacy_class: privacy, ledger: DB_PATH });
}

function cmdList(): void {
  const limit = Number(arg("--limit") || 20);
  const route = arg("--route");
  const d = db();
  let sql = `
    SELECT c.id, c.captured_at, c.source, c.content_kind, c.privacy_class, c.title, c.url,
           substr(COALESCE(c.content,''),1,120) AS excerpt,
           g.score, g.route, g.summary
    FROM captures c
    LEFT JOIN grades g ON g.id = (SELECT id FROM grades WHERE capture_id = c.id ORDER BY id DESC LIMIT 1)`;
  const where: string[] = [];
  if (has("--ungraded")) where.push("g.id IS NULL");
  if (route) where.push(`g.route = '${route.replace(/'/g, "")}'`);
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY c.id DESC LIMIT ?";
  const rows = d.query(sql).all(limit) as Record<string, unknown>[];
  if (has("--json")) return out(rows);
  if (!rows.length) return console.log("ledger empty (or no rows match)");
  for (const r of rows) {
    const g = r.score == null ? "ungraded" : `${r.score} → ${r.route ?? "unrouted"}`;
    console.log(`#${r.id}  [${r.content_kind}] ${r.title || r.excerpt || r.url || ""}`);
    console.log(`      ${r.captured_at}  src=${r.source}  ${r.privacy_class}  ${g}`);
  }
}

function cmdGrade(): void {
  const id = Number(process.argv[3]);
  const score = Number(arg("--score"));
  if (!id || Number.isNaN(score)) { out({ ok: false, error: "usage: amber grade <id> --score 0-100 [--route R]" }); process.exit(1); }
  const route = arg("--route") as Route | undefined;
  if (route && !ROUTES.includes(route)) { out({ ok: false, error: `--route must be one of: ${ROUTES.join(", ")}` }); process.exit(1); }
  const d = db();
  if (!d.query("SELECT id FROM captures WHERE id = ?").get(id)) { out({ ok: false, error: `no capture #${id}` }); process.exit(1); }
  d.query(`INSERT INTO grades (capture_id, score, route, grade_version, summary, graded_at) VALUES (?,?,?,?,?,?)`)
    .run(id, score, route ?? null, arg("--version") || "local-v1", arg("--summary") ?? null, new Date().toISOString());
  out({ ok: true, id, score, route: route ?? null, note: "grades append; the raw capture is never rewritten" });
}

function cmdRoute(): void {
  const threshold = Number(arg("--threshold") || 60);
  const apply = has("--apply");
  const d = db();
  const rows = d.query(`
    SELECT c.id, c.title, c.content, g.score, g.route
    FROM captures c JOIN grades g ON g.id = (SELECT id FROM grades WHERE capture_id = c.id ORDER BY id DESC LIMIT 1)
    WHERE g.score >= ? AND g.route IS NOT NULL AND g.route != 'none'
      AND NOT EXISTS (SELECT 1 FROM routed_actions ra WHERE ra.capture_id = c.id)
  `).all(threshold) as { id: number; title: string; content: string; score: number; route: Route }[];

  if (!apply) {
    out({ ok: true, dryRun: true, threshold, wouldRoute: rows.map(r => ({ id: r.id, score: r.score, route: r.route, title: r.title })), note: "re-run with --apply to log routed_actions" });
    return;
  }
  const now = new Date().toISOString();
  for (const r of rows) {
    d.query(`INSERT INTO routed_actions (capture_id, route, action, detail, acted_at) VALUES (?,?,?,?,?)`)
      .run(r.id, r.route, "logged", `score ${r.score} cleared threshold ${threshold}`, now);
  }
  out({ ok: true, threshold, routed: rows.length, ids: rows.map(r => r.id) });
}

function cmdStats(): void {
  const d = db();
  const one = (q: string) => (d.query(q).get() as Record<string, number>);
  out({
    ledger: DB_PATH,
    total_captures: one("SELECT COUNT(*) AS n FROM captures").n,
    graded: one("SELECT COUNT(DISTINCT capture_id) AS n FROM grades").n,
    ungraded: one("SELECT COUNT(*) AS n FROM captures c WHERE NOT EXISTS (SELECT 1 FROM grades g WHERE g.capture_id = c.id)").n,
    routed: one("SELECT COUNT(DISTINCT capture_id) AS n FROM routed_actions").n,
    by_route: d.query("SELECT route, COUNT(*) AS n FROM grades WHERE route IS NOT NULL GROUP BY route ORDER BY n DESC").all(),
    by_kind: d.query("SELECT content_kind, COUNT(*) AS n FROM captures GROUP BY content_kind ORDER BY n DESC").all(),
  });
}

function cmdShow(): void {
  const id = Number(process.argv[3]);
  const d = db();
  const cap = d.query("SELECT * FROM captures WHERE id = ?").get(id);
  if (!cap) { out({ ok: false, error: `no capture #${id}` }); process.exit(1); }
  out({ capture: cap, grades: d.query("SELECT * FROM grades WHERE capture_id = ? ORDER BY id").all(id), routed_actions: d.query("SELECT * FROM routed_actions WHERE capture_id = ? ORDER BY id").all(id) });
}

const cmd = process.argv[2];
switch (cmd) {
  case "capture": cmdCapture(); break;
  case "list": cmdList(); break;
  case "grade": cmdGrade(); break;
  case "route": cmdRoute(); break;
  case "stats": cmdStats(); break;
  case "show": cmdShow(); break;
  default:
    console.log(`amber — Linux-native amber ledger for Synapse

  amber capture --kind note --content "..." [--source S] [--url U] [--title T] [--privacy personal|public]
  amber list [--limit N] [--route R] [--ungraded] [--json]
  amber grade <id> --score 0-100 [--route R] [--summary "..."]
  amber route [--threshold N] [--apply]
  amber show <id>
  amber stats

Routes: ${ROUTES.join(" | ")}
Ledger: ${DB_PATH}`);
}
