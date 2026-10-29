import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertWorkspaceAllowed } from "../src/config.js";

test("允许根目录及其子目录", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-feishu-config-"));
  const child = join(root, "project");
  mkdirSync(child);
  assert.equal(assertWorkspaceAllowed(child, [realpathSync(root)]), realpathSync(child));
});

test("拒绝允许根目录之外的目录", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-feishu-allowed-"));
  const outside = mkdtempSync(join(tmpdir(), "codex-feishu-outside-"));
  assert.throws(() => assertWorkspaceAllowed(outside, [realpathSync(root)]), /不在允许范围/);
});

test("解析符号链接后阻止越界", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-feishu-symlink-root-"));
  const outside = mkdtempSync(join(tmpdir(), "codex-feishu-symlink-outside-"));
  const link = join(root, "escaped");
  symlinkSync(outside, link);
  assert.throws(() => assertWorkspaceAllowed(link, [realpathSync(root)]), /不在允许范围/);
});
