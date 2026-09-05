#!/usr/bin/env bun
/**
 * VerifyPosture — assert this install's security posture after any upgrade.
 *
 * LifeOS upgrades re-overlay system-owned files and can silently restore shipped
 * defaults. Two of those defaults are network-facing on this machine:
 *   - PULSE.toml [syslog] ships enabled and binds UDP 5514 on 0.0.0.0
 *   - PULSE.toml [notifications.ntfy] ships enabled and egresses to ntfy.sh
 *
 * Config is not code, so it cannot be carried as a patch. It gets verified instead.
 * Run after every upgrade. Exit 0 = posture holds; exit 1 = something regressed.
 *
 * Usage: bun ~/.claude/LIFEOS/TOOLS/VerifyPosture.ts [--json]
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface Check { name: string; pass: boolean; detail: string; fix?: string }
const checks: Check[] = [];
const HOME = process.env.HOME || "";
const add = (name: string, pass: boolean, detail: string, fix?: string) =>
  checks.push({ name, pass, detail, fix });

function sh(cmd: string): string {
  try { return Bun.spawnSync(["bash", "-lc", cmd]).stdout.toString().trim(); } catch { return ""; }
}

// ── 1-2. PULSE.toml flags that ship dangerous-by-default ──
const toml = join(HOME, ".claude/LIFEOS/PULSE/PULSE.toml");
if (existsSync(toml)) {
  const raw = readFileSync(toml, "utf-8");
  // Section lookup is line-anchored and bounded to the section body. A bare
  // indexOf matched the string "[syslog]" inside a COMMENT on line 57, then read
  // the next `enabled = true` from an unrelated section and reported the syslog
  // listener enabled while it was in fact off and nothing was bound to 5514
  // (found 2026-09-05). Appearance is not existence.
  const sectionBody = (section: string): string | null => {
    const esc = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m0 = raw.match(new RegExp(`^\\[${esc}\\]\\s*$`, "m"));
    if (!m0 || m0.index === undefined) return null;
    return raw.slice(m0.index + m0[0].length).split(/^\[/m)[0];
  };
  const flag = (section: string): boolean | null => {
    const body = sectionBody(section);
    if (body === null) return null;
    const m = body.match(/^enabled\s*=\s*(true|false)/m);
    return m ? m[1] === "true" : null;
  };
  const syslog = flag("syslog");
  add("PULSE syslog disabled", syslog === false,
    `[syslog] enabled = ${syslog}`,
    "set enabled = false in ~/.claude/LIFEOS/PULSE/PULSE.toml — it binds UDP 5514 on 0.0.0.0");

  // RULED 2026-09-05 by the principal: public ntfy egress is SANCTIONED, not a
  // regression. The lane is load-bearing (DawnFlightNotify, MorningBrief.sh, the
  // unit-failure notifier) and carries notification metadata only, never brief
  // content, per MORNING_BRIEF's metadata-only rule. The check now asserts the
  // sanctioned SHAPE rather than demanding the feature be off: a private,
  // unguessable topic on the expected host. A topic that turns guessable, or a
  // server swapped for something unexpected, still fails.
  const ntfy = flag("notifications.ntfy");
  const nbody = sectionBody("notifications.ntfy") ?? "";
  const topic = (nbody.match(/^\s*topic\s*=\s*"([^"]*)"/m) || [])[1] ?? "";
  const server = (nbody.match(/^\s*server\s*=\s*"([^"]*)"/m) || [])[1] ?? "";
  const shapeOk = ntfy !== true
    || (server === "ntfy.sh" && topic.length >= 16 && /[0-9a-f]{12,}/.test(topic));
  add("PULSE ntfy sanctioned (metadata-only)", shapeOk,
    ntfy === true
      ? `enabled, server = ${server || "(unset)"}, topic ${topic.length} chars — sanctioned 2026-09-05`
      : `[notifications.ntfy] enabled = ${ntfy}`,
    "public ntfy is ruled acceptable; keep server = ntfy.sh and the topic long and random — never put brief content on this lane");
} else {
  add("PULSE.toml present", false, `missing at ${toml}`);
}

// ── 3. Nothing listening on the syslog port, regardless of config ──
const udp = sh("ss -lnu 2>/dev/null | grep -c ':5514' || true");
add("UDP 5514 closed", udp === "0" || udp === "", `listeners on 5514: ${udp || "0"}`,
  "systemctl --user restart com.lifeos.pulse.service after disabling [syslog]");

// ── 4. Pulse bound to loopback only, never 0.0.0.0 ──
const binds = sh("ss -lnt 2>/dev/null | grep ':31337' | awk '{print $4}'");
const loopbackOnly = binds !== "" && binds.split("\n").every(b => b.startsWith("127.0.0.1:"));
add("Pulse loopback-only", loopbackOnly, `31337 bound to: ${binds || "(not listening)"}`,
  "unset LIFEOS_PULSE_BIND_ALL and restart; tailnet access goes via `tailscale serve`, not a wide bind");

// ── 5. Tailscale exposure is tailnet-only (serve), never public (funnel) ──
// `tailscale funnel status` prints the SERVE config too, and serve entries are
// labelled "(tailnet only)". Only a real funnel is public: it renders "(Funnel)"
// or "Funnel on". Matching loosely here produced a false positive.
const funnel = sh("tailscale funnel status 2>/dev/null");
const funnelOn = /\(funnel\)|funnel on/i.test(funnel);
const funnelOff = !funnelOn;
add("Tailscale funnel off", funnelOff,
  funnelOff ? (funnel.includes("tailnet only") ? "serve active, tailnet only — no public exposure" : "no public funnel") : funnel,
  "tailscale funnel off — funnel exposes to the public internet; serve is tailnet-only");

// ── 6. Local patches still applied (upgrades use copyMissing, but Update step 3 overwrites some) ──
const gen = join(HOME, ".claude/LIFEOS/TOOLS/GenerateTelosSummary.ts");
if (existsSync(gen)) {
  const src = readFileSync(gen, "utf-8");
  add("Context Filter patch intact", src.includes("readContextFilter()"),
    src.includes("Human 3.0 transition") ? "hardcoded literal is BACK — patch reverted" : "reads from TELOS.md",
    "re-apply from the patches/v7.28.3 branch in your fork");
}

// ── 7. DA icon survived the last upgrade ──
// LIFEOS_SYSTEM_PROMPT.md is a system file that Update step 3 deliberately overwrites,
// so a configured closer glyph silently reverts to the shipped default on upgrade.
// The gate accepts both, so nothing breaks loudly; it just quietly stops being yours.
{
  const cfgPath = join(HOME, ".config/LIFEOS/USER/CONFIG/LIFEOS_CONFIG.toml");
  const promptPath = join(HOME, ".claude/LIFEOS/LIFEOS_SYSTEM_PROMPT.md");
  if (existsSync(cfgPath) && existsSync(promptPath)) {
    const m = readFileSync(cfgPath, "utf-8").match(/^icon\s*=\s*"([^"]+)"/m);
    const configured = m?.[1];
    if (!configured) {
      add("DA icon configured", true, "no custom icon set, default in use");
    } else {
      const prompt = readFileSync(promptPath, "utf-8");
      add("DA icon in system prompt", prompt.includes(configured),
        prompt.includes(configured)
          ? `system prompt uses ${configured}`
          : `configured ${configured} but system prompt reverted to the default`,
        "re-apply the glyph to LIFEOS_SYSTEM_PROMPT.md; it is overwritten by Update step 3");
    }
  }
}

// ── 7. USER tree still symlinked and resolving ──
const userLink = join(HOME, ".claude/LIFEOS/USER");
const resolved = sh(`readlink -f ${userLink}`);
add("USER tree resolves", resolved.includes(".config/LIFEOS/USER"),
  `${userLink} -> ${resolved || "(broken)"}`,
  "bun ~/src/LifeOS/LifeOS/Tools/LinkUser.ts --apply");

const failed = checks.filter(c => !c.pass);
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
} else {
  console.log("LifeOS posture check\n");
  for (const c of checks) console.log(`${c.pass ? "✅" : "❌"} ${c.name} — ${c.detail}`);
  if (failed.length) {
    console.log("\nFix:");
    for (const c of failed) if (c.fix) console.log(`  ${c.name}: ${c.fix}`);
  }
  console.log(`\n${failed.length === 0 ? "posture holds" : `${failed.length} regression(s)`}`);
}
process.exit(failed.length === 0 ? 0 : 1);
