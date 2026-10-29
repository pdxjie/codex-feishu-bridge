import { execFile } from "node:child_process";
import { promises as fs, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { DynamicToolCall, DynamicToolResult, DynamicToolSpec } from "../codex/client.js";
import type { Logger } from "../logger.js";

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

export class GuestReadonlyTools {
  private databasePromise: Promise<DatabaseGatewayLike> | null = null;
  private readonly projectRoot: string;

  constructor(
    projectRoot: string,
    private readonly databaseConfigPath: string,
    private readonly databaseConnection: string,
    private readonly logger: Logger,
  ) {
    this.projectRoot = realpathSync(projectRoot);
  }

  specs(): DynamicToolSpec[] {
    return [
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
        table: { type: "string", pattern: "^[A-Za-z0-9_]+$" },
      }, ["table"]),
      tool("database_explain", "对单条 SELECT 查询执行 EXPLAIN。写语句会被拒绝。", {
        sql: { type: "string", minLength: 6, maxLength: 20_000 },
      }, ["sql"]),
      tool("database_query", "执行一条受保护的生产只读查询。仅允许 SELECT/SHOW/DESCRIBE/EXPLAIN，结果限行并脱敏。", {
        sql: { type: "string", minLength: 4, maxLength: 20_000 },
        maxRows: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      }, ["sql"]),
    ];
  }

  async handle(call: DynamicToolCall): Promise<DynamicToolResult> {
    const args = isRecord(call.arguments) ? call.arguments : {};
    this.logger.info("访客只读工具调用", { threadId: call.threadId, turnId: call.turnId, tool: call.tool });
    let value: unknown;
    switch (call.tool) {
      case "project_search":
        value = await this.search(requiredString(args.query, "query"), boundedInteger(args.maxResults, 80, 1, 200));
        break;
      case "project_read_file":
        value = await this.readFile(
          requiredString(args.path, "path"),
          boundedInteger(args.startLine, 1, 1, 1_000_000),
          boundedInteger(args.endLine, 240, 1, 1_000_000),
        );
        break;
      case "project_list_directory":
        value = await this.listDirectory(optionalString(args.path) || ".");
        break;
      case "database_describe_table":
        value = await (await this.database()).describeTable(this.databaseConnection, requiredString(args.table, "table"));
        break;
      case "database_explain":
        value = await (await this.database()).explain(this.databaseConnection, requiredString(args.sql, "sql"));
        break;
      case "database_query":
        value = await (await this.database()).query(
          this.databaseConnection,
          requiredString(args.sql, "sql"),
          boundedInteger(args.maxRows, 50, 1, 100),
        );
        break;
      default:
        throw new Error("访客无权调用该工具。");
    }
    return {
      success: true,
      contentItems: [{ type: "inputText", text: truncate(JSON.stringify(value, null, 2), MAX_TOOL_OUTPUT) }],
    };
  }

  private async search(query: string, maxResults: number): Promise<{ matches: string[]; truncated: boolean }> {
    const { stdout } = await execFileAsync(
      "rg",
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
    const lines = redactSensitiveText(stdout).split(/\r?\n/).filter(Boolean);
    return { matches: lines.slice(0, maxResults), truncated: lines.length > maxResults };
  }

  private async readFile(path: string, startLine: number, endLine: number): Promise<Record<string, unknown>> {
    const absolute = await this.resolveSafePath(path, false);
    if (!ALLOWED_FILE.test(absolute)) throw new Error("该文件类型不允许通过访客机器人读取。");
    const safeEnd = Math.min(Math.max(endLine, startLine), startLine + 299);
    const content = await fs.readFile(absolute, "utf8");
    const lines = redactSensitiveText(content).split(/\r?\n/);
    return {
      path: normalizePath(relative(this.projectRoot, absolute)),
      startLine,
      endLine: Math.min(safeEnd, lines.length),
      totalLines: lines.length,
      content: lines.slice(startLine - 1, safeEnd).map((line, index) => `${startLine + index}: ${line}`).join("\n"),
    };
  }

  private async listDirectory(path: string): Promise<Record<string, unknown>> {
    const absolute = await this.resolveSafePath(path, true);
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    return {
      path: normalizePath(relative(this.projectRoot, absolute) || "."),
      entries: entries
        .filter((entry) => !entry.name.startsWith(".") && !BLOCKED_PATH.test(`/${entry.name}`))
        .slice(0, 200)
        .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" })),
      truncated: entries.length > 200,
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
        const modulePath = join(this.projectRoot, "tools", "mc-kb", "src", "database-gateway.js");
        const imported = (await import(pathToFileURL(modulePath).href)) as {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
