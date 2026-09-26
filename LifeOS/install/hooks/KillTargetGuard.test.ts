/** KillTargetGuard.test.ts — refuse cases (the incident's shape and its kin) and allow cases (handles). */
import { describe, expect, test } from 'bun:test';
import { assess, check } from './KillTargetGuard.hook';

const refuse = (c: string) => expect({ c, r: assess(c).refuse }).toEqual({ c, r: true });
const allow = (c: string) => expect({ c, r: assess(c).refuse }).toEqual({ c, r: false });

describe('refuses name- and recency-derived targets', () => {
  test('the incident probe, verbatim shape', () => refuse(`setsid bash -c '( trap "" TERM; sleep 40 ) &' ; sleep 0.6; TGT=$(pgrep -n sleep); PG=$(ps -o pgid= -p $TGT); kill -9 -$PG`));
  test('kill of a pgrep substitution', () => refuse('kill -9 $(pgrep -f gradle)'));
  test('kill of a backtick substitution', () => refuse('kill `pidof emulator`'));
  test('pkill by name', () => refuse('pkill -f qemu-system'));
  test('killall', () => refuse('killall java'));
  test('pgrep piped to xargs kill', () => refuse('pgrep -f "GradleDaemon" | xargs kill -9'));
  test('ps|grep|awk piped to kill', () => refuse("ps aux | grep emulator | awk '{print $2}' | xargs kill"));
  test('ps|grep|while read kill', () => refuse('ps -eo pid,comm | grep node | while read p c; do kill $p; done'));
  test('negative literal group', () => refuse('kill -TERM -12345'));
  test('kill -- -group', () => refuse('kill -- -12345'));
  test('kill -9 -1 (everything)', () => refuse('kill -9 -1'));
  test('negative variable group', () => refuse('kill -9 -$PG'));
  test('inside bash -c', () => refuse(`bash -c "kill -9 -$(pgrep -n sleep)"`));
});

describe('allows launch handles and unit-addressed stops', () => {
  test('literal pid', () => allow('kill 12345'));
  test('signal + literal pid', () => allow('kill -TERM 12345'));
  test('$! handle', () => allow('sleep 40 & PID=$!; kill $PID'));
  test('$! directly', () => allow('kill $!'));
  test('job spec', () => allow('kill %1'));
  test('pidfile read is a variable, not a search', () => allow('kill $(cat /tmp/mine.pid)'.replace('$(cat /tmp/mine.pid)', '$MYPID')));
  test('kill -0 liveness probe with pgrep is a read, not a signal', () => allow('kill -0 $(pgrep -n bun) && echo alive'));
  test('systemctl kill of a unit', () => allow('systemctl --user kill lifeos-liveness.service'));
  test('tmux kill-session', () => allow('tmux kill-session -t build'));
  test('docker kill by container', () => allow('docker kill torkmark-ingest'));
  test('adb kill-server', () => allow('adb kill-server'));
  test('gradlew --stop', () => allow('./gradlew --stop'));
  test('emulator -kill style flag', () => allow('emulator @tk-jku -no-window; adb -s emulator-5554 emu kill'));
  test('a heredoc that WRITES a probe is not a kill', () => allow('cat > /tmp/probe.sh <<EOF\nkill -9 -$(pgrep -n sleep)\nEOF\nchmod +x /tmp/probe.sh'));
  test('the word kill in prose/grep', () => allow('grep -rn "kill -9" hooks/ | head'));
  test('git log mentioning killall in a message', () => allow('git log --oneline | grep -i "killall"'));
});

describe('check() shape', () => {
  test('non-Bash input is ignored', () => expect(check({ tool_input: {} })).toBeNull());
  test('refusal carries the incident id', () => expect(check({ tool_input: { command: 'pkill -f sleep' } })?.message).toMatch(/INC-20260920-reaper-probe-session-kill/));
});

describe('quoted text is data; executed payloads are commands', () => {
  test('pkill inside a JS program string is prose', () => allow(`bun -e 'const s="a rule about pkill and killall"; console.log(s)'`));
  test('commit message mentioning pkill', () => allow(`git commit -m "rules: pkill is never a kill target"`));
  test('grep for pkill', () => allow(`grep -rn "pkill" hooks/`));
  test('sh -c payload with pkill is refused', () => refuse(`sh -c 'pkill -f sleep'`));
  test('eval payload with kill of pgrep is refused', () => refuse(`eval "kill -9 $(pgrep -n java)"`));
  test('sudo pkill refused', () => refuse('sudo pkill -9 -f emulator'));
  test('ssh remote pkill refused', () => refuse(`ssh spare-host 'pkill -f GradleDaemon'`));
  test('xargs kill chain still refused', () => refuse('pgrep -f qemu | xargs kill'));
});

// Codex maintenance review 2026-09-25: every reproducing input, as decided.
describe('codex P1: quoting cannot hide an executed target', () => {
  test('double-quoted group target', () => refuse('kill -9 "-$(pgrep -n sleep)"'));
  test('double-quoted substitution runs pkill', () => refuse('echo "$(pkill -f sleep)"'));
  test('double-quoted variable group target', () => refuse('kill -9 "-$PG"'));
  test('quoted command word is still the command', () => refuse(`'pkill' -f sleep`));
  test('split-quoted command word', () => refuse(`p'k'ill -f sleep`));
  test('apostrophe in a comment does not open a quote', () => refuse("# don't\npkill -f sleep"));
  test('literal double-quoted prose stays data', () => allow('git commit -m "pkill is never a target"'));
  test('metacharacters inside an expanding quote are not separators', () => allow('git commit -m "fix $HOME; pkill is prose"'));
});

