import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { compileInventoryQuery, INVENTORY_DATASETS } from "../src/guest/inventory-diagnostics.js";
import type { ErpAccessContext } from "../src/guest/erp-access-control.js";

const context: ErpAccessContext = {
  erpUserId: 655, feishuUserId: "test", userName: "运营", roleIds: [11], roleNames: ["运营专员"],
  superAdministrator: false, inventoryOperationsRole: true, moduleIds: [1], moduleNames: ["运营管理"], purviewIds: [],
  dataScope: { platforms: [1, 3], shops: [10, 20], shopMarketplaces: [101, 201], categories: [7],
    shopGroups: [{ platform: 1, shop: 10, marketplace: 101 }, { platform: 3, shop: 20, marketplace: 201 }], categoryScopeConfigured: true },
};
const filters = { sku: "G10050LG01A-JH", platformId: 1, startDate: "2026-10-29", endDate: "2026-10-30" };

test("运营无仓储页面权限，固定数据集仍可查；每条查询排除其他渠道、国家和品类", () => {
  const db = fixture();
  try {
    for (const dataset of INVENTORY_DATASETS) {
      const query = compileInventoryQuery(context, { ...filters, dataset }, 100);
      const rows = db.prepare(query.sql).all();
      assert.ok(rows.length > 0, dataset);
      assert.ok(rows.every((row) => row.sku === filters.sku), dataset);
      assert.ok(rows.every((row) => row.country_id === undefined || row.country_id === 1), dataset);
      assert.ok(rows.every((row) => row.storehouse_id === undefined || row.storehouse_id === 1), dataset);
      assert.doesNotMatch(JSON.stringify(rows), /SECRET|OTHER-ORDER|purchase_price|supplier|email/);
    }
    const rows = db.prepare(compileInventoryQuery(context, { ...filters, dataset: "stock" }, 100).sql).all();
    assert.deepEqual(rows.map((row) => row.channel_batch_id), [1]);
  } finally { db.close(); }
});

test("订单范围保留平台店铺站点组合；汇总可解释其他店铺占用但不暴露明细", () => {
  const db = fixture();
  try {
    const query = compileInventoryQuery(context, { ...filters, dataset: "occupancy" }, 100);
    const rows = db.prepare(query.sql).all();
    assert.deepEqual(rows.map((row) => row.order_id), ["OWN-ORDER"]);
    // The older active reservation must not disappear when the user mentions yesterday.
    assert.equal(rows[0]!.ship_create_time, "2026-09-01 00:00:00");
    const summary = db.prepare(compileInventoryQuery(context, { ...filters, dataset: "occupancy_summary" }, 100).sql).all();
    assert.equal(summary[0]!.channel_confirmation_occupancy, 3);
    assert.equal(summary[0]!.visible_confirmation_occupancy, 1);
    const hiddenOrder = db.prepare(compileInventoryQuery(context, { ...filters, dataset: "occupancy", orderId: "OTHER-ORDER" }, 100).sql).all();
    assert.equal(hiddenOrder.length, 0);
  } finally { db.close(); }
});

test("IO通过真实虚拟批次关联；调拨中其他店铺订单号被隐藏，结束日期包含整天", () => {
  const db = fixture();
  try {
    const io = db.prepare(compileInventoryQuery(context, { ...filters, dataset: "channel_io" }, 100).sql).all();
    assert.deepEqual(io.map((row) => row.id), [2, 1]);
    assert.equal(io[0]!.operator_name, "测试操作员");
    const transfers = db.prepare(compileInventoryQuery(context, { ...filters, dataset: "transfers" }, 100).sql).all();
    assert.equal(transfers.length, 2);
    assert.equal(transfers.find((r) => r.id === 1)!.authorized_order_id, "OWN-ORDER");
    assert.equal(transfers.find((r) => r.id === 2)!.authorized_order_id, null);
  } finally { db.close(); }
});

