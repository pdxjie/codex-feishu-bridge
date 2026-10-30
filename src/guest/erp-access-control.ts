import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import sqlParserPackage from "node-sql-parser";
import type { Logger } from "../logger.js";
import { authorizationUnknown, hasInventoryCapability, INVENTORY_OPERATIONS_ROLES, INVENTORY_SOURCE_FILES, type ShopScopeGroup } from "./inventory-policy.js";
import { annotatePageBinding, pageAliasIds, reservedPageTable, reviewedPageBinding } from "./page-data-bindings.js";

const { Parser } = sqlParserPackage as unknown as { Parser: new () => SqlParser };

type SqlParser = {
  tableList(sql: string, options: { database: string }): string[];
  columnList(sql: string, options: { database: string }): string[];
  astify(sql: string, options: { database: string }): unknown;
};

export type DatabaseGatewayForAccess = {
  query(name: string, sql: string, maxRows?: number): Promise<unknown>;
};

export type ErpDataScope = {
  platforms: "ALL" | number[];
  shops: "ALL" | number[];
  shopMarketplaces: "ALL" | number[];
  categories: "ALL" | number[];
  shopGroups?: ShopScopeGroup[];
  categoryScopeConfigured?: boolean;
};

export type ErpAccessContext = {
  feishuUserId: string;
  erpUserId: number;
  userName: string;
  roleIds: number[];
  roleNames: string[];
  superAdministrator: boolean;
  inventoryOperationsRole?: boolean;
  inventoryCaseSourceAccess?: boolean;
  moduleIds: number[];
  moduleNames: string[];
  purviewIds: number[];
  dataScope: ErpDataScope;
};

export type ErpPageAccess = {
  pagePurviewId: number;
  viewId: number;
  pageName: string;
  moduleId: number;
  menuUrl: string;
  permissionUrl: string;
  hasAccess: boolean;
  dataSources?: string[];
  dataAccessHint?: string;
};

export type GuestAccessGuard = {
  initialize(): Promise<void>;
  resolveUser(feishuUserId: string): Promise<ErpAccessContext>;
  bindThread(threadId: string, context: ErpAccessContext): void;
  unbindThread(threadId: string): void;
  contextForThread(threadId: string): Promise<ErpAccessContext>;
  publicProfile(context: ErpAccessContext): Record<string, unknown>;
  findPages(context: ErpAccessContext, query: string): Promise<ErpPageAccess[]>;
  authorizePage(context: ErpAccessContext, pagePurviewId: number): Promise<ErpPageAccess>;
  authorizeSql(context: ErpAccessContext, pagePurviewId: number, sql: string, operation: "query" | "export"): Promise<void>;
  authorizeTable(context: ErpAccessContext, pagePurviewId: number, table: string): Promise<void>;
  canReadProjectFile(context: ErpAccessContext, relativePath: string): boolean;
  canReadProjectPath(context: ErpAccessContext, relativePath: string): boolean;
};

type IndexedFile = { path: string; domain: string; tables: string[] };
type QueryResult = { rows?: unknown };

const DOMAIN_MODULE_IDS: Record<string, number[]> = {
  Operation: [1],
  Finances: [2],
  Statistics: [3],
  Warehousing: [4],
  SystemSettings: [5],
  UserManagement: [5],
  Logistics: [19],
  Aftersale: [20],
  Kmc: [35],
  Product: [37],
  Oa: [41],
  Purchase: [67],
  Plan: [74],
  ItemsPlan: [74],
};

const MODULE_NAMES: Record<number, string> = {
  1: "运营管理",
  2: "财务管理",
  3: "运营数据",
  4: "仓储管理",
  5: "系统设置",
  19: "物流管理",
  20: "售后管理",
  35: "品牌部管理",
  37: "产品管理",
  41: "OA审批",
  53: "人事管理",
  67: "采购管理",
  74: "计划管理",
  78: "BI看板",
};

