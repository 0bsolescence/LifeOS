#!/usr/bin/env bun
/**
 * @version 1.0.1
 * FeedPull.ts — deterministic morning-headlines capture. NO MODEL IN THE LOOP.
 *
 * Reads the feed roster from USER/CONFIG/FEEDS.json, fetches each RSS/Atom
 * feed, and writes deduplicated headlines to MEMORY/DATA/Headlines/. Grading
 * against TELOS is triage and happens in-session at the morning summons —
 * this tool only captures (capture-vs-triage doctrine, KNOWLEDGE 2026-08).
 *
 * Postconditions (Rule 6 discipline):
 *   - latest.json rewritten with a run stamp and per-feed status
 *   - exit 0 when at least one feed answered; exit 1 when ALL feeds failed
 *   - a dead feed is a logged status line, never a crash
 *
 * Usage:
 *   bun FeedPull.ts            # pull all topics
 *   bun FeedPull.ts --status   # print last run's per-feed status, pull nothing
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const CONFIG = join(HOME, ".claude", "LIFEOS", "USER", "CONFIG", "FEEDS.json");
const OUT_DIR = join(HOME, ".claude", "LIFEOS", "MEMORY", "DATA", "Headlines");
const SEEN_PATH = join(OUT_DIR, "seen.json");
const SEEN_CAP = 5000;
const PER_FEED_CAP = 10;
const FETCH_TIMEOUT_MS = 15_000;

interface FeedDef { name: string; url: string }
interface Headline {
  topic: string;
  feed: string;
  title: string;
  link: string;
  published: string | null;
}
interface FeedStatus { topic: string; feed: string; ok: boolean; items: number; note: string }

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstTag(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  return m ? m[1] : null;
}

/** Atom links live in an attribute; RSS links in element text. Handle both. */
function extractLink(xml: string): string | null {
  const rss = firstTag(xml, "link");
  if (rss && rss.trim() && !rss.includes("<")) return decodeEntities(rss);
  const atom = /<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i.exec(xml)
    ?? /<link[^>]*href=["']([^"']+)["']/i.exec(xml);
  return atom ? atom[1] : null;
}

/** Parse RSS <item> and Atom <entry> blocks with the same minimal extractor. */
function parseFeed(xml: string, topic: string, feed: string): Headline[] {
  const blocks = [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  const out: Headline[] = [];
  for (const block of blocks.slice(0, PER_FEED_CAP * 2)) {
    const title = firstTag(block, "title");
    const link = extractLink(block);
    if (!title || !link) continue;
    const published = firstTag(block, "pubDate") ?? firstTag(block, "published") ?? firstTag(block, "updated");
    out.push({
      topic, feed,
      title: decodeEntities(title),
      link: link.trim(),
      published: published ? new Date(decodeEntities(published)).toISOString() : null,
    });
    if (out.length >= PER_FEED_CAP) break;
  }
  return out;
}

/**
 * A feed that answered with an empty channel is healthy, not dead — arXiv publishes
 * nothing on weekends and declares <skipDays>, so its channel is legitimately empty.
 * Item blocks present but none extracted IS a format problem and stays flagged.
 */
function classifyEmpty(xml: string): { ok: boolean; note: string } {
  if (!/<rss[\s>]|<feed[\s>]|<rdf:RDF[\s>]/i.test(xml)) {
    return { ok: false, note: "response is not RSS/Atom — check feed format" };
  }
  if (/<(item|entry)[\s>]/i.test(xml)) {
    return { ok: false, note: "feed has item blocks but none parsed — check feed format" };
  }
  return { ok: true, note: "feed answered with no items (nothing published)" };
}

async function fetchFeed(def: FeedDef, topic: string): Promise<{ items: Headline[]; status: FeedStatus }> {
  try {
    const res = await fetch(def.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": "LifeOS-FeedPull/1.0 (personal morning brief)" },
    });
    if (!res.ok) {
      return { items: [], status: { topic, feed: def.name, ok: false, items: 0, note: `HTTP ${res.status}` } };
    }
    const body = await res.text();
    const items = parseFeed(body, topic, def.name);
    const { ok, note } = items.length > 0 ? { ok: true, note: "ok" } : classifyEmpty(body);
    return { items, status: { topic, feed: def.name, ok, items: items.length, note } };
  } catch (err) {
    const note = err instanceof Error ? err.message : String(err);
    return { items: [], status: { topic, feed: def.name, ok: false, items: 0, note } };
  }
}

function loadSeen(): Set<string> {
  try { return new Set(JSON.parse(readFileSync(SEEN_PATH, "utf8"))); } catch { return new Set(); }
}

async function main() {
  if (process.argv.includes("--status")) {
    const latest = join(OUT_DIR, "latest.json");
    if (!existsSync(latest)) { console.log("no runs yet"); return; }
    const data = JSON.parse(readFileSync(latest, "utf8"));
    for (const s of data.feeds as FeedStatus[]) {
      console.log(`${s.ok ? "OK  " : "DEAD"} ${s.topic} / ${s.feed} — ${s.items} item(s) — ${s.note}`);
    }
    return;
  }

  const config = JSON.parse(readFileSync(CONFIG, "utf8"));
  mkdirSync(OUT_DIR, { recursive: true });
  const seen = loadSeen();

  const jobs: Promise<{ items: Headline[]; status: FeedStatus }>[] = [];
  for (const [topic, feeds] of Object.entries(config.topics as Record<string, FeedDef[]>)) {
    for (const def of feeds) jobs.push(fetchFeed(def, topic));
  }
  const results = await Promise.all(jobs);

  const statuses = results.map((r) => r.status);
  const fresh = results.flatMap((r) => r.items).filter((h) => !seen.has(h.link));
  for (const h of fresh) seen.add(h.link);

  const stamp = new Date();
  const day = stamp.toISOString().slice(0, 10);
  const payload = {
    ran: stamp.toISOString(),
    feeds: statuses,
    fresh: fresh.length,
    headlines: fresh,
  };
  writeFileSync(join(OUT_DIR, `${day}.json`), JSON.stringify(payload, null, 2));
  writeFileSync(join(OUT_DIR, "latest.json"), JSON.stringify(payload, null, 2));
  writeFileSync(SEEN_PATH, JSON.stringify([...seen].slice(-SEEN_CAP)));

  const alive = statuses.filter((s) => s.ok).length;
  console.log(`FeedPull: ${alive}/${statuses.length} feeds answered, ${fresh.length} fresh headline(s) → ${day}.json`);
  for (const s of statuses.filter((x) => !x.ok)) console.log(`  DEAD ${s.topic} / ${s.feed} — ${s.note}`);
  process.exit(alive > 0 ? 0 : 1);
}

main();
