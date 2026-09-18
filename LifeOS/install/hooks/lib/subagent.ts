/**
 * @version 2.0.0
 * subagent.ts — the single answer to "am I running inside a subagent?"
 *
 * Eight hooks each carried their own copy of this test, and the copies had
 * drifted into two incompatible families:
 *
 *   LoadContext, KittyEnvPersist   → CLAUDE_PROJECT_DIR path + CLAUDE_AGENT_TYPE
 *   the six memory/surface hooks   → CLAUDE_CODE_SUBAGENT_NAME | _TYPE | CLAUDE_AGENT_SDK
 *
 * Neither family sees what the other keys on, so whichever marker the harness
 * actually sets, some hooks were guessing. Duplicated guards drift silently
 * because nothing compares them; one function is the fix, not a rule telling
 * people to keep nine copies in step.
 *
 * v2.0.0 (2026-09-18, INC-20260918-hook-mute): the documented signal comes
 * first. Claude Code puts `agent_id` (and `agent_type`) in the hook's stdin
 * JSON when, and only when, the hook runs inside a subagent (hooks reference:
 * "When running with --agent or inside a subagent, two additional fields are
 * included"). Callers that have parsed their stdin pass it in; the env markers
 * remain as the fallback for callers with no stdin.
 *
 * The one marker that is GONE is `CLAUDE_CODE_FORK_SUBAGENT`. It was added
 * for public issue #1831 (forks set only that marker). From Claude Code
 * 2.1.26x the harness exports it into EVERY child of the main interactive
 * session — hooks included, verified on a live PostToolUse hook process on
 * 2.1.274 — so keying on it muted nine hooks in every primary session for
 * four days before anyone noticed. A false positive here suppresses the
 * session-start context, the hot-layer memory, the 🧠/🩺/⚙️ lines, the ascent
 * strip and the memory reviewer, silently. Never key on an undocumented
 * env variable again; the stdin field is the contract.
 */

/** The two fields Claude Code adds to hook stdin inside a subagent. */
export interface SubagentIdentity {
  agent_id?: unknown;
  agent_type?: unknown;
}

/**
 * True when this process is a subagent/delegate rather than the main session.
 *
 * @param input the hook's parsed stdin JSON, when the caller has it. A hook
 *   that has not read stdin passes nothing and gets the env-only answer.
 */
export function isSubagentContext(input?: SubagentIdentity | null): boolean {
  if (input && typeof input === 'object') {
    if (typeof input.agent_id === 'string' && input.agent_id.length > 0) return true;
    if (typeof input.agent_type === 'string' && input.agent_type.length > 0) return true;
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || '';
  return Boolean(
    projectDir.includes('/.claude/Agents/') ||
      process.env.CLAUDE_AGENT_TYPE ||
      process.env.CLAUDE_CODE_SUBAGENT_NAME ||
      process.env.CLAUDE_CODE_SUBAGENT_TYPE ||
      process.env.CLAUDE_AGENT_SDK === '1',
  );
}