const ALL_MODULE_IDS = Object.keys(MODULE_NAMES).map(Number);
const SUPER_ADMIN_ROLE_IDS = new Set([1, 13]);
const PURCHASE_INFO_VIEW = 252;
const SUPPLIER_INFO_VIEW = 709;
const SUPPLIER_INFO_EXPORT = 906;
const PURCHASE_INFO_EXPORT = 907;
const BLOCKED_COLUMN = /(?:password|passwd|pwd|secret|token|credential|private_key|access_key|client_secret|mobile|phone|email|address|id_card|identity|bank_account|account|payee|swift|salary|wage|wechat|qq)/i;
const PURCHASE_PRICE_COLUMN = /(?:^|_)(?:purchase_price|purchase_cost|cost_price)(?:$|_)/i;
const SUPPLIER_TABLE = /(?:^|_)(?:supplier|supplier_header|supplier_account)(?:$|_)/i;
const SHOP_SCOPED_MODULES = new Set([1, 3, 78]);
const CATEGORY_SCOPED_MODULES = new Set([1, 3, 37, 78]);

export class ErpAccessControl implements GuestAccessGuard {
  private readonly parser = new Parser();
  private readonly threadContexts = new Map<string, ErpAccessContext>();
  private readonly tableModules = new Map<string, Set<number>>();
  private readonly fileModules = new Map<string, Set<number>>();
  private readonly readablePrefixes = new Map<number, Set<string>>();
  private initialized = false;