test("明确拒绝未授权渠道，未知角色或缺少范围应标记未确认；不能以角色名称自报授权", () => {
  assert.throws(() => compileInventoryQuery(context, { ...filters, dataset: "stock", platformId: 6 }, 50), /权限不足/);
  assert.throws(() => compileInventoryQuery({ ...context, inventoryOperationsRole: false }, { ...filters, dataset: "stock" }, 50), /暂无法确认数据授权范围/);
  assert.throws(() => compileInventoryQuery({ ...context, dataScope: { ...context.dataScope, shopGroups: [] } }, { ...filters, dataset: "stock" }, 50), /暂无法确认数据授权范围/);
  assert.throws(() => compileInventoryQuery(context, { dataset: "stock", sku: filters.sku }, 50), /请明确/);
  assert.throws(() => compileInventoryQuery(context, { ...filters, dataset: "supplier_prices" }, 50), /暂无法确认/);
});

test("输入不能注入SQL、扩表、跨日期上限或伪造过滤条件", () => {
  for (const args of [
    { ...filters, dataset: "stock", sql: "SELECT * FROM mc_supplier" },
    { ...filters, dataset: "stock", sku: "x' OR 1=1" },
    { ...filters, dataset: "stock", countryId: "1 OR 1=1" },
    { ...filters, dataset: "channel_io", endDate: "2026-12-30" },
    { ...filters, dataset: "channel_io", startDate: "2026-02-30" },
    { ...filters, dataset: "channel_io", startDate: "2026-11-01" },
    { dataset: "channel_io", sku: filters.sku, platformId: 1 },
    { ...filters, dataset: "stock", orderId: "OWN-ORDER" },
    { ...filters, dataset: "transit_allocations", storehouseId: 1 },
  ]) assert.throws(() => compileInventoryQuery(context, args, 50));
});

test("导出编译器与查询共用授权边界，最大10000条，类别范围也必须满足", () => {
  const db = fixture();
  try {
    const result = compileInventoryQuery(context, { ...filters, dataset: "stock" }, 10000);
    assert.match(result.sql, /LIMIT 10001$/);
    assert.equal(db.prepare(result.sql).all().length, 1);
    const deniedCategory = { ...context, dataScope: { ...context.dataScope, categories: [999] } };
    assert.equal(db.prepare(compileInventoryQuery(deniedCategory, { ...filters, dataset: "stock" }, 50).sql).all().length, 0);
    assert.throws(() => compileInventoryQuery(context, { ...filters, dataset: "stock" }, 10001));
    const noCategoryDimension = { ...context, dataScope: { ...context.dataScope, categories: [], categoryScopeConfigured: false } };
    assert.equal(db.prepare(compileInventoryQuery(noCategoryDimension, { ...filters, dataset: "stock" }, 50).sql).all().length, 1);
  } finally { db.close(); }
});

