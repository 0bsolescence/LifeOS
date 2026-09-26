/** SessionHarvester.test.ts — corrections survive embedded evidence; sentence-start anchoring; bounded head sniff. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harvestLearnings, isAgentTranscriptHead, isCorrectionTurn, stripEmbeddedBlocks } from "./SessionHarvester";

const dir = mkdtempSync(join(tmpdir(), "harvester-"));
let n = 0;
function session(turns: [string, string][], head: object[] = []): string {
  const p = join(dir, `s${n++}.jsonl`);
  const rows = [...head, ...turns.map(([role, text], i) => ({ type: role, timestamp: `2026-09-25T20:00:${String(i).padStart(2, "0")}Z`, message: { role, content: role === "assistant" ? [{ type: "text", text }] : text } }))];
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}
const corrections = (p: string) => harvestLearnings(p).filter((l) => l.type === "correction");
const ASSIST = "Here is the identifier I chose for the new field, in camelCase as before.";

describe("embedded blocks", () => {
  test("strip removes pasted content and keeps what was said", () => {
    expect(stripEmbeddedBlocks("Actually, use snake_case. Here is the evidence: <pasted_content id=1>the naming guide</pasted_content>")).toBe("Actually, use snake_case. Here is the evidence:");
  });
  test("strip drops the memory-state block to the end", () => {
    expect(stripEmbeddedBlocks("Wait, check this.\n── CURRENT MEMORY STATE\nActually, stuff")).toBe("Wait, check this.");
  });
  test("a correction beside pasted evidence is captured", () => {
    const p = session([["user", "a question about naming the field please"], ["assistant", ASSIST], ["user", "Actually, use snake_case. Here is the evidence: <pasted_content>the naming guide says actually, wait, use this</pasted_content>"]]);
    expect(corrections(p).length).toBe(1);
  });
  test("a turn that is only a pasted document is not a correction", () => {
    const p = session([["user", "a question about naming the field please"], ["assistant", ASSIST], ["user", "<pasted_content>Actually, the guide says snake_case everywhere. Wait, also this.</pasted_content>"]]);
    expect(corrections(p).length).toBe(0);
  });
  test("a teammate message is not a correction", () => {
    expect(isCorrectionTurn('<teammate-message teammate_id="x">Actually, do the other thing first.</teammate-message>').matches).toBe(false);
  });
});

describe("sentence-start anchoring", () => {
  test("Thanks. Actually, ... is captured", () => {
    const p = session([["user", "a question about naming the field please"], ["assistant", ASSIST], ["user", "Thanks. Actually, use snake_case for the identifier."]]);
    expect(corrections(p).length).toBe(1);
  });
  test("a turn opening with Actually, is captured", () => expect(isCorrectionTurn("Actually, use snake_case for the identifier.").matches).toBe(true));
  test("mid-sentence actually is not", () => expect(isCorrectionTurn("Please do X and actually finish Y before lunch.").matches).toBe(false));
  test("mid-sentence wait is not", () => expect(isCorrectionTurn("We can wait, then ship it tomorrow morning.").matches).toBe(false));
  test("explicit shapes still match anywhere", () => expect(isCorrectionTurn("Hmm, no, I meant the other file entirely.").matches).toBe(true));
});

describe("agent-transcript head sniff", () => {
  test("an agent-setting first line marks a raven transcript and harvests nothing", () => {
    const p = session([["user", "a question about naming the field please"], ["assistant", ASSIST], ["user", "Actually, use snake_case for the identifier."]], [{ type: "agent-setting", agentSetting: { name: "raven" } }]);
    expect(isAgentTranscriptHead(p)).toBe(true);
    expect(corrections(p).length).toBe(0);
  });
  test("an ordinary transcript is not an agent transcript", () => {
    expect(isAgentTranscriptHead(session([["user", "hello there, general question"]]))).toBe(false);
  });
  test("only the first 4096 bytes are read: an agent-setting line past them is not seen", () => {
    const p = join(dir, "late.jsonl");
    writeFileSync(p, JSON.stringify({ type: "user", message: { content: "x".repeat(5000) } }) + "\n" + JSON.stringify({ type: "agent-setting", agentSetting: {} }) + "\n");
    expect(isAgentTranscriptHead(p)).toBe(false);
  });
  test("a large raven transcript is judged from its head", () => {
    const p = join(dir, "big.jsonl");
    writeFileSync(p, JSON.stringify({ type: "agent-setting", agentSetting: {} }) + "\n" + (JSON.stringify({ type: "user", message: { content: "y".repeat(1000) } }) + "\n").repeat(20000));
    const t0 = performance.now();
    expect(isAgentTranscriptHead(p)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(20);
  });
});
