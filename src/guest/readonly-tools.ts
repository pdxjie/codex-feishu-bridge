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
  ) {
    this.projectRoot = realpathSync(projectRoot);
    this.ripgrepPath = resolveRipgrepBinary();
    this.exports = new GuestExportManager(exportRoot, exportMaxRows, logger);
    this.access =
      accessGuard ??
      new ErpAccessControl(
        this.projectRoot,
        accessIndexPath || defaultErpAccessIndexPath(this.databaseGatewayPath),
        () => this.database(),
        this.databaseConnection,
        logger,
      );
  }

  async initialize(): Promise<void> {
    await Promise.all([this.exports.initialize(), this.access.initialize()]);
  }

  resolveUserAccess(feishuUserId: string): Promise<ErpAccessContext> {
    return this.access.resolveUser(feishuUserId);
  }

  bindThreadAccess(threadId: string, context: ErpAccessContext): void {
    this.access.bindThread(threadId, context);
  }

  takeExportFiles(turnId: string): GuestExportFile[] {
    return this.exports.takeFiles(turnId);
  }

  removeExportFiles(files: GuestExportFile[]): Promise<void> {
    return this.exports.removeFiles(files);
  }

  specs(): DynamicToolSpec[] {
    return [
      tool("erp_access_profile", "查看当前飞书用户映射到 ERP 后的角色、可访问模块与数据范围。首次排查应先调用。", {}),
      tool("erp_page_access", "按页面名称或业务关键词查找 ERP 页面权限。查询或导出业务数据前必须先调用，并使用目标页面返回的 pagePurviewId；hasAccess=false 时必须直接回复权限不足。", {
        query: { type: "string", minLength: 1, maxLength: 80 },
      }, ["query"]),
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
    const accessContext = await this.access.contextForThread(call.threadId);
    this.logger.info("访客只读工具调用", { threadId: call.threadId, turnId: call.turnId, tool: call.tool });
    let value: unknown;
    switch (call.tool) {
      case "erp_access_profile":
        value = this.access.publicProfile(accessContext);
        break;
      case "erp_page_access":
        value = await this.access.findPages(accessContext, requiredString(args.query, "query"));
        break;
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