function fixture(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.function("TO_SECONDS", (value) => Date.parse(String(value).replace(" ", "T") + "Z") / 1000);
  db.exec(`
    CREATE TABLE mc_goods(id INTEGER, sku TEXT, category_id INTEGER);
    INSERT INTO mc_goods VALUES (1, 'G10050LG01A-JH', 7), (2, 'SECRET-SKU', 8);
    CREATE TABLE mc_country(id INTEGER, english TEXT, is_del INTEGER);
    INSERT INTO mc_country VALUES (1, 'US', 0), (2, 'CA', 0);
    CREATE TABLE mc_shop(id INTEGER, platform_type INTEGER, is_del INTEGER);
    INSERT INTO mc_shop VALUES (10,1,0),(20,3,0),(30,1,0);
    CREATE TABLE mc_shop_marketplace(id INTEGER, shop_id INTEGER, country_code TEXT, is_del INTEGER);
    INSERT INTO mc_shop_marketplace VALUES (101,10,'US',0),(102,10,'CA',0),(201,20,'US',0),(301,30,'US',0);
    CREATE TABLE mc_channel_stock_batch(id INTEGER, batch_id INTEGER, goods_id INTEGER, platform_channel INTEGER,
      country_id INTEGER, storehouse_id INTEGER, storehouse_type INTEGER, stock INTEGER, lock_stock INTEGER, number INTEGER, update_time TEXT, is_del INTEGER);
    INSERT INTO mc_channel_stock_batch VALUES
      (1,1,1,1,1,1,1,100,20,150,'2026-10-30',0),
      (2,1,1,3,1,1,1,80,0,100,'2026-10-30',0),
      (3,2,1,1,2,2,1,50,0,50,'2026-10-30',0),
      (4,3,2,1,1,1,1,10,0,10,'2026-10-30',0);
    CREATE TABLE mc_user(id INTEGER, user_name TEXT);
    INSERT INTO mc_user VALUES(1,'测试操作员');
    CREATE TABLE mc_channel_stock_io_record(id INTEGER, virtual_batch_id INTEGER, batch_id INTEGER, goods_id INTEGER,
      storehouse_id INTEGER, create_time TEXT, io_type INTEGER, number INTEGER, operation_id INTEGER);
    INSERT INTO mc_channel_stock_io_record VALUES
      (1,1,1,1,1,'2026-10-29 00:00:00',2,2,1),(2,1,1,1,1,'2026-10-30 23:59:59',2,3,1),
      (3,1,1,1,1,'2026-10-31 00:00:00',2,1,1),(4,2,1,1,1,'2026-10-30 12:00:00',2,2,1),
      (5,1,999,1,1,'2026-10-30 12:00:00',2,2,1);
    CREATE TABLE mc_order(order_id TEXT, shop_id INTEGER, shop_marketplace_id INTEGER, source INTEGER, state INTEGER, freeze INTEGER, fulfillment_channel INTEGER);
    INSERT INTO mc_order VALUES ('OWN-ORDER',10,101,1,2,0,1),('OTHER-ORDER',30,301,1,2,0,1),('CROSS-OTHER-ORDER',20,201,1,2,0,1);
    CREATE TABLE mc_order_items_ship(id INTEGER, order_id TEXT, goods_id INTEGER, storehouse_id INTEGER, state INTEGER,
      batch_id INTEGER, is_lock INTEGER, parent_id INTEGER, plat_order_no TEXT, auto_push INTEGER, is_del INTEGER, create_time TEXT);
    INSERT INTO mc_order_items_ship VALUES (1,'OWN-ORDER',1,1,0,0,0,0,'',1,0,'2026-09-01 00:00:00'),
      (2,'OTHER-ORDER',1,1,0,0,0,0,'',1,0,'2026-10-29 00:00:00'),(3,'CROSS-OTHER-ORDER',1,1,0,0,0,0,'',1,0,'2026-10-29 00:00:00');
    CREATE TABLE mc_storehouse(id INTEGER, country_id INTEGER, type INTEGER, is_entity INTEGER, is_delivery INTEGER);
    INSERT INTO mc_storehouse VALUES (1,1,1,1,1),(2,2,1,1,1);
    CREATE TABLE mc_channel_allocated_record(id INTEGER, goods_id INTEGER, source_id INTEGER, target_id INTEGER,
      source_batch_id INTEGER, target_batch_id INTEGER, number INTEGER, allocate_state INTEGER, transfer_type INTEGER,
      create_time TEXT, allocate_time TEXT, operator_id INTEGER, order_id TEXT, is_del INTEGER);
    INSERT INTO mc_channel_allocated_record VALUES (1,1,1,3,1,2,5,2,1,'2026-10-29','2026-10-30',1,'OWN-ORDER',0),
      (2,1,1,3,1,2,6,2,1,'2026-10-30','2026-10-30',1,'OTHER-ORDER',0);
    UPDATE mc_channel_allocated_record SET create_time = create_time || ' 12:00:00';
    CREATE TABLE mc_stock_batch(id INTEGER, goods_id INTEGER, storehouse_id INTEGER, stock INTEGER, is_valid INTEGER);
    INSERT INTO mc_stock_batch VALUES (1,1,1,180,1),(2,1,2,50,1);
    CREATE TABLE mc_stock_io_record(id INTEGER, goods_id INTEGER, batch_id INTEGER, storehouse_id INTEGER, create_time TEXT, io_type INTEGER, io_detail_type INTEGER, number INTEGER);
    INSERT INTO mc_stock_io_record VALUES (1,1,1,1,'2026-10-29 12:00:00',2,17,4),(2,1,2,2,'2026-10-29 12:00:00',2,17,5);
    CREATE TABLE mc_channel_transit_allocated_record(id INTEGER, goods_id INTEGER, country_id INTEGER, source_id INTEGER, target_id INTEGER,
      number INTEGER, released_number INTEGER, allocate_state INTEGER, record_state INTEGER, transfer_type INTEGER,
      create_time TEXT, allocate_time TEXT, release_time TEXT, is_del INTEGER);
    INSERT INTO mc_channel_transit_allocated_record VALUES (1,1,1,1,3,20,3,1,1,1,'2026-10-29 12:00:00','2026-10-29 12:00:00',NULL,0),
      (2,1,2,1,3,20,3,1,1,1,'2026-10-29 12:00:00','2026-10-29 12:00:00',NULL,0);
  `);
  db.exec(`
    ALTER TABLE mc_order ADD COLUMN plat_order_id TEXT;
    INSERT INTO mc_order(order_id,shop_id,shop_marketplace_id,source,state,freeze,fulfillment_channel,plat_order_id)
      VALUES('HISTORY-ORDER',10,101,1,4,0,1,'112-8095369-6984237');
    ALTER TABLE mc_order_items_ship ADD COLUMN order_item_id INTEGER;
    ALTER TABLE mc_order_items_ship ADD COLUMN push_datetime INTEGER DEFAULT 0;
    ALTER TABLE mc_order_items_ship ADD COLUMN delivery_time INTEGER DEFAULT 0;
    INSERT INTO mc_order_items_ship(id,order_id,goods_id,storehouse_id,state,batch_id,is_lock,parent_id,plat_order_no,auto_push,is_del,create_time,order_item_id,push_datetime,delivery_time)
      VALUES(4,'HISTORY-ORDER',1,1,3,1,0,0,'',1,0,'2026-10-28 00:00:00',99,${Date.parse('2026-10-30T23:59:59+08:00') / 1000},${Date.parse('2026-10-31T01:00:00+08:00') / 1000});
  `);
  return db;
}