  constructor(
    private readonly projectRoot: string,
    private readonly indexPath: string,
    private readonly database: () => Promise<DatabaseGatewayForAccess>,
    private readonly databaseConnection: string,
    private readonly logger: Logger,
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!existsSync(this.indexPath)) {
      throw new Error(`ERP 权限索引不存在，访客数据访问已默认拒绝：${this.indexPath}`);
    }
    const db = new DatabaseSync(this.indexPath, { readOnly: true });
    try {
      const rows = db
        .prepare(
          `SELECT f.path, f.domain, tr.table_name
           FROM files f
           LEFT JOIN table_refs tr ON tr.file_id = f.id
           ORDER BY f.path`,
        )
        .all() as Array<{ path: string; domain: string; table_name: string | null }>;
      const files = new Map<string, IndexedFile>();
      for (const row of rows) {
        const file = files.get(row.path) ?? { path: normalizePath(row.path), domain: row.domain, tables: [] };
        if (row.table_name) file.tables.push(normalizeTable(row.table_name));
        files.set(row.path, file);
        const directModules = DOMAIN_MODULE_IDS[row.domain] ?? [];
        if (row.table_name && directModules.length > 0) addAll(this.tableModules, normalizeTable(row.table_name), directModules);
      }

      for (const file of files.values()) {
        const modules = new Set(DOMAIN_MODULE_IDS[file.domain] ?? []);
        for (const table of file.tables) {
          for (const moduleId of this.tableModules.get(table) ?? []) modules.add(moduleId);
        }
        if (modules.size === 0) continue;
        this.fileModules.set(file.path, modules);
        for (const moduleId of modules) this.addReadablePrefixes(moduleId, file.path);
      }
      this.initialized = true;
      this.logger.info("ERP 角色权限索引已加载", {
        indexPath: this.indexPath,
        tables: this.tableModules.size,
        files: this.fileModules.size,
      });
    } finally {
      db.close();
    }
  }

  async resolveUser(feishuUserId: string): Promise<ErpAccessContext> {
    await this.initialize();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(feishuUserId)) throw denied("无法确认飞书用户身份");
    const gateway = await this.database();
    const identity = firstRow(
      await gateway.query(
        this.databaseConnection,
        `SELECT fsu.erp_user_id, u.user_name, u.role_id
         FROM mc_feishu_user fsu
         INNER JOIN mc_user u ON u.id = fsu.erp_user_id
         WHERE fsu.user_id = '${feishuUserId}'
           AND fsu.enable = 1 AND fsu.is_del = 0
           AND u.status = 0 AND u.is_del = 0
         LIMIT 2`,
        2,
      ),
    );
    if (!identity || !positiveInteger(identity.erp_user_id)) {
      throw denied("飞书账号未绑定有效的 ERP 用户，或 ERP 账号已冻结/停用");
    }
    const roleIds = parseIdList(identity.role_id);
    if (roleIds.length === 0) throw denied("ERP 用户没有配置角色");
    const superAdministrator = roleIds.some((id) => SUPER_ADMIN_ROLE_IDS.has(id));
    const roleList = roleIds.join(",");
    const metadataRows = rowsOf(
      await gateway.query(
        this.databaseConnection,
        `SELECT
           GROUP_CONCAT(DISTINCT r.role_name ORDER BY r.id SEPARATOR '||') AS role_names,
           MAX(CASE WHEN r.id IN (${INVENTORY_OPERATIONS_ROLES.join(",")}) THEN 1 ELSE 0 END) AS inventory_operations_role,
           GROUP_CONCAT(DISTINCT CASE WHEN p.type = 0 THEN p.module_id END ORDER BY p.module_id) AS module_ids,
           GROUP_CONCAT(DISTINCT CASE WHEN p.id IN (${[PURCHASE_INFO_VIEW, SUPPLIER_INFO_VIEW, SUPPLIER_INFO_EXPORT, PURCHASE_INFO_EXPORT].join(",")}) THEN p.id END ORDER BY p.id) AS sensitive_purview_ids
         FROM mc_role r
         LEFT JOIN mc_role_relate_purview rrp ON rrp.role_id = r.id
         LEFT JOIN mc_purview p ON p.id = rrp.purview_id AND p.is_del = 0
         WHERE r.id IN (${roleList}) AND r.is_del = 0`,
        2,
      ),
    )[0] ?? {};
    const moduleIds = superAdministrator ? ALL_MODULE_IDS : parseIdList(metadataRows.module_ids);
    if (moduleIds.length === 0) throw denied("ERP 角色没有任何可查看模块");
    const purviewIds = superAdministrator
      ? [PURCHASE_INFO_VIEW, SUPPLIER_INFO_VIEW, SUPPLIER_INFO_EXPORT, PURCHASE_INFO_EXPORT]
      : parseIdList(metadataRows.sensitive_purview_ids);
    const dataScope: ErpDataScope = superAdministrator
      ? { platforms: "ALL", shops: "ALL", shopMarketplaces: "ALL", categories: "ALL", shopGroups: [{ platform: 0, shop: 0, marketplace: 0 }], categoryScopeConfigured: true }
      : await this.loadDataScope(gateway, roleIds);
    const context: ErpAccessContext = {
      feishuUserId,
      erpUserId: Number(identity.erp_user_id),
      userName: String(identity.user_name ?? "ERP用户"),
      roleIds,
      roleNames: String(metadataRows.role_names ?? "").split("||").map((name) => name.trim()).filter(Boolean),
      superAdministrator,
      inventoryOperationsRole: Number(metadataRows.inventory_operations_role) === 1,
      moduleIds,
      moduleNames: moduleIds.map((id) => MODULE_NAMES[id]).filter((name): name is string => Boolean(name)),
      purviewIds,
      dataScope,
    };
    this.logger.info("飞书用户 ERP 权限已确认", {
      erpUserId: context.erpUserId,
      moduleIds: context.moduleIds,
      dataScope: scopeSummary(context.dataScope),
    });
    return context;
  }

  bindThread(threadId: string, context: ErpAccessContext): void {
    this.threadContexts.set(threadId, context);
  }

  unbindThread(threadId: string): void {
    this.threadContexts.delete(threadId);
  }

  async contextForThread(threadId: string): Promise<ErpAccessContext> {
    const context = this.threadContexts.get(threadId);
    if (!context) throw denied("当前会话没有经过 ERP 身份授权");
    const refreshed = await this.resolveUser(context.feishuUserId);
    this.threadContexts.set(threadId, refreshed);
    return refreshed;
  }

  publicProfile(context: ErpAccessContext): Record<string, unknown> {
    return {
      erpUserId: context.erpUserId,
      userName: context.userName,
      roles: context.roleNames,
      accessibleModules: context.moduleNames,
      dataScope: scopeSummary(context.dataScope),
      businessCapabilities: hasInventoryCapability(context) ? [{
        name: "inventory_diagnosis", tool: "inventory_diagnose",
        directions: ["渠道库存", "渠道IO", "历史扣减订单追溯", "调拨", "订单占用", "仓储库存核对", "仓储IO汇总", "在途分配与释放"],
        scope: "已有角色授予；渠道/国家来自已有店铺站点范围，订单明细另校验店铺站点。共享库存证据不含价格、客户资料或其他渠道全量数据。",
      }] : [],
      relatedDiagnosis: { tool: "inventory_case_open", basis: "库存原因排查可按已有品库存页面权限授权同品同国的关联证据，不要求运营角色或关联模块页面权限；直接查询其他模块仍校验目标页面。" },
      enforcement: "直接查询已授权页面的数据不要求 inventory_diagnosis 能力；按页面 dataSources/dataAccessHint 取数。库存联合排查另走 inventory_diagnose。页面搜索未匹配不等于无权；已明确页面却缺少数据映射属于桥接适配问题，不要求用户截图或新增角色。只有业务方向本身不清楚时才请用户补充。",
    };
  }

  async findPages(context: ErpAccessContext, query: string): Promise<ErpPageAccess[]> {
    const keyword = query.trim();
    if (!keyword || keyword.length > 80 || !/^[\p{L}\p{N}\s_\-/()（）]+$/u.test(keyword)) {
      throw new Error("页面关键词只能包含文字、数字、空格、括号、下划线、斜杠或短横线。");
    }
    const escaped = escapeSqlLiteral(keyword);
    const aliasIds = pageAliasIds(keyword);
    const roleList = context.roleIds.join(",");
    const accessSql = context.superAdministrator
      ? "1"
      : `EXISTS (
           SELECT 1 FROM mc_role_relate_purview page_rrp
           WHERE page_rrp.purview_id = p.id AND page_rrp.role_id IN (${roleList})
         )`;
    const rows = rowsOf(
      await (await this.database()).query(
        this.databaseConnection,
        `SELECT p.id AS page_purview_id, p.view_id,
                COALESCE(NULLIF(v.view_name, ''), p.purview_name) AS page_name,
                p.module_id, COALESCE(v.menu_url, '') AS menu_url,
                p.url AS permission_url,
                ${accessSql} AS has_access
         FROM mc_purview p
         LEFT JOIN mc_view v ON v.id = p.view_id AND v.is_del = 0
         WHERE p.type = 0 AND p.is_del = 0
           AND (COALESCE(v.view_name, '') LIKE '%${escaped}%'
             OR p.purview_name LIKE '%${escaped}%'
             OR COALESCE(v.menu_url, '') LIKE '%${escaped}%'
             OR p.url LIKE '%${escaped}%'${aliasIds.length ? ` OR p.id IN (${aliasIds.join(",")})` : ""})
         ORDER BY CASE WHEN COALESCE(v.view_name, '') = '${escaped}' THEN 0 ELSE 1 END,
                  p.id
         LIMIT 20`,
        20,
      ),
    );
    return rows.map(pageAccessFromRow).filter((page): page is ErpPageAccess => page !== null).map(annotatePageBinding);
  }

  async authorizePage(context: ErpAccessContext, pagePurviewId: number): Promise<ErpPageAccess> {
    if (!positiveInteger(pagePurviewId)) throw pageDenied("未指定有效的 ERP 页面权限");
    const roleList = context.roleIds.join(",");
    const accessSql = context.superAdministrator
      ? "1"
      : `EXISTS (
           SELECT 1 FROM mc_role_relate_purview page_rrp
           WHERE page_rrp.purview_id = p.id AND page_rrp.role_id IN (${roleList})
         )`;
    const row = firstRow(
      await (await this.database()).query(
        this.databaseConnection,
        `SELECT p.id AS page_purview_id, p.view_id,
                COALESCE(NULLIF(v.view_name, ''), p.purview_name) AS page_name,
                p.module_id, COALESCE(v.menu_url, '') AS menu_url,
                p.url AS permission_url,
                ${accessSql} AS has_access
         FROM mc_purview p
         LEFT JOIN mc_view v ON v.id = p.view_id AND v.is_del = 0
         WHERE p.id = ${Number(pagePurviewId)} AND p.type = 0 AND p.is_del = 0
         LIMIT 1`,
        1,
      ),
    );
    const page = row ? pageAccessFromRow(row) : null;
    if (!page) throw authorizationUnknown("无法确认对应的 ERP 页面");
    if (!page.hasAccess) throw pageDenied(`当前 ERP 用户没有“${page.pageName}”页面权限`);
    return annotatePageBinding(page);
  }

  async authorizeSql(
    context: ErpAccessContext,
    pagePurviewId: number,
    sql: string,
    operation: "query" | "export",
  ): Promise<void> {
    const page = await this.authorizePage(context, pagePurviewId);
    const parsed = this.parseSql(sql);
    if (parsed.hasWildcard) throw denied("禁止 SELECT *；必须只选择本次排查必需的字段");
    if (parsed.tables.length === 0) return;
    const binding = reviewedPageBinding(page);
    const touchedModules = new Set<number>();
    for (const table of parsed.tables) {
      const allowed = this.authorizeTableForPage(page, table);
      for (const moduleId of allowed) touchedModules.add(moduleId);
    }
    for (const column of parsed.columns) {
      if (binding && !binding.columns.has(column)) throw authorizationUnknown(`“${page.pageName}”尚未登记字段 ${column}，不能借页面授权读取其他业务字段`);
      if (BLOCKED_COLUMN.test(column)) throw denied("查询包含 ERP 明确保护的个人信息或凭据字段");
      if (PURCHASE_PRICE_COLUMN.test(column)) {
        const required = operation === "export" ? PURCHASE_INFO_EXPORT : PURCHASE_INFO_VIEW;
        if (!context.purviewIds.includes(required)) throw denied(operation === "export" ? "没有采购价导出权限" : "没有采购价查看权限");
      }
    }
    if (parsed.tables.some((table) => SUPPLIER_TABLE.test(table))) {
      const required = operation === "export" ? SUPPLIER_INFO_EXPORT : SUPPLIER_INFO_VIEW;
      if (!context.purviewIds.includes(required)) throw denied(operation === "export" ? "没有供应商信息导出权限" : "没有供应商信息查看权限");
    }
    this.enforceDataScope(context, parsed, touchedModules);
  }

  async authorizeTable(context: ErpAccessContext, pagePurviewId: number, table: string): Promise<void> {
    const page = await this.authorizePage(context, pagePurviewId);
    this.authorizeTableForPage(page, normalizeTable(table));
  }

  canReadProjectFile(context: ErpAccessContext, relativePath: string): boolean {
    if ((hasInventoryCapability(context) || context.inventoryCaseSourceAccess) && INVENTORY_SOURCE_FILES.has(normalizePath(relativePath))) return true;
    const modules = this.fileModules.get(normalizePath(relativePath));
    return Boolean(modules && [...modules].some((moduleId) => context.moduleIds.includes(moduleId)));
  }

  canReadProjectPath(context: ErpAccessContext, relativePath: string): boolean {
    const normalized = normalizePath(relativePath).replace(/^\.\/?/, "").replace(/\/$/, "");
    if (!normalized) return true;
    if ((hasInventoryCapability(context) || context.inventoryCaseSourceAccess) && [...INVENTORY_SOURCE_FILES].some((file) => file.startsWith(`${normalized}/`))) return true;
    return context.moduleIds.some((moduleId) => this.readablePrefixes.get(moduleId)?.has(normalized));
  }

  private authorizeTableForPage(page: ErpPageAccess, table: string): number[] {
    const normalized = normalizeTable(table);
    const binding = reviewedPageBinding(page);
    if (binding) {
      if (!binding.tables.includes(normalized)) throw authorizationUnknown(`“${page.pageName}”与数据表 ${normalized} 的业务映射不匹配；页面授权不等于整个计划或仓储模块授权`);
      return [page.moduleId];
    }
    if (reservedPageTable(normalized)) throw authorizationUnknown(`数据表 ${normalized} 需使用已核验的分渠道品库存页面授权（1104），不能借用其他页面`);
    const tableModules = [...(this.tableModules.get(normalized) ?? [])];
    if (tableModules.length === 0) throw authorizationUnknown(`无法将数据表 ${normalized} 安全归属到 ERP 页面`);
    const pageModules = pageModuleIds(page);
    const authorized = tableModules.filter((moduleId) => pageModules.has(moduleId));
    if (authorized.length === 0) {
      throw new Error(`暂无法确认数据授权范围：“${page.pageName}”页面与数据表 ${normalized} 的业务映射不匹配。页面权限已通过，这是桥接数据适配缺失，需要维护者核对真实调用链；不是用户缺少权限，不要求截图或重复补充已明确的业务方向。`);
    }
    return authorized;
  }

  private parseSql(sql: string): ParsedSql {
    let ast: unknown;
    let rawTables: string[];
    let rawColumns: string[];
    try {
      ast = this.parser.astify(sql, { database: "MySQL" });
      rawTables = this.parser.tableList(sql, { database: "MySQL" });
      rawColumns = this.parser.columnList(sql, { database: "MySQL" });
    } catch {
      throw denied("SQL 无法进行可靠的权限分析");
    }
    if (Array.isArray(ast) || !isRecord(ast) || (ast.type !== "select" && !Array.isArray(ast.with))) {
      throw denied("只允许可进行权限分析的单条 SELECT/CTE 查询");
    }
    const cteNames = collectCteNames(ast);
    const tables = [...new Set(rawTables.map(tableListName).map(normalizeTable).filter((table) => table && !cteNames.has(table)))];
    const hasWildcard = rawColumns.some((column) => column.split("::").at(-1)?.includes("*"));
    const columns = [...new Set(rawColumns.map(columnListName).filter(Boolean))];
    const where = isRecord(ast) ? ast.where : null;
    return { ast, tables, columns, where, hasWildcard };
  }

  private enforceDataScope(context: ErpAccessContext, parsed: ParsedSql, modules: Set<number>): void {
    const appliesShopScope = [...modules].some((id) => SHOP_SCOPED_MODULES.has(id));
    if (appliesShopScope) {
      this.requireScope(parsed.where, "platform_type", context.dataScope.platforms, "平台");
      this.requireScope(parsed.where, "shop_id", context.dataScope.shops, "店铺");
      this.requireScope(parsed.where, "shop_marketplace_id", context.dataScope.shopMarketplaces, "店铺站点");
    }
    const appliesCategoryScope = [...modules].some((id) => CATEGORY_SCOPED_MODULES.has(id));
    if (appliesCategoryScope && context.dataScope.categoryScopeConfigured !== false) this.requireScope(parsed.where, "category_id", context.dataScope.categories, "品类");
  }

  private requireScope(where: unknown, column: string, scope: "ALL" | number[], label: string): void {
    if (scope === "ALL") return;
    if (scope.length === 0) throw authorizationUnknown(`没有可核验的${label}数据范围`);
    if (!conditionGuaranteesAllowed(where, column, new Set(scope))) {
      throw denied(`当前 ERP 角色仅可访问指定${label}，查询必须使用 ${column} 明确限制在本人数据范围内`);
    }
  }

  private async loadDataScope(gateway: DatabaseGatewayForAccess, roleIds: number[]): Promise<ErpDataScope> {
    const scopeResult = await gateway.query(
        this.databaseConnection,
        `SELECT scope_type, scope_level1, scope_level2, scope_level3, scope_value
         FROM mc_role_data_scope WHERE role_id IN (${roleIds.join(",")})`,
        10000,
      );
    if (isRecord(scopeResult) && scopeResult.truncated) throw authorizationUnknown("ERP 数据范围读取不完整");
    const result: ErpDataScope = { platforms: [], shops: [], shopMarketplaces: [], categories: [], shopGroups: [], categoryScopeConfigured: false };
    for (const row of rowsOf(scopeResult)) {
      if (row.scope_type === "shop_group") {
        if ([row.scope_level1, row.scope_level2, row.scope_level3].some((value) => value === null || value === "" || value === undefined)) {
          throw authorizationUnknown("ERP 店铺授权记录缺少层级值");
        }
        const [platform, shop, marketplace] = [row.scope_level1, row.scope_level2, row.scope_level3].map(Number);
        if (![platform, shop, marketplace].every((id) => Number.isSafeInteger(id))) throw authorizationUnknown("ERP 店铺授权记录异常");
        // ERP uses negative IDs for invalid selections, and 0 for all descendants.
        if (platform! < 0 || (platform! > 0 && shop! < 0) || (platform! > 0 && shop! > 0 && marketplace! < 0)) continue;
        result.shopGroups!.push({ platform: platform!, shop: platform === 0 ? 0 : shop!, marketplace: platform === 0 || shop === 0 ? 0 : marketplace! });
      } else if (row.scope_type === "category") {
        result.categoryScopeConfigured = true;
        if (row.scope_value === null || row.scope_value === "" || row.scope_value === undefined) throw authorizationUnknown("ERP 品类授权记录缺少值");
        const category = Number(row.scope_value);
        if (!Number.isSafeInteger(category)) throw authorizationUnknown("ERP 品类授权记录异常");
        if (category === 0) result.categories = "ALL";
        else if (category > 0 && result.categories !== "ALL") result.categories.push(category);
      }
    }
    if (result.shopGroups!.some((group) => group.platform === 0)) {
      result.platforms = result.shops = result.shopMarketplaces = "ALL";
    } else if (result.shopGroups!.length) {
      result.platforms = uniquePositive(result.shopGroups!.map((group) => group.platform));
      const conditions = result.shopGroups!.map((g) => `(s.platform_type = ${g.platform}${g.shop ? ` AND s.id = ${g.shop}${g.marketplace ? ` AND sm.id = ${g.marketplace}` : ""}` : ""})`).join(" OR ");
      const expanded = await gateway.query(this.databaseConnection,
        `SELECT s.id AS shop_id, sm.id AS marketplace_id FROM mc_shop s
         LEFT JOIN mc_shop_marketplace sm ON sm.shop_id = s.id AND sm.is_del = 0
         WHERE s.is_del = 0 AND (${conditions})`, 10000);
      if (isRecord(expanded) && expanded.truncated) throw authorizationUnknown("ERP 店铺站点范围读取不完整");
      result.shops = uniquePositive(rowsOf(expanded).map((row) => Number(row.shop_id)));
      result.shopMarketplaces = uniquePositive(rowsOf(expanded).map((row) => Number(row.marketplace_id)));
    }
    return result;
  }

  private addReadablePrefixes(moduleId: number, filePath: string): void {
    const prefixes = this.readablePrefixes.get(moduleId) ?? new Set<string>();
    let current = normalizePath(filePath);
    prefixes.add(current);
    while (current.includes("/")) {
      current = current.slice(0, current.lastIndexOf("/"));
      if (current) prefixes.add(current);
    }
    this.readablePrefixes.set(moduleId, prefixes);
  }
}

