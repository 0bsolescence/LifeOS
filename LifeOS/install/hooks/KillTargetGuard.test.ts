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
