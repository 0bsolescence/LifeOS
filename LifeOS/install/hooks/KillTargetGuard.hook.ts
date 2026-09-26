#!/usr/bin/env bun
/**
 * @version 2.0.0
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
 * not itself create and hold. The command is parsed, not grepped: heredocs are
 * stripped (quote-aware), quotes are resolved, the command is split into simple
 * commands, every `$(…)`/backtick group is walked as the command it is, and the
 * command word is found past assignments, redirections, keywords and wrappers
 * (sudo, env, nohup, exec, xargs, watch, nice, ionice, setsid, timeout N,
 * command, builtin, eval, ssh host). Refused:
 *   - `pkill`, `killall` in command position, with or without a path prefix
 *   - a `kill` target containing a `$(…)` or backtick substitution
 *   - a `kill` target of `0`, `-1` or any `-<N>` / `-$VAR`: a process group
 *   - a `kill $VAR` target when the same command runs a process search
 *     (pgrep, pidof, ps, lsof, fuser) anywhere: `T=$(pgrep x); kill $T`
 *   - `… | xargs kill` when the command runs a process search
 * Allowed, untouched:
 *   - `kill <literal pid>`, `kill $PID` with no search, `kill $!`, `kill %1`
 *   - `kill -0 …` in any form (a liveness probe delivers no signal)
 *   - `kill` as an argument: `systemctl kill`, `tmux kill-*`, `docker kill`,
 *     `adb … kill-server`, `emu kill`; `command -v pkill`, `echo pkill`
 *   - quoted text: single-quoted, and double-quoted without `$`/backtick, is a
 *     data word (it keeps its word, so a quoted COMMAND word still counts). A
 *     double-quoted `$(…)` is expanded by the shell and is scanned. The payload
 *     of `bash -c`, `sh -c`, `su -c`, `eval`, `ssh host '…'` is scanned as a program.
 *   - heredoc bodies are data, except a body fed to a shell (scanned whole) and
 *     the `$(…)` substitutions of an unquoted-tag body (they run at write time).
 *   Known limits: a program in another language that spawns a name-killer itself
 *   (bun -e, python -c), a command word held in a variable (`$K -f x`), and
 *   ANSI-C escapes spelling a name (`$'pk\151ll'`) are not resolved; the guard
 *   closes the incident's shape at the shell layer.
 * Escape hatch: none inside a Claude session. Destructive process probes run
 * in a disposable VM or an `unshare -Urpf --mount-proc` namespace, proven
 * first (recovery ISA C1 containment). Fail-OPEN on internal anomaly, matching
 * the dispatcher's isolation contract, except input nested past the parser's
 * depth bound, which is refused; a refusal is exit 2 with the reason.
 *
 * WIRING: PreToolGuard.hook.ts (PreToolUse:Bash) via the exported check().
 */

import { readFileSync } from "node:fs";

type BlockResult = { block: true; message: string } | null;

export interface KillVerdict { refuse: boolean; reason: string; match?: string }

// ── Lexical helpers. Every scanner is a single forward pass; nesting is bounded
// by MAX_DEPTH so hostile input cannot turn a parse into a stack overflow.
const MAX_DEPTH = 16;
class TooDeep extends Error {}

