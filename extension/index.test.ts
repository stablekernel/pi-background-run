/**
 * pi-bgrun — Phase 0 spike smoke tests.
 *
 * These don't require a real pi runtime. We extract the core logic by importing
 * the module's internals via a test harness that fakes the ExtensionAPI:
 *   - fakePi.sendUserMessage captures wake messages
 *   - fakeCtx.isIdle() simulates the agent's idle state (true by default —
 *     bgrun returns immediately so by the time the child exits the agent has
 *     finished its turn)
 *   - we drive a real child_process.spawn through the bgrun tool's execute()
 *   - assert exit handling, log marker, bgtail, bgstatus
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

interface CapturedWake {
  text: string;
  options?: Record<string, unknown>;
}

function makeFakePi(opts: { idle?: boolean; priorEntries?: any[] } = {}): {
  pi: any;
  wakes: CapturedWake[];
  entries: any[];
  tools: Map<string, { execute: (...args: any[]) => Promise<any> }>;
  ctx: any;
  handlers: Map<string, ((...args: any[]) => Promise<any>)[]>;
  fireSessionStart: () => Promise<void>;
} {
  const wakes: CapturedWake[] = [];
  const entries: any[] = opts.priorEntries ? [...opts.priorEntries] : [];
  const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
  const handlers = new Map<string, ((...args: any[]) => Promise<any>)[]>();
  const idle = opts.idle ?? true;
  const ctx = {
    isIdle: () => idle,
    hasUI: false,
    ui: { notify() {}, setWidget() {}, setStatus() {} },
    sessionManager: { getEntries: () => entries },
  };
  const pi = {
    sendUserMessage(text: string, options?: Record<string, unknown>) {
      wakes.push({ text, options });
    },
    appendEntry(customType: string, data?: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    registerEntryRenderer() {},
    registerTool(def: any) {
      tools.set(def.name, def);
    },
    on(event: string, handler: (...args: any[]) => Promise<any>) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
  const fireSessionStart = async () => {
    for (const h of handlers.get("session_start") ?? []) {
      await h({ reason: "startup" }, ctx);
    }
  };
  return { pi, wakes, entries, tools, ctx, handlers, fireSessionStart };
}

async function loadExtension(fakePi: any): Promise<Map<string, { execute: (...args: any[]) => Promise<any> }>> {
  const url = pathToFileURL(join(process.cwd(), "extension/index.ts")).href;
  const mod = await import(url);
  mod.default(fakePi);
  return fakePi.tools as Map<string, { execute: (...args: any[]) => Promise<any> }>;
}

function waitForWakes(wakes: CapturedWake[], count: number, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (wakes.length >= count) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for ${count} wakes, got ${wakes.length}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

test("bgrun: successful command writes log + exit marker and wakes with ✅", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  try {
    const { pi, wakes, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;

    const res = await bgrun.execute("call-1", { command: "echo hello world" }, undefined, undefined, ctx);
    const started = res.content[0].text as string;
    assert.match(started, /^started: /);
    const id = (started.match(/^started: ([^\n]+)/) || [])[1];
    assert.ok(id, "got a job id");

    await waitForWakes(wakes, 1);
    // When idle, sendUserMessage is called with no options.
    assert.equal(wakes[0].options, undefined);
    const wake = wakes[0].text;
    assert.match(wake, /✅/);
    assert.match(wake, /exit 0/);
    assert.match(wake, /hello world/);
    assert.match(wake, new RegExp(id));

    const logPath = join(dir, `${id}.log`);
    assert.ok(existsSync(logPath), "log file exists");
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /hello world/);
    assert.match(log, /__BGRUN_EXIT__=0/);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgrun: failing command wakes with ❌ and the non-zero exit code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  try {
    const { pi, wakes, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;

    await bgrun.execute("call-2", { command: "echo failing now; exit 7" }, undefined, undefined, ctx);
    await waitForWakes(wakes, 1);
    const wake = wakes[0].text;
    assert.match(wake, /❌/);
    assert.match(wake, /exit 7/);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgrun: when agent is busy, wake is queued as followUp", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  try {
    const { pi, wakes, tools, ctx } = makeFakePi({ idle: false });
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;

    await bgrun.execute("call-busy", { command: "echo while-busy" }, undefined, undefined, ctx);
    await waitForWakes(wakes, 1);
    assert.equal(wakes[0].options?.deliverAs, "followUp");
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgtail: returns last N lines, strips the exit marker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  try {
    const { pi, wakes, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;
    const bgtail = tools.get("bgtail")!;

    const res = await bgrun.execute("call-3", { command: "printf 'line1\\nline2\\nline3\\n'" }, undefined, undefined, ctx);
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];
    await waitForWakes(wakes, 1);

    const tail = await bgtail.execute("call-3", { id, lines: 2 }, undefined, undefined, ctx);
    const text = tail.content[0].text as string;
    assert.ok(!text.includes("__BGRUN_EXIT__"), "marker stripped");
    assert.match(text, /line2\nline3$|^line3$/);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgstatus: shows running then done with exit code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  try {
    const { pi, wakes, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;
    const bgstatus = tools.get("bgstatus")!;

    const res = await bgrun.execute("call-4", { command: "sleep 0.2; echo done" }, undefined, undefined, ctx);
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];

    // While running, status should say running.
    const running = await bgstatus.execute("call-4", { id }, undefined, undefined, ctx);
    assert.match(running.content[0].text as string, /running/);

    await waitForWakes(wakes, 1);
    const done = await bgstatus.execute("call-4", { id }, undefined, undefined, ctx);
    assert.match(done.content[0].text as string, /done/);
    assert.match(done.content[0].text as string, /exit=0/);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgstatus: list-all scans the jobs dir after 'restart' (no in-memory records)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  try {
    const { pi, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;
    const res = await bgrun.execute("call-5", { command: "echo persisted" }, undefined, undefined, ctx);
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];

    // Wait for completion by polling the log marker.
    const logPath = join(dir, `${id}.log`);
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        try {
          if (readFileSync(logPath, "utf8").includes("__BGRUN_EXIT__=0")) return resolve();
        } catch {}
        if (Date.now() - start > 5000) return reject(new Error("log marker never appeared"));
        setTimeout(tick, 50);
      };
      tick();
    });

    // Fresh instance — no in-memory records. Directory scan should still find it.
    const { pi: pi2, tools: tools2 } = makeFakePi();
    await loadExtension(pi2);
    const bgstatus2 = tools2.get("bgstatus")!;
    const list = await bgstatus2.execute("call-5", {}, undefined, undefined, ctx);
    assert.match(list.content[0].text as string, new RegExp(id));
    assert.match(list.content[0].text as string, /exit=0/);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgrun: rejects empty command", async () => {
  const { pi, tools, ctx } = makeFakePi();
  await loadExtension(pi);
  const bgrun = tools.get("bgrun")!;
  await assert.rejects(
    () => bgrun.execute("call-6", { command: "" }, undefined, undefined, ctx),
    /command is required/,
  );
});

// ── Phase 1 tests ────────────────────────────────────────────────────────────

test("bgrun: appends bgrun-job entries (running then done)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  try {
    const { pi, wakes, entries, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;

    await bgrun.execute("call-e1", { command: "echo entry-test" }, undefined, undefined, ctx);
    // One running entry appended at start.
    const runningEntries = entries.filter((e) => e.data?.state === "running");
    assert.equal(runningEntries.length, 1, "running entry appended at start");
    assert.equal(runningEntries[0].data.cmd, "echo entry-test");

    await waitForWakes(wakes, 1);
    // One done entry appended on exit.
    const doneEntries = entries.filter((e) => e.data?.state === "done");
    assert.equal(doneEntries.length, 1, "done entry appended on exit");
    assert.equal(doneEntries[0].data.exitCode, 0);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session_start: reconstructs in-memory Map from bgrun-job entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  try {
    // First instance: run a job, capture its entries.
    const { pi: pi1, wakes, entries, tools: tools1, ctx: ctx1 } = makeFakePi();
    await loadExtension(pi1);
    const bgrun1 = tools1.get("bgrun")!;
    const res = await bgrun1.execute("call-r1", { command: "echo reconstruct-me" }, undefined, undefined, ctx1);
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];
    await waitForWakes(wakes, 1);

    // Second instance: simulate a restart. Load fresh, passing the prior entries,
    // then fire session_start to trigger reconstruction.
    const { pi: pi2, tools: tools2, ctx: ctx2, fireSessionStart } = makeFakePi({ priorEntries: entries });
    await loadExtension(pi2);
    await fireSessionStart();

    // Now bgstatus should find the job in the in-memory Map (not just dir scan).
    const bgstatus2 = tools2.get("bgstatus")!;
    const status = await bgstatus2.execute("call-r2", { id }, undefined, undefined, ctx2);
    const text = status.content[0].text as string;
    assert.match(text, /done.*exit=0/);
    // Verify it came from the in-memory Map (not "from log" marker).
    assert.ok(!text.includes("from log"), "reconstructed from entries, not dir scan");
    assert.ok(!text.includes("recovered from log"), "reconstructed from entries, not log recovery");
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgclean: removes old logs, keeps recent ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  try {
    const { pi, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;
    const bgclean = tools.get("bgclean")!;

    // Run a real job (recent log — should be kept).
    await bgrun.execute("call-c1", { command: "echo recent" }, undefined, undefined, ctx);
    await new Promise((r) => setTimeout(r, 200)); // let it finish

    // Write an old log file (backdated mtime).
    const oldPath = join(dir, "old-job-1000000000-99999.log");
    const fs = await import("node:fs");
    fs.writeFileSync(oldPath, "old output\n__BGRUN_EXIT__=0\n");
    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
    fs.utimesSync(oldPath, oldTime, oldTime);

    const result = await bgclean.execute("call-c2", { days: 7 }, undefined, undefined, ctx);
    const text = result.content[0].text as string;
    assert.match(text, /removed 1/);
    assert.ok(!fs.existsSync(oldPath), "old log removed");
    // The recent log should still exist.
    const remaining = fs.readdirSync(dir).filter((f: string) => f.endsWith(".log"));
    assert.equal(remaining.length, 1, "recent log kept");
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgclean: rejects negative days", async () => {
  const { pi, tools, ctx } = makeFakePi();
  await loadExtension(pi);
  const bgclean = tools.get("bgclean")!;
  await assert.rejects(
    () => bgclean.execute("call-c3", { days: -1 }, undefined, undefined, ctx),
    /non-negative/,
  );
});

test("bgclean: does not remove a running job's log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  try {
    const { pi, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;
    const bgclean = tools.get("bgclean")!;

    // Start a long-running job (10s) so it's still running when we clean.
    const res = await bgrun.execute("call-c4", { command: "sleep 10" }, undefined, undefined, ctx);
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];
    const logPath = join(dir, `${id}.log`);

    // Backdate the log's mtime to make it look old — but the job is still running
    // (pid is in the in-memory Map), so bgclean should skip it.
    const fs = await import("node:fs");
    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    // Wait a moment for the log file to exist, then backdate.
    await new Promise((r) => setTimeout(r, 100));
    fs.utimesSync(logPath, oldTime, oldTime);

    const result = await bgclean.execute("call-c5", { days: 7 }, undefined, undefined, ctx);
    const text = result.content[0].text as string;
    assert.match(text, /skipped 1 running/);
    assert.ok(fs.existsSync(logPath), "running job's log not removed");

    // Kill the orphaned sleep so it doesn't linger.
    try { process.kill((res.details as any).pid); } catch {}
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});
