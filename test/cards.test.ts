import assert from "node:assert/strict";
import test from "node:test";
import {
  guestHelpCard,
  projectThreadsCard,
  projectsCard,
  sessionsCard,
  threadResultCard,
} from "../src/feishu/cards.js";

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

test("访客帮助卡提供新建和停止快捷指令但不暴露会话管理入口", () => {
  const serialized = JSON.stringify(guestHelpCard());
  assert.match(serialized, /自主排查/);
  assert.match(serialized, /生产只读/);
  assert.match(serialized, /\/new/);
  assert.match(serialized, /\/stop/);
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

test("最终结果将 Markdown 表格渲染为移动端友好的明细卡片", () => {
  const result = threadResultCard(
    "自主排查@测试同事",
    [
      "查到 SKU `G37007BR05A-YF` 的采购明细。",
      "",
      "| 采购单号 | 状态 | 数量 | 已出运 |",
      "|---|---|---:|---:|",
      "| KA26UG08415-US | 计划中 | 535 | 509 |",
      "| KA26UG08413-AU | 计划中 | 28 | 3 |",
      "",
      "- 剩余共 **51** 件",
    ].join("\n"),
  );
  const serialized = JSON.stringify(result);
  assert.match(serialized, /📋 查询明细（2 条）/);
  assert.match(serialized, /采购单号.*KA26UG08415-US/);
  assert.match(serialized, /状态.*计划中/);
  assert.match(serialized, /剩余共 \*\*51\*\* 件/);
  assert.doesNotMatch(serialized, /\|---\|/);
});

test("可识别经过消息转义的 Markdown 表格竖线", () => {
  const result = JSON.stringify(
    threadResultCard("自主排查@测试同事", "\\| 字段 \\| 值 \\|\n\\|---\\|---\\|\n\\| SKU \\| `ABC-1` \\|"),
  );
  assert.match(result, /📋 查询明细（1 条）/);
  assert.doesNotMatch(result, /\\\\\|---/);
});
