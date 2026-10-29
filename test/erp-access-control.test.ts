import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ErpAccessControl, type ErpAccessContext } from "../src/guest/erp-access-control.js";
import { Logger } from "../src/logger.js";

const logger = new Logger("error");
const PURCHASE_PAGE = 1001;
const OPERATION_PAGE = 1002;
const DENIED_PAGE = 1003;
const TRACKING_PAGE = 1852;

test("ERP 模块权限在 SQL 执行前强制拒绝越权和未知表", async () => {
  const control = createControl();
  await control.initialize();
  const context = accessContext({ moduleIds: [67] });

  await control.authorizeSql(context, PURCHASE_PAGE, "SELECT id, order_no FROM mc_purchase_order WHERE id = 1", "query");
  await assert.rejects(
    () => control.authorizeSql(context, PURCHASE_PAGE, "SELECT id FROM mc_finance_statement WHERE id = 1", "query"),
    /权限不足.*页面无权访问数据表/,
  );
  await assert.rejects(
    () => control.authorizeSql(context, PURCHASE_PAGE, "SELECT id FROM mc_unindexed_private_data", "query"),
    /无法将数据表.*安全归属到 ERP 页面/,
  );
  await assert.rejects(
    () => control.authorizeSql(context, PURCHASE_PAGE, "SELECT * FROM mc_purchase_order WHERE id = 1", "query"),
    /禁止 SELECT \*/,
  );
});

test("查询和导出必须拥有目标 ERP 页面权限，不能借用同模块页面", async () => {
  const control = createControl();
  await control.initialize();
  const context = accessContext({ moduleIds: [1, 4, 19, 67] });

  await assert.rejects(
    () => control.authorizeSql(context, DENIED_PAGE, "SELECT id FROM mc_purchase_order WHERE id = 1", "query"),
    /权限不足.*没有“采购单”页面权限/,
  );
  await assert.rejects(
    () => control.authorizeSql(context, OPERATION_PAGE, "SELECT id FROM mc_purchase_order WHERE id = 1", "query"),
    /权限不足.*页面无权访问数据表 purchase_order/,
  );
  await control.authorizeSql(
    context,
    TRACKING_PAGE,
    "SELECT tracking_number, status FROM mc_tracking_info WHERE id = 1",
    "export",
  );
});

test("采购价、供应商信息和导出分别复用 ERP 细粒度权限", async () => {
  const control = createControl();
  await control.initialize();
  const base = accessContext({ moduleIds: [67] });

  await assert.rejects(
    () => control.authorizeSql(base, PURCHASE_PAGE, "SELECT purchase_price FROM mc_goods WHERE id = 1", "query"),
    /没有采购价查看权限/,
  );
  await assert.rejects(
    () => control.authorizeSql(base, PURCHASE_PAGE, "SELECT id, name FROM mc_supplier WHERE id = 1", "query"),
    /没有供应商信息查看权限/,
  );
  await control.authorizeSql(base, PURCHASE_PAGE, "SELECT id FROM mc_purchase_order WHERE id = 1", "export");

  const allowed = accessContext({
    moduleIds: [67],
    purviewIds: [252, 709, 906, 907],
  });
  await control.authorizeSql(allowed, PURCHASE_PAGE, "SELECT purchase_price FROM mc_goods WHERE id = 1", "query");
  await control.authorizeSql(allowed, PURCHASE_PAGE, "SELECT id, name FROM mc_supplier WHERE id = 1", "export");
});

test("受限店铺范围必须在所有 OR 分支中明确收窄", async () => {
  const control = createControl();
  await control.initialize();
  const context = accessContext({
    moduleIds: [1],
    dataScope: { platforms: "ALL", shops: [10], shopMarketplaces: "ALL", categories: "ALL" },
  });

  await control.authorizeSql(context, OPERATION_PAGE, "SELECT id FROM mc_order WHERE shop_id IN (10)", "query");
  await assert.rejects(
    () => control.authorizeSql(context, OPERATION_PAGE, "SELECT id FROM mc_order WHERE shop_id = 11", "query"),
    /必须使用 shop_id/,
  );
  await assert.rejects(
    () => control.authorizeSql(context, OPERATION_PAGE, "SELECT id FROM mc_order WHERE shop_id = 10 OR 1 = 1", "query"),
    /必须使用 shop_id/,
  );
});