type ParsedSql = { ast: unknown; tables: string[]; columns: string[]; where: unknown; hasWildcard: boolean };

function conditionGuaranteesAllowed(node: unknown, column: string, allowed: Set<number>): boolean {
  if (!isRecord(node)) return false;
  if (node.type === "binary_expr") {
    const operator = String(node.operator ?? "").toUpperCase();
    if (operator === "AND") {
      return conditionGuaranteesAllowed(node.left, column, allowed) || conditionGuaranteesAllowed(node.right, column, allowed);
    }
    if (operator === "OR") {
      return conditionGuaranteesAllowed(node.left, column, allowed) && conditionGuaranteesAllowed(node.right, column, allowed);
    }
    if ((operator === "=" || operator === "IN") && columnReference(node.left) === column) {
      const values = literalNumbers(node.right);
      return values.length > 0 && values.every((value) => allowed.has(value));
    }
    if (operator === "=" && columnReference(node.right) === column) {
      const values = literalNumbers(node.left);
      return values.length === 1 && allowed.has(values[0]!);
    }
  }
  if (node.type === "unary_expr" && String(node.operator ?? "").toUpperCase() !== "NOT") {
    return conditionGuaranteesAllowed(node.expr, column, allowed);
  }
  return false;
}

function columnReference(value: unknown): string | null {
  return isRecord(value) && value.type === "column_ref" && typeof value.column === "string"
    ? value.column.toLowerCase()
    : null;
}

