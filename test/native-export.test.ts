import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, writeFile, readFile, readdir, rm, chmod, access } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";
import { NativeExportManager } from "../src/guest/native-export.js";
import { signedHeaders, validateNativeExport, validateEndpoint } from "../src/guest/native-export-protocol.js";
import type { ErpAccessContext } from "../src/guest/erp-access-control.js";
import { loadConfig } from "../src/config.js";
import { Logger } from "../src/logger.js";

const logger = new Logger("error");
const context = (id: string) => ({ feishuUserId: id } as ErpAccessContext);
const call = (turnId: string) => ({ threadId: "thread", turnId, callId: turnId, tool: "erp_native_export_file", arguments: {} });
const plan = {
  pagePurviewId: 23,
  route: "/transportOrder/queueExportData",
  controllerFile: "application/admin/controller/MuaTransportOrder.php",
  controllerMethod: "queueExportData",
  serviceFile: "application/admin/service/TransportOrderService.php",
  className: "service\\TransportOrderService",
  factory: "new",
  dataMethod: "queueExport",
  titleMethod: "getExportTitle",
  dataArguments: ["filters", "erpUserId"],
  titleArguments: ["filters"],
  resultMode: "rows",
  filters: { order_date_type: 1, order_type_date_from: "2026-10-25", order_type_date_to: "2026-10-31", select_fields: "invoice_no,sku,goods_name,actual_packing_number" },
  fileName: "近一周出运单明细.xlsx",
  sheetName: "出运单明细",
};
const args = { plan };

test("动态原生导出计划不是业务白名单，也不接受代码、越界文件或伪造路由", () => {
  assert.equal(validateNativeExport(plan).dataMethod, "queueExport");
  assert.throws(() => validateNativeExport({ ...plan, script: "phpinfo();" }));
  assert.throws(() => validateNativeExport({ ...plan, serviceFile: "../../tmp/EvilService.php" }));
  assert.throws(() => validateNativeExport({ ...plan, className: "Evil" }));
  assert.throws(() => validateNativeExport({ ...plan, controllerMethod: "deleteContent", route: "/transportOrder/deleteContent" }));
  assert.throws(() => validateNativeExport({ ...plan, dataMethod: "createExportTask" }));
  assert.throws(() => validateNativeExport({ ...plan, filters: { unsafe_key: "\0" } }));
  for (const endpoint of ["http://erp.example/export", "https://u:password@erp.example/export", "https://erp.example/#secret"]) assert.throws(() => validateEndpoint(endpoint));
  assert.equal(validateEndpoint("http://127.0.0.1/export"), "http://127.0.0.1/export");
});

test("未配置时明确不可用，URL和凭证必须成对配置", async () => {
  const env = { FEISHU_APP_ID: "test", FEISHU_APP_SECRET: "test", FEISHU_ALLOWED_OPEN_IDS: "test", ALLOWED_WORKSPACE_ROOTS: process.cwd(), DEFAULT_WORKSPACE: process.cwd() };
  assert.equal(loadConfig(env).nativeExport, undefined);
  assert.throws(() => loadConfig({ ...env, ERP_NATIVE_EXPORT_URL: "https://erp.example/export" }), /同时配置/);
  const manager = new NativeExportManager("unused", undefined, logger);
  assert.equal(manager.catalog().configured, false);
  await assert.rejects(() => manager.create(call("missing"), context("alice"), args), /尚未部署/);
});

test("临时脚本通过签名调用、下载真实Excel、隔离用户并在发送后清理", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "native-export-"));
  const secret = randomBytes(32).toString("hex");
  const secretFile = join(root, "secret");
  await writeFile(secretFile, secret, { mode: 0o600 });
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(["SKU", "库存"]); sheet.addRow(["TEST-SKU", 12]);
  const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
  let mode = "ok";
  const calls: Array<{ action: string; user: string; requestId: string }> = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const action = String(req.headers["x-codex-export-action"]);
      const expected = signedHeaders(action, raw, secret, String(req.headers["x-codex-export-time"]), String(req.headers["x-codex-export-nonce"]));
      assert.equal(req.headers["x-codex-export-signature"], expected["x-codex-export-signature"]);
      const body = JSON.parse(raw);
      calls.push({ action, user: body.feishuUserId, requestId: body.requestId });
      if (mode === "forbidden") { res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ message: "权限不足" })); return; }
      if (mode === "redirect") { res.writeHead(302, { location: "/elsewhere" }); res.end(); return; }
      if (action === "download") {
        res.writeHead(200, { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        // Multiple chunks exercise streaming writes and integrity checks.
        res.write(xlsx.subarray(0, 1000)); res.end(xlsx.subarray(1000)); return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: action === "ack" ? "delivered" : "ready", fileName: plan.fileName, rowCount: mode === "overlimit" ? 10001 : mode === "wrongrows" ? 2 : 1,
        bytes: xlsx.length, sha256: mode === "badhash" ? "0".repeat(64) : createHash("sha256").update(xlsx).digest("hex") }));
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const address = server.address() as { port: number };
  const manager = new NativeExportManager(join(root, "jobs"), { endpoint: `http://127.0.0.1:${address.port}/export`, secretFile }, logger);
  await manager.initialize();
  const [a, b, duplicate] = await Promise.all([
    manager.create(call("turn-a"), context("alice"), args), manager.create(call("turn-b"), context("bob"), args), manager.create(call("turn-a"), context("alice"), args),
  ]);
  assert.equal(a.path, duplicate.path); assert.notEqual(a.path, b.path);
  assert.equal(calls.filter((c) => c.action === "create").length, 2);
  assert.deepEqual(new Set(calls.map((c) => c.user)), new Set(["alice", "bob"]));
  assert.deepEqual(manager.takeFiles("turn-a"), [a]); assert.deepEqual(manager.takeFiles("turn-a"), []);
  const loaded = new ExcelJS.Workbook(); await loaded.xlsx.readFile(a.path);
  assert.equal(loaded.worksheets[0]!.getCell("B2").value, 12);
  for (const name of await readdir(dirname(a.path))) {
    if (name.endsWith("xlsx")) continue;
    assert.ok(!(await readFile(join(dirname(a.path), name), "utf8")).includes(secret));
  }
  await manager.authorizeDelivery(a);
  mode = "forbidden";
  await assert.rejects(() => manager.authorizeDelivery(a), /权限不足/);
  mode = "ok";
  await manager.removeSentFiles([a, b]);
  await assert.rejects(() => access(a.path));
  assert.equal(calls.filter((c) => c.action === "ack").length, 2);
  for (const [failure, error] of [["forbidden", /权限不足/], ["badhash", /完整性/], ["wrongrows", /实际行数/], ["overlimit", /元数据/]] as const) {
    mode = failure;
    await assert.rejects(() => manager.create(call(failure), context("alice"), args), error);
    assert.deepEqual(manager.takeFiles(failure), []);
  }
  mode = "redirect";
  await assert.rejects(() => manager.create(call("redirect"), context("alice"), args));
  assert.ok(!calls.some((c) => c.action === ""));
  mode = "ok";
  await chmod(secretFile, 0o644);
  await assert.rejects(() => manager.create(call("badmode"), context("alice"), args), /私有文件/);
});
