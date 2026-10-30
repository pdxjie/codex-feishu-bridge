import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertWorkspaceAllowed, loadConfig } from "../src/config.js";

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


test("游客模式允许注释或清空管理员列表，关闭游客模式仍要求管理员", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-feishu-guest-only-"));
  const database = join(root, "connections.json");
  const gateway = join(root, "gateway.js");
  writeFileSync(database, "{}");
  writeFileSync(gateway, "");
  const env = {
    FEISHU_APP_ID: "test-app", FEISHU_APP_SECRET: "test-secret", FEISHU_GUEST_MODE_ENABLED: "true",
    ALLOWED_WORKSPACE_ROOTS: root, DEFAULT_WORKSPACE: root, GUEST_WORKSPACE_ROOT: root,
    GUEST_DB_CONFIG_PATH: database, GUEST_DB_GATEWAY_PATH: gateway,
  };
  assert.equal(loadConfig(env).allowedOpenIds.size, 0);
  assert.equal(loadConfig({ ...env, FEISHU_ALLOWED_OPEN_IDS: "" }).allowedOpenIds.size, 0);
  assert.equal(loadConfig({ ...env, FEISHU_ALLOWED_OPEN_IDS: "ou_owner" }).allowedOpenIds.has("ou_owner"), true);
  assert.throws(() => loadConfig({ ...env, FEISHU_GUEST_MODE_ENABLED: "false" }), /必须配置/);
});
