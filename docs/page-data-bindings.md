# 页面授权与数据来源映射

直接查询 ERP 已授权页面，与运营角色的库存联合排查是两条独立授权路径。没有 `inventory_diagnosis` 能力，不能否定用户已有的页面访问权。

## 分渠道品库存误拦截修复（2026-10-30）

生产记录确认：新版分渠道库存管理权限 1104、视图 339，所属模块是计划管理（74），菜单 `/channel-pmc-stock-manager`，权限 URL 为 `/`。旧逻辑仅用模块与 URL 推断表归属；实际 `channel_items_country_summary` 属于 Warehousing，因此页面检查通过后仍被错误阻断。

核对 `/Users/gaochenjie/Desktop/mc` 的源码链路：

- `application/admin/view/src/router/modules/storehouse.js` 将菜单路由到 `channelStockManager/mix.vue`。
- `mix.vue` 中的“分渠道品库存管理（最大可售）”标签使用 `ChannelPmcCompleteItemsManager.vue`。
- 前端请求 `app/Warehousing/ChannelItemsCountrySummary/getList`。
- 对应 Controller → `ChannelItemsCountrySummaryService::getList/filterParam` → `ChannelItemsCountrySummaryDAO::getListByPage/getListWhere`。
- 页面原生列表按照请求中的品编码、国家、渠道筛选，不使用运营角色或运营店铺范围作为额外门槛。

`src/guest/page-data-bindings.ts` 现在为这条已验证的业务链登记精确授权：

1. 每次查询仍实时核验当前用户是否具有 1104 权限。
2. 同时核验 viewId、moduleId、menuUrl 和 permissionUrl，元数据改变时要求维护者复核，不静默扩大授权。
3. 仅放行该页面的品标识和库存字段，数据表限于 `items` 和 `channel_items_country_summary`。不因源码属于仓储就开放整个仓储模块。
4. 不因 PMC 用户缺少运营店铺授权而误拒绝这个原生页面的汇总数据；这项规则只适用于此已核对的页面。
5. 其他页面不能借用此绑定读取品渠道汇总，采购、财务、订单和额外产品字段继续拒绝。
6. “最大可售”及带中文括号的标签名称可匹配页面，返回明确的数据来源、品编码字段和计算口径。

最大可售在库口径为普通在库 + FBA在库 + CG线上库存 + WFS在库；在途为普通在途 + FBA在途 + CG在途 + WFS在途。不是模拟扣减数据，也不能把 CG 线上库存与另一套 CG 库存重复相加。

验证使用李荣的真实 ERP 用户 796，经桥接 `resolveUserAccess`、`erp_page_access`、`database_query` 全链路读取生产只读连接；在没有库存联合诊断角色的情况下查询成功，返回 `G10014-29GR` / US 的 5 个渠道，未截断。没有修改 ERP 角色、权限或数据库数据，也没有向同事发送测试消息。

补充了页面允许、无页面权限、权限撤回、旧页面借权、额外模块/字段拒绝、中文括号搜索和元数据变更的回归检查。

## 后续映射规则

真实 ERP 页面可能跨多个代码领域、包含多个标签，或权限 URL 只登记 `/`。源码目录归属仅是定位线索，不能代替页面业务授权。

新登记需要核对页面 → 前端请求 → Controller → Service → DAO → 数据表与字段，以及原生列表实际使用的数据范围。不能仅把某个模块整体放开，也不能根据模糊页面名猜测数据权限。

业务目标不清楚时才请用户补充方向。目标页面与条件已明确、页面授权已通过但映射未适配时，应说明桥接适配问题，由维护者处理；不能要求用户截图、重新开权限或新增角色来掩盖适配缺失。
