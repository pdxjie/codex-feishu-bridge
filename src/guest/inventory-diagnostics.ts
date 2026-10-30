import type { InventoryCaseGrant } from "./inventory-case.js";
import type { ErpAccessContext } from "./erp-access-control.js";
import { authorizationUnknown, inventoryCategoryPredicate, inventoryCountryPredicate, requireInventoryCapability, shopScopePredicate } from "./inventory-policy.js";

export const INVENTORY_DATASETS = ["stock", "channel_io", "channel_io_orders", "transfers", "occupancy", "occupancy_summary", "warehouse_reconciliation", "warehouse_io_summary", "transit_allocations"] as const;
export type InventoryDataset = typeof INVENTORY_DATASETS[number];
export type InventoryQuery = { sql: string; dataset: InventoryDataset; platformId: number; notes: string[] };

// This compiler accepts business filters only, never model-authored SQL,
// columns, joins, role IDs, or ownership claims. Every dataset applies scope.
export function compileInventoryQuery(context: ErpAccessContext, args: Record<string, unknown>, maxRows: number, relatedCase?: InventoryCaseGrant): InventoryQuery {
  if (!relatedCase) requireInventoryCapability(context);
  else if (relatedCase.erpUserId !== context.erpUserId || !relatedCase.skus.includes(String(args.sku)) || args.countryId !== relatedCase.countryId) {
    throw new Error("权限不足：查询对象或国家超出本次关联排查范围。");
  }
  const dataset = args.dataset as InventoryDataset;
  if (!INVENTORY_DATASETS.includes(dataset)) throw authorizationUnknown("尚未映射的库存排查方向");
  if (typeof args.sku !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(args.sku)) {
    throw new Error("请提供一个准确的 SKU 编码，不能使用通配符或 SQL。");
  }
  for (const key of Object.keys(args)) {
    if (!["dataset", "sku", "ioRecordId", "platformId", "countryId", "storehouseId", "orderId", "startDate", "endDate", "maxRows", "title", "fileName", "format"].includes(key)) {
      throw new Error(`库存排查不接受参数 ${key}，不能指定 SQL 或扩大授权范围。`);
    }
  }
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 10000) throw new Error("无效的结果数量限制。");
  const platforms = context.dataScope.platforms;
  const platformId = optionalId(args.platformId, "platformId") ?? (Array.isArray(platforms) && platforms.length === 1 ? platforms[0]! : null);
  if (!platformId) throw authorizationUnknown("请明确要排查的渠道，例如亚马逊或 Wayfair");
  if (!relatedCase && !context.superAdministrator && !context.dataScope.shopGroups!.some((g) => g.platform === 0 || g.platform === platformId)) {
    throw new Error("权限不足：该渠道超出当前 ERP 角色的数据授权范围。");
  }
  const countryId = optionalId(args.countryId, "countryId");
  const storehouseId = optionalId(args.storehouseId, "storehouseId");
  const ioRecordId = optionalId(args.ioRecordId, "ioRecordId");
  if (ioRecordId && !["channel_io", "channel_io_orders"].includes(dataset)) throw new Error("ioRecordId仅用于渠道流水及其历史订单追溯，其他数据集不接受该过滤条件。");
  const orderId = args.orderId;
  if (orderId !== undefined && (typeof orderId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(orderId))) throw new Error("请提供有效的 ERP 订单编号。");
  if (orderId !== undefined && dataset !== "occupancy") throw new Error("订单编号仅用于订单占用明细；不要把其他数据集误认为已经按订单过滤。");
  if (storehouseId && dataset === "transit_allocations") throw new Error("在途分配尚不支持仓库过滤，请按国家、渠道和 SKU 查询。");
  const dateRange = parseDateRange(args.startDate, args.endDate);
  const historical = ["channel_io", "channel_io_orders", "transfers", "warehouse_io_summary", "transit_allocations"].includes(dataset);
  if (historical && !dateRange) throw new Error("请提供开始和结束日期（YYYY-MM-DD），一次最多 31 天。");
  const countryScope = (platform: string, country: string) => relatedCase
    ? `${country} = ${relatedCase.countryId}` : inventoryCountryPredicate(context, platform, country);
  const liveRelation = relatedCase ? ` AND EXISTS (SELECT 1 FROM mc_items case_i
    INNER JOIN mc_items_vsku case_iv ON case_iv.items_id = case_i.id AND case_iv.is_del = 0
    INNER JOIN mc_vsku_mapping_sku case_m ON case_m.vsku_id = case_iv.vsku_id AND case_m.is_del = 0
    WHERE case_i.items_code = '${relatedCase.itemsCode}' AND case_i.is_del = 0 AND case_m.goods_id = g.id)` : "";
  const g = `g.sku = '${args.sku}' AND ${relatedCase ? "1 = 1" : inventoryCategoryPredicate(context)}${liveRelation}`;
  const channel = (alias: string) => `${alias}.platform_channel = ${platformId}
    AND ${countryScope(`${alias}.platform_channel`, `${alias}.country_id`)}
    ${countryId ? `AND ${alias}.country_id = ${countryId}` : ""}
    ${storehouseId ? `AND ${alias}.storehouse_id = ${storehouseId}` : ""}`;
  const orderScope = context.superAdministrator ? "1 = 1" : !context.dataScope.shopGroups?.length ? "1 = 0" : shopScopePredicate(context.dataScope, "o.source", "o.shop_id", "o.shop_marketplace_id");
  const during = (column: string) => `${column} >= '${dateRange!.start}' AND ${column} < '${dateRange!.endExclusive}'`;
  const limit = `LIMIT ${maxRows + 1}`;
  let sql: string;
  if (relatedCase && ["occupancy", "channel_io_orders"].includes(dataset) && !context.superAdministrator && !context.dataScope.shopGroups?.length) {
    throw new Error("权限不足：关联诊断可查看occupancy_summary占用数量，订单明细仍需店铺权限。");
  }
  const notes = [
    relatedCase ? "已按来源页面授权本次品/国家的关联库存证据，无需仓储页面或运营角色；订单明细仍按店铺授权。" : "渠道库存为平台/国家共享资源，按已有店铺站点授权推导可排查范围；订单明细另按店铺站点过滤。",
    "返回数量受限，截断结果不得当作完整汇总；空结果只能说明授权范围内未找到，不能证明全公司没有记录。",
  ];
  switch (dataset) {
    case "stock":
      sql = `SELECT g.sku, csb.id AS channel_batch_id, csb.batch_id, csb.platform_channel,
        csb.country_id, csb.storehouse_id, csb.storehouse_type, csb.stock, csb.lock_stock, csb.number AS inbound_number,
        csb.update_time FROM mc_channel_stock_batch csb INNER JOIN mc_goods g ON g.id = csb.goods_id
        WHERE ${g} AND ${channel("csb")} AND csb.is_del = 0 ORDER BY csb.id ${limit}`;
      notes.push("当前快照，不是历史日期库存；stock、lock_stock 和订单预占是不同口径，不能未经代码核验直接相减得到最终可用量。");
      break;
    case "channel_io":
      sql = `SELECT g.sku, io.id, io.create_time, io.io_type, io.number,
        csb.platform_channel, csb.country_id, csb.storehouse_id, csb.batch_id, csb.id AS channel_batch_id,
        io.operation_id, u.user_name AS operator_name, csb.is_del AS channel_batch_deleted
        FROM mc_channel_stock_io_record io
        INNER JOIN mc_channel_stock_batch csb ON csb.id = io.virtual_batch_id
          AND csb.goods_id = io.goods_id AND csb.batch_id = io.batch_id AND csb.storehouse_id = io.storehouse_id
        INNER JOIN mc_goods g ON g.id = io.goods_id
        LEFT JOIN mc_user u ON u.id = io.operation_id
        WHERE ${g} AND ${channel("csb")} AND ${during("io.create_time")} ${ioRecordId ? `AND io.id = ${ioRecordId}` : ""}
        ORDER BY io.create_time DESC, io.id DESC ${limit}`;
      notes.push("操作人是流水执行人，不一定是业务占用方；operation_id=0 通常为系统。没有可靠虚拟批次关联的旧流水不包含在结果中；不输出可能夹带订单或敏感资料的自由文本备注。");
      notes.push("询问扣减对应订单时，继续用channel_io_orders并传ioRecordId。不得用当前occupancy订单代替历史扣减订单；未查到物理IO也不能推断尚未发货。");
      break;
    case "channel_io_orders":
      // ERP datetime columns use Asia/Shanghai; push_datetime stores epoch seconds.
      // Explicit arithmetic avoids depending on the MySQL session timezone.
      sql = `SELECT g.sku, io.id AS io_record_id, io.create_time AS io_time, io.io_type, io.number AS io_quantity,
        csb.id AS channel_batch_id, csb.batch_id, csb.platform_channel, csb.country_id, csb.storehouse_id,
        s.id AS ship_id, s.order_item_id, s.state AS ship_state, s.push_datetime, s.delivery_time,
        s.create_time AS ship_create_time, o.order_id, o.plat_order_id AS platform_order_id,
        o.shop_id, o.shop_marketplace_id, o.state AS order_state,
        'batch_and_push_second_match' AS evidence_type,
        COUNT(*) OVER (PARTITION BY io.id) AS visible_matching_ship_rows
        FROM mc_channel_stock_io_record io
        INNER JOIN mc_channel_stock_batch csb ON csb.id = io.virtual_batch_id
          AND csb.goods_id = io.goods_id AND csb.batch_id = io.batch_id AND csb.storehouse_id = io.storehouse_id
        INNER JOIN mc_goods g ON g.id = io.goods_id
        INNER JOIN mc_order_items_ship s ON s.goods_id = io.goods_id AND s.batch_id = io.batch_id
          AND s.storehouse_id = io.storehouse_id AND s.is_del = 0 AND s.batch_id > 0 AND s.push_datetime > 0
          AND s.push_datetime = (TO_SECONDS(io.create_time) - TO_SECONDS('1970-01-01 08:00:00'))
        INNER JOIN mc_order o ON o.order_id = s.order_id
        WHERE ${g} AND ${channel("csb")} AND io.io_type = 2 AND ${during("io.create_time")}
          AND o.source = ${platformId} AND ${orderScope} ${ioRecordId ? `AND io.id = ${ioRecordId}` : ""}
        ORDER BY io.create_time DESC, io.id DESC, s.id ${limit}`;
      notes.push("历史扣减追溯：核对流水、虚拟批次、实物批次、SKU、仓库和推单秒级时间；包含已发货/已完成订单，不按当前占用状态或订单创建日期筛选。优先展示platform_order_id，同时注明ERP内部order_id。push_datetime/delivery_time是Unix秒，按北京时间解释；ship_create_time是发货明细创建时间，不是订单下单时间。",
        "evidence_type是同批次同秒推单的交叉证据，不是流水外键直接绑定。visible_matching_ship_rows仅为本人可见候选明细数，不代表全库唯一；多候选、重复流水或截断时不得任选一单断言对应关系。空结果表示未找到可见的精确匹配，可能因其他业务扣减、回滚/重推、删除、时间差或授权范围；不能退回occupancy猜测订单，也不能据此证明未发货。");
      break;
    case "transfers":
      sql = `SELECT g.sku, r.id, r.source_id AS source_channel, r.target_id AS target_channel,
        r.number, r.allocate_state, r.transfer_type, r.create_time, r.allocate_time,
        r.operator_id, u.user_name AS operator_name,
        CASE WHEN o.source = ${platformId} AND ${orderScope} THEN r.order_id ELSE NULL END AS authorized_order_id
        FROM mc_channel_allocated_record r INNER JOIN mc_goods g ON g.id = r.goods_id
        LEFT JOIN mc_order o ON o.order_id = r.order_id
        LEFT JOIN mc_user u ON u.id = r.operator_id
        WHERE ${g} AND r.is_del = 0 AND ${during("r.create_time")}
        AND (EXISTS (SELECT 1 FROM mc_channel_stock_batch csb WHERE csb.id = r.source_batch_id
          AND csb.goods_id = r.goods_id AND csb.platform_channel = r.source_id AND ${channel("csb")})
          OR EXISTS (SELECT 1 FROM mc_channel_stock_batch csb WHERE csb.id = r.target_batch_id
          AND csb.goods_id = r.goods_id AND csb.platform_channel = r.target_id AND ${channel("csb")}))
        ORDER BY r.create_time DESC, r.id DESC ${limit}`;
      notes.push("仅返回授权渠道实际参与且批次关系可验证的调拨。对方渠道仅作为本次调拨来源/去向展示；无权查看的关联订单号为空。日期按记录创建时间筛选，allocate_time 是实际执行时间。");
      break;
    case "occupancy":
    case "occupancy_summary": {
      // Mirrors getAuditedOrderItemsShip (not the differently-filtered Detail
      // method) and getEstimatedReserveQuantity; keep the two counts separate.
      const confirmation = "o.state IN (1,2,3) AND o.shop_id NOT IN (52,58,82,84,94,99,75) AND s.parent_id = 0 AND (s.state = 4 OR s.plat_order_no = '') AND s.auto_push = 1 AND w.is_entity = 1 AND w.type IN (1,4) AND w.is_delivery = 1";
      const reserved = "s.batch_id = 0 AND s.is_lock = 0 AND o.state IN (2,3) AND o.freeze = 0 AND o.fulfillment_channel = 1";
      const base = `FROM mc_order_items_ship s INNER JOIN mc_order o ON o.order_id = s.order_id
        INNER JOIN mc_goods g ON g.id = s.goods_id INNER JOIN mc_storehouse w ON w.id = s.storehouse_id
        WHERE ${g} AND s.is_del = 0 AND o.source = ${platformId}
        AND ${countryScope("o.source", "w.country_id")}
        ${countryId ? `AND w.country_id = ${countryId}` : ""}
        ${storehouseId ? `AND w.id = ${storehouseId}` : ""}
        AND ((${confirmation}) OR (${reserved}))`;
      sql = dataset === "occupancy"
        ? `SELECT g.sku, o.order_id, o.shop_id, o.shop_marketplace_id, o.source AS platform_channel,
          s.id AS ship_id, s.storehouse_id, w.country_id, s.state AS ship_state, o.state AS order_state,
          s.batch_id, s.auto_push, s.create_time AS ship_create_time,
          CASE WHEN ${confirmation} THEN 1 ELSE 0 END AS confirmation_occupancy,
          CASE WHEN ${reserved} THEN 1 ELSE 0 END AS estimated_reserve
          ${base} AND ${orderScope} ${orderId ? `AND o.order_id = '${orderId}'` : ""}
          ORDER BY s.id ${limit}`
        : `SELECT g.sku, w.country_id, s.storehouse_id, w.type AS storehouse_type,
          SUM(CASE WHEN ${confirmation} THEN 1 ELSE 0 END) AS channel_confirmation_occupancy,
          SUM(CASE WHEN ${reserved} THEN 1 ELSE 0 END) AS channel_estimated_reserve,
          SUM(CASE WHEN (${confirmation}) AND ${orderScope} THEN 1 ELSE 0 END) AS visible_confirmation_occupancy,
          SUM(CASE WHEN (${reserved}) AND ${orderScope} THEN 1 ELSE 0 END) AS visible_estimated_reserve
          ${base} GROUP BY g.sku, w.country_id, s.storehouse_id, w.type ORDER BY s.storehouse_id ${limit}`;
      notes.push("当前占用，不受历史日期筛选；不能用于识别历史扣减对应订单，已发货订单可能不在结果内。ship_create_time是发货明细创建时间，不是订单下单时间。确认订单占用与预估预留口径不同、可能重叠，禁止相加。每条发货单商品记录计 1 件；核对来源 OrderItemsShipDAO::getAuditedOrderItemsShip / getEstimatedReserveQuantity。汇总为渠道共享占用，明细只展示有权查看的店铺订单；差额不能反推其他店铺身份。");
      break;
    }
    case "warehouse_reconciliation":
      sql = `SELECT DISTINCT g.sku, b.id AS batch_id, b.storehouse_id, b.stock AS warehouse_stock, b.is_valid,
        (SELECT COALESCE(SUM(all_c.stock), 0) FROM mc_channel_stock_batch all_c
          WHERE all_c.batch_id = b.id AND all_c.goods_id = b.goods_id AND all_c.storehouse_id = b.storehouse_id AND all_c.is_del = 0) AS all_channels_stock,
        (SELECT COALESCE(SUM(own_c.stock), 0) FROM mc_channel_stock_batch own_c
          WHERE own_c.batch_id = b.id AND own_c.goods_id = b.goods_id AND own_c.storehouse_id = b.storehouse_id AND own_c.is_del = 0 AND ${channel("own_c")}) AS authorized_channel_stock
        FROM mc_goods g INNER JOIN mc_channel_stock_batch csb ON csb.goods_id = g.id
        INNER JOIN mc_stock_batch b ON b.id = csb.batch_id AND b.goods_id = csb.goods_id AND b.storehouse_id = csb.storehouse_id
        WHERE ${g} AND csb.is_del = 0 AND ${channel("csb")}
        ORDER BY b.id ${limit}`;
      notes.push("当前快照。跨模块只提供授权渠道关联物理批次的数量核对，不返回其他渠道逐项库存、采购价、供应商或仓库全部批次。差异需要结合业务口径判断。");
      break;
    case "warehouse_io_summary":
      sql = `SELECT g.sku, io.batch_id, io.storehouse_id, DATE(io.create_time) AS record_date,
        io.io_type, io.io_detail_type, SUM(io.number) AS quantity, COUNT(1) AS record_count
        FROM mc_stock_io_record io INNER JOIN mc_goods g ON g.id = io.goods_id
        WHERE ${g} AND ${during("io.create_time")}
          AND EXISTS (SELECT 1 FROM mc_channel_stock_batch csb WHERE csb.batch_id = io.batch_id
            AND csb.goods_id = io.goods_id AND csb.storehouse_id = io.storehouse_id AND ${channel("csb")})
        GROUP BY g.sku, io.batch_id, io.storehouse_id, DATE(io.create_time), io.io_type, io.io_detail_type
        ORDER BY record_date DESC, io.batch_id, io.io_type, io.io_detail_type ${limit}`;
      notes.push("仅授权渠道关联物理批次的仓储流水汇总，可能包含同批次其他渠道的出入库，不能归因于本渠道。无其他业务单号、操作人和备注；按记录创建时间筛选。");
      break;
    case "transit_allocations":
      sql = `SELECT g.sku, r.id, r.country_id, r.source_id AS source_channel, r.target_id AS target_channel,
        r.number, r.released_number, r.allocate_state, r.record_state, r.transfer_type,
        r.create_time, r.allocate_time, r.release_time
        FROM mc_channel_transit_allocated_record r INNER JOIN mc_goods g ON g.id = r.goods_id
        WHERE ${g} AND r.is_del = 0 AND (r.source_id = ${platformId} OR r.target_id = ${platformId})
          AND ${countryScope(String(platformId), "r.country_id")}
          ${countryId ? `AND r.country_id = ${countryId}` : ""}
          AND (${during("r.create_time")} OR ${during("r.release_time")})
        ORDER BY r.id DESC ${limit}`;
      notes.push("仅本渠道参与的在途分配/释放数量与状态；不展开采购单、成本或其他渠道全量在途。日期覆盖创建或释放时间。");
      break;
  }
  if (!historical && dateRange) notes.push("传入日期不用于当前快照查询；追溯历史变化请改用 IO/调拨数据集。");
  return { sql, dataset, platformId, notes };
}

function optionalId(value: unknown, field: string): number | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`无效的 ${field}`);
  return value;
}

function parseDateRange(start: unknown, end: unknown): { start: string; endExclusive: string } | null {
  if (start === undefined && end === undefined) return null;
  const parse = (value: unknown): number => {
    if (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) throw new Error("日期格式必须为 YYYY-MM-DD。");
    const time = Date.parse(`${value}T00:00:00Z`);
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new Error("日期无效。");
    return time;
  };
  const from = parse(start), to = parse(end);
  if (to < from || to - from >= 31 * 86400000) throw new Error("日期范围必须为正序且不超过 31 天。");
  return { start: `${start} 00:00:00`, endExclusive: `${new Date(to + 86400000).toISOString().slice(0, 10)} 00:00:00` };
}
