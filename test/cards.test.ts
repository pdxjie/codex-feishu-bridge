import assert from "node:assert/strict";
import test from "node:test";
import { guestHelpCard, projectThreadsCard, projectsCard, sessionsCard } from "../src/feishu/cards.js";

test("会话卡片包含切换动作和当前会话标记", () => {
  const card = sessionsCard(
    [
      {
        id: "thread-1",
        name: "测试会话",
        cwd: "/tmp/project",
        updatedAt: 1_700_000_000,
        createdAt: 1_700_000_000,
      },
    ],
    "thread-1",
  );
  const serialized = JSON.stringify(card);
  assert.match(serialized, /测试会话/);
  assert.match(serialized, /switch_thread/);
  assert.match(serialized, /thread-1/);
  assert.match(serialized, /当前会话/);
});

test("访客帮助卡只提示直接聊天，不暴露项目或会话管理入口", () => {
  const serialized = JSON.stringify(guestHelpCard());
  assert.match(serialized, /自主排查/);
  assert.match(serialized, /生产只读/);
  assert.doesNotMatch(serialized, /sessions|projects|guest_switch_thread|guest_new_thread|new_in_project/);
});

test("项目卡片包含查看和新建会话操作", () => {
  const project = {
    id: "project-1",
    name: "MC",
    roots: ["/workspace/MC"],
    threads: [],
    project: {
      id: "project-1",
      name: "MC",
      roots: [{ path: "/workspace/MC" }],
      metadata: {},
      position: 0,
      createdAt: 1,
      updatedAt: 1,
    },
  };
  const serialized = JSON.stringify(projectsCard([project], "project-1"));
  assert.match(serialized, /open_project/);
  assert.match(serialized, /new_in_project/);

  const threadCard = JSON.stringify(
    projectThreadsCard(
      {
        ...project,
        threads: [
          {
            id: "thread-1",
            name: "会话一",
            cwd: "/workspace/MC",
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
      null,
      0,
    ),
  );
  assert.match(threadCard, /switch_thread/);
  assert.match(threadCard, /在项目中新建会话/);
});
