#!/usr/bin/env bun
/**
 * PluginReconcile.ts — keep Claude Code plugins in sync across LifeOS nodes.
 *
 * Closes the "second node not yet mounted" drift class: plugins
 * are machine-local, so a plugin vetted+installed on one node was invisible to
 * the other until someone remembered. The synced manifest
 * (USER/CONFIG/PLUGINS.json) is the source of truth; this tool reconciles a
 * node's installed set against it.
 *
 * DOCTRINE:
 *   - Manifest is authored only after a vet (the pin carries the ruling).
 *   - --check is non-mutating: reports drift, exits 0 clean / 3 on drift.
 *     Safe to run from the pull timer (mutations stay deliberate, per the
 *     sync-split rule: pull auto + non-mutating, installs are decisions).
 *   - --apply installs MISSING plugins at the manifest version. It NEVER
 *     updates a plugin past its pin — a version bump is a re-vet, done by hand.
 *   - Postcondition-checked: after --apply, re-reads installed set and asserts
 *     each intended install actually landed (success-shaped ≠ done).
 *
 * Usage: PluginReconcile.ts [--check | --apply] [--json]
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

const HOME = homedir();
const MANIFEST = join(HOME, ".config", "LIFEOS", "USER", "CONFIG", "PLUGINS.json");
const INSTALLED = join(HOME, ".claude", "plugins", "installed_plugins.json");
const KNOWN_MKTS = join(HOME, ".claude", "plugins", "known_marketplaces.json");

type ManifestPlugin = {
  name: string;
  marketplace: string;
  source: { type: string; repo?: string; url?: string };
  version: string;
  vetted_sha: string | null;
};

const mode = process.argv.includes("--apply") ? "apply" : "check";
const asJson = process.argv.includes("--json");

function readJson(p: string): any {
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8"));
}

function loadInstalled(): Map<string, { version: string; sha?: string }> {
  const m = new Map<string, { version: string; sha?: string }>();
  const data = readJson(INSTALLED);
  if (!data?.plugins) return m;
  for (const [key, entries] of Object.entries<any>(data.plugins)) {
    const name = key.split("@")[0];
    const e = Array.isArray(entries) ? entries[0] : entries;
    if (e) m.set(name, { version: e.version, sha: e.gitCommitSha });
  }
  return m;
}

function sh(cmd: string): { ok: boolean; out: string } {
  try {
    const out = Bun.spawnSync(["bash", "-lc", cmd], { stdout: "pipe", stderr: "pipe" });
    return { ok: out.exitCode === 0, out: new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr) };
  } catch (e) {
    return { ok: false, out: String(e) };
  }
}

const manifest = readJson(MANIFEST);
if (!manifest?.plugins) {
  console.error(`[PluginReconcile] no manifest at ${MANIFEST} — nothing to reconcile.`);
  process.exit(2);
}

const installed = loadInstalled();
const knownMkts = readJson(KNOWN_MKTS) ?? {};

type DriftRow = { name: string; kind: "missing" | "version-mismatch" | "ok"; want: string; have: string | null };
const rows: DriftRow[] = [];

for (const p of manifest.plugins as ManifestPlugin[]) {
  const have = installed.get(p.name);
  if (!have) rows.push({ name: p.name, kind: "missing", want: p.version, have: null });
  else if (p.version !== "unknown" && have.version !== "unknown" && have.version !== p.version)
    rows.push({ name: p.name, kind: "version-mismatch", want: p.version, have: have.version });
  else rows.push({ name: p.name, kind: "ok", want: p.version, have: have.version });
}

const missing = rows.filter((r) => r.kind === "missing");
const mismatched = rows.filter((r) => r.kind === "version-mismatch");

if (mode === "check") {
  if (asJson) {
    console.log(JSON.stringify({ node: HOME, missing, mismatched, ok: rows.filter((r) => r.kind === "ok").length }, null, 2));
  } else {
    if (missing.length === 0 && mismatched.length === 0) {
      console.log(`[PluginReconcile] in sync — ${rows.length} plugins match the manifest.`);
    } else {
      for (const r of missing) console.log(`MISSING   ${r.name} (want ${r.want}) — run PluginReconcile.ts --apply`);
      for (const r of mismatched) console.log(`MISMATCH  ${r.name} have ${r.have}, manifest pins ${r.want} — re-vet before changing the pin; not auto-fixed`);
    }
  }
  // Drift exits 3 so the pull timer / caller can notice; mismatch is drift too.
  process.exit(missing.length + mismatched.length > 0 ? 3 : 0);
}

// --apply: install MISSING only. Never touch mismatches (those are re-vets).
if (missing.length === 0) {
  console.log("[PluginReconcile] nothing to install — no missing plugins.");
  if (mismatched.length > 0) console.log(`[PluginReconcile] ${mismatched.length} version mismatch(es) left untouched by design (re-vet to change a pin).`);
  process.exit(0);
}

for (const r of missing) {
  const p = (manifest.plugins as ManifestPlugin[]).find((x) => x.name === r.name)!;
  // Ensure the marketplace is registered first.
  if (!knownMkts[p.marketplace]) {
    const ref = p.source.repo ?? p.source.url ?? "";
    console.log(`[PluginReconcile] adding marketplace ${p.marketplace} (${ref})`);
    const add = sh(`claude plugin marketplace add ${ref}`);
    if (!add.ok) { console.error(`[PluginReconcile] FAILED to add marketplace for ${p.name}:\n${add.out}`); continue; }
  }
  console.log(`[PluginReconcile] installing ${p.name}@${p.marketplace} (pin ${p.version})`);
  const inst = sh(`claude plugin install ${p.name}@${p.marketplace}`);
  if (!inst.ok) console.error(`[PluginReconcile] install reported failure for ${p.name}:\n${inst.out}`);
}

// Postcondition: re-read installed set, assert each intended install landed.
const after = loadInstalled();
const landed = missing.filter((r) => after.has(r.name)).map((r) => r.name);
const failed = missing.filter((r) => !after.has(r.name)).map((r) => r.name);
console.log(`[PluginReconcile] postcondition: ${landed.length}/${missing.length} installed (${landed.join(", ") || "none"}).`);
if (failed.length > 0) {
  console.error(`[PluginReconcile] STILL MISSING after apply: ${failed.join(", ")} — investigate, do not assume success.`);
  process.exit(1);
}
console.log("[PluginReconcile] all missing plugins installed and verified present.");
process.exit(0);
