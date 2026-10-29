import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeApp, isActiveWriterConflict, renderDesktopTurn, renderRolloutEvent, resolveAccessRole } from "../src/app.js";
import { CodexClient } from "../src/codex/client.js";
import { DesktopCodexClient, DesktopThreadUnavailableError } from "../src/codex/desktop-client.js";
import type { CodexThread } from "../src/codex/types.js";
import type { AppConfig } from "../src/config.js";
import { Logger } from "../src/logger.js";
import { StateStore } from "../src/store.js";

const logger = new Logger("error");

type FakeCodex = {
  forkThread: (threadId: string, options?: { projectId?: string; beforeTurnId?: string }) => Promise<CodexThread>;
  startTurn: (threadId: string, text: string) => Promise<string>;
  readThread?: (threadId: string) => Promise<CodexThread>;
  readProject?: (projectId: string) => Promise<{
    id: string;
    name: string;
    roots: Array<{ path: string }>;
  }>;
};

type FakeDesktop = {
  readThread: (threadId: string, turnLimit?: number) => Promise<{
    schemaVersion: number;
    thread: { id: string; kind: string; title?: string };
    turns: Array<{ id: string; status: string; items: Array<Record<string, unknown>> }>;
  }>;
  sendMessage: (threadId: string, text: string) => Promise<void>;
  listProjects?: () => Promise<Array<{
    projectId: string;
    projectKind: string;
    label: string;
    path?: string;
  }>>;
  createThread?: (prompt: string, projectId: string, title?: string) => Promise<{ threadId: string }>;
  createRolloutCursor?: (threadId: string, includeExisting?: boolean) => Promise<{
    threadId: string;
    path: string | null;
    offset: number;
  }>;
  readRolloutEvents?: () => Promise<Array<Record<string, unknown>>>;
};

type TestAppInternals = {
  codex: FakeCodex;
  desktop: FakeDesktop;
  feishu: {
    sendCard: (chatId: string, card: Record<string, unknown>) => Promise<string>;
    updateCard: (messageId: string, card: Record<string, unknown>) => Promise<void>;
  };
  store: StateStore;
  activeTurns: Map<string, string>;
  finalMessages: Map<string, string>;
  liveProgress: Map<string, { timer: NodeJS.Timeout | null }>;
  submitPrompt: (openId: string, chatId: string, text: string) => Promise<void>;
  finishTurn: (params: Record<string, unknown>) => Promise<void>;
  onCodexNotification: (notification: { method: string; params?: Record<string, unknown> }) => void;
  flushLiveProgress: (state: unknown) => Promise<void>;
};

function thread(id: string, projectId = "project-1"): CodexThread {
  return {
    id,
    projectId,
    name: "测试会话",
    cwd: "/tmp",
    createdAt: 1,
    updatedAt: 1,
  };
}

function createTestApp(
  fakeCodex: FakeCodex,
  fakeDesktop: FakeDesktop = {
    async readThread(threadId) {
      return { schemaVersion: 1, thread: { id: threadId, kind: "codex", title: "测试会话" }, turns: [] };
    },
    async sendMessage() {},
  },
): {
  app: TestAppInternals;
  cards: Record<string, unknown>[];
  updates: Record<string, unknown>[];
  close: () => void;
} {
  const directory = mkdtempSync(join(tmpdir(), "codex-feishu-parallel-"));
  const config: AppConfig = {
    feishuAppId: "test-app",
    feishuAppSecret: "test-secret",
    allowedOpenIds: new Set(["ou_test"]),
    guestModeEnabled: false,
    allowedWorkspaceRoots: [directory],
    defaultWorkspace: directory,
    guestCodexHome: join(directory, "guest-codex-home"),
    guestDbConfigPath: join(directory, "connections.json"),
    guestDbConnection: "production",
    guestMaxConcurrentTurns: 4,
    stateDbPath: join(directory, "state.db"),
    codexBin: "/bin/true",
    logLevel: "error",
  };
  const bridge = new BridgeApp(config, logger) as unknown as TestAppInternals;
  const cards: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  bridge.codex = fakeCodex;
  bridge.desktop = {
    ...fakeDesktop,
    createRolloutCursor:
      fakeDesktop.createRolloutCursor ??
      (async (threadId) => ({ threadId, path: null, offset: 0 })),
    readRolloutEvents: fakeDesktop.readRolloutEvents ?? (async () => []),
  };
  bridge.feishu = {
    async sendCard(_chatId, card) {
      cards.push(card);
      return `message-${cards.length}`;
    },
    async updateCard(messageId, card) {
      updates.push({ messageId, card });
    },
  };
  bridge.store.rememberUser("ou_test", "oc_test");
  bridge.store.setActiveThread("ou_test", "oc_test", "thread-source", "project-1");
  return {
    app: bridge,
    cards,
    updates,
    close: () => {
      for (const progress of bridge.liveProgress.values()) {
        if (progress.timer) clearTimeout(progress.timer);
      }
      bridge.activeTurns.clear();
      bridge.store.close();
    },
  };
}

