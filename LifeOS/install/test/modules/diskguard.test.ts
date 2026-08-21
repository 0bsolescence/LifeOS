/**
 * diskguard.test.ts — the pure logic of the DiskGuard Pulse module.
 *
 * Everything here runs on fixtures: canned df/du output and a synthetic snap
 * tree in a temp dir. Nothing reads the host's actual disk state, so the
 * suite passes identically on a full disk and an empty one.
 *
 * Zero external deps, per the testing doctrine's harness rule.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseDfPosix,
  classifyPercent,
  resolveConfig,
  interpretDu,
  formatBytes,
  discoverSnapCommonDirs,
  start,
  stop,
  health,
  handleRequest,
  __setRuntimeDepsForTests,
  __inspectRuntimeForTests,
  type DiskGuardConfig,
} from "../../LIFEOS/PULSE/modules/diskguard";

const cfg = (over: Partial<DiskGuardConfig> = {}): DiskGuardConfig => ({
  warnPercent: 80,
  criticalPercent: 90,
  watchPaths: [],
  checkIntervalSeconds: 300,
  duTimeoutMs: 30_000,
  ...over,
});

const du = (over: Partial<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> = {}) => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...over,
});

// ── parseDfPosix ──

describe("parseDfPosix", () => {
  test("parses a typical linux df -P -k root line", () => {
    const out = [
      "Filesystem     1024-blocks      Used Available Capacity Mounted on",
      "/dev/nvme0n1p2   479079112 258887900 195781340      57% /",
    ].join("\n");
    const entries = parseDfPosix(out);
    expect(entries.length).toBe(1);
    expect(entries[0]).toEqual({
      filesystem: "/dev/nvme0n1p2",
      sizeKb: 479079112,
      usedKb: 258887900,
      availKb: 195781340,
      usedPercent: 57,
      mount: "/",
    });
  });

  test("survives filesystem names and mount points containing spaces", () => {
    const out = [
      "Filesystem 1024-blocks Used Available Capacity Mounted on",
      "map auto_home 0 0 0 100% /System/Volumes/Data/home",
      "/dev/disk3s1 971350180 21569540 552003420 4% /Volumes/My Backup Disk",
    ].join("\n");
    const entries = parseDfPosix(out);
    expect(entries.length).toBe(2);
    expect(entries[0].filesystem).toBe("map auto_home");
    expect(entries[1].mount).toBe("/Volumes/My Backup Disk");
    expect(entries[1].usedPercent).toBe(4);
  });

  test("ignores the header and unparseable lines", () => {
    expect(parseDfPosix("Filesystem 1024-blocks Used Available Capacity Mounted on\ngarbage\n")).toEqual([]);
    expect(parseDfPosix("")).toEqual([]);
  });

  test("a filesystem at 100% parses as 100", () => {
    const out = "h\n/dev/sda1 100 100 0 100% /\n";
    expect(parseDfPosix(out)[0].usedPercent).toBe(100);
  });
});

// ── classifyPercent ──

describe("classifyPercent", () => {
  test("below warn is ok", () => {
    expect(classifyPercent(79, cfg())).toBe("ok");
  });
  test("warn threshold is inclusive", () => {
    expect(classifyPercent(80, cfg())).toBe("warn");
    expect(classifyPercent(89, cfg())).toBe("warn");
  });
  test("critical threshold is inclusive and wins over warn", () => {
    expect(classifyPercent(90, cfg())).toBe("critical");
    expect(classifyPercent(100, cfg())).toBe("critical");
  });
  test("respects custom thresholds", () => {
    const c = cfg({ warnPercent: 50, criticalPercent: 70 });
    expect(classifyPercent(49, c)).toBe("ok");
    expect(classifyPercent(50, c)).toBe("warn");
    expect(classifyPercent(70, c)).toBe("critical");
  });
});

// ── resolveConfig ──

describe("resolveConfig", () => {
  test("empty section yields defaults with discovered snap dirs as the watch list", () => {
    const c = resolveConfig(undefined, ["/var/snap/docker/common"]);
    expect(c.warnPercent).toBe(80);
    expect(c.criticalPercent).toBe(90);
    expect(c.watchPaths).toEqual(["/var/snap/docker/common"]);
  });

  test("merges extra watch_paths after discovered dirs, deduplicated", () => {
    const c = resolveConfig(
      { watch_paths: ["/var/lib/docker", "/var/snap/docker/common"] },
      ["/var/snap/docker/common", "/var/snap/lxd/common"],
    );
    expect(c.watchPaths).toEqual(["/var/snap/docker/common", "/var/snap/lxd/common", "/var/lib/docker"]);
  });

  test("drops non-absolute and non-string watch_paths entries", () => {
    const c = resolveConfig({ watch_paths: ["relative/path", 42, "/ok"] }, []);
    expect(c.watchPaths).toEqual(["/ok"]);
  });

  test("nonsense thresholds fall back to defaults rather than disabling the guard", () => {
    expect(resolveConfig({ warn_percent: 95, critical_percent: 90 }, []).warnPercent).toBe(80);
    expect(resolveConfig({ warn_percent: 0 }, []).warnPercent).toBe(80);
    expect(resolveConfig({ warn_percent: "85" }, []).warnPercent).toBe(80);
    expect(resolveConfig({ critical_percent: 101 }, []).criticalPercent).toBe(90);
  });

  test("valid custom thresholds are honored", () => {
    const c = resolveConfig({ warn_percent: 70, critical_percent: 85 }, []);
    expect(c.warnPercent).toBe(70);
    expect(c.criticalPercent).toBe(85);
  });

  test("interval and du timeout are floored at sane minimums", () => {
    const c = resolveConfig({ check_interval_seconds: 1, du_timeout_ms: 5 }, []);
    expect(c.checkIntervalSeconds).toBe(30);
    expect(c.duTimeoutMs).toBe(1000);
  });
});

// ── interpretDu ──

describe("interpretDu", () => {
  const P = "/var/snap/docker/common";

  test("clean exit reports verified bytes", () => {
    const r = interpretDu(du({ stdout: "125829120\t/var/snap/docker/common\n" }), P);
    expect(r.verified).toBe(true);
    expect(r.bytes).toBe(125829120 * 1024);
    expect(r.note).toBeNull();
    expect(r.human).toBe("120 GiB");
  });

  test("permission-denied with a partial size reports an unverified floor, never a fact", () => {
    const r = interpretDu(
      du({
        exitCode: 1,
        stdout: "4096\t/var/snap/docker/common\n",
        stderr: "du: cannot read directory '/var/snap/docker/common/var-lib-docker': Permission denied\n",
      }),
      P,
    );
    expect(r.verified).toBe(false);
    expect(r.bytes).toBe(4096 * 1024);
    expect(r.note).toContain("at least");
  });

  test("permission-denied with a zero size collapses to unreadable — a 0 floor is no information", () => {
    // Real GNU du prints "0\t<path>" even for a fully-denied tree; reporting
    // that as "0 B" is exactly the fabricated number the honesty contract bans.
    const r = interpretDu(
      du({
        exitCode: 1,
        stdout: "0\t/var/snap/docker/common\n",
        stderr: "du: cannot read directory '/var/snap/docker/common': Permission denied\n",
      }),
      P,
    );
    expect(r.verified).toBe(false);
    expect(r.bytes).toBeNull();
    expect(r.note).toBe("unreadable without privilege");
  });

  test("permission-denied with no size at all reports unreadable without privilege", () => {
    const r = interpretDu(
      du({ exitCode: 1, stderr: "du: cannot read directory '/var/snap/docker/common': Permission denied\n" }),
      P,
    );
    expect(r.verified).toBe(false);
    expect(r.bytes).toBeNull();
    expect(r.note).toBe("unreadable without privilege");
  });

  test("timeout makes no claim about size", () => {
    const r = interpretDu(du({ exitCode: 143, timedOut: true, stdout: "999\t/x\n" }), P);
    expect(r.verified).toBe(false);
    expect(r.bytes).toBeNull();
    expect(r.note).toContain("timed out");
  });

  test("a non-permission failure surfaces the first stderr line", () => {
    const r = interpretDu(du({ exitCode: 2, stderr: "du: unexpected explosion\nmore noise\n" }), P);
    expect(r.verified).toBe(false);
    expect(r.bytes).toBeNull();
    expect(r.note).toBe("du: unexpected explosion");
  });
});

// ── formatBytes ──

describe("formatBytes", () => {
  test("scales through the units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
    expect(formatBytes(120 * 1024 * 1024 * 1024)).toBe("120 GiB");
  });
});

// ── discoverSnapCommonDirs ──

describe("discoverSnapCommonDirs", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "diskguard-snap-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("finds every <name>/common under the snap root, sorted", () => {
    mkdirSync(join(root, "docker", "common"), { recursive: true });
    mkdirSync(join(root, "lxd", "common"), { recursive: true });
    mkdirSync(join(root, "core22"), { recursive: true }); // no common/ — excluded
    expect(discoverSnapCommonDirs(root)).toEqual([
      join(root, "docker", "common"),
      join(root, "lxd", "common"),
    ]);
  });

  test("a missing snap root yields an empty list, not an error", () => {
    expect(discoverSnapCommonDirs(join(root, "does-not-exist"))).toEqual([]);
  });
});

// ── Runtime: lifecycle and concurrency ──
//
// These drive the real start/stop/handleRequest surface with every host touch
// (df, du, PULSE.toml, /var/snap, existence checks) replaced, so they assert
// runtime behaviour without reading a byte of the host's actual disk usage.

const DF_OK = {
  exitCode: 0,
  stdout: [
    "Filesystem     1024-blocks      Used Available Capacity Mounted on",
    "/dev/sda1            100000     57000     43000      57% /",
    "",
  ].join("\n"),
  stderr: "",
  timedOut: false,
};

/** Let already-resolved promise chains drain before asserting. */
const settle = () => new Promise((r) => setTimeout(r, 0));

