import { execFile } from "node:child_process";
import { accessSync, constants, promises as fs, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { DynamicToolCall, DynamicToolResult, DynamicToolSpec } from "../codex/client.js";
import type { Logger } from "../logger.js";
import {
  defaultErpAccessIndexPath,
  ErpAccessControl,
  type ErpAccessContext,
  type GuestAccessGuard,
} from "./erp-access-control.js";
import { GuestExportManager, type GuestExportFile, type GuestExportFormat } from "./export-files.js";
import { compileInventoryQuery, INVENTORY_DATASETS } from "./inventory-diagnostics.js";
import { InventoryCases } from "./inventory-case.js";
import { NativeExportManager } from "./native-export.js";
import type { NativeExportConfig } from "./native-export-protocol.js";

const execFileAsync = promisify(execFile);
const MAX_TOOL_OUTPUT = 48_000;
const BLOCKED_PATH = /(^|\/)(?:\.git|\.env[^/]*|auth\.json|connections\.json|id_[a-z0-9_-]+|[^/]*\.(?:pem|key|p12|pfx))(?:\/|$)/i;
const ALLOWED_FILE = /\.(?:php|js|mjs|cjs|ts|tsx|vue|md|sql|json|ya?ml|xml|ini|conf|txt)$/i;

type DatabaseGatewayLike = {
  profile(name: string): { environment: string; mode: string };
  listConnections(): Array<Record<string, unknown>>;
  describeTable(name: string, table: string): Promise<unknown>;
  explain(name: string, sql: string): Promise<unknown>;
  query(name: string, sql: string, maxRows?: number): Promise<unknown>;
};

type DatabaseQueryResult = {
  rows?: unknown;
  rowCount?: unknown;
  truncated?: unknown;
  maxRows?: unknown;
};

export class GuestReadonlyTools {
  private databasePromise: Promise<DatabaseGatewayLike> | null = null;
  private readonly projectRoot: string;
  private readonly ripgrepPath: string;
  private readonly exports: GuestExportManager;
  private readonly access: GuestAccessGuard;
  private readonly nativeExports: NativeExportManager;
  private readonly inventoryCases: InventoryCases;

  constructor(
    projectRoot: string,
    private readonly databaseConfigPath: string,
    private readonly databaseConnection: string,
    private readonly logger: Logger,
    private readonly databaseGatewayPath = join(projectRoot, "tools", "mc-kb", "src", "database-gateway.js"),
    exportRoot = join(projectRoot, ".codex-feishu-exports"),
    private readonly exportMaxRows = 10_000,
    accessIndexPath?: string,
    accessGuard?: GuestAccessGuard,
    nativeExportConfig?: NativeExportConfig,
  ) {
    this.projectRoot = realpathSync(projectRoot);
    this.ripgrepPath = resolveRipgrepBinary();
    this.exports = new GuestExportManager(exportRoot, exportMaxRows, logger);
    this.nativeExports = new NativeExportManager(join(exportRoot, "native-jobs"), nativeExportConfig, logger);
    this.access =
      accessGuard ??
      new ErpAccessControl(
        this.projectRoot,
        accessIndexPath || defaultErpAccessIndexPath(this.databaseGatewayPath),
        () => this.database(),
        this.databaseConnection,
        logger,
      );
    this.inventoryCases = new InventoryCases(this.access, () => this.database(), this.databaseConnection);
  }

  async initialize(): Promise<void> {
    await Promise.all([this.exports.initialize(), this.access.initialize(), this.nativeExports.initialize()]);
  }

  resolveUserAccess(feishuUserId: string): Promise<ErpAccessContext> {
    return this.access.resolveUser(feishuUserId);
  }

  bindThreadAccess(threadId: string, context: ErpAccessContext): void {
    this.access.bindThread(threadId, context);
  }

  bindGuestPrompt(threadId: string, context: ErpAccessContext, prompt: string, previousThreadId?: string): void {
    this.inventoryCases.bindPrompt(threadId, context, prompt, previousThreadId);
  }

  takeExportFiles(turnId: string): GuestExportFile[] {
    return [...this.exports.takeFiles(turnId), ...this.nativeExports.takeFiles(turnId)];
  }

  async removeExportFiles(files: GuestExportFile[]): Promise<void> {
    await this.nativeExports.removeSentFiles(files);
    await this.exports.removeFiles(files);
  }

  async authorizeExportDelivery(file: GuestExportFile): Promise<void> {
    await this.nativeExports.authorizeDelivery(file);
  }

  specs(): DynamicToolSpec[] {
    return [
      tool("erp_export_catalog", "查看已接入ERP原生导出的业务、筛选条件、字段与服务是否就绪。用户明确要求标准业务导出时先调用；未接入不代表ERP本身没有该功能。", {}),
      tool("erp_native_export_file", "通过服务认证调用ERP原有导出逻辑，生成真实Excel并在结束后发送当前飞书聊天。无需用户登录。ERP校验本人页面、导出和数据权限。仅明确要求导出时使用；固定执行脚本，不接受URL、SQL、代码或身份。先从erp_export_catalog确认准确匹配。", {
        kind: { type: "string", enum: ["channel_stock", "purchase_orders"] },
        filters: { type: "object", additionalProperties: false, properties: {
          sku: { type: "string" }, platformId: { type: "integer", minimum: 1 }, countryId: { type: "integer", minimum: 1 }, storehouseId: { type: "integer", minimum: 1 },
          startDate: { type: "string" }, endDate: { type: "string" }, fields: { type: "array", items: { type: "string" } },
        } },
      }, ["kind", "filters"]),
      tool("erp_access_profile", "查看当前飞书用户映射到 ERP 后的角色、可访问模块与数据范围。首次排查应先调用。", {}),
      tool("erp_page_access", "按关键词搜索页面候选。已登记页面返回dataSources和dataAccessHint：直接查询该页面无需库存联合诊断角色。只有目标页面匹配且hasAccess=false才判无权；已授权却映射失败是桥接适配问题，不能要求用户截图或开权限。库存联合排查另走inventory_diagnose。", {
        query: { type: "string", minLength: 1, maxLength: 80 },
      }, ["query"]),
      tool("inventory_case_open", "库存异常或原因排查先用此工具：以有权限的分渠道/全渠道品库存页面1104/1103为业务依据，核验真实聊天问题、品编码和国家，返回品SKU映射、两页库存组成和更新时间，并授权该品该国的批次/IO/调拨/占用等关联证据。无需运营角色或仓储页面权限。直接索要无权模块数据不能使用。", {
        pagePurviewId: pagePurviewIdSchema(), itemsCode: { type: "string" }, countryCode: { type: "string", description: "问题中的国家二字码，例如CA、US" },
      }, ["pagePurviewId", "itemsCode", "countryCode"]),
      tool("inventory_diagnose", "受控库存联合排查：已有运营角色按店铺范围，或inventory_case_open已核验的品/国家关系授权；不要求关联模块页面权限。支持渠道库存、IO、调拨、订单占用、仓储数量核对/IO汇总、在途分配。只接受业务过滤条件，不接受 SQL。明确 SKU 和渠道；历史数据必须给出日期，当前占用不按日期截断。平台 ID：亚马逊1、Wayfair3、Walmart6、eBay7、VC16、Walmart DSV17、Temu20、TikTok21；其他渠道先读 PlatformConstant。", inventoryProperties(), ["dataset", "sku"]),
      tool("inventory_export_file", "仅用户明确要求导出时使用；导出与 inventory_diagnose 相同授权、字段与关联范围的排查证据，不允许导出任意模块或用户拼接的数据。机器人会在任务结束后发送文件。", {
        ...inventoryProperties(this.exportMaxRows),
        title: { type: "string", minLength: 1, maxLength: 120 },
        fileName: { type: "string", minLength: 1, maxLength: 120 },
        format: { type: "string", enum: ["xlsx", "csv", "docx"], default: "xlsx" },
      }, ["dataset", "sku", "title", "fileName"]),
      tool("database_list_connections", "确认当前访客允许使用的只读数据库连接及环境。不会返回主机、账号或密码。", {}),
      tool("project_search", "在指定 ERP 项目源码内搜索文本或符号。只返回匹配文件和行号。", {
        query: { type: "string", minLength: 2, maxLength: 200 },
        maxResults: { type: "integer", minimum: 1, maximum: 200, default: 80 },
      }, ["query"]),
      tool("project_read_file", "读取指定 ERP 项目内的一个源码文件片段。敏感文件和项目外路径会被拒绝。", {
        path: { type: "string", minLength: 1, maxLength: 500 },
        startLine: { type: "integer", minimum: 1, default: 1 },
        endLine: { type: "integer", minimum: 1, default: 240 },
      }, ["path"]),
      tool("project_list_directory", "列出指定 ERP 项目内的目录内容。", {
        path: { type: "string", maxLength: 500, default: "." },
      }),
      tool("database_describe_table", "读取生产只读数据库中的表结构和索引。", {
        pagePurviewId: pagePurviewIdSchema(),
        table: { type: "string", pattern: "^[A-Za-z0-9_]+$" },
      }, ["pagePurviewId", "table"]),
      tool("database_explain", "对单条 SELECT 查询执行 EXPLAIN。写语句会被拒绝。", {
        pagePurviewId: pagePurviewIdSchema(),
        sql: { type: "string", minLength: 6, maxLength: 20_000 },
      }, ["pagePurviewId", "sql"]),
      tool("database_query", "执行一条经过目标 ERP 页面权限、敏感字段和数据范围校验的生产只读 SELECT/CTE 查询。", {
        pagePurviewId: pagePurviewIdSchema(),
        sql: { type: "string", minLength: 4, maxLength: 20_000 },
        maxRows: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      }, ["pagePurviewId", "sql"]),
      tool("database_export_file", "执行一条受保护的生产只读查询，并把脱敏结果生成 Excel、CSV 或 Word 文件。仅当用户明确要求导出时调用；文件会在任务结束后由机器人发送到当前飞书聊天。", {
        pagePurviewId: pagePurviewIdSchema(),
        sql: { type: "string", minLength: 4, maxLength: 20_000 },
        title: { type: "string", minLength: 1, maxLength: 120 },
        fileName: { type: "string", minLength: 1, maxLength: 120 },
        format: { type: "string", enum: ["xlsx", "csv", "docx"], default: "xlsx" },
        maxRows: { type: "integer", minimum: 1, maximum: this.exportMaxRows, default: this.exportMaxRows },
        columnLabels: { type: "object", additionalProperties: { type: "string" } },
      }, ["pagePurviewId", "sql", "title", "fileName"]),
      tool("export_table_file", "把本次排查中已经得到的结构化结果生成 Excel、CSV 或 Word 文件。不能读取本机文件；仅当用户明确要求导出时调用。", {
        pagePurviewId: pagePurviewIdSchema(),
        title: { type: "string", minLength: 1, maxLength: 120 },
        fileName: { type: "string", minLength: 1, maxLength: 120 },
        format: { type: "string", enum: ["xlsx", "csv", "docx"], default: "xlsx" },
        rows: {
          type: "array",
          minItems: 1,
          maxItems: this.exportMaxRows,
          items: { type: "object", additionalProperties: true },
        },
        columnLabels: { type: "object", additionalProperties: { type: "string" } },
      }, ["pagePurviewId", "title", "fileName", "rows"]),
    ];
  }

  async handle(call: DynamicToolCall): Promise<DynamicToolResult> {
    const args = isRecord(call.arguments) ? call.arguments : {};
    const accessContext = { ...await this.access.contextForThread(call.threadId), inventoryCaseSourceAccess: false };
    // Source-code exceptions are limited to reviewed files and recheck source permissions.
    const relatedCase = await this.inventoryCases.current(call.threadId, accessContext);
    if (relatedCase) accessContext.inventoryCaseSourceAccess = true;
    this.logger.info("访客只读工具调用", { threadId: call.threadId, turnId: call.turnId, tool: call.tool });
    let value: unknown;
    switch (call.tool) {
      case "erp_export_catalog":
        value = this.nativeExports.catalog();
        break;
      case "erp_native_export_file": {
        const file = await this.nativeExports.create(call, accessContext, args);
        value = { status: "created", source: "ERP原生导出", fileName: file.fileName, rowCount: file.rowCount,
          message: "已取得ERP导出文件，任务结束后机器人发送到当前飞书聊天。" };
        break;
      }
      case "erp_access_profile":
        value = { ...this.access.publicProfile(accessContext), activeRelatedDiagnosis: relatedCase ?? null };
        break;
      case "erp_page_access": {
        const candidates = await this.access.findPages(accessContext, requiredString(args.query, "query"));
        value = {
          status: candidates.length ? "candidates_require_business_match" : "authorization_scope_unconfirmed",
          candidates,
          message: "搜索结果是页面候选。匹配且hasAccess=true时按dataSources/dataAccessHint查询，不额外要求库存联合诊断角色；只有明确目标页面无权才拒绝。已授权页面的数据映射失败应由维护者处理，不能转为要求用户截图或补开权限。",
        };
        break;
      }
      case "inventory_case_open":
        value = await this.inventoryCases.open(call.threadId, accessContext, args);
        break;
      case "inventory_diagnose":
      case "inventory_export_file": {
        const exporting = call.tool === "inventory_export_file";
        const maxRows = boundedInteger(args.maxRows, exporting ? this.exportMaxRows : 50, 1, exporting ? this.exportMaxRows : 100);
        const query = compileInventoryQuery(accessContext, args, maxRows, relatedCase);
        this.logger.info("库存联合排查授权", {
          threadId: call.threadId, erpUserId: accessContext.erpUserId,
          capability: relatedCase ? "inventory_related_case" : "inventory_diagnosis",
          sourcePage: relatedCase?.pagePurviewId, itemsCode: relatedCase?.itemsCode, countryId: relatedCase?.countryId,
          dataset: query.dataset, platformId: query.platformId, exporting,
        });
        const result = await (await this.database()).query(this.databaseConnection, query.sql, maxRows) as DatabaseQueryResult;
        if (!exporting) {
          value = { dataset: query.dataset, rows: result.rows, rowCount: result.rowCount, truncated: result.truncated, notes: query.notes };
        } else {
          const file = await this.exports.create({
            turnId: call.turnId, title: requiredString(args.title, "title"),
            fileName: requiredString(args.fileName, "fileName"), format: exportFormat(args.format), rows: recordRows(result.rows),
          });
          value = { status: "created", fileName: file.fileName, rowCount: file.rowCount, sourceTruncated: Boolean(result.truncated), notes: query.notes,
            message: "排查证据文件已生成，任务结束后机器人发送到当前飞书聊天。" };
        }
        break;
      }
      case "database_list_connections": {
        const gateway = await this.database();
        const profile = gateway.profile(this.databaseConnection);
        value = [{ name: this.databaseConnection, environment: profile.environment, mode: profile.mode }];
        break;
      }
      case "project_search":
        value = await this.search(
          accessContext,
          requiredString(args.query, "query"),
          boundedInteger(args.maxResults, 80, 1, 200),
        );
        break;
      case "project_read_file":
        value = await this.readFile(
          accessContext,
          requiredString(args.path, "path"),
          boundedInteger(args.startLine, 1, 1, 1_000_000),
          boundedInteger(args.endLine, 240, 1, 1_000_000),
        );
        break;
      case "project_list_directory":
        value = await this.listDirectory(accessContext, optionalString(args.path) || ".");
        break;
      case "database_describe_table": {
        const table = requiredString(args.table, "table");
        await this.access.authorizeTable(accessContext, requiredPositiveInteger(args.pagePurviewId, "pagePurviewId"), table);
        value = await (await this.database()).describeTable(this.databaseConnection, table);
        break;
      }
      case "database_explain": {
        const sql = requiredString(args.sql, "sql");
        await this.access.authorizeSql(
          accessContext,
          requiredPositiveInteger(args.pagePurviewId, "pagePurviewId"),
          sql,
          "query",
        );
        value = await (await this.database()).explain(this.databaseConnection, sql);
        break;
      }
      case "database_query": {
        const sql = requiredString(args.sql, "sql");
        await this.access.authorizeSql(
          accessContext,
          requiredPositiveInteger(args.pagePurviewId, "pagePurviewId"),
          sql,
          "query",
        );
        value = await (await this.database()).query(
          this.databaseConnection,
          sql,
          boundedInteger(args.maxRows, 50, 1, 100),
        );
        break;
      }
      case "database_export_file": {
        const requestedRows = boundedInteger(args.maxRows, this.exportMaxRows, 1, this.exportMaxRows);
        const sql = requiredString(args.sql, "sql");
        await this.access.authorizeSql(
          accessContext,
          requiredPositiveInteger(args.pagePurviewId, "pagePurviewId"),
          sql,
          "export",
        );
        const queryResult = (await (await this.database()).query(
          this.databaseConnection,
          sql,
          requestedRows,
        )) as DatabaseQueryResult;
        const rows = recordRows(queryResult.rows);
        const format = exportFormat(args.format);
        const file = await this.exports.create({
          turnId: call.turnId,
          title: requiredString(args.title, "title"),
          fileName: requiredString(args.fileName, "fileName"),
          format,
          rows,
          ...(recordStringMap(args.columnLabels) ? { columnLabels: recordStringMap(args.columnLabels)! } : {}),
        });
        value = {
          status: "created",
          fileName: file.fileName,
          format: file.format,
          rowCount: file.rowCount,
          sourceTruncated: Boolean(queryResult.truncated),
          message: "文件已生成，任务结束后机器人会把附件发送到当前飞书聊天。",
        };
        break;
      }
      case "export_table_file": {
        await this.access.authorizePage(
          accessContext,
          requiredPositiveInteger(args.pagePurviewId, "pagePurviewId"),
        );
        const file = await this.exports.create({
          turnId: call.turnId,
          title: requiredString(args.title, "title"),
          fileName: requiredString(args.fileName, "fileName"),
          format: exportFormat(args.format),
          rows: recordRows(args.rows),
          ...(recordStringMap(args.columnLabels) ? { columnLabels: recordStringMap(args.columnLabels)! } : {}),
        });
        value = {
          status: "created",
          fileName: file.fileName,
          format: file.format,
          rowCount: file.rowCount,
          message: "文件已生成，任务结束后机器人会把附件发送到当前飞书聊天。",
        };
        break;
      }
      default:
        throw new Error("访客无权调用该工具。");
    }
    return {
      success: true,
      contentItems: [{ type: "inputText", text: truncate(JSON.stringify(value, null, 2), MAX_TOOL_OUTPUT) }],
    };
  }

  private async search(
    context: ErpAccessContext,
    query: string,
    maxResults: number,
  ): Promise<{ matches: string[]; truncated: boolean }> {
    const { stdout } = await execFileAsync(
      this.ripgrepPath,
      [
        "--line-number",
        "--no-heading",
        "--color",
        "never",
        "--hidden",
        "--glob",
        "!**/.git/**",
        "--glob",
        "!**/.env*",
        "--glob",
        "!**/*.{pem,key,p12,pfx}",
        "--glob",
        "!**/connections.json",
        "--",
        query,
        ".",
      ],
      { cwd: this.projectRoot, encoding: "utf8", maxBuffer: 512 * 1024, timeout: 15_000 },
    ).catch((error: unknown) => {
      const candidate = error as { code?: number; stdout?: string };
      if (candidate.code === 1) return { stdout: "", stderr: "" };
      throw error;
    });
    const lines = redactSensitiveText(stdout)
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((line) => {
        const path = line.split(":", 1)[0] ?? "";
        return this.access.canReadProjectFile(context, path);
      });
    return { matches: lines.slice(0, maxResults), truncated: lines.length > maxResults };
  }

  private async readFile(
    context: ErpAccessContext,
    path: string,
    startLine: number,
    endLine: number,
  ): Promise<Record<string, unknown>> {
    const absolute = await this.resolveSafePath(path, false);
    const relativePath = normalizePath(relative(this.projectRoot, absolute));
    if (!this.access.canReadProjectFile(context, relativePath)) throw new Error("无权访问：该源码文件不属于当前 ERP 角色可达模块。");
    if (!ALLOWED_FILE.test(absolute)) throw new Error("该文件类型不允许通过访客机器人读取。");
    const safeEnd = Math.min(Math.max(endLine, startLine), startLine + 299);
    const content = await fs.readFile(absolute, "utf8");
    const lines = redactSensitiveText(content).split(/\r?\n/);
    return {
      path: relativePath,
      startLine,
      endLine: Math.min(safeEnd, lines.length),
      totalLines: lines.length,
      content: lines.slice(startLine - 1, safeEnd).map((line, index) => `${startLine + index}: ${line}`).join("\n"),
    };
  }

  private async listDirectory(context: ErpAccessContext, path: string): Promise<Record<string, unknown>> {
    const absolute = await this.resolveSafePath(path, true);
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    const authorizedEntries = entries.filter((entry) => {
      if (entry.name.startsWith(".") || BLOCKED_PATH.test(`/${entry.name}`)) return false;
      const entryPath = normalizePath(relative(this.projectRoot, join(absolute, entry.name)));
      return entry.isDirectory()
        ? this.access.canReadProjectPath(context, entryPath)
        : this.access.canReadProjectFile(context, entryPath);
    });
    return {
      path: normalizePath(relative(this.projectRoot, absolute) || "."),
      entries: authorizedEntries
        .slice(0, 200)
        .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" })),
      truncated: authorizedEntries.length > 200,
    };
  }

  private async resolveSafePath(input: string, directory: boolean): Promise<string> {
    if (isAbsolute(input)) throw new Error("访客工具只接受项目相对路径。");
    const candidate = resolve(this.projectRoot, input);
    const canonical = await fs.realpath(candidate);
    const relation = relative(this.projectRoot, canonical);
    if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
      throw new Error("路径超出允许的 ERP 项目目录。");
    }
    const normalized = `/${normalizePath(relation)}`;
    if (BLOCKED_PATH.test(normalized)) throw new Error("该路径包含敏感凭据或受保护文件，访客不可读取。");
    const stat = await fs.stat(canonical);
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(directory ? "目标不是目录。" : "目标不是文件。");
    return canonical;
  }

  private async database(): Promise<DatabaseGatewayLike> {
    if (!this.databasePromise) {
      this.databasePromise = (async () => {
        const imported = (await import(pathToFileURL(this.databaseGatewayPath).href)) as {
          DatabaseGateway: new (configPath: string) => DatabaseGatewayLike;
        };
        const gateway = new imported.DatabaseGateway(this.databaseConfigPath);
        const profile = gateway.profile(this.databaseConnection);
        if (profile.environment !== "production" || profile.mode !== "readonly") {
          throw new Error("访客数据库连接必须同时标记为 production 和 readonly。");
        }
        return gateway;
      })();
    }
    return this.databasePromise;
  }
}