test("同一会话运行时不自动分叉，提示切换会话并行", async () => {
  const calls: Array<{ method: string; threadId: string; value?: unknown }> = [];
  const fixture = createTestApp({
    async forkThread(threadId, options) {
      calls.push({ method: "fork", threadId, value: options });
      return thread("thread-fork");
    },
    async startTurn(threadId, text) {
      calls.push({ method: "start", threadId, value: text });
      return "turn-fork";
    },
  });

  try {
    fixture.app.activeTurns.set("thread-source", "turn-source");
    fixture.app.store.setTurnRoute("thread-source", "turn-source", "ou_test", "oc_test");

    await assert.rejects(
      fixture.app.submitPrompt("ou_test", "oc_test", "并行执行新任务"),
      /切换到其他会话并行工作/,
    );
    assert.deepEqual(calls, []);
    assert.equal(fixture.app.store.getUser("ou_test")?.activeThreadId, "thread-source");
  } finally {
    fixture.close();
  }
});

test("管理员保留完整角色，其他用户在开启后自动进入访客角色", () => {
  const owners = new Set(["ou_owner"]);
  assert.equal(resolveAccessRole("ou_owner", owners, true), "owner");
  assert.equal(resolveAccessRole("ou_colleague", owners, true), "guest");
  assert.equal(resolveAccessRole("ou_colleague", owners, false), null);
});

test("飞书消息直接写入 Desktop 的同一会话，不创建分支", async () => {
  const desktopCalls: Array<{ method: string; threadId: string; text?: string }> = [];
  const fixture = createTestApp({
    async forkThread(threadId, options) {
      throw new Error(`不应创建分支：${threadId} ${JSON.stringify(options)}`);
    },
    async startTurn() {
      throw new Error("不应通过独立 App Server 启动任务");
    },
  }, {
    async readThread(threadId) {
      desktopCalls.push({ method: "read", threadId });
      return {
        schemaVersion: 1,
        thread: { id: threadId, kind: "codex", title: "桌面同一会话" },
        turns: [{ id: "old-turn", status: "completed", items: [] }],
      };
    },
    async sendMessage(threadId, text) {
      desktopCalls.push({ method: "send", threadId, text });
    },
  });

  try {
    await fixture.app.submitPrompt("ou_test", "oc_test", "在同一会话继续执行");

    assert.deepEqual(desktopCalls, [
      { method: "read", threadId: "thread-source" },
      { method: "send", threadId: "thread-source", text: "在同一会话继续执行" },
    ]);
    assert.equal(fixture.app.store.getUser("ou_test")?.activeThreadId, "thread-source");
    assert.match(fixture.app.activeTurns.get("thread-source") ?? "", /^desktop-/);
    assert.match(JSON.stringify(fixture.cards), /桌面同一会话/);
  } finally {
    fixture.close();
  }
});

