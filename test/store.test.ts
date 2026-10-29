import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StateStore } from "../src/store.js";

test("保存用户当前会话和任务路由", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-feishu-store-"));
  const store = new StateStore(join(directory, "state.db"));
  try {
    store.rememberUser("ou_user", "oc_chat");
    assert.equal(store.getUser("ou_user")?.activeThreadId, null);

    store.setActiveThread("ou_user", "oc_chat", "thread-1");
    assert.equal(store.getUser("ou_user")?.activeThreadId, "thread-1");

    store.setActiveProject("ou_user", "oc_chat", "project-1");
    assert.equal(store.getUser("ou_user")?.activeProjectId, "project-1");

    store.setActiveThread("ou_user", "oc_chat", "thread-2", "project-2");
    assert.equal(store.getUser("ou_user")?.activeThreadId, "thread-2");
    assert.equal(store.getUser("ou_user")?.activeProjectId, "project-2");

    store.setTurnRoute("thread-2", "turn-1", "ou_user", "oc_chat");
    assert.deepEqual(store.getTurnRoute("thread-2"), {
      turnId: "turn-1",
      openId: "ou_user",
      chatId: "oc_chat",
      role: "owner",
    });
  } finally {
    store.close();
  }
});

test("访客会话按 open_id 隔离并记录访客任务路由", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-feishu-guest-store-"));
  const store = new StateStore(join(directory, "state.db"));
  try {
    store.addGuestThread("ou_a", "guest-thread-a", "A 的排查");
    store.addGuestThread("ou_b", "guest-thread-b", "B 的排查");
    assert.deepEqual(store.listGuestThreads("ou_a").map((thread) => thread.threadId), ["guest-thread-a"]);
    assert.equal(store.getGuestThread("guest-thread-a")?.openId, "ou_a");

    store.setTurnRoute("guest-thread-a", "turn-a", "ou_a", "oc_a", "guest");
    assert.deepEqual(store.getTurnRoute("guest-thread-a"), {
      turnId: "turn-a",
      openId: "ou_a",
      chatId: "oc_a",
      role: "guest",
    });
  } finally {
    store.close();
  }
});

test("飞书事件只能处理一次", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-feishu-dedupe-"));
  const store = new StateStore(join(directory, "state.db"));
  try {
    assert.equal(store.markEventProcessed("event-1"), true);
    assert.equal(store.markEventProcessed("event-1"), false);
  } finally {
    store.close();
  }
});
