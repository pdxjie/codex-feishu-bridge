import type { ErpAccessContext, GuestAccessGuard, DatabaseGatewayForAccess } from "./erp-access-control.js";
import { reviewedPageBinding } from "./page-data-bindings.js";
import { authorizationUnknown } from "./inventory-policy.js";

// These grants are constructed only from the bridge's original Feishu message,
// live page authorization and database relationships. Never accept one as tool input.
export type InventoryCaseGrant = {
  erpUserId: number; pagePurviewId: number; itemsCode: string;
  countryId: number; countryCode: string; skus: string[];
};
type Entry = { userId: number; prompt: string; expires: number; grant?: InventoryCaseGrant };
const TTL = 4 * 60 * 60 * 1000;
const continuation = /^(?:请)?(?:继续|继续排查|继续查|继续分析|继续查原因|查下去|接着查|导出排查证据|导出上述排查证据|把排查证据导出Excel)[。！!\s]*$/i;
// Short follow-ups can refer to this case without repeating its item/country.
// No new identifiers, locations or unrelated module names are accepted here.
const relatedFollowup = /^(?:请|帮我|再|继续|接着|进一步|把|将|这些|上述|这次|该品|这个品|的|查|查询|核对|看|分析|排查|导出|一下|渠道|库存|批次|物理|仓储|仓库|流水|IO|调拨|占用|数量|汇总|证据|结果|原因|记录|和|与|及|成|为|生成|整理|Excel|xlsx|CSV|Word|文件|[\s，,。.!！、？?])+$/i;
const diagnostic = /为什么|为何|怎么回事|原因|不一致|不相符|对不上|差异|异常|不够|不足|无法使用|被占用|排查|追溯/;
const codePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export class InventoryCases {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly access: GuestAccessGuard, private readonly database: () => Promise<DatabaseGatewayForAccess>, private readonly connection: string) {}

  bindPrompt(threadId: string, context: ErpAccessContext, prompt: string, previousThreadId?: string): void {
    const previous = this.entries.get(previousThreadId ?? threadId);
    const now = Date.now();
    const followup = continuation.test(prompt.trim()) || (relatedFollowup.test(prompt.trim()) && /查|核对|看|分析|导出|生成|整理/.test(prompt));
    const preserve = previous && previous.userId === context.erpUserId && previous.expires > now && followup;
    this.entries.set(threadId, preserve ? { ...previous, expires: now + TTL } : { userId: context.erpUserId, prompt, expires: now + TTL });
    if (previousThreadId && previousThreadId !== threadId) this.entries.delete(previousThreadId);
    for (const [key, entry] of this.entries) if (entry.expires <= now) this.entries.delete(key);
  }

  async current(threadId: string, context: ErpAccessContext): Promise<InventoryCaseGrant | undefined> {
    const entry = this.entries.get(threadId);
    if (!entry || entry.expires <= Date.now() || entry.userId !== context.erpUserId) {
      this.entries.delete(threadId);
      return undefined;
    }
    if (!entry.grant) return undefined;
    await this.checkPage(context, entry.grant.pagePurviewId);
    if (entry.grant.pagePurviewId === 1103 && context.roleIds.some(id => [81, 82].includes(id))) {
      const result = await (await this.database()).query(this.connection,
        `SELECT i.id FROM mc_items i INNER JOIN mc_spu s ON s.id = i.spu_id WHERE i.items_code = '${entry.grant.itemsCode}' AND i.is_del = 0 AND s.is_del = 0 AND s.category_id = 10 LIMIT 1`, 1) as { rows?: unknown[] };
      if (!result.rows?.length) throw new Error("权限不足：该品超出来源页面现有的品类范围。");
    }
    return entry.grant;
  }

  private async checkPage(context: ErpAccessContext, id: number): Promise<void> {
    const page = await this.access.authorizePage(context, id);
    const reviewed = id === 1103
      ? page.viewId === 338 && page.moduleId === 74 && page.menuUrl === "/pmc-stock-manager" && page.permissionUrl === "/"
      : id === 1104 && Boolean(reviewedPageBinding(page));
    if (!page.hasAccess || !reviewed) {
      throw new Error("暂无法确认数据授权范围：该业务页面尚未登记库存关联诊断映射，需维护者适配；无需用户新增角色或截图。");
    }
  }

  async open(threadId: string, context: ErpAccessContext, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    for (const key of Object.keys(args)) if (!["pagePurviewId", "itemsCode", "countryCode"].includes(key)) throw new Error(`关联诊断不接受参数 ${key}`);
    const { itemsCode, countryCode, pagePurviewId } = args;
    if (typeof itemsCode !== "string" || !codePattern.test(itemsCode) || typeof countryCode !== "string" || !/^[A-Z]{2}$/.test(countryCode) || typeof pagePurviewId !== "number") throw new Error("请指定准确品编码、国家二字码和已有权限的库存页面。");
    const entry = this.entries.get(threadId);
    if (!entry || entry.userId !== context.erpUserId || entry.expires <= Date.now()) throw authorizationUnknown("缺少本次真实业务问题，请在聊天中明确品编码、国家和库存异常");
    const codes: string[] = entry.prompt.match(/[A-Za-z0-9][A-Za-z0-9_.-]*/g) ?? [];
    if (!diagnostic.test(entry.prompt) || !/库存|在库|在途|可售|占用/.test(entry.prompt) || !codes.includes(itemsCode)) {
      throw authorizationUnknown("当前消息不是该品的库存原因排查；直接查询其他模块仍需目标页面权限");
    }
    // A case cannot be widened to a different object after opening.
    if (entry.grant && (entry.grant.itemsCode !== itemsCode || entry.grant.countryCode !== countryCode || entry.grant.pagePurviewId !== pagePurviewId)) throw new Error("关联诊断不能改换业务对象或授权来源，请发送新的具体业务问题。");
    await this.checkPage(context, pagePurviewId);
    const db = await this.database();
    const query = async (sql: string, limit = 100) => {
      const result = await db.query(this.connection, sql, limit) as { rows?: Record<string, unknown>[]; truncated?: boolean };
      if (result.truncated) throw authorizationUnknown("关联关系超过安全数量上限，需要维护者完善范围适配");
      return result.rows ?? [];
    };
    const country = (await query(`SELECT id, english, chinese FROM mc_country WHERE english = '${countryCode}' AND is_del = 0 LIMIT 2`, 2))[0];
    if (!country || !(entry.prompt.includes(String(country.chinese)) || codes.includes(countryCode))) throw authorizationUnknown("国家须与本次业务问题一致");
    const countryId = Number(country.id);
    if (!Number.isSafeInteger(countryId) || countryId <= 0) throw authorizationUnknown("国家映射异常");
    const itemScope = pagePurviewId === 1103 && context.roleIds.some(id => [81, 82].includes(id))
      ? " AND EXISTS (SELECT 1 FROM mc_spu s WHERE s.id = mc_items.spu_id AND s.is_del = 0 AND s.category_id = 10)" : "";
    const item = (await query(`SELECT id, items_code, type FROM mc_items WHERE items_code = '${itemsCode}' AND is_del = 0${itemScope} LIMIT 2`, 2));
    if (item.length !== 1) throw authorizationUnknown("未找到唯一有效品编码");
    const id = Number(item[0]!.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw authorizationUnknown("品映射异常");
    const mapping = await query(`SELECT iv.vsku_id, m.goods_id, g.sku FROM mc_items_vsku iv
      INNER JOIN mc_vsku_mapping_sku m ON m.vsku_id = iv.vsku_id AND m.is_del = 0
      INNER JOIN mc_goods g ON g.id = m.goods_id AND g.is_del = 0
      WHERE iv.items_id = ${id} AND iv.is_del = 0 ORDER BY iv.vsku_id, m.goods_id LIMIT 101`);
    const skus = [...new Set(mapping.map(row => String(row.sku)))];
    if (skus.some(sku => !codePattern.test(sku))) throw authorizationUnknown("关联SKU格式异常");
    const all = await query(`SELECT items_id, country_code, in_stock, in_fba_stock, in_cg_stock, in_wfs_stock, in_transit, in_factory, update_time
      FROM mc_items_country_summary WHERE items_id = ${id} AND country_code = '${countryCode}' LIMIT 2`, 2);
    const channels = await query(`SELECT items_id, country_code, platform_channel, real_in_stock, real_in_fba_stock, real_in_cg_online_stock, real_in_wfs_stock,
      real_in_transit, real_in_fba_transit, real_in_cg_transit, real_in_wfs_transit, update_time
      FROM mc_channel_items_country_summary WHERE items_id = ${id} AND country_code = '${countryCode}' ORDER BY platform_channel LIMIT 101`);
    entry.grant = { erpUserId: context.erpUserId, pagePurviewId, itemsCode, countryId, countryCode, skus };
    return { status: "authorized_related_inventory_diagnosis", sourcePage: pagePurviewId, item: item[0], countryId, countryCode,
      mapping, allChannelsSummary: all, channelSummary: channels,
      next: "对返回的关联SKU使用inventory_diagnose继续查stock、warehouse_reconciliation、channel_io、transfers、occupancy_summary、warehouse_io_summary、transit_allocations；无需其他模块页面或运营角色。必须传本次countryId和具体platformId。",
      notes: ["授权仅覆盖该品在该国的库存原因证据，不含成本、客户资料或无权订单明细。",
        "当前映射为直接品→VSKU→SKU关系；组合品/同款替代关系尚未展开，不能将这些SKU简单相加当作页面最大可售量，也不能因直接关联无记录断言不存在库存。",
        "汇总更新时间不等于任务运行时间；差异和时间先后不能直接证明未同步或未回收。继续核对批次及流水后再定因。"] };
  }
}