test("未落盘的临时空会话会用首条任务迁移为 Desktop 真实会话", async () => {
  const calls: Array<{ method: string; value?: unknown }> = [];
  const fixture = createTestApp(
    {
      async forkThread() {
        throw new Error("不应分支");
      },
      async startTurn() {
        throw new Error("不应通过独立 App Server 启动任务");
      },
      async readThread(threadId) {
        return { ...thread(threadId), name: "旧的临时会话" };
      },
      async readProject(projectId) {
        return { id: projectId, name: "测试项目", roots: [{ path: "/tmp" }] };
      },
    },
    {
      async readThread(threadId) {
        throw new DesktopThreadUnavailableError(threadId);
      },
      async sendMessage() {
        throw new Error("首条消息已由 createThread 提交，不应重复发送");
      },
      async listProjects() {
        return [{ projectId: "desktop-project", projectKind: "local", label: "测试项目", path: "/tmp" }];
      },
      async createThread(prompt, projectId, title) {
        calls.push({ method: "create", value: { prompt, projectId, title } });
        return { threadId: "desktop-thread" };
      },
    },
  );

  try {
    await fixture.app.submitPrompt("ou_test", "oc_test", "互通测试");

    assert.deepEqual(calls, [
      {
        method: "create",
        value: { prompt: "互通测试", projectId: "desktop-project", title: "旧的临时会话" },
      },
    ]);
    assert.equal(fixture.app.store.getUser("ou_test")?.activeThreadId, "desktop-thread");
    assert.match(fixture.app.activeTurns.get("desktop-thread") ?? "", /^desktop-/);
  } finally {
    fixture.close();
  }
});

test("只把 active writer 冲突识别为可自动分支错误", () => {
  assert.equal(isActiveWriterConflict(new Error("already has an active writer")), true);
  assert.equal(isActiveWriterConflict(new Error("permission denied")), false);
  assert.equal(isActiveWriterConflict("already has an active writer"), false);
});

test("任务结束后自动推送带会话标题的结果", async () => {
  const fixture = createTestApp({
    async forkThread() {
      return thread("unused");
    },
    async startTurn() {
      return "unused";
    },
    async readThread(threadId) {
      assert.equal(threadId, "thread-source");
      return { ...thread(threadId), name: "数据库迁移任务" };
    },
  });

  try {
    fixture.app.store.setTurnRoute("thread-source", "turn-source", "ou_test", "oc_test");
    fixture.app.activeTurns.set("thread-source", "turn-source");
    fixture.app.finalMessages.set("turn-source", "迁移已经完成。\n共更新 12 张表。\n");

    await fixture.app.finishTurn({
      threadId: "thread-source",
      turn: { id: "turn-source", status: "completed", items: [] },
    });

    const serialized = JSON.stringify(fixture.cards);
    assert.match(serialized, /【数据库迁移任务】Codex 已完成/);
    assert.match(serialized, /会话：数据库迁移任务/);
    assert.match(serialized, /迁移已经完成/);
    assert.equal(fixture.app.activeTurns.has("thread-source"), false);
    assert.equal(fixture.app.finalMessages.has("turn-source"), false);
  } finally {
    fixture.close();
  }
});

test("Desktop 快照只提取公开思考摘要和公开消息，不泄露命令及原始思维", () => {
  const view = renderDesktopTurn({
    id: "turn-stream",
    status: "inProgress",
    items: [
      { id: "r1", type: "reasoning", summary: ["正在检查项目结构。"], rawText: "不可展示的原始思维" },
      { id: "p1", type: "plan", text: "✅ 读取代码\n🔄 运行测试" },
      { id: "c1", type: "commandExecution", command: "secret-command", status: "inProgress" },
      { id: "m1", type: "agentMessage", phase: "commentary", text: "已完成第一阶段。" },
    ],
  });

  const serialized = JSON.stringify(view);
  assert.match(serialized, /正在检查项目结构/);
  assert.match(serialized, /读取代码/);
  assert.match(serialized, /正在执行命令/);
  assert.match(serialized, /已完成第一阶段/);
  assert.doesNotMatch(serialized, /不可展示的原始思维/);
  assert.doesNotMatch(serialized, /secret-command/);
});

