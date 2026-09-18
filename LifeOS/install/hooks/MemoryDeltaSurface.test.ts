/** MemoryDeltaSurface.test.ts — the 🩺 line: CRITICAL always, WARN only after 24 h continuous non-ok. */
import { describe, expect, test } from 'bun:test';
import { healthLineFromLog, WARN_SURFACE_AFTER_MS } from './MemoryDeltaSurface.hook';

const H = 60 * 60 * 1000;
const now = Date.parse('2026-09-18T15:00:00Z');
const row = (agoMs: number, overall: string, extra: any = {}) =>
  JSON.stringify({ ts: new Date(now - agoMs).toISOString(), overall, counts: { critical: 0, warn: 1, ok: 5 }, findings: [{ id: 'x', severity: 'warn', message: 'reviewer never fired' }], ...extra });

describe('healthLineFromLog', () => {
  test('empty log → null', () => { expect(healthLineFromLog('', now)).toBeNull(); });
  test('latest ok → null', () => { expect(healthLineFromLog([row(30 * H, 'warn'), row(1 * H, 'ok')].join('\n'), now)).toBeNull(); });
  test('critical → line regardless of duration', () => {
    const l = healthLineFromLog(row(0, 'critical', { findings: [{ severity: 'critical', message: 'hook file missing' }] }), now);
    expect(l).toMatch(/^🩺 MEMORY HEALTH: CRITICAL — hook file missing/);
  });
  test('warn for 2 h → null (transient)', () => { expect(healthLineFromLog([row(2 * H, 'warn'), row(0, 'warn')].join('\n'), now)).toBeNull(); });
  test('warn continuously for 3 days → WARN line naming the finding and the days', () => {
    const l = healthLineFromLog([row(80 * H, 'warn'), row(50 * H, 'warn'), row(1 * H, 'warn')].join('\n'), now);
    expect(l).toMatch(/^🩺 MEMORY HEALTH: WARN for 3d — reviewer never fired/);
  });
  test('an ok row inside the window resets the stretch', () => {
    const l = healthLineFromLog([row(80 * H, 'warn'), row(20 * H, 'ok'), row(10 * H, 'warn'), row(1 * H, 'warn')].join('\n'), now);
    expect(l).toBeNull();
  });
  test('threshold constant is 24 h', () => { expect(WARN_SURFACE_AFTER_MS).toBe(24 * H); });
});
