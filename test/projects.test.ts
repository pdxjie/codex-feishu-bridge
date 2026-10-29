import assert from "node:assert/strict";
import test from "node:test";
import type { CodexProject, CodexThread } from "../src/codex/types.js";
import { groupThreadsByProject, UNASSIGNED_PROJECT_ID } from "../src/projects.js";

const projects: CodexProject[] = [
  {
    id: "mc",
    name: "MC",
    roots: [{ path: "/workspace/MC" }],
    metadata: {},
    position: 0,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "auto",
    name: "AutoCoding",
    roots: [{ path: "/workspace/MC/auto_coding" }],
    metadata: {},
    position: 1,
    createdAt: 1,
    updatedAt: 1,
  },
];

function thread(id: string, cwd: string, projectId?: string | null): CodexThread {
  return { id, cwd, ...(projectId !== undefined ? { projectId } : {}), createdAt: 1, updatedAt: 1 };
}

test("优先按显式项目 ID 归类", () => {
  const groups = groupThreadsByProject(projects, [thread("t1", "/other", "mc")]);
  assert.deepEqual(groups.find((group) => group.id === "mc")?.threads.map((item) => item.id), ["t1"]);
});

test("无项目 ID 时选择最长的匹配项目根目录", () => {
  const groups = groupThreadsByProject(projects, [thread("t1", "/workspace/MC/auto_coding/src")]);
  assert.deepEqual(groups.find((group) => group.id === "auto")?.threads.map((item) => item.id), ["t1"]);
  assert.deepEqual(groups.find((group) => group.id === "mc")?.threads, []);
});

test("无法匹配的会话进入未归类分组", () => {
  const groups = groupThreadsByProject(projects, [thread("t1", "/workspace/other")]);
  assert.deepEqual(groups.find((group) => group.id === UNASSIGNED_PROJECT_ID)?.threads.map((item) => item.id), [
    "t1",
  ]);
});