test("rollout 增量只提取公开消息和安全状态", () => {
  const commentary = renderRolloutEvent({
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: {
        type: "AgentMessage",
        phase: "commentary",
        content: [{ type: "Text", text: "正在检查公开进度。" }],
      },
    },
  });
  const command = renderRolloutEvent({
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: {
        type: "CommandExecution",
        status: "failed",
        exit_code: 2,
        command: "secret-command --token hidden",
        aggregated_output: "private output",
      },
    },
  });
  const reasoning = renderRolloutEvent({
    type: "response_item",
    payload: {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "公开思考摘要" }],
      encrypted_content: "encrypted-secret",
      raw_content: "hidden-chain-of-thought",
    },
  });

  const serialized = JSON.stringify({ commentary, command, reasoning });
  assert.match(serialized, /正在检查公开进度/);
  assert.match(serialized, /命令执行失败.*exit 2/);
  assert.match(serialized, /公开思考摘要/);
  assert.doesNotMatch(serialized, /secret-command|private output|encrypted-secret|hidden-chain-of-thought/);
});

test("rollout 游标只读取完整 JSONL 且不会重复事件", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-feishu-rollout-"));
  const path = join(directory, "rollout-test.jsonl");
  const first = JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } });
  const second = JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } });
  const splitAt = Math.floor(second.length / 2);
  writeFileSync(path, `${first}\n${second.slice(0, splitAt)}`);

  const client = new DesktopCodexClient(logger);
  const cursor = { threadId: "thread-test", path, offset: 0 };
  assert.deepEqual(await client.readRolloutEvents(cursor), [JSON.parse(first)]);
  assert.deepEqual(await client.readRolloutEvents(cursor), []);

  appendFileSync(path, `${second.slice(splitAt)}\n`);
  assert.deepEqual(await client.readRolloutEvents(cursor), [JSON.parse(second)]);
  assert.deepEqual(await client.readRolloutEvents(cursor), []);
});

test("向会话发消息前先确保 Desktop 已经加载", async () => {
  const calls: Array<{ caller?: string; tool: string; args?: Record<string, unknown> }> = [];
  const client = new DesktopCodexClient(logger) as unknown as {
    resolveControllerThread: (threadId: string) => Promise<string>;
    ensureThreadLoaded: (threadId: string) => Promise<void>;
    callTool: (caller: string, tool: string, args: Record<string, unknown>) => Promise<{
      success: boolean;
      contentItems: [];
    }>;
    sendMessage: (threadId: string, prompt: string) => Promise<void>;
  };
  client.resolveControllerThread = async () => "controller-thread";
  client.ensureThreadLoaded = async (threadId) => {
    calls.push({ tool: "ensure_loaded", args: { threadId } });
  };
  client.callTool = async (caller, tool, args) => {
    calls.push({ caller, tool, args });
    return { success: true, contentItems: [] };
  };

  await client.sendMessage("target-thread", "互通测试");

  assert.deepEqual(calls, [
    {
      tool: "ensure_loaded",
      args: { threadId: "target-thread" },
    },
    {
      caller: "controller-thread",
      tool: "send_message_to_thread",
      args: { threadId: "target-thread", prompt: "互通测试" },
    },
  ]);
});

test("分支会话继承项目归属并设置并行名称", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = new CodexClient("/bin/true", logger);
  const fakeRpc = {
    async request(method: string, params: unknown) {
      requests.push({ method, params });
      if (method === "thread/fork") return { thread: thread("thread-fork", "") };
      return {};
    },
  };
  (client as unknown as { rpc: typeof fakeRpc }).rpc = fakeRpc;

  const fork = await client.forkThread("thread-source", {
    projectId: "project-1",
    beforeTurnId: "turn-running",
  });

  assert.equal(fork.projectId, "project-1");
  assert.equal(fork.name, "测试会话（飞书并行）");
  assert.deepEqual(requests, [
    {
      method: "thread/fork",
      params: {
        threadId: "thread-source",
        beforeTurnId: "turn-running",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        ephemeral: false,
        excludeTurns: true,
        deferGoalContinuation: true,
      },
    },
    {
      method: "thread/metadata/update",
      params: { threadId: "thread-fork", projectId: "project-1" },
    },
    {
      method: "thread/name/set",
      params: { threadId: "thread-fork", name: "测试会话（飞书并行）" },
    },
  ]);
});
