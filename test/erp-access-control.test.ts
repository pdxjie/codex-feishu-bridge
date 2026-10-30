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
const CHANNEL_ITEMS_PAGE = 1104;

function channelItemsPage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { page_purview_id: CHANNEL_ITEMS_PAGE, view_id: 339, module_id: 74,
    page_name: "分渠道库存管理", menu_url: "/channel-pmc-stock-manager", permission_url: "/", has_access: 1, ...overrides };
}

const maximumSellSql = "SELECT c.platform_channel, (c.real_in_stock + c.real_in_fba_stock + c.real_in_cg_online_stock + c.real_in_wfs_stock) AS in_stock, (c.real_in_transit + c.real_in_fba_transit + c.real_in_cg_transit + c.real_in_wfs_transit) AS in_transit, c.update_time FROM mc_channel_items_country_summary AS c INNER JOIN mc_items AS i ON i.id = c.items_id WHERE i.items_code = 'G10014-29GR' AND c.country_code = 'US' ORDER BY c.platform_channel LIMIT 30";

test("PMC有最大可售页面权限时可查询品库存，无需运营角色或店铺授权", async () => {
  const control = createControl(() => ({ rows: [channelItemsPage()] }));
  const pmc = accessContext({ moduleIds: [74], inventoryOperationsRole: false,
    dataScope: { platforms: [], shops: [], shopMarketplaces: [], categories: [], categoryScopeConfigured: false } });
  await control.initialize();
  const page = await control.authorizePage(pmc, CHANNEL_ITEMS_PAGE);
  assert.deepEqual(page.dataSources, ["mc_channel_items_country_summary", "mc_items"]);
  assert.match(page.dataAccessHint!, /real_in_cg_online_stock/);
  await control.authorizeSql(pmc, CHANNEL_ITEMS_PAGE, maximumSellSql, "query");
  await control.authorizeSql(pmc, CHANNEL_ITEMS_PAGE, maximumSellSql, "export");
  await control.authorizeTable(pmc, CHANNEL_ITEMS_PAGE, "mc_channel_items_country_summary");
  await control.authorizeSql(pmc, CHANNEL_ITEMS_PAGE, "SELECT id,items_code,type,status,is_del FROM mc_items WHERE items_code='G10014-29GR' LIMIT 1", "query");
});

test("已登记页面不等于开放整个仓储/计划模块或其他产品字段", async () => {
  const control = createControl(() => ({ rows: [channelItemsPage()] }));
  for (const table of ["mc_stock_batch", "mc_order", "mc_purchase_order", "mc_finance_statement"]) {
    await assert.rejects(() => control.authorizeSql(accessContext({}), CHANNEL_ITEMS_PAGE, `SELECT id FROM ${table}`, "query"), /业务映射不匹配/);
  }
  await assert.rejects(() => control.authorizeSql(accessContext({}), CHANNEL_ITEMS_PAGE, "SELECT id,purchase_price FROM mc_items", "query"), /尚未登记字段/);
  await assert.rejects(() => control.authorizeSql(accessContext({}), CHANNEL_ITEMS_PAGE, "SELECT * FROM mc_channel_items_country_summary", "query"), /禁止 SELECT/);
});

test("撤销页面权限会立即阻止品库存查询；不能借旧SKU页面授权", async () => {
  let hasAccess = 1;
  const control = createControl((sql) => sql.includes("WHERE p.id = 1104") ? { rows: [channelItemsPage({ has_access: hasAccess })] } : {
    rows: [pageRow(876, "分渠道库存管理", 74, "/Warehousing/ChannelGoodsCountrySummary/getList", true)],
  });
  await control.authorizeSql(accessContext({}), CHANNEL_ITEMS_PAGE, maximumSellSql, "query");
  hasAccess = 0;
  await assert.rejects(() => control.authorizeSql(accessContext({}), CHANNEL_ITEMS_PAGE, maximumSellSql, "query"), /权限不足/);
  await assert.rejects(() => control.authorizeSql(accessContext({}), 876, maximumSellSql, "query"), /不能借用其他页面/);
});

test("最大可售标签名和中文括号能匹配登记页面，仍使用真实ERP授权", async () => {
  let denied = false;
  const control = createControl((sql) => {
    assert.match(sql, /p.id IN \(1104\)/);
    assert.match(sql, /EXISTS/);
    return { rows: [channelItemsPage({ has_access: denied ? 0 : 1 })] };
  });
  for (const keyword of ["最大可售", "分渠道库存管理（最大可售）", "分渠道品库存管理（最大可售）"]) {
    const pages = await control.findPages(accessContext({}), keyword);
    assert.equal(pages[0]!.pagePurviewId, CHANNEL_ITEMS_PAGE);
    assert.equal(pages[0]!.hasAccess, true);
  }
  denied = true;
  assert.equal((await control.findPages(accessContext({}), "最大可售"))[0]!.hasAccess, false);
});

