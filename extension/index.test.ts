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

function makeFakePi(opts: { idle?: boolean } = {}): {
  pi: any;
  wakes: CapturedWake[];
  tools: Map<string, { execute: (...args: any[]) => Promise<any> }>;
  ctx: any;
} {
  const wakes: CapturedWake[] = [];
  const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
  const idle = opts.idle ?? true;
  const ctx = { isIdle: () => idle };
  const pi = {
    sendUserMessage(text: string, options?: Record<string, unknown>) {
      wakes.push({ text, options });
    },
    registerTool(def: any) {
      tools.set(def.name, def);
    },
    on() {},
  };
  return { pi, wakes, tools, ctx };
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