function resolveRipgrepBinary(): string {
  const pathCandidates = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, "rg"));
  const candidates = [
    ...pathCandidates,
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/codex-path/rg",
    "/Applications/ChatGPT.app/Contents/Resources/rg",
    "/Applications/Codex.app/Contents/Resources/codex-cli/codex-path/rg",
    "/Applications/Codex.app/Contents/Resources/rg",
  ];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 继续检查下一个安装位置。
    }
  }
  throw new Error("未找到可执行的 rg，访客源码搜索工具无法启动。");
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): DynamicToolSpec {
  return {
    type: "function",
    name,
    description,
    inputSchema: { type: "object", additionalProperties: false, properties, ...(required.length ? { required } : {}) },
  };
}

function pagePurviewIdSchema(): Record<string, unknown> {
  return {
    type: "integer",
    minimum: 1,
    description: "目标 ERP 页面的页面权限 ID，必须来自本轮 erp_page_access 的精确匹配结果。",
  };
}

function inventoryProperties(maxRows = 100): Record<string, unknown> {
  return {
    dataset: { type: "string", enum: INVENTORY_DATASETS, description: "stock 当前渠道库存；channel_io 历史渠道流水；channel_io_orders 按流水实际批次和推单时间追溯历史扣减订单，包含已发货订单，不能用occupancy代替；transfers 历史调拨；occupancy 当前本人可见订单占用；occupancy_summary 当前渠道占用数量汇总；warehouse_reconciliation 关联物理批次数量核对；warehouse_io_summary 关联物理批次流水汇总；transit_allocations 在途分配/释放。" },
    sku: { type: "string", minLength: 1, maxLength: 64 },
    ioRecordId: { type: "integer", minimum: 1, description: "仅channel_io/channel_io_orders使用，精确指定channel_io返回的流水id，追问某次扣减对应订单时必传。" },
    platformId: { type: "integer", minimum: 1, description: "渠道常量 ID；用户只有一个授权平台时可省略。" },
    countryId: { type: "integer", minimum: 1 },
    storehouseId: { type: "integer", minimum: 1 },
    orderId: { type: "string", description: "仅 occupancy 可用，精确匹配 ERP 订单编号。" },
    startDate: { type: "string", description: "历史流水/调拨必填 YYYY-MM-DD，ERP记录时间口径。" },
    endDate: { type: "string", description: "包含当天，跨度最多31天。当前库存/占用查询不按日期过滤。" },
    maxRows: { type: "integer", minimum: 1, maximum: maxRows, default: Math.min(50, maxRows) },
  };
}

function redactSensitiveText(text: string): string {
  return text
    .replace(/((?:password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key)\s*[:=]\s*)[^\s,;'"}]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|xox[baprs]|ghp|glpat)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_TOKEN]");
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n...[输出已截断]`;
}

function normalizePath(value: string): string {
  return value.split(sep).join("/");
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`缺少参数 ${name}`);
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === "number" && Number.isInteger(value) ? value : fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function requiredPositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(`缺少有效参数 ${name}`);
  return value;
}

function exportFormat(value: unknown): GuestExportFormat {
  return value === "csv" || value === "docx" ? value : "xlsx";
}

function recordRows(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error("导出结果不是结构化数据行。");
  const rows = value.filter(isRecord);
  if (rows.length !== value.length) throw new Error("导出数据中包含无效行。");
  return rows;
}

function recordStringMap(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return Object.fromEntries(entries);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