function literalNumbers(value: unknown): number[] {
  if (!isRecord(value)) return [];
  if (value.type === "number" && Number.isFinite(Number(value.value))) return [Number(value.value)];
  if (value.type === "string" && /^\d+$/.test(String(value.value))) return [Number(value.value)];
  if (value.type === "expr_list" && Array.isArray(value.value)) return value.value.flatMap(literalNumbers);
  return [];
}

function collectCteNames(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectCteNames(entry, output);
    return output;
  }
  if (!isRecord(value)) return output;
  if (Array.isArray(value.with)) {
    for (const entry of value.with) {
      if (isRecord(entry) && isRecord(entry.name) && typeof entry.name.value === "string") output.add(normalizeTable(entry.name.value));
    }
  }
  for (const child of Object.values(value)) collectCteNames(child, output);
  return output;
}

function tableListName(value: string): string {
  return value.split("::").at(-1) ?? "";
}

function columnListName(value: string): string {
  return (value.split("::").at(-1) ?? "").replace(/[()`*]/g, "").trim().toLowerCase();
}

function normalizeTable(value: string): string {
  return value.replace(/^[`'\"]|[`'\"]$/g, "").split(".").at(-1)!.replace(/^mc_/, "").toLowerCase();
}

function normalizePath(value: string): string {
  return value.split(sep).join("/").replace(/^\.\//, "");
}

function addAll(map: Map<string, Set<number>>, key: string, values: number[]): void {
  const current = map.get(key) ?? new Set<number>();
  for (const value of values) current.add(value);
  map.set(key, current);
}

function rowsOf(value: unknown): Array<Record<string, unknown>> {
  if (!isRecord(value)) return [];
  const rows = (value as QueryResult).rows;
  return Array.isArray(rows) ? rows.filter(isRecord) : [];
}

function firstRow(value: unknown): Record<string, unknown> | null {
  const rows = rowsOf(value);
  if (rows.length !== 1) return null;
  return rows[0]!;
}

function parseIdList(value: unknown): number[] {
  const values = Array.isArray(value) ? value : String(value ?? "").split(",");
  return uniquePositive(values.map(Number));
}

function pageAccessFromRow(row: Record<string, unknown>): ErpPageAccess | null {
  if (!positiveInteger(row.page_purview_id) || !positiveInteger(row.view_id) || !positiveInteger(row.module_id)) return null;
  return {
    pagePurviewId: Number(row.page_purview_id),
    viewId: Number(row.view_id),
    pageName: String(row.page_name ?? "ERP页面"),
    moduleId: Number(row.module_id),
    menuUrl: String(row.menu_url ?? ""),
    permissionUrl: String(row.permission_url ?? ""),
    hasAccess: Number(row.has_access) === 1,
  };
}

function pageModuleIds(page: ErpPageAccess): Set<number> {
  const modules = new Set<number>([page.moduleId]);
  const routeDomain = page.permissionUrl.split("/").filter(Boolean)[0]?.toLowerCase();
  if (!routeDomain) return modules;
  for (const [domain, moduleIds] of Object.entries(DOMAIN_MODULE_IDS)) {
    if (domain.toLowerCase() === routeDomain) {
      for (const moduleId of moduleIds) modules.add(moduleId);
      break;
    }
  }
  return modules;
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "''");
}

function uniquePositive(values: Array<number | undefined>): number[] {
  return [...new Set(values.filter((value): value is number => Number.isInteger(value) && Number(value) > 0).map(Number))];
}

function positiveInteger(value: unknown): boolean {
  return Number.isInteger(Number(value)) && Number(value) > 0;
}

function scopeSummary(scope: ErpDataScope): Record<string, string | number> {
  const summarize = (value: "ALL" | number[]) => (value === "ALL" ? "全部" : value.length === 0 ? "未确认授权范围" : `${value.length} 项`);
  return {
    platforms: summarize(scope.platforms),
    shops: summarize(scope.shops),
    shopMarketplaces: summarize(scope.shopMarketplaces),
    categories: scope.categoryScopeConfigured === false ? "ERP未配置品类限制；仍按业务的店铺/渠道授权" : summarize(scope.categories),
  };
}

function denied(reason: string): Error {
  return new Error(`无权访问：${reason}`);
}

function pageDenied(reason: string): Error {
  return new Error(`权限不足：${reason}`);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function defaultErpAccessIndexPath(databaseGatewayPath: string): string {
  return resolve(dirname(databaseGatewayPath), "../../..", ".codex", "knowledge", "index.sqlite");
}
