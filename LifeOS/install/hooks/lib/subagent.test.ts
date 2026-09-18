/**
 * subagent.test.ts — the negative and positive controls for isSubagentContext.
 *
 * The negative control is the incident: a main session under Claude Code
 * 2.1.274 carries CLAUDE_CODE_FORK_SUBAGENT=1 and CLAUDE_CODE_CHILD_SESSION=1
 * in every hook process. Those must NOT read as a subagent.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { isSubagentContext } from './subagent';

const MARKERS = [
  'CLAUDE_PROJECT_DIR', 'CLAUDE_AGENT_TYPE', 'CLAUDE_CODE_SUBAGENT_NAME',
  'CLAUDE_CODE_SUBAGENT_TYPE', 'CLAUDE_CODE_FORK_SUBAGENT', 'CLAUDE_AGENT_SDK',
  'CLAUDE_CODE_CHILD_SESSION',
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of MARKERS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of MARKERS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('main session', () => {
  test('clean env, no stdin → false', () => {
    expect(isSubagentContext()).toBe(false);
    expect(isSubagentContext(null)).toBe(false);
  });
  test('2.1.274 env (fork + child markers set), main-session stdin → false (INC-20260918)', () => {
    process.env.CLAUDE_CODE_FORK_SUBAGENT = '1';
    process.env.CLAUDE_CODE_CHILD_SESSION = '1';
    expect(isSubagentContext()).toBe(false);
    expect(isSubagentContext({ session_id: 'x', hook_event_name: 'UserPromptSubmit' } as any)).toBe(false);
  });
  test('empty agent fields do not count', () => {
    expect(isSubagentContext({ agent_id: '', agent_type: '' })).toBe(false);
    expect(isSubagentContext({ agent_id: 42 as any })).toBe(false);
  });
});

describe('subagent', () => {
  test('raven stdin carries agent_id → true, even with a clean env', () => {
    expect(isSubagentContext({ agent_id: 'a95e58d42cddff516', agent_type: 'claude-code-guide' })).toBe(true);
  });
  test('agent_type alone → true', () => {
    expect(isSubagentContext({ agent_type: 'Explore' })).toBe(true);
  });
  test('fork stdin (agent_id, no agent_type) → true', () => {
    expect(isSubagentContext({ agent_id: 'a3446a3d0c882d3bd' })).toBe(true);
  });
  test('explicit env markers still count when there is no stdin', () => {
    process.env.CLAUDE_AGENT_TYPE = 'general-purpose';
    expect(isSubagentContext()).toBe(true);
    delete process.env.CLAUDE_AGENT_TYPE;
    process.env.CLAUDE_CODE_SUBAGENT_NAME = 'raven';
    expect(isSubagentContext()).toBe(true);
    delete process.env.CLAUDE_CODE_SUBAGENT_NAME;
    process.env.CLAUDE_AGENT_SDK = '1';
    expect(isSubagentContext()).toBe(true);
    delete process.env.CLAUDE_AGENT_SDK;
    process.env.CLAUDE_PROJECT_DIR = '/home/x/.claude/Agents/foo';
    expect(isSubagentContext()).toBe(true);
  });
  test('the fork env marker alone is never enough (it is set in main sessions)', () => {
    process.env.CLAUDE_CODE_FORK_SUBAGENT = '1';
    expect(isSubagentContext()).toBe(false);
  });
});