test("ERP页面元数据变更时拒绝复用过期映射", async () => {
  for (const changed of [{ view_id: 340 }, { module_id: 2 }, { menu_url: "/finance" }]) {
    const control = createControl(() => ({ rows: [channelItemsPage(changed)] }));
    await assert.rejects(() => control.authorizeSql(accessContext({}), CHANNEL_ITEMS_PAGE, maximumSellSql, "query"), /元数据发生变化/);
  }
});

test("ERP 模块权限在 SQL 执行前强制拒绝越权和未知表", async () => {
  const control = createControl();
  await control.initialize();
  const context = accessContext({ moduleIds: [67] });

  await control.authorizeSql(context, PURCHASE_PAGE, "SELECT id, order_no FROM mc_purchase_order WHERE id = 1", "query");
  await assert.rejects(
    () => control.authorizeSql(context, PURCHASE_PAGE, "SELECT id FROM mc_finance_statement WHERE id = 1", "query"),
    /暂无法确认数据授权范围.*业务映射不匹配/,
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
    /暂无法确认数据授权范围.*purchase_order.*业务映射不匹配/,
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

test("找不到页面不能判定用户无权；明确无页面权限仍拒绝", async () => {
  const control = createControl();
  await assert.rejects(() => control.authorizePage(accessContext({}), 999999), /暂无法确认数据授权范围/);
  await assert.rejects(() => control.authorizePage(accessContext({}), DENIED_PAGE), /权限不足/);
});

test("运营可以读联合排查所需仓储源码，不因此获得仓储页面或财务源码权限", async () => {
  const control = createControl();
  await control.initialize();
  const operator = accessContext({ inventoryOperationsRole: true, moduleIds: [1] });
  assert.equal(control.canReadProjectFile(operator, "application/admin/App/Domain/Warehousing/DAO/OrderItemsShipDAO.php"), true);
  assert.equal(control.canReadProjectFile(operator, "application/admin/App/Domain/Finances/DAO/StatementDAO.php"), false);
  assert.equal(control.canReadProjectPath(operator, "application/admin/App/Domain/Warehousing/DAO"), true);
  await assert.rejects(() => control.authorizePage(operator, DENIED_PAGE), /权限不足/);
});

test("沿用现有角色并展开平台全部店铺，保留层级元组且权限每次调用刷新", async () => {
  let operations = true;
  const control = createControl((sql) => {
    if (sql.includes("FROM mc_feishu_user")) return { rows: [{ erp_user_id: 655, user_name: "测试用户", role_id: "11" }] };
    if (sql.includes("FROM mc_role r")) return { rows: [{ role_names: "运营专员", inventory_operations_role: operations ? 1 : 0, module_ids: "1" }] };
    if (sql.includes("FROM mc_role_data_scope")) return { rows: [
      { scope_type: "shop_group", scope_level1: 1, scope_level2: 0, scope_level3: 0, scope_value: -1 },
      { scope_type: "shop_group", scope_level1: 3, scope_level2: 20, scope_level3: 201, scope_value: -1 },
    ] };
    if (sql.includes("FROM mc_shop s")) {
      assert.match(sql, /s.platform_type = 1/);
      assert.match(sql, /s.platform_type = 3 AND s.id = 20 AND sm.id = 201/);
      return { rows: [{ shop_id: 10, marketplace_id: 101 }, { shop_id: 20, marketplace_id: 201 }] };
    }
    throw new Error("Unexpected authorization query");
  });
  const user = await control.resolveUser("test");
  assert.equal(user.inventoryOperationsRole, true);
  assert.deepEqual(user.dataScope.shops, [10, 20]);
  assert.deepEqual(user.dataScope.shopMarketplaces, [101, 201]);
  assert.deepEqual(user.dataScope.shopGroups, [{ platform: 1, shop: 0, marketplace: 0 }, { platform: 3, shop: 20, marketplace: 201 }]);
  assert.equal(user.dataScope.categoryScopeConfigured, false);
  control.bindThread("test-thread", user);
  operations = false;
  assert.equal((await control.contextForThread("test-thread")).inventoryOperationsRole, false);
});

test("未知店铺范围不能被当成全量权限", async () => {
  const control = createControl();
  await control.initialize();
  await assert.rejects(() => control.authorizeSql(accessContext({ dataScope: {
    platforms: [], shops: [], shopMarketplaces: [], categories: "ALL",
  } }), OPERATION_PAGE, "SELECT id FROM mc_order", "query"), /暂无法确认数据授权范围/);
});

function createControl(query: (sql: string) => { rows: Array<Record<string, unknown>> } = pageQueryResult): ErpAccessControl {
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
    async () => ({ async query(_name: string, sql: string) { return query(sql); } }),
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