describe('codex P1: search-derived variables', () => {
  test('pgrep assigned then killed', () => refuse('TGT=$(pgrep -n sleep); kill -9 $TGT'));
  test('braced variable after pidof', () => refuse('P=`pidof java`\nkill ${P}'));
  test('ps|while read kill via variable', () => refuse('ps -eo pid | while read p; do kill "$p"; done'));
  test('$! handle with no search stays allowed', () => allow('sleep 30 & P=$!; kill $P'));
  test('search in quoted prose is not a search', () => allow(`grep -n 'pgrep' notes.md; kill $P`));
});

describe('codex P1: heredoc detection', () => {
  test('here-string is not a heredoc', () => refuse('cat <<<EOF\nkill -9 -$(pgrep -n sleep)'));
  test('<< inside single quotes is not a heredoc', () => refuse(`printf '%s' '<<EOF'\nkill -9 -$(pgrep -n sleep)`));
  test('<< inside arithmetic is not a heredoc', () => refuse('echo $((1 << SHIFT))\nkill -9 -$(pgrep -n sleep)'));
  test('quoted-tag heredoc body is data', () => allow(`cat > p.sh <<'EOF'\npkill -f sleep\nEOF`));
  test('heredoc fed to a shell is a program', () => refuse('bash <<EOF\npkill -f sleep\nEOF'));
  test('unquoted heredoc substitution runs at write time', () => refuse('cat > x <<EOF\n$(pkill -f sleep)\nEOF'));
  test('command after the heredoc terminator is scanned', () => refuse('cat > x <<EOF\nhello\nEOF\nkill 0'));
});

describe('codex P1: command position and process groups', () => {
  test('path-prefixed pkill', () => refuse('/usr/bin/pkill -f sleep'));
  test('kill 0', () => refuse('kill 0'));
  test('kill -9 0', () => refuse('kill -9 0'));
  test('kill -s KILL -- -123', () => refuse('kill -s KILL -- -123'));
  test('pkill after then', () => refuse('if true; then pkill x; fi'));
  test('pkill in a subshell', () => refuse('( pkill x )'));
  test('pkill in a brace group', () => refuse('{ pkill x; }'));
  test('pkill in process substitution', () => refuse('diff <(pkill x) y'));
  test('sudo -u root pkill', () => refuse('sudo -u root pkill -f x'));
  test('env VAR=1 pkill', () => refuse('env FOO=1 pkill x'));
  test('timeout 5 pkill', () => refuse('timeout 5 pkill x'));
  test('nice -n 10 killall', () => refuse('nice -n 10 killall java'));
  test('command pkill executes', () => refuse('command pkill x'));
  test('backslash-escaped pkill', () => refuse('\\pkill x'));
  test('ssh with options, unquoted remote', () => refuse('ssh -p 22 host pkill x'));
  test('kill -0 <pid> probe stays allowed', () => allow('kill -0 12345'));
  test('kill -0 0 is a probe', () => allow('kill -0 0'));
  test('kill -l lists signals', () => allow('kill -l'));
});

describe('codex P2: ordinary commands are not refused', () => {
  test('command -v pkill', () => allow('command -v pkill'));
  test('echo pkill', () => allow('echo pkill'));
  test('systemctl kill with a substitution argument', () => allow('systemctl kill $(printf lifeos.service)'));
  test('systemctl --user kill unit', () => allow('systemctl --user kill lifeos.service'));
  test('which killall', () => allow('which killall'));
});

describe('performance: no quadratic regex', () => {
  const big = (tok: string) => tok.repeat(Math.ceil(65536 / tok.length)).slice(0, 65536);
  for (const tok of ['ssh a ', 'kill ', "'a' ", '"$x" ', 'a ', 'sudo ', '<< ', '$(a) ']) {
    test(`64 KB of ${JSON.stringify(tok)} under 50 ms`, () => {
      const cmd = big(tok);
      assess(cmd); // warm
      const t0 = performance.now();
      assess(cmd);
      expect(performance.now() - t0).toBeLessThan(50);
    });
  }
  test('pathological nesting is refused, not a crash', () => expect(assess('"$('.repeat(5000)).refuse).toBe(true));
});

describe('codex re-review: new P1 regressions', () => {
  test('attached redirection does not hide pkill', () => refuse('pkill</dev/null -f sleep'));
  test('attached output redirection does not hide pkill', () => refuse('pkill>/dev/null -f sleep'));
  test('env --unset VAR pkill', () => refuse('env --unset HOME pkill -f sleep'));
  test('sudo --user root pkill', () => refuse('sudo --user root pkill -f sleep'));
  test('fd redirections still parse', () => allow('make build 2>&1 >/dev/null; echo done 2>/dev/null'));
  test('sudo --user root on a safe command', () => allow('sudo --user root systemctl status x'));
});
