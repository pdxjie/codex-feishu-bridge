import assert from "node:assert/strict";
import test from "node:test";
import { GuestDesktopSync } from "../src/guest/desktop-sync.js";
import { DesktopCodexClient } from "../src/codex/desktop-client.js";
import { Logger } from "../src/logger.js";

const logger = new Logger("error");
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("failed guest registration retries without another Feishu message", async () => {
  let attempts = 0;
  const sync = new GuestDesktopSync(async () => { if (++attempts === 1) throw new Error("offline"); }, () => [], logger, 10);
  sync.enqueue("guest");
  await sync.flush();
  assert.equal(attempts, 1);
  await sync.flush();
  assert.equal(attempts, 1);
  await delay(15);
  await sync.flush();
  assert.equal(attempts, 2);
  await sync.flush();
  assert.equal(attempts, 2);
  await sync.stop();
});

test("completion during running-state sync gets a later pass and no overlapping writes", async () => {
  let release!: () => void;
  let running = true;
  const observed: boolean[] = [];
  const sync = new GuestDesktopSync(async () => {
    observed.push(running);
    if (observed.length === 1) await new Promise<void>((resolve) => { release = resolve; });
  }, () => [], logger);
  sync.enqueue("guest");
  const first = sync.flush();
  running = false;
  sync.enqueue("guest");
  const concurrent = sync.flush();
  assert.deepEqual(observed, [true]);
  release();
  await Promise.all([first, concurrent]);
  await sync.flush();
  assert.deepEqual(observed, [true, false]);
  await sync.stop();
});

test("periodic sync reads active guests until stopped", async () => {
  let calls = 0;
  const sync = new GuestDesktopSync(async () => { calls++; }, () => ["guest"], logger, 10);
  sync.start();
  await delay(35);
  await sync.stop();
  const stoppedAt = calls;
  assert.ok(stoppedAt >= 1);
  await delay(20);
  assert.equal(calls, stoppedAt);
});

for (const alreadyPinned of [false, true]) {
  test(`external thread registration preserves original pin state (${alreadyPinned})`, async () => {
    const client = new DesktopCodexClient(logger);
    const pins: boolean[] = [];
    let moves = 0;
    client.refreshExternalThread = async () => ({ schemaVersion: 1, thread: { id: "guest", kind: "codex" }, turns: [] });
    client.moveThreadToProject = async () => { if (++moves === 1) throw new Error("The task is not available in the sidebar."); };
    const internals = client as unknown as {
      resolveControllerThread: () => Promise<string>;
      callToolJson: () => Promise<unknown>;
      callTool: (_caller: string, tool: string, args: { pinned: boolean }) => Promise<unknown>;
    };
    internals.resolveControllerThread = async () => "controller";
    internals.callToolJson = async () => ({ pinnedThreads: alreadyPinned ? [{ id: "guest" }] : [] });
    internals.callTool = async (_caller, tool, args) => { assert.equal(tool, "set_thread_pinned"); pins.push(args.pinned); };
    await client.registerExternalThread("guest", "project");
    assert.equal(moves, 2);
    assert.deepEqual(pins, alreadyPinned ? [] : [true, false]);
  });
}

test("registration transport error never pins or resumes a thread", async () => {
  const client = new DesktopCodexClient(logger);
  client.refreshExternalThread = async () => { throw new Error("ECONNREFUSED"); };
  client.moveThreadToProject = async () => { assert.fail("must not mutate when offline"); };
  await assert.rejects(client.registerExternalThread("guest", "project"), /ECONNREFUSED/);
});

test("temporary pin cleanup is retried after a lost unpin response", async () => {
  const client = new DesktopCodexClient(logger);
  let moves = 0;
  const pins: boolean[] = [];
  client.refreshExternalThread = async () => ({ schemaVersion: 1, thread: { id: "guest", kind: "codex" }, turns: [] });
  client.moveThreadToProject = async () => { if (++moves === 1) throw new Error("The task is not available in the sidebar."); };
  const internals = client as unknown as {
    resolveControllerThread: () => Promise<string>;
    callToolJson: () => Promise<unknown>;
    callTool: (_caller: string, tool: string, args: { pinned: boolean }) => Promise<unknown>;
  };
  internals.resolveControllerThread = async () => "controller";
  internals.callToolJson = async () => ({ pinnedThreads: [] });
  internals.callTool = async (_caller, _tool, args) => {
    pins.push(args.pinned);
    if (pins.length === 2) throw new Error("ECONNRESET");
  };
  await assert.rejects(client.registerExternalThread("guest", "project"), /ECONNRESET/);
  await client.registerExternalThread("guest", "project");
  assert.deepEqual(pins, [true, false, false]);
});
