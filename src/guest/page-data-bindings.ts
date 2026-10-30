import type { ErpPageAccess } from "./erp-access-control.js";

// Verified against production metadata and Desktop/mc source on 2026-10-30:
// router/modules/storehouse.js -> channelStockManager/mix.vue ->
// ChannelPmcCompleteItemsManager.vue -> ChannelItemsCountrySummaryController
// -> getList/filterParam/DAO. The page belongs to Plan, but reads Warehousing
// data. Its permission URL is '/', so directory/domain inference is insufficient.
export const CHANNEL_ITEMS_PAGE = 1104;
const TABLES = ["channel_items_country_summary", "items"];
const COLUMNS = new Set([
  "id", "items_id", "items_code", "name", "type", "status", "is_del",
  "country_code", "platform_channel", "string_index", "create_time", "update_time",
  "real_in_stock", "real_in_transit", "real_in_factory", "real_in_fba_stock", "real_in_fba_transit",
  "real_in_cg_stock", "real_in_cg_transit", "real_in_cg_online_stock", "real_in_wfs_stock", "real_in_wfs_transit",
  "in_stock", "in_transit", "in_factory", "in_fba_stock", "in_fba_transit", "in_fba_factory",
  "in_cg_stock", "in_cg_transit", "in_cg_factory", "all_real_in_stock", "all_real_in_transit",
]);

export function reviewedPageBinding(page: ErpPageAccess) {
  if (page.pagePurviewId !== CHANNEL_ITEMS_PAGE) return undefined;
  if (page.viewId !== 339 || page.moduleId !== 74 || page.menuUrl !== "/channel-pmc-stock-manager" || page.permissionUrl !== "/") {
    throw new Error("暂无法确认数据授权范围：已登记页面的ERP元数据发生变化，需维护者复核页面映射，不应要求用户开权限或提供截图。");
  }
  return {
    tables: TABLES,
    columns: COLUMNS,
    // The reviewed native listing takes country/platform filters from the
    // request and does not impose operations-role/shop scope. This grant is
    // limited to page inventory data, never order, purchase or finance data.
    scope: "native_page" as const,
    hint: "该页面包含SKU、品最大可售和模拟扣减标签。品编码查 items.items_code；品数量查 channel_items_country_summary。最大可售在库=real_in_stock+real_in_fba_stock+real_in_cg_online_stock+real_in_wfs_stock；在途=real_in_transit+real_in_fba_transit+real_in_cg_transit+real_in_wfs_transit。直接页面查询不要求运营库存联合诊断角色或店铺授权；授权仅覆盖已登记的页面库存字段。",
  };
}

export function reservedPageTable(table: string): boolean {
  return table === "channel_items_country_summary";
}

export function pageAliasIds(keyword: string): number[] {
  const normalized = keyword.replace(/[()（）\s]/g, "");
  return ["最大可售", "分渠道最大可售", "分渠道品库存管理", "分渠道品库存管理最大可售", "分渠道库存管理最大可售"].includes(normalized)
    ? [CHANNEL_ITEMS_PAGE] : [];
}

export function annotatePageBinding(page: ErpPageAccess): ErpPageAccess {
  const binding = reviewedPageBinding(page);
  return binding ? { ...page, dataSources: binding.tables.map((table) => `mc_${table}`), dataAccessHint: binding.hint } : page;
}