test("源码文件也按 ERP 模块权限过滤", async () => {
  const control = createControl();
  await control.initialize();
  const purchase = accessContext({ moduleIds: [67] });
  assert.equal(control.canReadProjectFile(purchase, "application/admin/App/Domain/Purchase/DAO/PurchaseOrderDAO.php"), true);
  assert.equal(control.canReadProjectFile(purchase, "application/admin/App/Domain/Finances/DAO/StatementDAO.php"), false);
  assert.equal(control.canReadProjectPath(purchase, "application/admin/App/Domain/Purchase"), true);
  assert.equal(control.canReadProjectPath(purchase, "application/admin/App/Domain/Finances"), false);
});

function createControl(): ErpAccessControl {
  const directory = mkdtempSync(join(tmpdir(), "codex-feishu-access-"));
  const indexPath = join(directory, "index.sqlite");
  const db = new DatabaseSync(indexPath);
  db.exec(`
    CREATE TABLE files (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      domain TEXT NOT NULL
    );
    CREATE TABLE table_refs (
      id INTEGER PRIMARY KEY,
      file_id INTEGER NOT NULL,
      table_name TEXT NOT NULL
    );
    INSERT INTO files (id, path, domain) VALUES
      (1, 'application/admin/App/Domain/Purchase/DAO/PurchaseOrderDAO.php', 'Purchase'),
      (2, 'application/admin/App/Domain/Finances/DAO/StatementDAO.php', 'Finances'),
      (3, 'application/admin/App/Domain/Product/Model/GoodsModel.php', 'Product'),
      (4, 'application/admin/App/Domain/Purchase/DAO/GoodsDAO.php', 'Purchase'),
      (5, 'application/admin/App/Domain/Purchase/DAO/SupplierDAO.php', 'Purchase'),
      (6, 'application/admin/App/Domain/Operation/DAO/OrderDAO.php', 'Operation'),
      (7, 'application/admin/App/Domain/Logistics/DAO/TrackingInfoDAO.php', 'Logistics');
    INSERT INTO table_refs (file_id, table_name) VALUES
      (1, 'purchase_order'),
      (2, 'finance_statement'),
      (3, 'goods'),
      (4, 'goods'),
      (5, 'supplier'),
      (6, 'order'),
      (7, 'tracking_info');
  `);
  db.close();
  return new ErpAccessControl(
    directory,
    indexPath,
    async () => ({ async query(_name: string, sql: string) { return pageQueryResult(sql); } }),
    "production",
    logger,
  );
}

function pageQueryResult(sql: string): { rows: Array<Record<string, unknown>> } {
  const pageId = Number(/WHERE p\.id = (\d+)/.exec(sql)?.[1] ?? 0);
  const definitions: Record<number, Record<string, unknown>> = {
    [PURCHASE_PAGE]: pageRow(PURCHASE_PAGE, "采购单", 67, "/Purchase/PurchaseOrder/getContent", true),
    [OPERATION_PAGE]: pageRow(OPERATION_PAGE, "订单列表", 1, "/Operation/Order/getContent", true),
    [DENIED_PAGE]: pageRow(DENIED_PAGE, "采购单", 67, "/Purchase/PurchaseOrder/getContent", false),
    [TRACKING_PAGE]: pageRow(TRACKING_PAGE, "物流轨迹", 4, "/Logistics/TrackingInfo/getList", true),
  };
  return { rows: definitions[pageId] ? [definitions[pageId]!] : [] };
}

function pageRow(
  pagePurviewId: number,
  pageName: string,
  moduleId: number,
  permissionUrl: string,
  hasAccess: boolean,
): Record<string, unknown> {
  return {
    page_purview_id: pagePurviewId,
    view_id: pagePurviewId,
    page_name: pageName,
    module_id: moduleId,
    menu_url: "",
    permission_url: permissionUrl,
    has_access: hasAccess ? 1 : 0,
  };
}

function accessContext(overrides: Partial<ErpAccessContext>): ErpAccessContext {
  return {
    feishuUserId: "u_test",
    erpUserId: 100,
    userName: "测试用户",
    roleIds: [20],
    roleNames: ["测试角色"],
    superAdministrator: false,
    moduleIds: [],
    moduleNames: [],
    purviewIds: [],
    dataScope: { platforms: "ALL", shops: "ALL", shopMarketplaces: "ALL", categories: "ALL" },
    ...overrides,
  };
}
