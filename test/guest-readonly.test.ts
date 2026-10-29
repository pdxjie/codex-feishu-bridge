import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import { GuestReadonlyTools } from "../src/guest/readonly-tools.js";
import type { ErpAccessContext, GuestAccessGuard } from "../src/guest/erp-access-control.js";
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

  const tools = testTools(root);
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
  const tools = testTools(root);

  const result = await tools.handle(call("project_search", { query: "PaymentService", maxResults: 20 }));
  const text = result.contentItems[0]?.text ?? "";
  assert.match(text, /src\/Service\.php/);
  assert.doesNotMatch(text, /\.env|PaymentService-secret/);
});

test("访客只能通过受控工具生成导出文件并在发送后清理", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-feishu-guest-export-project-"));
  const exportRoot = mkdtempSync(join(tmpdir(), "codex-feishu-guest-exports-"));
  const tools = new GuestReadonlyTools(
    root,
    join(root, "missing-db.json"),
    "production",
    logger,
    undefined,
    exportRoot,
    10,
    undefined,
    createTestAccessGuard(),
  );
  tools.bindThreadAccess("guest-thread", TEST_CONTEXT);
  await tools.initialize();

  const result = await tools.handle(
    call("export_table_file", {
      title: "采购明细",
      pagePurviewId: 1001,
      fileName: "采购明细.xlsx",
      format: "xlsx",
      rows: [
        { order_no: "PO-001", quantity: 12, status: "采购中" },
        { order_no: "PO-002", quantity: 5, status: "已完成" },
      ],
      columnLabels: { order_no: "采购单号", quantity: "数量", status: "状态" },
    }),
  );
  assert.match(result.contentItems[0]?.text ?? "", /采购明细\.xlsx/);
  const files = tools.takeExportFiles("guest-turn");
  assert.equal(files.length, 1);
  assert.equal(files[0]?.rowCount, 2);
  assert.ok(files[0] && existsSync(files[0].path));
  assert.equal(readFileSync(files[0]!.path).subarray(0, 2).toString("ascii"), "PK");

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(files[0]!.path);
  const sheet = workbook.getWorksheet("数据");
  assert.equal(sheet?.getCell("A1").value, "采购明细");
  assert.equal(sheet?.getCell("A2").value, "采购单号");
  assert.equal(sheet?.getCell("B3").value, 12);

  await tools.removeExportFiles(files);
  assert.equal(existsSync(files[0]!.path), false);
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

const TEST_CONTEXT: ErpAccessContext = {
  feishuUserId: "test-user",
  erpUserId: 1,
  userName: "测试用户",
  roleIds: [1],
  roleNames: ["测试角色"],
  superAdministrator: true,
  moduleIds: [1, 2, 3, 4, 5, 19, 20, 35, 37, 41, 53, 67, 74, 78],
  moduleNames: ["全部模块"],
  purviewIds: [252, 709, 906, 907],
  dataScope: { platforms: "ALL", shops: "ALL", shopMarketplaces: "ALL", categories: "ALL" },
};

function testTools(root: string): GuestReadonlyTools {
  const tools = new GuestReadonlyTools(
    root,
    join(root, "missing-db.json"),
    "production",
    logger,
    undefined,
    undefined,
    1000,
    undefined,
    createTestAccessGuard(),
  );
  tools.bindThreadAccess("guest-thread", TEST_CONTEXT);
  return tools;
}

function createTestAccessGuard(): GuestAccessGuard {
  const contexts = new Map<string, ErpAccessContext>();
  return {
    async initialize() {},
    async resolveUser() { return TEST_CONTEXT; },
    bindThread(threadId, context) { contexts.set(threadId, context); },
    unbindThread(threadId) { contexts.delete(threadId); },
    async contextForThread(threadId) {
      const context = contexts.get(threadId);
      if (!context) throw new Error("missing test context");
      return context;
    },
    publicProfile() { return {}; },
    async findPages() { return []; },
    async authorizePage() {
      return {
        pagePurviewId: 1001,
        viewId: 1001,
        pageName: "采购单",
        moduleId: 67,
        menuUrl: "",
        permissionUrl: "/Purchase/PurchaseOrder/getContent",
        hasAccess: true,
      };
    },
    async authorizeSql() {},
    async authorizeTable() {},
    canReadProjectFile() { return true; },
    canReadProjectPath() { return true; },
  };
}
