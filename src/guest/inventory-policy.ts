import type { ErpAccessContext, ErpDataScope } from "./erp-access-control.js";

// Existing production ERP roles, reviewed 2026-10-30. Supplemental page grants
// (e.g. logistics staff temporarily granted an operations page) are not job roles.
export const INVENTORY_OPERATIONS_ROLES = [11, 15, 37, 38, 69, 70, 82, 84, 86, 87, 128, 129, 131, 133, 136, 155, 162, 179, 183, 250];

export type ShopScopeGroup = { platform: number; shop: number; marketplace: number };

export function authorizationUnknown(reason: string): Error {
  return new Error(`暂无法确认数据授权范围：${reason}。请补充所属渠道/店铺及具体业务问题；不要将此结果解释为用户无权。`);
}

export function hasInventoryCapability(context: ErpAccessContext): boolean {
  return context.superAdministrator || context.inventoryOperationsRole === true;
}

export function requireInventoryCapability(context: ErpAccessContext): void {
  if (!hasInventoryCapability(context)) {
    throw authorizationUnknown("尚未建立业务关联诊断；已有品库存页面权限时先调用inventory_case_open，不要求新增运营角色；直接查询仍核验目标页面");
  }
  if (!context.superAdministrator && !context.dataScope.shopGroups?.length) {
    throw authorizationUnknown("缺少可核验的平台/店铺数据范围");
  }
}

// Preserve hierarchical grants: (platform A, shop X) OR (platform B, shop Y).
// Independent IN lists would accidentally authorize cross-combinations.
export function shopScopePredicate(scope: ErpDataScope, platform: string, shop: string, marketplace: string): string {
  const groups = scope.shopGroups;
  if (!groups?.length) throw authorizationUnknown("缺少平台/店铺授权映射");
  return `(${groups.map((g) => {
    if (![g.platform, g.shop, g.marketplace].every((n) => Number.isSafeInteger(n) && n >= 0)) {
      throw authorizationUnknown("ERP 数据范围格式异常");
    }
    if (g.platform === 0) return "1 = 1";
    return `(${platform} = ${g.platform}${g.shop ? ` AND ${shop} = ${g.shop}${g.marketplace ? ` AND ${marketplace} = ${g.marketplace}` : ""}` : ""})`;
  }).join(" OR ")})`;
}

// Shared channel stock has no shop owner. Country eligibility is derived from
// an authorized shop/site, while order details retain the full shop/site tuple.
export function inventoryCountryPredicate(context: ErpAccessContext, platform: string, country: string): string {
  if (context.superAdministrator) return "1 = 1";
  const scope = shopScopePredicate(context.dataScope, "scope_shop.platform_type", "scope_shop.id", "scope_site.id");
  return `EXISTS (SELECT 1 FROM mc_shop scope_shop
    INNER JOIN mc_shop_marketplace scope_site ON scope_site.shop_id = scope_shop.id AND scope_site.is_del = 0
    INNER JOIN mc_country scope_country ON scope_country.english = scope_site.country_code AND scope_country.is_del = 0
    WHERE scope_shop.is_del = 0 AND scope_shop.platform_type = ${platform}
      AND scope_country.id = ${country} AND ${scope})`;
}

export function inventoryCategoryPredicate(context: ErpAccessContext): string {
  const scope = context.dataScope;
  if (context.superAdministrator || scope.categories === "ALL" || scope.categoryScopeConfigured === false) return "1 = 1";
  if (!scope.categories.length || !scope.categories.every((id) => Number.isSafeInteger(id) && id > 0)) {
    throw authorizationUnknown("品类授权记录异常");
  }
  return `g.category_id IN (${scope.categories.join(",")})`;
}

export const INVENTORY_SOURCE_FILES = new Set([
  "Warehousing/Service/ItemsCountrySummaryService", "Warehousing/DAO/ItemsCountrySummaryDAO", "Warehousing/Model/ItemsCountrySummaryModel",
  "Warehousing/Service/ChannelItemsCountrySummaryService", "Warehousing/DAO/ChannelItemsCountrySummaryDAO", "Warehousing/Model/ChannelItemsCountrySummaryModel",
  "Product/Service/ItemsVskuService", "Product/DAO/ItemsVskuDAO", "Product/Model/ItemsVskuModel",
  "Product/Service/VskuMappingSkuService", "Product/DAO/VskuMappingSkuDAO", "Product/Model/VskuMappingSkuModel",
  "Warehousing/Service/ChannelStockBatchService", "Warehousing/DAO/ChannelStockBatchDAO", "Warehousing/Model/ChannelStockBatchModel",
  "Warehousing/Service/ChannelStockIoRecordService", "Warehousing/DAO/ChannelStockIoRecordDAO", "Warehousing/Model/ChannelStockIoRecordModel",
  "Warehousing/Service/StockBatchService", "Warehousing/DAO/StockBatchDAO", "Warehousing/Model/StockBatchModel",
  "Warehousing/Service/StockIoRecordService", "Warehousing/DAO/StockIoRecordDAO", "Warehousing/Model/StockIoRecordModel",
  "Warehousing/Service/OrderItemsShipService", "Warehousing/DAO/OrderItemsShipDAO", "Warehousing/Model/OrderItemsShipModel",
  "Warehousing/Constant/OrderItemsShipConstant", "Warehousing/Constant/StorehouseConstant",
  "Warehousing/Model/ChannelTransitAllocatedRecordModel", "Warehousing/DAO/ChannelTransitAllocatedRecordDAO", "Warehousing/Service/ChannelTransitAllocatedRecordService",
  "Logistics/Service/ChannelAllocatedRecordService", "Logistics/DAO/ChannelAllocatedRecordDAO", "Logistics/Model/ChannelAllocatedRecordModel",
  "Operation/Constant/PlatformConstant", "Product/Model/GoodsModel", "Product/Model/CountryModel",
].map((file) => `application/admin/App/Domain/${file}.php`).concat([
  "application/admin/service/StockService.php", "application/admin/constant/OrderConstant.php",
  "application/admin/constant/StockIoRecordDetailTypeConstant.php", "application/admin/constant/StockIoRecordDetailTypeConstantV2.php",
]));
