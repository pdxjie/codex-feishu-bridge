import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readdir, rm, stat } from "node:fs/promises";
import net, { type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DesktopCodexClient, DesktopThreadUnavailableError } from "../src/codex/desktop-client.js";
import { Logger } from "../src/logger.js";

const tools = ["send_message_to_thread", "read_thread", "list_threads", "list_projects", "create_thread"];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("Desktop recovers helper loss, downstream disconnect, pipe rotation without replaying mutations", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp("/tmp/feishu-recovery-");
  const pipeDir = join(root, "pipes");
  await mkdir(pipeDir);
  const base = join(root, "helper.sock");
  const helpers: ChildProcess[] = [];
  const connections = new Set<Socket>();
  let dropRead = false;
  let dropMutation = false;
  let readCalls = 0;
  let mutations = 0;
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => connections.delete(socket));
    let buffer: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const length = buffer.readUInt32LE(0);
        const message = JSON.parse(buffer.subarray(4, length + 4).toString());
        buffer = buffer.subarray(length + 4);
        let result: unknown;
        if (message.method === "tools/list") result = { tools: tools.map((name) => ({ name, namespace: "test" })) };
        else {
          const tool = message.params.tool;
          if (tool === "read_thread") {
            readCalls++;
            if (dropRead) { dropRead = false; socket.destroy(); return; }
          }
          if (tool === "send_message_to_thread") {
            mutations++;
            if (dropMutation) { socket.destroy(); return; }
          }
          const data = tool === "list_threads" ? { threads: [{ id: "controller", kind: "codex" }] }
            : tool === "read_thread" ? { schemaVersion: 1, thread: { id: message.params.arguments.threadId, kind: "codex" }, turns: [] }
            : tool === "list_projects" ? { projects: [] } : {};
          result = { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(data) }] };
        }
        const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        const frame = Buffer.alloc(4 + payload.length);
        frame.writeUInt32LE(payload.length);
        payload.copy(frame, 4);
        socket.write(frame);
      }
    });
  });
  let pipe = join(pipeDir, "desktop-a.sock");
  server.listen(pipe);
  await once(server, "listening");
  const startHelper = async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../src/codex/desktop-helper.mjs", import.meta.url))], {
      env: { ...process.env, CODEX_APP_TOOLS_PIPE_PATH: pipe, CODEX_FEISHU_HELPER_SOCKET: base },
      stdio: "pipe",
    });
    helpers.push(child);
    const socket = join(root, `helper-${child.pid}.sock`);
    for (let i = 0; i < 100; i++) {
      if (await stat(socket).then(() => true, () => false)) return child;
      await delay(20);
    }
    throw new Error("helper did not start");
  };
  let wakes = 0;
  let recoverOnWake = false;
  const client = new DesktopCodexClient(new Logger("error"), {
    socketDirectory: pipeDir, helperSocketPath: base, healthIntervalMs: 100,
    recoveryCandidates: async () => ["01a07adb-330b-7053-9b8f-7d5e514dcea5"],
    wakeDesktop: async () => { wakes++; if (recoverOnWake) await startHelper(); },
    wakeTimeoutMs: 80, wakePollMs: 10,
  });
  try {
    const first = await startHelper();
    await delay(20);
    const second = await startHelper();
    await client.start();
    await t.test("each helper owns an independent private socket", async () => {
      const sockets = (await readdir(root)).filter((name) => name.endsWith(".sock"));
      assert.equal(sockets.length, 2);
      for (const name of sockets) assert.equal((await stat(join(root, name))).mode & 0o777, 0o600);
    });
    await t.test("helper owner exit leaves another helper available", async () => {
      second.kill("SIGTERM");
      await once(second, "exit");
      assert.equal((await client.readThread("target")).thread.id, "target");
      assert.ok(await stat(join(root, `helper-${first.pid}.sock`)));
    });
    await t.test("downstream disconnection retries the read", async () => {
      dropRead = true;
      const before = readCalls;
      assert.equal((await client.readThread("target")).thread.id, "target");
      assert.ok(readCalls >= before + 2);
    });
    await t.test("uncertain task delivery is never replayed", async () => {
      dropMutation = true;
      await assert.rejects(client.sendMessage("target", "test"), /未自动重发/);
      assert.equal(mutations, 1);
      dropMutation = false;
    });
    await t.test("Desktop pipe rotation is discovered automatically", async () => {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      pipe = join(pipeDir, "desktop-b.sock");
      server.listen(pipe);
      await once(server, "listening");
      await delay(300); // background health checks recover without an incoming message
      assert.equal((await client.readThread("target")).thread.id, "target");
      assert.equal((await client.healthCheck()).socketConnected, true);
    });
    await t.test("concurrent readers recover after native connection loss", async () => {
      for (const socket of connections) socket.destroy();
      const results = await Promise.all(Array.from({ length: 5 }, (_, i) => client.readThread(`target-${i}`)));
      assert.equal(results.length, 5);
    });
    await t.test("all helpers gone: Desktop wake bootstraps a fresh helper for concurrent callers", async () => {
      for (const child of helpers) if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
      recoverOnWake = true;
      const results = await Promise.all(Array.from({ length: 5 }, (_, i) => client.readThread(`target-${i}`)));
      assert.equal(results.length, 5);
      assert.equal(wakes, 1);
      assert.equal(mutations, 1); // only the deliberate ambiguous-send test above
      recoverOnWake = false;
    });
    await t.test("transport outage is not mistaken for a missing thread", async () => {
      for (const child of helpers) if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
      await assert.rejects(client.readThread("no-rollout"), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!(error instanceof DesktopThreadUnavailableError));
        return true;
      });
      assert.equal(wakes, 1); // no repeated Desktop activation during cooldown
    });
  } finally {
    await client.stop();
    for (const child of helpers) if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
