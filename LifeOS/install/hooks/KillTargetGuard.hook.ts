#!/usr/bin/env bun
/**
 * @version 1.1.0
 * KillTargetGuard.hook.ts — a kill target is a launch handle, never a name.
 *
 * INC-20260920-reaper-probe-session-kill: a probe on tuf selected its target
 * with `pgrep -n sleep`, derived a process group from that guess, and ran
 * `kill -9 -$PG`. The newest `sleep` belonged to the compositor's session; the
 * Wayland session and every Claude session on the host died. The launched
 * target's own pid was available and unused.
 *
 * RULE (OPERATIONAL_RULES § Verification, applied 2026-09-25): no Bash command
 * from any session — main or subagent — signals a pid, pgid or session it did
 * not itself create and hold. Refused at this one choke point:
 *   - `pkill …` and `killall …` (name-selected targets)
 *   - `kill …` whose target text contains `pgrep`, `pidof`, `ps …|grep`, or
 *     any command substitution / backtick feeding the target
 *   - `pgrep|pidof|ps … | xargs kill` and `… | while read … kill`
 *   - `kill -<sig> -<N>` / `kill -- -<N>` / `kill -<sig> -$VAR`: a process-group
 *     or `-1` (everything) target. A group id cannot be verified as one this
 *     session created; signal the pid you launched instead.
 * Allowed, untouched:
 *   - `kill <literal pid>`, `kill $PID`, `kill $!`, `kill %1`, `kill -TERM 12345`
 *   - `kill -0 …` in any form (a liveness probe delivers no signal)
 *   - `systemctl … kill`, `tmux kill-*`, `docker kill`, `adb … kill-server`,
 *     `gradlew --stop`, `emulator … -kill`: unit/handle-addressed, not pid guesses
 *   - text inside quotes (prose, a grep pattern, a commit message, a JS program) and
 *     heredoc bodies: data, not a command this call runs. The payload of `bash -c`,
 *     `sh -c`, `eval`, `su -c`, `ssh host '…'` IS scanned as a command.
 *   Known limit: a program in another language that spawns a name-killer itself
 *   (bun -e, python -c) is not parsed; the guard closes the incident's shape at the shell layer.
 * Escape hatch: none inside a Claude session. Destructive process probes run
 * in a disposable VM or an `unshare -Urpf --mount-proc` namespace, proven
 * first (recovery ISA C1 containment). Fail-OPEN on internal anomaly, matching
 * the dispatcher's isolation contract; a refusal is exit 2 with the reason.
 *
 * WIRING: PreToolGuard.hook.ts (PreToolUse:Bash) via the exported check().
 */

import { readFileSync } from "node:fs";

type BlockResult = { block: true; message: string } | null;

export interface KillVerdict { refuse: boolean; reason: string; match?: string }

// Strip heredoc bodies: the text between `<<TAG` and the line holding TAG is
// data being written, not a command this call runs. A probe SCRIPT may be
// written; running it is a separate Bash call that the guard sees on its own.
function stripHeredocs(cmd: string): string {
  const lines = cmd.split("\n");
  const out: string[] = [];
  let tag: string | null = null;
  for (const line of lines) {
    if (tag !== null) {
      if (line.trim() === tag) tag = null;
      continue;
    }
    const m = line.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (m) tag = m[1];
    out.push(line);
  }
  return out.join("\n");
}

