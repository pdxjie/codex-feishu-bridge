import { isAbsolute, relative, resolve, sep } from "node:path";
import type { CodexProject, CodexThread } from "./codex/types.js";

export const UNASSIGNED_PROJECT_ID = "__unassigned__";

export type ProjectGroup = {
  project: CodexProject | null;
  id: string;
  name: string;
  roots: string[];
  threads: CodexThread[];
};

export function groupThreadsByProject(projects: CodexProject[], threads: CodexThread[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const project of projects) {
    groups.set(project.id, {
      project,
      id: project.id,
      name: project.name,
      roots: project.roots.map((root) => resolve(root.path)),
      threads: [],
    });
  }

  const unassigned: ProjectGroup = {
    project: null,
    id: UNASSIGNED_PROJECT_ID,
    name: "未归类会话",
    roots: [],
    threads: [],
  };

  for (const thread of threads) {
    const explicit = thread.projectId ? groups.get(thread.projectId) : undefined;
    const target = explicit ?? bestRootMatch(thread.cwd, [...groups.values()]) ?? unassigned;
    target.threads.push(thread);
  }

  for (const group of groups.values()) {
    group.threads.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  unassigned.threads.sort((a, b) => b.updatedAt - a.updatedAt);

  const result = [...groups.values()];
  if (unassigned.threads.length > 0) result.push(unassigned);
  return result;
}

export function findProjectGroup(groups: ProjectGroup[], projectId: string): ProjectGroup | null {
  return groups.find((group) => group.id === projectId) ?? null;
}

function bestRootMatch(cwd: string, groups: ProjectGroup[]): ProjectGroup | null {
  let best: { group: ProjectGroup; rootLength: number } | null = null;
  for (const group of groups) {
    for (const root of group.roots) {
      if (!isWithin(root, cwd)) continue;
      if (!best || root.length > best.rootLength) best = { group, rootLength: root.length };
    }
  }
  return best?.group ?? null;
}

function isWithin(root: string, candidate: string): boolean {
  const relation = relative(resolve(root), resolve(candidate));
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}