function endOfSingle(s: string, i: number): number {
  const j = s.indexOf("'", i);
  return j < 0 ? s.length : j;
}
function endOfAnsi(s: string, i: number): number {
  for (let k = i; k < s.length; k++) {
    if (s[k] === "\\") { k++; continue; }
    if (s[k] === "'") return k;
  }
  return s.length;
}
function endOfBacktick(s: string, i: number): number {
  for (let k = i; k < s.length; k++) {
    if (s[k] === "\\") { k++; continue; }
    if (s[k] === "`") return k;
  }
  return s.length;
}
function endOfDouble(s: string, i: number, d = 0): number {
  if (d > MAX_DEPTH) throw new TooDeep();
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (c === "\\") { k++; continue; }
    if (c === '"') return k;
    if (c === "$" && s[k + 1] === "(") { k = endOfGroup(s, k + 2, d + 1); continue; }
    if (c === "`") { k = endOfBacktick(s, k + 1); continue; }
  }
  return s.length;
}
// i is the index just after the opening `(`; returns the index of the matching `)`.
function endOfGroup(s: string, i: number, d = 0): number {
  if (d > MAX_DEPTH) throw new TooDeep();
  let depth = 1;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (c === "\\") { k++; continue; }
    if (c === "'") { k = endOfSingle(s, k + 1); continue; }
    if (c === '"') { k = endOfDouble(s, k + 1, d + 1); continue; }
    if (c === "`") { k = endOfBacktick(s, k + 1); continue; }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return k;
  }
  return s.length;
}
const commentStart = (s: string, i: number) => i === 0 || /[\s;&|(]/.test(s[i - 1]);

// ── Command-word walker: skips assignments, redirections, shell keywords and
// wrappers that execute their argument (with the wrapper's own options), and
// returns the command that actually runs. `command -v X` / `builtin -v` are lookups.
const KEYWORDS = new Set(["!", "{", "}", "if", "then", "do", "else", "elif", "while", "until", "coproc"]);
const WRAPPERS: Record<string, string> = {
  // wrapper → single-letter options that take a separate argument
  sudo: "ugphCDrtUT", doas: "uC", env: "uCS", nohup: "", exec: "a", xargs: "InPLsdEa",
  watch: "nd", nice: "n", ionice: "cnp", setsid: "", timeout: "sk", command: "", builtin: "",
  eval: "", time: "fo", stdbuf: "ioe", ssh: "bcDEeFIiJLlmOoPpQRSWw",
};
// Long wrapper options that take a SEPARATE value (`sudo --user root`, `env --unset HOME`).
const LONG_TAKES_ARG = new Set(["--user", "--group", "--host", "--prompt", "--chdir", "--role", "--type", "--close-from", "--other-user",
  "--unset", "--split-string", "--signal", "--kill-after", "--adjustment", "--class", "--classdata", "--pid",
  "--max-args", "--max-procs", "--delimiter", "--arg-file", "--replace", "--max-lines", "--max-chars", "--eof",
  "--interval", "--input", "--output", "--error", "--format", "--argv0"]);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
const REDIR = /^\d*(&?>>?|<>?|>&|<&|>\|)/;
const base = (w: string) => { const x = w.replace(/\\/g, ""); return x.slice(x.lastIndexOf("/") + 1); };

interface Walk { cmd: string; args: string[]; remote: boolean; viaXargs: boolean }
function walk(words: string[]): Walk {
  let i = 0, remote = false, viaXargs = false;
  while (i < words.length) {
    const w = words[i];
    if (KEYWORDS.has(w) || ASSIGN.test(w)) { i++; continue; }
    if (REDIR.test(w)) { i += /^\d*[<>&|]+$/.test(w) ? 2 : 1; continue; }
    const b = base(w);
    if (Object.prototype.hasOwnProperty.call(WRAPPERS, b)) {
      i++;
      if ((b === "command" || b === "builtin") && /^-[A-Za-z]*[vV]/.test(words[i] ?? "")) return { cmd: `${b} -v`, args: words.slice(i + 1), remote, viaXargs };
      const takesArg = WRAPPERS[b];
      while (i < words.length && words[i].startsWith("-") && words[i] !== "-") {
        const o = words[i++];
        if (o === "--") break;
        if (o.length === 2 && takesArg.includes(o[1])) i++;
        else if (LONG_TAKES_ARG.has(o)) i++;
      }
      if (b === "env") while (i < words.length && ASSIGN.test(words[i])) i++;
      if (b === "timeout") i++; // the duration
      if (b === "ssh") { i++; remote = true; } // the host; the rest is the remote command
      if (b === "eval") remote = true;
      if (b === "xargs") viaXargs = true;
      continue;
    }
    return { cmd: b, args: words.slice(i + 1), remote, viaXargs };
  }
  return { cmd: "", args: [], remote, viaXargs };
}
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "su"]);
let payloadMemo: { prefix: string; v: boolean } = { prefix: "", v: false };
function isPayloadCtx(prefix: string): boolean {
  // The prefix is capped at 256 chars, so a long segment asks the same question repeatedly.
  if (prefix === payloadMemo.prefix) return payloadMemo.v;
  const v = isPayloadCtxUncached(prefix);
  payloadMemo = { prefix, v };
  return v;
}
function isPayloadCtxUncached(prefix: string): boolean {
  const words = prefix.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  const w = walk(words);
  return SHELLS.has(w.cmd) || w.remote;
}