test("页面关联诊断执行真实SQL：跨仓储/物流限同品同国，不返回无权订单，关系删除立即失效", () => {
  const db = fixture();
  const pmc = { ...context, inventoryOperationsRole: false, dataScope: { platforms: [], shops: [], shopMarketplaces: [], categories: [], shopGroups: [] } };
  const grant = { erpUserId: pmc.erpUserId, pagePurviewId: 1104, itemsCode: 'ITEM-1', countryId: 1, countryCode: 'US', skus: [filters.sku] };
  const scoped = { ...filters, countryId: 1 };
  try {
    db.exec(`CREATE TABLE mc_items(id INTEGER, items_code TEXT, is_del INTEGER);
      CREATE TABLE mc_items_vsku(items_id INTEGER, vsku_id INTEGER, is_del INTEGER);
      CREATE TABLE mc_vsku_mapping_sku(vsku_id INTEGER, goods_id INTEGER, is_del INTEGER);
      INSERT INTO mc_items VALUES(1445, 'ITEM-1', 0);
      INSERT INTO mc_items_vsku VALUES(1445, 4000, 0);
      INSERT INTO mc_vsku_mapping_sku VALUES(4000, 1, 0);`);
    for (const dataset of INVENTORY_DATASETS.filter(d => !['occupancy', 'channel_io_orders'].includes(d))) {
      const rows = db.prepare(compileInventoryQuery(pmc, { ...scoped, dataset }, 100, grant).sql).all();
      assert.ok(rows.length > 0, dataset);
      assert.ok(rows.every(r => r.country_id === undefined || r.country_id === 1));
      assert.doesNotMatch(JSON.stringify(rows), /OWN-ORDER|OTHER-ORDER|SECRET-SKU/);
    }
    for (const bad of [
      { ...scoped, dataset: 'stock', sku: 'SECRET-SKU' }, { ...scoped, dataset: 'stock', countryId: 2 },
      { ...scoped, dataset: 'occupancy' }, { ...scoped, dataset: 'channel_io_orders' }, { ...scoped, dataset: 'stock', sql: 'SELECT * FROM mc_user' },
      { ...scoped, dataset: 'supplier_prices' }, { ...scoped, dataset: 'stock', relatedCase: grant },
    ]) assert.throws(() => compileInventoryQuery(pmc, bad, 100, grant));
    assert.throws(() => compileInventoryQuery({ ...pmc, erpUserId: 999 }, { ...scoped, dataset: 'stock' }, 100, grant));
    assert.throws(() => compileInventoryQuery(pmc, { ...scoped, dataset: 'stock' }, 100));
    const sql = compileInventoryQuery(pmc, { ...scoped, dataset: 'stock' }, 10000, grant).sql;
    assert.match(sql, /LIMIT 10001$/);
    db.exec('UPDATE mc_vsku_mapping_sku SET is_del = 1');
    assert.equal(db.prepare(sql).all().length, 0);
  } finally { db.close(); }
});


