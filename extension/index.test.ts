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
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

interface CapturedWake {
  text: string;
  options?: Record<string, unknown>;
}

function makeFakePi(
  opts: {
    idle?: boolean;
    priorEntries?: any[];
    ctxFields?: Record<string, unknown>;
  } = {},
): {
  pi: any;
  wakes: CapturedWake[];
  entries: any[];
  tools: Map<string, { execute: (...args: any[]) => Promise<any> }>;
  commands: Map<
    string,
    { description?: string; handler: (...args: any[]) => Promise<void> }
  >;
  ctx: any;
  handlers: Map<string, ((...args: any[]) => Promise<any>)[]>;
  fireSessionStart: () => Promise<void>;
} {
  const wakes: CapturedWake[] = [];
  const entries: any[] = opts.priorEntries ? [...opts.priorEntries] : [];
  const tools = new Map<
    string,
    { execute: (...args: any[]) => Promise<any> }
  >();
  const commands = new Map<
    string,
    { description?: string; handler: (...args: any[]) => Promise<void> }
  >();
  const handlers = new Map<string, ((...args: any[]) => Promise<any>)[]>();
  const idle = opts.idle ?? true;
  const ctx = {
    isIdle: () => idle,
    hasUI: false,
    ui: { notify() {}, setWidget() {}, setStatus() {} },
    sessionManager: { getEntries: () => entries },
    ...(opts.ctxFields as Record<string, unknown> | undefined),
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
    registerCommand(name: string, def: any) {
      commands.set(name, def);
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
  return {
    pi,
    wakes,
    entries,
    tools,
    commands,
    ctx,
    handlers,
    fireSessionStart,
  };
}

async function loadExtension(
  fakePi: any,
): Promise<Map<string, { execute: (...args: any[]) => Promise<any> }>> {
  const url = pathToFileURL(join(process.cwd(), "extension/index.ts")).href;
  const mod = await import(url);
  mod.default(fakePi);
  return fakePi.tools as Map<
    string,
    { execute: (...args: any[]) => Promise<any> }
  >;
}

function waitForWakes(
  wakes: CapturedWake[],
  count: number,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (wakes.length >= count) return resolve();
      if (Date.now() - start > timeoutMs)
        return reject(
          new Error(
            `timed out waiting for ${count} wakes, got ${wakes.length}`,
          ),
        );
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

    const res = await bgrun.execute(
      "call-1",
      { command: "echo hello world" },
      undefined,
      undefined,
      ctx,
    );
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

    await bgrun.execute(
      "call-2",
      { command: "echo failing now; exit 7" },
      undefined,
      undefined,
      ctx,
    );
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

    await bgrun.execute(
      "call-busy",
      { command: "echo while-busy" },
      undefined,
      undefined,
      ctx,
    );
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

    const res = await bgrun.execute(
      "call-3",
      { command: "printf 'line1\\nline2\\nline3\\n'" },
      undefined,
      undefined,
      ctx,
    );
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];
    await waitForWakes(wakes, 1);

    const tail = await bgtail.execute(
      "call-3",
      { id, lines: 2 },
      undefined,
      undefined,
      ctx,
    );
    const text = tail.content[0].text as string;
    assert.ok(!text.includes("__BGRUN_EXIT__"), "marker stripped");
    assert.match(text, /line2\nline3$|^line3$/);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgtail: condenses output — strips ANSI, collapses repeats, caps long lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  try {
    const { pi, wakes, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;
    const bgtail = tools.get("bgtail")!;

    // 1 ANSI-colored line, 5 identical spinner lines, 1 huge line
    const esc = "\u001b"; // literal ESC byte, safe to pass through a shell arg
    const payload =
      `printf "${esc}[32mOK green${esc}[0m\nwait\nwait\nwait\nwait\nwait\nline3\n"; ` +
      "echo \"$(printf 'x%.0s' $(seq 1 5000))\"";
    const res = await bgrun.execute(
      "call-c1",
      { command: payload },
      undefined,
      undefined,
      ctx,
    );
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];
    await waitForWakes(wakes, 1);

    const tail = await bgtail.execute(
      "call-c1",
      { id, lines: 40 },
      undefined,
      undefined,
      ctx,
    );
    const text = tail.content[0].text as string;
    assert.ok(!text.includes("\u001b"), "ANSI escapes stripped");
    assert.ok(text.includes("OK green"), "text after stripping survives");
    assert.match(
      text,
      /wait {2}\[x5\]/,
      "5 identical lines collapsed to one with count",
    );
    assert.ok(!text.includes("x".repeat(4000)), "5000-char line capped");
    assert.match(text, /\u2026\[\+3\d{3} chars\]/, "truncation marker present");
    assert.match(text, /\(\d+ ANSI escape/, "notes mention ANSI stripping");
    assert.match(
      text,
      /1 repeated-line run collapsed/,
      "notes mention run collapse",
    );
    assert.ok((tail.details as any).condensed === true);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgtail: raw=true skips condensing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  try {
    const { pi, wakes, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;
    const bgtail = tools.get("bgtail")!;

    const esc = "\u001b";
    const res = await bgrun.execute(
      "call-c2",
      { command: `printf "${esc}[31mraw-red${esc}[0m\nwait\nwait\nwait\n"` },
      undefined,
      undefined,
      ctx,
    );
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];
    await waitForWakes(wakes, 1);

    const tail = await bgtail.execute(
      "call-c2",
      { id, raw: true },
      undefined,
      undefined,
      ctx,
    );
    const text = tail.content[0].text as string;
    assert.ok(text.includes("\u001b[31m"), "raw keeps ANSI escapes");
    assert.ok(
      text.includes("wait\nwait\nwait"),
      "raw keeps repeated lines uncollapsed",
    );
    assert.ok((tail.details as any).condensed === false);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgtail: total cap kicks in on large output with guidance note", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  try {
    const { pi, wakes, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;
    const bgtail = tools.get("bgtail")!;

    // ~200 distinct lines x ~500 chars = ~100KB, well past the 8KB total cap
    const cmd =
      "for i in $(seq 1 200); do echo \"line-$i $(printf 'y%.0s' $(seq 1 500))\"; done";
    const res = await bgrun.execute(
      "call-c3",
      { command: cmd },
      undefined,
      undefined,
      ctx,
    );
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];
    await waitForWakes(wakes, 1);

    const tail = await bgtail.execute(
      "call-c3",
      { id, lines: 200 },
      undefined,
      undefined,
      ctx,
    );
    const text = tail.content[0].text as string;
    assert.ok(text.length < 10_000, "result capped well below raw size");
    assert.match(
      text,
      /output capped at 8000 chars — 200 raw lines total/,
      "cap note names the raw line count and suggests escalation paths",
    );
    assert.ok((tail.details as any).condenserNotes, "notes in details too");
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

    const res = await bgrun.execute(
      "call-4",
      { command: "sleep 0.2; echo done" },
      undefined,
      undefined,
      ctx,
    );
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];

    // While running, status should say running.
    const running = await bgstatus.execute(
      "call-4",
      { id },
      undefined,
      undefined,
      ctx,
    );
    assert.match(running.content[0].text as string, /running/);

    await waitForWakes(wakes, 1);
    const done = await bgstatus.execute(
      "call-4",
      { id },
      undefined,
      undefined,
      ctx,
    );
    assert.match(done.content[0].text as string, /done/);
    assert.match(done.content[0].text as string, /exit=0/);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgstatus: list-all after 'restart' hides finished logs by default, notes them instead", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  delete process.env.PI_BGRUN_FOREIGN_JOBS;
  try {
    const { pi, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;
    const res = await bgrun.execute(
      "call-5",
      { command: "echo persisted" },
      undefined,
      undefined,
      ctx,
    );
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];

    // Wait for completion by polling the log marker.
    const logPath = join(dir, `${id}.log`);
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        try {
          if (readFileSync(logPath, "utf8").includes("__BGRUN_EXIT__=0"))
            return resolve();
        } catch {}
        if (Date.now() - start > 5000)
          return reject(new Error("log marker never appeared"));
        setTimeout(tick, 50);
      };
      tick();
    });

    // Fresh instance — no in-memory records. Default listing must NOT spam the
    // finished job; it gets a one-line count note instead.
    const { pi: pi2, tools: tools2 } = makeFakePi();
    await loadExtension(pi2);
    const bgstatus2 = tools2.get("bgstatus")!;
    const list = await bgstatus2.execute(
      "call-5",
      {},
      undefined,
      undefined,
      ctx,
    );
    const text = list.content[0].text as string;
    assert.ok(!new RegExp(id).test(text), "finished job hidden by default");
    assert.match(text, /\(1 more job log\(s\) on disk/);

    // includeDone reveals it with the exit code recovered from the log.
    const full = await bgstatus2.execute(
      "call-5b",
      { includeDone: true },
      undefined,
      undefined,
      ctx,
    );
    const fullText = full.content[0].text as string;
    assert.match(fullText, new RegExp(id));
    assert.match(fullText, /exit=0/);
    assert.match(fullText, /\(from log\)/);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgstatus: showCompletedJobs config (env) lists finished jobs by default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  process.env.PI_BGRUN_SHOW_COMPLETED = "1";
  try {
    const { pi, wakes, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;
    const bgstatus = tools.get("bgstatus")!;

    const res = await bgrun.execute(
      "call-sd1",
      { command: "echo shown-done", name: "done-job" },
      undefined,
      undefined,
      ctx,
    );
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];
    await waitForWakes(wakes, 1);

    const list = await bgstatus.execute(
      "call-sd2",
      {},
      undefined,
      undefined,
      ctx,
    );
    assert.match(
      list.content[0].text as string,
      new RegExp(`${id} — done-job: done exit=0`),
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    delete process.env.PI_BGRUN_SHOW_COMPLETED;
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

    await bgrun.execute(
      "call-e1",
      { command: "echo entry-test" },
      undefined,
      undefined,
      ctx,
    );
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
    const res = await bgrun1.execute(
      "call-r1",
      { command: "echo reconstruct-me" },
      undefined,
      undefined,
      ctx1,
    );
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];
    await waitForWakes(wakes, 1);

    // Second instance: simulate a restart. Load fresh, passing the prior entries,
    // then fire session_start to trigger reconstruction.
    const {
      pi: pi2,
      tools: tools2,
      ctx: ctx2,
      fireSessionStart,
    } = makeFakePi({ priorEntries: entries });
    await loadExtension(pi2);
    await fireSessionStart();

    // Now bgstatus should find the job in the in-memory Map (not just dir scan).
    const bgstatus2 = tools2.get("bgstatus")!;
    const status = await bgstatus2.execute(
      "call-r2",
      { id },
      undefined,
      undefined,
      ctx2,
    );
    const text = status.content[0].text as string;
    assert.match(text, /done.*exit=0/);
    // Verify it came from the in-memory Map (not "from log" marker).
    assert.ok(
      !text.includes("from log"),
      "reconstructed from entries, not dir scan",
    );
    assert.ok(
      !text.includes("recovered from log"),
      "reconstructed from entries, not log recovery",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── name (human-readable label) tests ───────────────────────────────────────

test("bgrun: name flows into job id, response, entry, wake, and status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  try {
    const { pi, wakes, entries, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;

    const res = await bgrun.execute(
      "call-n1",
      { command: "echo named job", name: "unit-tests" },
      undefined,
      undefined,
      ctx,
    );
    const text = res.content[0].text as string;
    const id = (text.match(/^started: ([^\n]+)/) || [])[1];
    // Slug derives from the name, not the command.
    assert.ok(
      id.startsWith("unit-tests-"),
      `id should start with 'unit-tests-': ${id}`,
    );
    // Response includes the name.
    assert.match(text, /name: unit-tests/);
    // Details include the name.
    assert.equal((res.details as any).name, "unit-tests");

    await waitForWakes(wakes, 1);
    const wake = wakes[0].text;
    // Wake includes the name.
    assert.match(wake, /"unit-tests"/);

    // Persisted entries carry the name.
    const withName = entries.filter((e) => e.data?.name === "unit-tests");
    assert.equal(withName.length, 2, "running + done entries carry name");
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgrun: name is optional — behavior unchanged without it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  try {
    const { pi, wakes, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;

    const res = await bgrun.execute(
      "call-n2",
      { command: "echo unnamed job" },
      undefined,
      undefined,
      ctx,
    );
    const text = res.content[0].text as string;
    // No 'name:' line in the response.
    assert.ok(!/^ {2}name:/m.test(text), "no name line when name omitted");
    const id = (text.match(/^started: ([^\n]+)/) || [])[1];
    assert.ok(
      id.startsWith("echo-unnamed-job-"),
      `slug falls back to command: ${id}`,
    );

    await waitForWakes(wakes, 1);
    assert.ok(
      !wakes[0].text.includes('"'),
      "wake has no name quote when unnamed",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgrun: blank name is ignored, over-long name is truncated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  try {
    const { pi, wakes, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;

    // Blank name treated as absent.
    const res1 = await bgrun.execute(
      "call-n3",
      { command: "echo blank", name: "   " },
      undefined,
      undefined,
      ctx,
    );
    assert.ok(
      !/^ {2}name:/m.test(res1.content[0].text as string),
      "blank name ignored",
    );

    // Over-long name truncated to 80 chars.
    const longName = "x".repeat(200);
    const res2 = await bgrun.execute(
      "call-n4",
      { command: "echo long", name: longName },
      undefined,
      undefined,
      ctx,
    );
    const text2 = res2.content[0].text as string;
    const nameLine = (text2.match(/^ {2}name: (.+)$/m) || [])[1];
    assert.equal(nameLine.length, 80, "name truncated to 80 chars");

    await waitForWakes(wakes, 2);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgrun: name survives session_start reconstruction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  try {
    // First instance: run a named job, capture entries.
    const { pi: pi1, wakes, entries, tools: tools1, ctx: ctx1 } = makeFakePi();
    await loadExtension(pi1);
    const bgrun1 = tools1.get("bgrun")!;
    const res = await bgrun1.execute(
      "call-n5",
      { command: "echo named-restart", name: "rebuild" },
      undefined,
      undefined,
      ctx1,
    );
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];
    await waitForWakes(wakes, 1);

    // Second instance: reconstruct from entries, name should be restored.
    const {
      pi: pi2,
      tools: tools2,
      ctx: ctx2,
      fireSessionStart,
    } = makeFakePi({ priorEntries: entries });
    await loadExtension(pi2);
    await fireSessionStart();

    const bgstatus2 = tools2.get("bgstatus")!;
    const status = await bgstatus2.execute(
      "call-n6",
      { id },
      undefined,
      undefined,
      ctx2,
    );
    const text = status.content[0].text as string;
    assert.match(text, /name: rebuild/);
    assert.ok(
      !text.includes("recovered from log"),
      "reconstructed from entries, not log",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgstatus: list shows name after job id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  try {
    const { pi, wakes, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;
    const bgstatus = tools.get("bgstatus")!;

    await bgrun.execute(
      "call-n7",
      { command: "sleep 0.1; echo listed", name: "nightly" },
      undefined,
      undefined,
      ctx,
    );
    await waitForWakes(wakes, 1);

    const list = await bgstatus.execute(
      "call-n8",
      { includeDone: true },
      undefined,
      undefined,
      ctx,
    );
    assert.match(list.content[0].text as string, /— nightly: done exit=0/);
    // Without includeDone, finished jobs are hidden by default.
    const runningOnly = await bgstatus.execute(
      "call-n8b",
      {},
      undefined,
      undefined,
      ctx,
    );
    assert.ok(
      !/— nightly: done/.test(runningOnly.content[0].text as string),
      "done job hidden without includeDone",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session_start: foreign jobs are NOT adopted by default (opt-in only)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  delete process.env.PI_BGRUN_FOREIGN_JOBS;
  try {
    // A running foreign job (no exit marker, live pid — this test process).
    const foreignId = `other-session-job-${Date.now()}-${process.pid}`;
    writeFileSync(join(dir, `${foreignId}.log`), "someone else's job\n");

    const { pi, tools, ctx, fireSessionStart } = makeFakePi();
    ctx.hasUI = true;
    const widgetCalls: (string[] | undefined)[] = [];
    ctx.ui.setWidget = (_ns: string, lines: string[] | undefined) =>
      widgetCalls.push(lines);

    await loadExtension(pi);
    await fireSessionStart();

    // Widget never shows the foreign job.
    const shown = widgetCalls.find((l) => Array.isArray(l));
    assert.equal(
      shown,
      undefined,
      "no widget content for foreign jobs by default",
    );

    // List-all gives a count note, not the job itself.
    const bgstatus = tools.get("bgstatus")!;
    const list = await bgstatus.execute(
      "call-f1",
      {},
      undefined,
      undefined,
      ctx,
    );
    const text = list.content[0].text as string;
    assert.ok(!text.includes(foreignId), "foreign job not listed by default");
    assert.match(text, /\(1 more job log\(s\) on disk/);

    // Single-id lookup still works — that's the explicit escape hatch.
    const one = await bgstatus.execute(
      "call-f2",
      { id: foreignId },
      undefined,
      undefined,
      ctx,
    );
    assert.match(one.content[0].text as string, /: running/);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session_start: adopts running jobs from the jobs dir (other session's job) into the widget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  process.env.PI_BGRUN_FOREIGN_JOBS = "1";
  try {
    // A log with no exit marker whose pid is alive (this test process's own pid).
    const adoptedId = `kafka-bootstrap-${Date.now()}-${process.pid}`;
    writeFileSync(join(dir, `${adoptedId}.log`), "job still going\n");

    const { pi, tools, ctx, fireSessionStart } = makeFakePi();
    ctx.hasUI = true;
    const widgetCalls: (string[] | undefined)[] = [];
    ctx.ui.setWidget = (_ns: string, lines: string[] | undefined) =>
      widgetCalls.push(lines);

    await loadExtension(pi);
    await fireSessionStart();

    // Widget should now show the adopted job.
    const shown = widgetCalls.find((l) => Array.isArray(l)) ?? [];
    const flat = (shown as string[]).join("\n");
    assert.match(flat, /bgrun: 1 running/);
    assert.match(flat, new RegExp(adoptedId.slice(0, 20)));
    assert.match(flat, /\(adopted\)/);
    assert.match(flat, /since \d{2}:\d{2}:\d{2}/);

    // bgstatus single-id should also see it as running (in-memory now).
    const bgstatus = tools.get("bgstatus")!;
    const res = await bgstatus.execute(
      "call-a1",
      { id: adoptedId },
      undefined,
      undefined,
      ctx,
    );
    assert.match(res.content[0].text as string, /: running/);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    delete process.env.PI_BGRUN_FOREIGN_JOBS;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adopted job leaves the widget once its log shows the exit marker (revalidation)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  process.env.PI_BGRUN_FOREIGN_JOBS = "1";
  try {
    // Foreign running job (live pid = this process, no marker).
    const adoptedId = `foreign-finish-${Date.now()}-${process.pid}`;
    const logPath = join(dir, `${adoptedId}.log`);
    writeFileSync(logPath, "job still going\n");

    const { pi, tools, ctx, fireSessionStart } = makeFakePi();
    ctx.hasUI = true;
    const widgetCalls: (string[] | undefined)[] = [];
    ctx.ui.setWidget = (_ns: string, lines: string[] | undefined) =>
      widgetCalls.push(lines);

    await loadExtension(pi);
    await fireSessionStart();
    assert.ok(
      widgetCalls.some((l) => Array.isArray(l)),
      "widget shown after adoption",
    );

    // The foreign job finishes: marker appears in the log.
    writeFileSync(logPath, "job still going\n__BGRUN_EXIT__=0\n");

    // Any bgstatus call revalidates adopted jobs and refreshes the widget.
    const bgstatus = tools.get("bgstatus")!;
    const list = await bgstatus.execute(
      "call-a2",
      {},
      undefined,
      undefined,
      ctx,
    );
    const text = list.content[0].text as string;
    assert.ok(
      !/: running/.test(text),
      "adopted job no longer listed as running",
    );
    assert.match(
      text,
      /\(1 more job log\(s\) on disk/,
      "finished adopted job folded into the disk note",
    );
    assert.ok(
      widgetCalls.some((l) => l === undefined),
      "widget cleared after adopted job finished",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    delete process.env.PI_BGRUN_FOREIGN_JOBS;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session_start: does NOT adopt finished or dead-pid jobs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  process.env.PI_BGRUN_FOREIGN_JOBS = "1";
  try {
    // Finished (exit marker present).
    writeFileSync(
      join(dir, `done-job-${Date.now()}-${process.pid}.log`),
      "out\n__BGRUN_EXIT__=0\n",
    );
    // No marker but pid is certainly dead (pid 1 is launchd — alive, so use a likely-dead high pid).
    // Use pid 1-style trick instead: a dead pid we spawn and reap.
    const { spawnSync } = await import("node:child_process");
    const dead = spawnSync("sh", ["-c", "exit 0"]);
    assert.equal(dead.status, 0);
    // Write log with a pid that no longer exists: use the reaped child's pid if captured, else 999999.
    const deadPid = dead.pid ?? 999999;
    writeFileSync(
      join(dir, `dead-job-${Date.now()}-${deadPid}.log`),
      "partial\n",
    );

    const { pi, ctx, fireSessionStart } = makeFakePi();
    ctx.hasUI = true;
    let widgetShown = false;
    ctx.ui.setWidget = (_ns: string, lines: string[] | undefined) => {
      if (lines) widgetShown = true;
    };

    await loadExtension(pi);
    await fireSessionStart();
    assert.equal(widgetShown, false, "no widget for finished/dead jobs");
  } finally {
    delete process.env.PI_BGRUN_DIR;
    delete process.env.PI_BGRUN_FOREIGN_JOBS;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session_start: with foreign adoption OFF, finished foreign logs are not adopted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  delete process.env.PI_BGRUN_FOREIGN_JOBS;
  try {
    writeFileSync(
      join(dir, `done-job-${Date.now()}-${process.pid}.log`),
      "out\n__BGRUN_EXIT__=0\n",
    );
    const { pi, ctx, fireSessionStart } = makeFakePi();
    ctx.hasUI = true;
    let widgetShown = false;
    ctx.ui.setWidget = (_ns: string, lines: string[] | undefined) => {
      if (lines) widgetShown = true;
    };
    await loadExtension(pi);
    await fireSessionStart();
    assert.equal(widgetShown, false, "no adoption when disabled");
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgrun: job id encodes the CHILD's pid, not pi's own pid", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  try {
    const { pi, wakes, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;

    const res = await bgrun.execute(
      "call-pid",
      { command: "echo pidcheck" },
      undefined,
      undefined,
      ctx,
    );
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];
    const idPid = Number(id.split("-").pop());
    assert.ok(idPid > 0, `id ends with child pid: ${id}`);
    assert.notEqual(idPid, process.pid, "id must NOT carry pi's own pid");
    // Log file named after the id, no .tmp- leftovers.
    assert.ok(existsSync(join(dir, `${id}.log`)), "log at final id-named path");
    assert.equal(
      readdirSync(dir).filter((f) => f.startsWith(".tmp-")).length,
      0,
      "no temp log leftovers",
    );

    await waitForWakes(wakes, 1);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgclean all: removes a FINISHED job's old log even when its id-pid is alive", async () => {
  // Regression: exit marker must win over pid liveness. Old code checked
  // pid first, so any log whose id-pid happened to be a live process (e.g.
  // pi's own pid from the old id bug, or pid reuse) was kept forever.
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  try {
    // Old finished foreign log whose id-pid is THIS process (alive!) — must
    // still be removed by an explicit global sweep.
    const oldPath = join(dir, `stale-job-1000000000-${process.pid}.log`);
    writeFileSync(oldPath, "stale\n__BGRUN_EXIT__=2\n");
    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const fs = await import("node:fs");
    fs.utimesSync(oldPath, oldTime, oldTime);

    const { pi, tools, ctx } = makeFakePi();
    await loadExtension(pi);
    const bgclean = tools.get("bgclean")!;

    // Default scope: this session only — the foreign log is untouched.
    const scoped = await bgclean.execute(
      "call-stale-scoped",
      { days: 7 },
      undefined,
      undefined,
      ctx,
    );
    assert.match(scoped.content[0].text as string, /removed 0/);
    assert.ok(
      existsSync(oldPath),
      "foreign log untouched by session-scoped bgclean",
    );

    const result = await bgclean.execute(
      "call-stale",
      { days: 7, all: true },
      undefined,
      undefined,
      ctx,
    );
    assert.match(
      result.content[0].text as string,
      /removed 1 job log\(s\) \(all sessions\)/,
    );
    assert.ok(
      !existsSync(oldPath),
      "finished job's log removed despite live id-pid",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session_start adoption: skips finished jobs even with a live id-pid", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  process.env.PI_BGRUN_FOREIGN_JOBS = "1";
  try {
    // Finished job (exit marker) whose id-pid is this process (alive).
    writeFileSync(
      join(dir, `done-job-${Date.now()}-${process.pid}.log`),
      "out\n__BGRUN_EXIT__=0\n",
    );
    const { pi, ctx, fireSessionStart } = makeFakePi();
    ctx.hasUI = true;
    let widgetShown = false;
    ctx.ui.setWidget = (_ns: string, lines: string[] | undefined) => {
      if (lines) widgetShown = true;
    };
    await loadExtension(pi);
    await fireSessionStart();
    assert.equal(
      widgetShown,
      false,
      "finished job not adopted even though id-pid is alive",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    delete process.env.PI_BGRUN_FOREIGN_JOBS;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session_start: reconstructed 'running' job that finished while pi was down is cleared, not zombified", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  delete process.env.PI_BGRUN_FOREIGN_JOBS;
  try {
    // A job from 5 days ago whose transcript entry never got a done entry
    // (pi wasn't running when it exited), whose log is long gone and whose
    // pid is definitely dead.
    const zombieId = `cd-old-project-make-test-${Date.now()}-99999999`;
    const logPath = join(dir, `${zombieId}.log`); // never created
    const priorEntries = [
      {
        type: "custom",
        customType: "bgrun-job",
        data: {
          id: zombieId,
          pid: 99999999,
          cmd: "cd /old/project && make test",
          name: undefined,
          started: Date.now() - 5 * 24 * 60 * 60 * 1000,
          logPath,
          state: "running",
        },
      },
    ];
    const { pi, entries, tools, ctx, fireSessionStart } = makeFakePi({
      priorEntries,
    });
    ctx.hasUI = true;
    const widgetCalls: (string[] | undefined)[] = [];
    ctx.ui.setWidget = (_ns: string, lines: string[] | undefined) =>
      widgetCalls.push(lines);

    await loadExtension(pi);
    await fireSessionStart();

    // Revalidation runs before the widget ever renders — the zombie is
    // cleared immediately instead of showing as "running" forever.
    assert.ok(
      !widgetCalls.some((l) => Array.isArray(l)),
      "reconstructed zombie never shown in the widget",
    );

    // A done entry is appended so future resumes reconstruct it as done.
    const doneEntry = entries.find(
      (e) =>
        e.customType === "bgrun-job" &&
        e.data?.id === zombieId &&
        e.data?.state === "done",
    );
    assert.ok(doneEntry, "done entry appended for the recovered job");

    // Single-id lookup reports done, not running.
    const bgstatus = tools.get("bgstatus")!;
    const res = await bgstatus.execute(
      "call-z1",
      { id: zombieId },
      undefined,
      undefined,
      ctx,
    );
    assert.match(res.content[0].text as string, /: done/);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session_start: done entries with missing exitCode (signal kills) reconstruct as done", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  delete process.env.PI_BGRUN_FOREIGN_JOBS;
  try {
    // Jobs killed by a signal persist state:"done" with exitCode: undefined —
    // reconstruction must honor the state field, not just the exit code.
    const killedId = `nightly-watch-${Date.now()}-${process.pid}`;
    const logPath = join(dir, `${killedId}.log`);
    writeFileSync(logPath, "partial output\n"); // no marker — killed before it
    const priorEntries = [
      {
        type: "custom",
        customType: "bgrun-job",
        data: {
          id: killedId,
          pid: process.pid, // alive — liveness alone must not resurrect it as running
          cmd: "npm run watch",
          name: "nightly-watch",
          started: Date.now() - 60_000,
          logPath,
          state: "done",
          exitCode: undefined,
          exitedAt: Date.now() - 30_000,
        },
      },
    ];
    const { pi, tools, ctx, fireSessionStart } = makeFakePi({ priorEntries });
    ctx.hasUI = true;
    const widgetCalls: (string[] | undefined)[] = [];
    ctx.ui.setWidget = (_ns: string, lines: string[] | undefined) =>
      widgetCalls.push(lines);

    await loadExtension(pi);
    await fireSessionStart();

    assert.ok(
      !widgetCalls.some((l) => Array.isArray(l)),
      "signal-killed job with a done entry is not resurrected as running",
    );
    const bgstatus = tools.get("bgstatus")!;
    const res = await bgstatus.execute(
      "call-z2",
      { id: killedId },
      undefined,
      undefined,
      ctx,
    );
    assert.match(res.content[0].text as string, /: done/);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-clean: session boundaries sweep this session's old logs AND week-old foreign orphans by default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  delete process.env.PI_BGRUN_FOREIGN_JOBS;
  delete process.env.PI_BGRUN_GLOBAL_AUTO_CLEAN;
  try {
    const fs = await import("node:fs");
    const backdate = (path: string) => {
      const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      fs.utimesSync(path, oldTime, oldTime);
    };

    // This session's old done job (from the transcript) with a backdated log.
    const mineId = `my-old-job-${Date.now()}-99999999`;
    const myLog = join(dir, `${mineId}.log`);
    fs.writeFileSync(myLog, "mine\n__BGRUN_EXIT__=0\n");
    backdate(myLog);

    // A foreign session's week-old FINISHED log — an orphan; swept by default.
    const orphanLog = join(dir, "foreign-old-job-1000000000-99998.log");
    fs.writeFileSync(orphanLog, "foreign\n__BGRUN_EXIT__=0\n");
    backdate(orphanLog);

    // A foreign session's RECENT finished log — within retention, kept.
    const recentForeignLog = join(
      dir,
      `foreign-recent-${Math.floor(Date.now() / 1000)}-99997.log`,
    );
    fs.writeFileSync(recentForeignLog, "recent foreign\n__BGRUN_EXIT__=0\n");

    // A foreign session's week-old RUNNING log (no marker, live pid) — running
    // jobs are pid-protected even when old.
    const runningForeignLog = join(
      dir,
      `foreign-running-${Math.floor(Date.now() / 1000)}-${process.pid}.log`,
    );
    fs.writeFileSync(runningForeignLog, "still going\n");
    backdate(runningForeignLog);

    const priorEntries = [
      {
        type: "custom",
        customType: "bgrun-job",
        data: {
          id: mineId,
          pid: 99999999,
          cmd: "echo mine",
          name: undefined,
          started: Date.now() - 30 * 24 * 60 * 60 * 1000,
          logPath: myLog,
          state: "done",
          exitCode: 0,
          exitedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
        },
      },
    ];
    const { pi, fireSessionStart } = makeFakePi({ priorEntries });
    await loadExtension(pi);
    await fireSessionStart();

    assert.ok(!fs.existsSync(myLog), "this session's old log swept");
    assert.ok(
      !fs.existsSync(orphanLog),
      "week-old finished foreign orphan swept by default",
    );
    assert.ok(
      fs.existsSync(recentForeignLog),
      "recent foreign log kept (within retention)",
    );
    assert.ok(
      fs.existsSync(runningForeignLog),
      "old but RUNNING foreign log kept (pid-protected)",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-clean: globalAutoClean=false opts out — foreign orphans untouched, own old logs still swept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  delete process.env.PI_BGRUN_FOREIGN_JOBS;
  process.env.PI_BGRUN_GLOBAL_AUTO_CLEAN = "0";
  try {
    const fs = await import("node:fs");
    const backdate = (path: string) => {
      const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      fs.utimesSync(path, oldTime, oldTime);
    };

    const mineId = `my-old-job-${Date.now()}-99999999`;
    const myLog = join(dir, `${mineId}.log`);
    fs.writeFileSync(myLog, "mine\n__BGRUN_EXIT__=0\n");
    backdate(myLog);

    const orphanLog = join(dir, "foreign-old-job-1000000000-99998.log");
    fs.writeFileSync(orphanLog, "foreign\n__BGRUN_EXIT__=0\n");
    backdate(orphanLog);

    const priorEntries = [
      {
        type: "custom",
        customType: "bgrun-job",
        data: {
          id: mineId,
          pid: 99999999,
          cmd: "echo mine",
          name: undefined,
          started: Date.now() - 30 * 24 * 60 * 60 * 1000,
          logPath: myLog,
          state: "done",
          exitCode: 0,
          exitedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
        },
      },
    ];
    const { pi, fireSessionStart } = makeFakePi({ priorEntries });
    await loadExtension(pi);
    await fireSessionStart();

    assert.ok(!fs.existsSync(myLog), "this session's old log still swept");
    assert.ok(
      fs.existsSync(orphanLog),
      "foreign orphan untouched when globalAutoClean is off",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    delete process.env.PI_BGRUN_GLOBAL_AUTO_CLEAN;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-clean: global orphan sweep is throttled via .last-clean; manual bgclean all always runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  delete process.env.PI_BGRUN_FOREIGN_JOBS;
  delete process.env.PI_BGRUN_GLOBAL_AUTO_CLEAN; // default: on
  try {
    const fs = await import("node:fs");
    const backdate = (path: string) => {
      const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      fs.utimesSync(path, oldTime, oldTime);
    };

    // Old foreign log A + first session_start (no marker yet) → global sweep
    // runs, A removed.
    const logA = join(dir, "old-a-1000000000-99999.log");
    fs.writeFileSync(logA, "old a\n__BGRUN_EXIT__=0\n");
    backdate(logA);
    {
      const { pi, fireSessionStart } = makeFakePi();
      await loadExtension(pi);
      await fireSessionStart();
    }
    assert.ok(!fs.existsSync(logA), "first global sweep removed old log A");
    assert.ok(
      fs.existsSync(join(dir, ".last-clean")),
      "throttle marker written",
    );

    // Old foreign log B + second session_start while marker is fresh →
    // throttled, B kept.
    const logB = join(dir, "old-b-1000000000-99998.log");
    fs.writeFileSync(logB, "old b\n__BGRUN_EXIT__=0\n");
    backdate(logB);
    {
      const { pi, fireSessionStart } = makeFakePi();
      await loadExtension(pi);
      await fireSessionStart();
    }
    assert.ok(
      fs.existsSync(logB),
      "second global sweep throttled — old log B kept",
    );

    // Manual `bgclean all` ignores the throttle and removes B.
    const { pi: pi3, tools: tools3, ctx: ctx3 } = makeFakePi();
    await loadExtension(pi3);
    const bgclean = tools3.get("bgclean")!;
    const result = await bgclean.execute(
      "call-t1",
      { all: true },
      undefined,
      undefined,
      ctx3,
    );
    assert.match(
      result.content[0].text as string,
      /removed 1 job log\(s\) \(all sessions\)/,
    );
    assert.ok(!fs.existsSync(logB), "manual bgclean all removed log B");
  } finally {
    delete process.env.PI_BGRUN_DIR;
    delete process.env.PI_BGRUN_GLOBAL_AUTO_CLEAN;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bgclean: default scope is this session's logs; all: true sweeps everything", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  // Isolate bgclean's scoping from the global orphan auto-sweep (default on)
  // so the foreign log survives session_start for bgclean to (not) act on.
  process.env.PI_BGRUN_GLOBAL_AUTO_CLEAN = "0";
  try {
    const fs = await import("node:fs");
    const backdate = (path: string) => {
      const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      fs.utimesSync(path, oldTime, oldTime);
    };

    const mkEntry = (
      id: string,
      logPath: string,
      extra: Record<string, unknown> = {},
    ) => ({
      type: "custom",
      customType: "bgrun-job",
      data: {
        id,
        pid: 99999999,
        cmd: `echo ${id}`,
        name: undefined,
        started: Date.now() - 60_000,
        logPath,
        state: "done",
        exitCode: 0,
        exitedAt: Date.now() - 30_000,
        ...extra,
      },
    });

    // This session's recent done job (fresh log — kept).
    const recentId = `recent-job-${Date.now()}-99999998`;
    const recentLog = join(dir, `${recentId}.log`);
    fs.writeFileSync(recentLog, "recent\n__BGRUN_EXIT__=0\n");

    // This session's old done job (backdated log — removed by default scope).
    const oldId = `old-session-job-${Date.now()}-99999997`;
    const oldLog = join(dir, `${oldId}.log`);
    fs.writeFileSync(oldLog, "old session job\n__BGRUN_EXIT__=0\n");
    backdate(oldLog);

    // A foreign session's old log — untouched by default, removed with all.
    const foreignLog = join(dir, "foreign-old-job-1000000000-99996.log");
    fs.writeFileSync(foreignLog, "foreign\n__BGRUN_EXIT__=0\n");
    backdate(foreignLog);

    const priorEntries = [
      mkEntry(recentId, recentLog),
      mkEntry(oldId, oldLog, {
        started: Date.now() - 30 * 24 * 60 * 60 * 1000,
        exitedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
      }),
    ];
    const { pi, tools, ctx, fireSessionStart } = makeFakePi({ priorEntries });
    await loadExtension(pi);
    await fireSessionStart(); // reconstruct + session-scoped auto-sweep runs here too

    const bgclean = tools.get("bgclean")!;

    // Default: this session only.
    const scoped = await bgclean.execute(
      "call-c2",
      { days: 7 },
      undefined,
      undefined,
      ctx,
    );
    assert.match(scoped.content[0].text as string, /\(this session\)/);
    assert.ok(!fs.existsSync(oldLog), "this session's old log removed");
    assert.ok(fs.existsSync(recentLog), "this session's recent log kept");
    assert.ok(
      fs.existsSync(foreignLog),
      "foreign log untouched by session-scoped bgclean",
    );

    // all: true sweeps the shared dir.
    const global = await bgclean.execute(
      "call-c3",
      { days: 7, all: true },
      undefined,
      undefined,
      ctx,
    );
    assert.match(global.content[0].text as string, /\(all sessions\)/);
    assert.ok(!fs.existsSync(foreignLog), "foreign log removed by bgclean all");
    assert.ok(fs.existsSync(recentLog), "recent log still kept");
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
    const res = await bgrun.execute(
      "call-c4",
      { command: "sleep 10" },
      undefined,
      undefined,
      ctx,
    );
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];
    const logPath = join(dir, `${id}.log`);

    // Backdate the log's mtime to make it look old — but the job is still running
    // (pid is in the in-memory Map), so bgclean should skip it.
    const fs = await import("node:fs");
    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    // Wait a moment for the log file to exist, then backdate.
    await new Promise((r) => setTimeout(r, 100));
    fs.utimesSync(logPath, oldTime, oldTime);

    const result = await bgclean.execute(
      "call-c5",
      { days: 7 },
      undefined,
      undefined,
      ctx,
    );
    const text = result.content[0].text as string;
    assert.match(text, /skipped 1 running/);
    assert.ok(fs.existsSync(logPath), "running job's log not removed");

    // Kill the orphaned sleep so it doesn't linger (best-effort: it may have exited already).
    try {
      process.kill((res.details as any).pid);
    } catch {
      // already gone — fine
    }
  } finally {
    delete process.env.PI_BGRUN_DIR;
    delete process.env.PI_BGRUN_GLOBAL_AUTO_CLEAN;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("slash commands: /bgstatus, /bgtail, /bgclean registered and share the tool logic", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bgrun-test-"));
  process.env.PI_BGRUN_DIR = dir;
  delete process.env.PI_BGRUN_FOREIGN_JOBS;
  delete process.env.PI_BGRUN_GLOBAL_AUTO_CLEAN;
  try {
    const { pi, wakes, tools, commands, ctx } = makeFakePi();
    ctx.hasUI = true;
    const notes: { text: string; kind: string }[] = [];
    ctx.ui.notify = (text: string, kind: string) => notes.push({ text, kind });

    await loadExtension(pi);

    // All three human-facing commands are registered (/bgrun is agent-only).
    assert.ok(commands.has("bgstatus"), "/bgstatus registered");
    assert.ok(commands.has("bgtail"), "/bgtail registered");
    assert.ok(commands.has("bgclean"), "/bgclean registered");
    assert.ok(!commands.has("bgrun"), "/bgrun deliberately not a command");

    // Run a real job to completion so there's something to inspect.
    const bgrun = tools.get("bgrun")!;
    const res = await bgrun.execute(
      "call-cmd1",
      { command: "echo cmd-mirror", name: "mirror-job" },
      undefined,
      undefined,
      ctx,
    );
    const id = (res.content[0].text as string).match(/^started: ([^\n]+)/)![1];
    await waitForWakes(wakes, 1);

    // /bgstatus <id> → single-job status via notify.
    await commands.get("bgstatus")!.handler(id, ctx);
    assert.ok(
      notes.some((n) => n.text.includes(id) && /: done/.test(n.text)),
      "/bgstatus <id> notifies job status",
    );

    // /bgstatus done → listing includes the finished job.
    await commands.get("bgstatus")!.handler("done", ctx);
    assert.ok(
      notes.some((n) => /mirror-job: done exit=0/.test(n.text)),
      "/bgstatus done lists finished jobs",
    );

    // /bgtail <id> <lines> → condensed tail via notify.
    await commands.get("bgtail")!.handler(`${id} 5`, ctx);
    assert.ok(
      notes.some((n) => n.text.includes("cmd-mirror")),
      "/bgtail notifies the log tail",
    );

    // /bgtail with no args → usage error.
    await commands.get("bgtail")!.handler("", ctx);
    assert.ok(
      notes.some((n) => n.kind === "error" && /Usage: \/bgtail/.test(n.text)),
      "/bgtail without id shows usage",
    );

    // /bgclean (no args) → session-scoped summary via notify.
    await commands.get("bgclean")!.handler("", ctx);
    assert.ok(
      notes.some((n) => /removed 0 job log\(s\) \(this session\)/.test(n.text)),
      "/bgclean notifies the session-scoped summary",
    );

    // /bgclean 7 all → global scope.
    await commands.get("bgclean")!.handler("7 all", ctx);
    assert.ok(
      notes.some((n) => /\(all sessions\)/.test(n.text)),
      "/bgclean all notifies the global summary",
    );
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatSince: same-day shows time only; older days include the date", async () => {
  const url = pathToFileURL(join(process.cwd(), "extension/index.ts")).href;
  const mod: any = await import(url);
  assert.equal(typeof mod.formatSince, "function");

  const now = new Date("2026-09-09T10:00:00").getTime();
  const sameDay = new Date("2026-09-09T06:30:12").getTime();
  const prevDay = new Date("2026-09-04T15:05:40").getTime();
  const prevMonth = new Date("2026-08-12T23:59:59").getTime();
  const prevYear = new Date("2025-12-30T08:00:00").getTime();

  // Same calendar day → time only (unchanged display).
  assert.equal(mod.formatSince(sameDay, now), "06:30:12");

  // Different day, same year → date + time.
  const prevDayStr = mod.formatSince(prevDay, now);
  assert.match(prevDayStr, /Sep 4/);
  assert.match(prevDayStr, /15:05:40/);

  const prevMonthStr = mod.formatSince(prevMonth, now);
  assert.match(prevMonthStr, /Aug 12/);
  assert.match(prevMonthStr, /23:59:59/);

  // Different year → date includes the year.
  const prevYearStr = mod.formatSince(prevYear, now);
  assert.match(prevYearStr, /2025/);
  assert.match(prevYearStr, /Dec 30/);
  assert.match(prevYearStr, /08:00:00/);
});

// ── Project-local jobs dir ──────────────────────────────────────────────────

test("resolveJobsDirPath: relative resolves against a project root; absolute and no-root fall back", async () => {
  const mod = await import(
    pathToFileURL(join(process.cwd(), "extension/index.ts")).href
  );
  const proj = mkdtempSync(join(tmpdir(), "pi-bgrun-proj-"));
  const scratch = mkdtempSync(join(tmpdir(), "pi-bgrun-scratch-"));
  try {
    mkdirSync(join(proj, ".git"), { recursive: true });

    // absolute → used as-is, never flagged project-local (older configs keep
    // working unchanged — the migration guarantee)
    const absPath = join(proj, "abs-jobs");
    const abs = mod.resolveJobsDirPath(absPath, { cwd: proj });
    assert.equal(abs.dir, absPath);
    assert.equal(abs.projectLocal, false);

    // relative + project root → resolved against the root, flagged project-local
    const rel = mod.resolveJobsDirPath(".pi-bgrun/jobs", { cwd: proj });
    assert.equal(rel.dir, join(proj, ".pi-bgrun", "jobs"));
    assert.equal(rel.projectLocal, true);

    // unset → global default
    const none = mod.resolveJobsDirPath(undefined, { cwd: proj });
    assert.equal(none.dir, join(homedir(), ".pi-bgrun", "jobs"));
    assert.equal(none.projectLocal, false);

    // relative + cwd that is not a project → global fallback, never cwd-relative
    const fb = mod.resolveJobsDirPath(".pi-bgrun/jobs", { cwd: scratch });
    assert.equal(fb.dir, join(homedir(), ".pi-bgrun", "jobs"));
    assert.equal(fb.projectLocal, false);
  } finally {
    rmSync(proj, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("ensureGitExcluded: appends the jobs dir pattern to .git/info/exclude once per dir", async () => {
  const mod = await import(
    pathToFileURL(join(process.cwd(), "extension/index.ts")).href
  );
  const repo = mkdtempSync(join(tmpdir(), "pi-bgrun-repo-"));
  try {
    mkdirSync(join(repo, ".git", "info"), { recursive: true });
    mod.ensureGitExcluded(join(repo, ".pi-bgrun", "jobs"));
    mod.ensureGitExcluded(join(repo, ".pi-bgrun", "jobs"));
    // a second, different jobs dir under the same repo adds its own pattern
    mod.ensureGitExcluded(join(repo, ".pi-bgrun", "other"));
    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    assert.match(exclude, /# pi-bgrun job logs/);
    assert.equal(
      exclude.split("\n").filter((l) => l.trim() === ".pi-bgrun/jobs/").length,
      1,
      "pattern appears exactly once",
    );
    assert.ok(exclude.split("\n").includes(".pi-bgrun/other/"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("ensureGitExcluded: linked worktree (.git file) writes to the pointed git dir", async () => {
  const mod = await import(
    pathToFileURL(join(process.cwd(), "extension/index.ts")).href
  );
  const wt = mkdtempSync(join(tmpdir(), "pi-bgrun-wt-"));
  const gd = mkdtempSync(join(tmpdir(), "pi-bgrun-gitdir-"));
  try {
    writeFileSync(join(wt, ".git"), `gitdir: ${gd}\n`);
    mod.ensureGitExcluded(join(wt, ".pi-bgrun", "jobs"));
    const exclude = readFileSync(join(gd, "info", "exclude"), "utf8");
    assert.match(exclude, /^\.pi-bgrun\/jobs\/$/m);
    // nothing was created inside the worktree's own .git (it's a file)
    assert.ok(!existsSync(join(wt, ".git", "info")));
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(gd, { recursive: true, force: true });
  }
});

test("bgrun: relative jobsDir in project config → project-local log + auto git-exclude", async () => {
  const proj = mkdtempSync(join(tmpdir(), "pi-bgrun-proj-"));
  delete process.env.PI_BGRUN_DIR;
  try {
    mkdirSync(join(proj, ".git"), { recursive: true });
    mkdirSync(join(proj, ".pi"), { recursive: true });
    writeFileSync(
      join(proj, ".pi", "pi-bgrun.json"),
      JSON.stringify({ jobsDir: ".pi-bgrun/jobs" }),
    );
    const { pi, wakes, tools, ctx } = makeFakePi({
      ctxFields: { cwd: proj, isProjectTrusted: () => true },
    });
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;

    const res = await bgrun.execute(
      "call-1",
      { command: "echo project-local" },
      undefined,
      undefined,
      ctx,
    );
    const id = ((res.content[0].text as string).match(
      /^started: ([^\n]+)/,
    ) || [])[1];
    assert.ok(id, "got a job id");

    await waitForWakes(wakes, 1);

    const logPath = join(proj, ".pi-bgrun", "jobs", `${id}.log`);
    assert.ok(existsSync(logPath), "log written inside the project");
    assert.match(readFileSync(logPath, "utf8"), /project-local/);

    const exclude = join(proj, ".git", "info", "exclude");
    assert.ok(existsSync(exclude), "exclude file created");
    assert.match(readFileSync(exclude, "utf8"), /^\.pi-bgrun\/jobs\/$/m);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(proj, { recursive: true, force: true });
  }
});

test("bgtail: prefers the session record's logPath when the jobsDir config changes", async () => {
  const proj = mkdtempSync(join(tmpdir(), "pi-bgrun-proj-"));
  delete process.env.PI_BGRUN_DIR;
  try {
    mkdirSync(join(proj, ".git"), { recursive: true });
    mkdirSync(join(proj, ".pi"), { recursive: true });
    writeFileSync(
      join(proj, ".pi", "pi-bgrun.json"),
      JSON.stringify({ jobsDir: ".pi-bgrun/jobs" }),
    );
    const { pi, wakes, tools, ctx } = makeFakePi({
      ctxFields: { cwd: proj, isProjectTrusted: () => true },
    });
    await loadExtension(pi);
    const bgrun = tools.get("bgrun")!;
    const bgtail = tools.get("bgtail")!;

    const res = await bgrun.execute(
      "call-1",
      { command: "echo migrated-log" },
      undefined,
      undefined,
      ctx,
    );
    const id = ((res.content[0].text as string).match(
      /^started: ([^\n]+)/,
    ) || [])[1];
    assert.ok(id, "got a job id");
    await waitForWakes(wakes, 1);

    // A ctx with no project config/trust now resolves the jobs dir to the
    // GLOBAL default — only the session record's logPath can still find the
    // log (the mid-upgrade config-change scenario).
    const plainCtx = { ...ctx, cwd: undefined, isProjectTrusted: undefined };
    const tail = await bgtail.execute(
      "call-2",
      { id, lines: 10 },
      undefined,
      undefined,
      plainCtx,
    );
    assert.equal(tail.details.notFound, false);
    assert.match(tail.content[0].text as string, /migrated-log/);
  } finally {
    delete process.env.PI_BGRUN_DIR;
    rmSync(proj, { recursive: true, force: true });
  }
});