// ── Heredocs (top level). A `<<TAG` outside quotes, not a here-string (`<<<`) and
// not inside `$((…))`/`((…))`, starts a heredoc. Its body is data, except: fed to a
// shell (`bash <<EOF`, `cat <<EOF | sh`) it is scanned as commands, and with an
// unquoted tag its `$(…)`/backtick substitutions run at write time and are scanned.
function lineIsShellFed(line: string): boolean {
  return line.split(/[|;&(]/).some((piece) => isPayloadCtx(piece));
}
function substitutions(body: string): string[] {
  const out: string[] = [];
  for (let k = 0; k < body.length; k++) {
    const c = body[k];
    if (c === "\\") { k++; continue; }
    if (c === "$" && body[k + 1] === "(") { const j = endOfGroup(body, k + 2); out.push(body.slice(k, j + 1)); k = j; continue; }
    if (c === "`") { const j = endOfBacktick(body, k + 1); out.push(body.slice(k, j + 1)); k = j; }
  }
  return out;
}
export function stripHeredocs(s: string): string {
  const out: string[] = [];
  let pending: { tag: string; quoted: boolean }[] = [];
  let lineStart = 0, last = 0, i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "'") { i = endOfSingle(s, i + 1) + 1; continue; }
    if (c === "$" && s[i + 1] === "'") { i = endOfAnsi(s, i + 2) + 1; continue; }
    if (c === '"') { i = endOfDouble(s, i + 1) + 1; continue; }
    if (c === "`") { i = endOfBacktick(s, i + 1) + 1; continue; }
    if (c === "$" && s[i + 1] === "(") { i = endOfGroup(s, i + 2) + 1; continue; }
    if (c === "(" && s[i + 1] === "(") { i = endOfGroup(s, i + 1) + 1; continue; } // (( arithmetic ))
    if (c === "#" && commentStart(s, i)) { const j = s.indexOf("\n", i); i = j < 0 ? n : j; continue; }
    if (c === "<" && s[i + 1] === "<") {
      if (s[i + 2] === "<") { i += 3; continue; } // here-string: the next word is data, the next line is not
      const m = /^<<-?[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z0-9_.-]+))/.exec(s.slice(i, i + 128));
      if (m) { pending.push({ tag: m[1] ?? m[2] ?? m[3], quoted: m[3] === undefined || m[0].includes("\\") }); i += m[0].length; continue; }
      i += 2; continue;
    }
    if (c === "\n") {
      if (pending.length) {
        const shellFed = lineIsShellFed(s.slice(lineStart, i));
        out.push(s.slice(last, i + 1));
        let pos = i + 1;
        for (const h of pending) {
          const body: string[] = [];
          while (pos < n) {
            const nl = s.indexOf("\n", pos);
            const line = s.slice(pos, nl < 0 ? n : nl);
            pos = nl < 0 ? n : nl + 1;
            if (line.trim() === h.tag) break;
            body.push(line);
          }
          const text = body.join("\n");
          if (shellFed) out.push(text + "\n");
          else if (!h.quoted) { const subs = substitutions(text); if (subs.length) out.push(": " + subs.join(" ") + "\n"); }
        }
        pending = [];
        last = pos; i = pos; lineStart = pos;
        continue;
      }
      lineStart = i + 1;
    }
    i++;
  }
  out.push(s.slice(last));
  return out.join("");
}