// Discovery over a path that does not exist yields an empty watch list, which
// is all these cases need — so they require no writable filesystem at all and
// run identically in a sandbox with a read-only /tmp.
const ABSENT_SNAP_ROOT = "/nonexistent/diskguard-test-snap-root";

const stateRequest = () => new Request("http://127.0.0.1:31337/api/diskguard");
const refreshRequest = () => new Request("http://127.0.0.1:31337/api/diskguard?refresh=1");

describe("runtime lifecycle", () => {
  beforeEach(() => {
    __setRuntimeDepsForTests({
      runCmd: async () => DF_OK,
      loadSection: () => ({}),
      snapRoot: ABSENT_SNAP_ROOT,
      exists: () => false,
    });
  });

  afterEach(async () => {
    await stop();
    await settle();
    __setRuntimeDepsForTests(null);
  });

  test("start arms the periodic check and stop disarms it", async () => {
    expect(__inspectRuntimeForTests().timerArmed).toBe(false);

    await start();
    await settle();
    const started = __inspectRuntimeForTests();
    expect(started.timerArmed).toBe(true);
    expect(started.running).toBe(true);

    // The Pulse cleanup path calls this; an uncleared interval keeps firing du
    // sweeps and keeps the process referenced through shutdown.
    await stop();
    const stopped = __inspectRuntimeForTests();
    expect(stopped.timerArmed).toBe(false);
    expect(stopped.running).toBe(false);
    expect(health().status).toBe("stopped");
  });

  test("stop is idempotent — a second call leaves the timer disarmed", async () => {
    await start();
    await settle();
    await stop();
    await stop();
    expect(__inspectRuntimeForTests().timerArmed).toBe(false);
  });
});