// Command position only: start of line, after a separator, or after a wrapper that
// executes its argument (sudo, env, nohup, timeout N, xargs, exec, watch, ssh host).
const NAME_KILLERS = /(^|[\s;&|(`{]|\b(?:sudo|env|nohup|exec|xargs|watch|ssh\s+\S+|timeout\s+\S+)\s+)(pkill|killall)\b/m;

// Text inside ordinary quotes is data (a commit message, a grep pattern, a JS
// program, prose) — unless the quote is the payload of `bash -c`, `sh -c`,
// `eval`, `ssh host '…'` or `su -c`, where the quoted text IS a command and is scanned
// as one. Everything else in quotes is dropped before matching.
function commandPayloads(cmd: string): string[] {
  const out: string[] = [];
  const re = /\b(?:bash|sh|zsh|dash|ksh|su|ssh(?:\s+\S+)+?)\s+(?:[^\s'"]+\s+)*?(?:-c|--command)?\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
  for (const m of cmd.matchAll(re)) out.push(m[1] ?? m[2] ?? "");
  const ev = /\beval\s+(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|(\S[^\n;]*))/g;
  for (const m of cmd.matchAll(ev)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out.filter((x) => x.length > 0);
}

function stripQuotes(cmd: string): string {
  return cmd.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}
// A kill invocation: `kill` as a command word (not `tmux kill-session`, not
// `docker kill`, not `systemctl kill`, not `-kill`). Captures its argument text.
const KILL_CMD = /(^|[\s;&|(`{\x22\x27])kill\b(?!-)([^\n;&|]*)/g;
const SUBSTITUTION = /\$\(|`|\bpgrep\b|\bpidof\b|\bps\b/;
const PIPED_KILL = /\b(pgrep|pidof|ps|lsof|fuser)\b[^\n|]*\|[^\n]*\b(xargs\s+(?:-[^\s]+\s+)*kill|kill\b|while\b[^\n]*\bkill\b)/;

function signalIsZero(args: string): boolean {
  return /(^|\s)(-0|-s\s*0|-n\s*0|-SIG0)(\s|$)/.test(args);
}

function groupTarget(args: string): string | null {
  // `-- -123`, `-9 -123`, `-TERM -$PG`, `-9 -1`, `-9 -$(...)`
  const stripped = args.replace(/^\s+/, "");
  const m = stripped.match(/(?:^|\s)(?:--\s+)?-(\d+|\$[A-Za-z_{][^\s]*|\$\([^)]*\))(?=\s|$)/g);
  if (!m) return null;
  // The first `-9`/`-TERM` is the signal; a NEGATIVE numeric/variable token
  // after a signal or after `--` is a group. Detect the shape "-<sig> -<target>"
  // or "-- -<target>" explicitly.
  const shape = stripped.match(/(?:^|\s)(?:-(?:\d+|[A-Z]+|s\s+\w+|n\s+\d+)\s+|--\s+)-(\d+|\$[A-Za-z_{][^\s]*|\$\([^)]*\))(?=\s|$)/);
  return shape ? shape[0].trim() : null;
}

export function assess(command: string): KillVerdict {
  if (typeof command !== "string" || command.length === 0) return { refuse: false, reason: "no command" };
  const noHeredoc = stripHeredocs(command);
  for (const payload of commandPayloads(noHeredoc)) {
    const v = assessOne(payload);
    if (v.refuse) return { ...v, reason: `${v.reason} (inside an executed -c/eval payload)` };
  }
  return assessOne(stripQuotes(noHeredoc));
}

function assessOne(cmd: string): KillVerdict {

  const nk = cmd.match(NAME_KILLERS);
  if (nk) return { refuse: true, reason: `${nk[2]} selects targets by NAME`, match: nk[2] };

  const pk = cmd.match(PIPED_KILL);
  if (pk) return { refuse: true, reason: "a process search piped into kill", match: pk[0].slice(0, 80) };

  for (const m of cmd.matchAll(KILL_CMD)) {
    const args = m[2] ?? "";
    if (signalIsZero(args)) continue; // liveness probe, no signal delivered
    if (SUBSTITUTION.test(args)) return { refuse: true, reason: "kill target derived from a search or substitution", match: `kill${args}`.trim().slice(0, 80) };
    const g = groupTarget(args);
    if (g) return { refuse: true, reason: "process-group / -1 target (cannot be verified as this session's)", match: `kill${args}`.trim().slice(0, 80) };
  }
  return { refuse: false, reason: "targets are literal pids or handles" };
}

export function check(input: any): BlockResult {
  const command = input?.tool_input?.command;
  if (typeof command !== "string") return null;
  const v = assess(command);
  if (!v.refuse) return null;
  return {
    block: true,
    message: [
      "",
      `[KillTargetGuard] refused: ${v.reason}${v.match ? ` — \`${v.match}\`` : ""}.`,
      "A kill target is a launch handle you created and hold ($!, the pid a spawn returned, a pidfile you wrote), re-verified before the signal.",
      "Never a name, the newest process, a search result, or a process group. INC-20260920-reaper-probe-session-kill: `kill -9 -$(pgrep -n sleep)` took the compositor and every session on the host.",
      "If the target is a service, address it as one (`systemctl --user kill <unit>`, `tmux kill-session -t <name>`, `gradlew --stop` in its own worktree).",
      "Destructive process probes run only in a disposable VM or a proven `unshare -Urpf --mount-proc` namespace, never on a shared perch.",
      "",
    ].join("\n"),
  };
}

if (import.meta.main) {
  let input: any = {};
  try { input = JSON.parse(readFileSync(0, "utf-8")); } catch { process.exit(0); }
  const r = check(input);
  if (r?.block) { process.stderr.write(r.message); process.exit(2); }
  process.exit(0);
}