// ── Quote handling → "executable text". Quoted text keeps its WORD (so `'pkill'`
// in command position is still pkill) but loses its metacharacters (so a commit
// message's `; pkill` never becomes a segment). `$(…)`, backticks and `$VAR`
// inside double quotes are kept, because the shell expands them. The quoted
// payload of `bash -c`, `sh -c`, `su -c`, `eval`, `ssh host …` is a program and
// is emitted as its own lines.
const neutral = (x: string) => x.replace(/[\s;&|()<>'"#`$\\]/g, "_");
function neutralizeDouble(content: string): string {
  let r = "";
  for (let k = 0; k < content.length; k++) {
    const c = content[k];
    if (c === "\\") { r += "__"; k++; continue; }
    if (c === "$" && content[k + 1] === "(") { const j = endOfGroup(content, k + 2); r += content.slice(k, j + 1); k = j; continue; }
    if (c === "`") { const j = endOfBacktick(content, k + 1); r += content.slice(k, j + 1); k = j; continue; }
    if (c === "$" && content[k + 1] === "{") { const j = content.indexOf("}", k); const e = j < 0 ? content.length - 1 : j; r += content.slice(k, e + 1).replace(/\s/g, "_"); k = e; continue; }
    r += /[\s;&|()<>'"#]/.test(c) ? "_" : c;
  }
  return r;
}
function execText(s: string, depth: number): string {
  if (depth > MAX_DEPTH) throw new TooDeep();
  const out: string[] = [];
  let seg = "";
  const push = (x: string) => { out.push(x); if (seg.length < 256) seg += x; };
  const n = s.length;
  for (let i = 0; i < n;) {
    const c = s[i];
    if (c === "\\") { push(s.slice(i, i + 2)); i += 2; continue; }
    if (c === "#" && commentStart(s, i)) { const j = s.indexOf("\n", i); i = j < 0 ? n : j; continue; }
    if (c === "'" || (c === "$" && s[i + 1] === "'")) {
      const st = c === "'" ? i + 1 : i + 2;
      const j = c === "'" ? endOfSingle(s, st) : endOfAnsi(s, st);
      const content = s.slice(st, j);
      if (isPayloadCtx(seg)) out.push("\n", execText(content, depth + 1), "\n");
      else push(neutral(content));
      i = j + 1; continue;
    }
    if (c === '"') {
      const j = endOfDouble(s, i + 1, depth);
      const content = s.slice(i + 1, j);
      if (isPayloadCtx(seg)) out.push("\n", execText(content, depth + 1), "\n");
      else push(/[$`]/.test(content) ? neutralizeDouble(content) : neutral(content));
      i = j + 1; continue;
    }
    if (c === "$" && s[i + 1] === "(") { const j = endOfGroup(s, i + 2, depth); push(s.slice(i, j + 1)); i = j + 1; continue; }
    if (c === "`") { const j = endOfBacktick(s, i + 1); push(s.slice(i, j + 1)); i = j + 1; continue; }
    if (";&|\n()".includes(c)) { out.push(c); seg = ""; i++; continue; }
    push(c); i++;
  }
  return out.join("");
}

// ── Segmenting: split executable text into simple commands, walk each, and
// recurse into every `$(…)` / backtick group (each is a command that runs).
interface Acc { nameKill: string | null; kills: { args: string[]; viaXargs: boolean; text: string }[]; search: boolean }
const NAME_KILLERS = new Set(["pkill", "killall", "killall5"]);
const SEARCHES = new Set(["pgrep", "pidof", "ps", "lsof", "fuser"]);

function analyze(raw: string, depth: number, acc: Acc): void {
  if (depth > MAX_DEPTH) throw new TooDeep();
  const t = execText(raw, depth);
  const groups: string[] = [];
  let words: string[] = [], cur = "";
  const flush = () => { if (cur) words.push(cur); cur = ""; };
  const end = () => {
    flush();
    if (words.length === 0) return;
    const w = walk(words);
    if (NAME_KILLERS.has(w.cmd) && !acc.nameKill) acc.nameKill = w.cmd;
    if (SEARCHES.has(w.cmd)) acc.search = true;
    if (w.cmd === "kill") acc.kills.push({ args: w.args, viaXargs: w.viaXargs, text: ["kill", ...w.args].join(" ").slice(0, 80) });
    words = [];
  };
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "\\") { cur += t.slice(i, i + 2); i++; continue; }
    if (c === "$" && t[i + 1] === "(") { const j = endOfGroup(t, i + 2, depth); cur += t.slice(i, j + 1); groups.push(t.slice(i + 2, j)); i = j; continue; }
    if (c === "`") { const j = endOfBacktick(t, i + 1); cur += t.slice(i, j + 1); groups.push(t.slice(i + 1, j)); i = j; continue; }
    if (";&|\n()".includes(c)) { end(); continue; }
    if (c === " " || c === "\t" || c === "\r") { flush(); continue; }
    // A redirection attached to a word (`pkill</dev/null`) is its own word; an fd prefix (`2>`) stays with it.
    if ((c === "<" || c === ">") && cur !== "" && !/^\d+$/.test(cur) && !/[<>]$/.test(cur)) flush();
    cur += c;
  }
  end();
  for (const g of groups) analyze(g, depth + 1, acc);
}

function judgeKill(k: { args: string[]; viaXargs: boolean; text: string }, search: boolean): KillVerdict | null {
  const a = k.args;
  if (a[0] === "-l" || a[0] === "-L") return null; // list signals
  let i = 0, sig: string | null = null;
  if (a[0] === "-s" || a[0] === "-n") { sig = a[1] ?? ""; i = 2; }
  else if (a[0] && a[0].startsWith("-") && a[0] !== "--" && a[0].length > 1) { sig = a[0].slice(1); i = 1; }
  if (a[i] === "--") i++;
  if (sig !== null && /^(SIG)?0$/i.test(sig)) return null; // signal 0 is a liveness probe; nothing is delivered
  if (k.viaXargs && search) return { refuse: true, reason: "a process search piped into kill", match: k.text };
  for (const t of a.slice(i)) {
    if (/\$\(|`/.test(t)) return { refuse: true, reason: "kill target derived from a search or substitution", match: k.text };
    if (t.startsWith("-") || t === "0") return { refuse: true, reason: "process-group / -1 target (cannot be verified as this session's)", match: k.text };
    if (search && /^\$\{?[A-Za-z_0-9@*]/.test(t)) return { refuse: true, reason: "kill target is a variable in a command that runs a process search", match: k.text };
  }
  return null;
}

export function assess(command: string): KillVerdict {
  if (typeof command !== "string" || command.length === 0) return { refuse: false, reason: "no command" };
  const acc: Acc = { nameKill: null, kills: [], search: false };
  try {
    analyze(stripHeredocs(command), 0, acc);
  } catch (e) {
    if (e instanceof TooDeep || e instanceof RangeError) return { refuse: true, reason: "command nests too deeply to assess its kill targets" };
    throw e;
  }
  if (acc.nameKill) return { refuse: true, reason: `${acc.nameKill} selects targets by NAME`, match: acc.nameKill };
  for (const k of acc.kills) {
    const v = judgeKill(k, acc.search);
    if (v) return v;
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
