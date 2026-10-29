import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GuestReadonlyTools } from "../src/guest/readonly-tools.js";
import { Logger } from "../src/logger.js";

const logger = new Logger("error");

test("访客源码工具只读取项目内文件并脱敏", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-feishu-guest-project-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "Order.php"), "<?php\n$token = abcdefghijklmnop;\nclass Order {}\n");
  writeFileSync(join(root, ".env"), "DB_PASSWORD=do-not-show\n");
  const outside = mkdtempSync(join(tmpdir(), "codex-feishu-guest-outside-"));
  writeFileSync(join(outside, "secret.php"), "secret outside\n");
  symlinkSync(join(outside, "secret.php"), join(root, "src", "escaped.php"));

  const tools = new GuestReadonlyTools(root, join(root, "missing-db.json"), "production", logger);
  const read = await tools.handle(call("project_read_file", { path: "src/Order.php", startLine: 1, endLine: 20 }));
  const text = read.contentItems[0]?.text ?? "";
  assert.match(text, /class Order/);
  assert.match(text, /token = \[REDACTED\]/i);
  assert.doesNotMatch(text, /abcdefghijklmnop/);

  await assert.rejects(() => tools.handle(call("project_read_file", { path: ".env" })), /敏感|受保护/);
  await assert.rejects(() => tools.handle(call("project_read_file", { path: "src/escaped.php" })), /超出/);
  await assert.rejects(() => tools.handle(call("project_read_file", { path: "/etc/passwd" })), /相对路径/);
});

test("访客搜索工具不返回敏感文件内容", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-feishu-guest-search-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "Service.php"), "<?php\nclass PaymentService {}\n");
  writeFileSync(join(root, ".env"), "PAYMENT_SECRET=PaymentService-secret\n");
  const tools = new GuestReadonlyTools(root, join(root, "missing-db.json"), "production", logger);

  const result = await tools.handle(call("project_search", { query: "PaymentService", maxResults: 20 }));
  const text = result.contentItems[0]?.text ?? "";
  assert.match(text, /src\/Service\.php/);
  assert.doesNotMatch(text, /\.env|PaymentService-secret/);
});

function call(tool: string, args: Record<string, unknown>) {
  return {
    threadId: "guest-thread",
    turnId: "guest-turn",
    callId: "call-1",
    tool,
    arguments: args,
  };
}
