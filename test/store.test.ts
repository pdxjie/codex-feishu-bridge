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

test("每个访客固定绑定唯一会话并记录访客任务路由", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-feishu-guest-store-"));
  const store = new StateStore(join(directory, "state.db"));
  try {
    const first = store.addGuestThread("ou_a", "guest-thread-a", "自主排查@A");
    const duplicate = store.addGuestThread("ou_a", "guest-thread-a-duplicate", "自主排查@A");
    store.addGuestThread("ou_b", "guest-thread-b", "B 的排查");
    assert.equal(first.threadId, "guest-thread-a");
    assert.equal(first.desktopManaged, false);
    assert.equal(duplicate.threadId, "guest-thread-a");
    assert.equal(store.getGuestThreadForUser("ou_a")?.threadId, "guest-thread-a");
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

test("访客会话可迁移为 Desktop 原生会话并保留固定绑定", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-feishu-guest-migration-"));
  const store = new StateStore(join(directory, "state.db"));
  try {
    store.rememberUser("ou_a", "oc_a");
    store.addGuestThread("ou_a", "external-thread", "自主排查@A");
    store.setActiveThread("ou_a", "oc_a", "external-thread", "guest-project");
    store.setTurnRoute("external-thread", "turn-1", "ou_a", "oc_a", "guest");

    assert.deepEqual(
      store.listGuestThreadsPendingDesktopMigration().map((thread) => thread.threadId),
      ["external-thread"],
    );
    const migrated = store.replaceGuestThread("external-thread", "desktop-thread", true);

    assert.equal(migrated.desktopManaged, true);
    assert.equal(store.getGuestThreadForUser("ou_a")?.threadId, "desktop-thread");
    assert.equal(store.getUser("ou_a")?.activeThreadId, "desktop-thread");
    assert.equal(store.getTurnRoute("desktop-thread")?.turnId, "turn-1");
    assert.equal(store.getGuestThread("external-thread"), null);
    assert.deepEqual(store.listGuestThreadsPendingDesktopMigration(), []);
  } finally {
    store.close();
  }
});

test("访客新建会话时切换当前绑定并保留历史会话归属", () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-feishu-guest-new-thread-"));
  const store = new StateStore(join(directory, "state.db"));
  try {
    store.addGuestThread("ou_a", "guest-thread-old", "自主排查@A", true);
    const created = store.bindNewGuestThread("ou_a", "guest-thread-new", "自主排查@A", true);

    assert.equal(created.threadId, "guest-thread-new");
    assert.equal(store.getGuestThreadForUser("ou_a")?.threadId, "guest-thread-new");
    assert.equal(store.getGuestThread("guest-thread-old")?.openId, "ou_a");
    assert.deepEqual(
      store.listGuestThreads("ou_a").map((thread) => thread.threadId).sort(),
      ["guest-thread-new", "guest-thread-old"],
    );
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