describe("concurrent check coalescing", () => {
  let dfCalls: number;
  let release: () => void;
  let gate: Promise<void>;

  beforeEach(() => {
    dfCalls = 0;
    gate = new Promise<void>((r) => {
      release = r;
    });
    __setRuntimeDepsForTests({
      loadSection: () => ({}),
      snapRoot: ABSENT_SNAP_ROOT,
      exists: () => false,
      runCmd: async (cmd) => {
        if (cmd[0] === "df") dfCalls++;
        await gate;
        return DF_OK;
      },
    });
  });

  afterEach(async () => {
    release();
    await stop();
    await settle();
    __setRuntimeDepsForTests(null);
  });

  test("two concurrent refreshes run one scan and share its report", async () => {
    const first = handleRequest(refreshRequest(), "/api/diskguard");
    expect(__inspectRuntimeForTests().checkInFlight).toBe(true);
    const second = handleRequest(refreshRequest(), "/api/diskguard");

    release();
    const [a, b] = await Promise.all([first, second]);
    // One df spawn means one du sweep per watch path, not two — the whole
    // point: refresh pressure must not multiply I/O on a box short of headroom.
    expect(dfCalls).toBe(1);

    const reportA = await a!.json();
    const reportB = await b!.json();
    expect(reportA.checkedAt).toBe(reportB.checkedAt);
    expect(reportA.root.usedPercent).toBe(57);
  });

  test("a refresh arriving during the boot check joins it rather than spawning a second", async () => {
    await start();
    expect(dfCalls).toBe(1);

    const joined = handleRequest(refreshRequest(), "/api/diskguard");
    expect(dfCalls).toBe(1);

    release();
    const resp = await joined;
    expect(resp!.status).toBe(200);
    expect(dfCalls).toBe(1);
  });

  test("the in-flight slot clears, so a later refresh runs a fresh scan", async () => {
    const first = handleRequest(refreshRequest(), "/api/diskguard");
    release();
    await first;
    await settle();
    expect(__inspectRuntimeForTests().checkInFlight).toBe(false);

    await handleRequest(refreshRequest(), "/api/diskguard");
    expect(dfCalls).toBe(2);
  });

  test("a plain state read serves the cached report without starting a scan", async () => {
    release();
    await handleRequest(refreshRequest(), "/api/diskguard");
    await settle();
    expect(dfCalls).toBe(1);

    const cached = await handleRequest(stateRequest(), "/api/diskguard");
    expect(cached!.status).toBe(200);
    expect(dfCalls).toBe(1);
  });

  test("a failed scan releases the slot instead of pinning it forever", async () => {
    __setRuntimeDepsForTests({
      loadSection: () => ({}),
      snapRoot: ABSENT_SNAP_ROOT,
      exists: () => false,
      runCmd: async () => {
        throw new Error("df exploded");
      },
    });

    await expect(handleRequest(refreshRequest(), "/api/diskguard")).rejects.toThrow("df exploded");
    await settle();
    expect(__inspectRuntimeForTests().checkInFlight).toBe(false);
  });
});

// ── Pulse shutdown wiring ──

describe("pulse.ts cleanup path", () => {
  test("stops DiskGuard alongside the other modules that expose stop()", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "LIFEOS", "PULSE", "pulse.ts"), "utf8");
    const marker = "── Cleanup ──";
    expect(src).toContain(marker);
    const cleanup = src.slice(src.lastIndexOf(marker));
    // The interval start() arms is only ever cleared from here.
    expect(cleanup).toContain("diskguardModule.stop");
  });
});