test("历史流水追单包含已发货订单，按真实批次/商品/仓库/推单秒匹配，不能用当前占用代替", () => {
  const db = fixture();
  try {
    const args = { ...filters, dataset: 'channel_io_orders', ioRecordId: 2 };
    const rows = db.prepare(compileInventoryQuery(context, args, 100).sql).all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.order_id, 'HISTORY-ORDER');
    assert.equal(rows[0]!.platform_order_id, '112-8095369-6984237');
    assert.equal(rows[0]!.order_state, 4);
    assert.equal(rows[0]!.evidence_type, 'batch_and_push_second_match');
    assert.equal(rows[0]!.visible_matching_ship_rows, 1);
    assert.doesNotMatch(JSON.stringify(rows), /OWN-ORDER/);
    const occupancy = db.prepare(compileInventoryQuery(context, { ...filters, dataset: 'occupancy' }, 100).sql).all();
    assert.ok(occupancy.every(r => r.order_id !== 'HISTORY-ORDER'));
    for (const change of ["batch_id=2", "goods_id=2", "storehouse_id=2", "push_datetime=push_datetime+1", "is_del=1"]) {
      db.exec('SAVEPOINT change_match');
      db.exec(`UPDATE mc_order_items_ship SET ${change} WHERE id=4`);
      assert.equal(db.prepare(compileInventoryQuery(context, args, 100).sql).all().length, 0, change);
      db.exec('ROLLBACK TO change_match'); db.exec('RELEASE change_match');
    }
    // Exact timestamp is a corroboration, never a fabricated foreign key. Preserve ambiguity.
    db.exec(`INSERT INTO mc_order_items_ship SELECT 5,order_id,goods_id,storehouse_id,state,batch_id,is_lock,parent_id,plat_order_no,auto_push,is_del,create_time,order_item_id,push_datetime,delivery_time FROM mc_order_items_ship WHERE id=4`);
    const ambiguous = db.prepare(compileInventoryQuery(context, args, 1).sql).all();
    assert.equal(ambiguous[0]!.visible_matching_ship_rows, 2);
    db.exec("UPDATE mc_order SET shop_id=30,shop_marketplace_id=301 WHERE order_id='HISTORY-ORDER'");
    assert.equal(db.prepare(compileInventoryQuery(context, args, 100).sql).all().length, 0);
    assert.throws(() => compileInventoryQuery(context, { ...filters, dataset: 'occupancy', ioRecordId: 2 }, 10), /仅用于/);
    assert.throws(() => compileInventoryQuery(context, { ...args, ioRecordId: "2 OR 1=1" }, 10));
  } finally { db.close(); }
});
