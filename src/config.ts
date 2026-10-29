import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

const nonEmptyList = z.string().transform((value) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);

const schema = z.object({
  FEISHU_APP_ID: z.string().min(1),
  FEISHU_APP_SECRET: z.string().min(1),
  FEISHU_ALLOWED_OPEN_IDS: nonEmptyList.pipe(z.array(z.string()).min(1)),
  FEISHU_GUEST_MODE_ENABLED: z.string().default("false").transform((value) => value.toLowerCase() === "true"),
  FEISHU_TENANT_KEY: z.string().optional(),
  ALLOWED_WORKSPACE_ROOTS: nonEmptyList.pipe(z.array(z.string()).min(1)),
  DEFAULT_WORKSPACE: z.string().min(1),
  GUEST_WORKSPACE_ROOT: z.string().optional(),
  GUEST_CODEX_HOME: z.string().default("./data/guest-codex-home"),
  GUEST_DB_CONFIG_PATH: z.string().default(join(homedir(), ".config", "mc-ai", "connections.json")),
  GUEST_DB_GATEWAY_PATH: z.string().optional(),
  GUEST_PROJECT_INDEX_PATH: z.string().optional(),
  GUEST_DB_CONNECTION: z.string().default("production"),
  GUEST_MAX_CONCURRENT_TURNS: z.coerce.number().int().min(1).max(20).default(4),
  GUEST_EXPORT_ROOT: z.string().default("./data/exports"),
  GUEST_EXPORT_MAX_ROWS: z.coerce.number().int().min(1).max(1000).default(1000),
  STATE_DB_PATH: z.string().default("./data/state.db"),
  CODEX_BIN: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type AppConfig = {
  feishuAppId: string;
  feishuAppSecret: string;
  allowedOpenIds: Set<string>;
  guestModeEnabled: boolean;
  feishuTenantKey?: string;
  allowedWorkspaceRoots: string[];
  defaultWorkspace: string;
  guestWorkspaceRoot?: string;
  guestCodexHome: string;
  guestDbConfigPath: string;
  guestDbGatewayPath?: string;
  guestProjectIndexPath?: string;
  guestDbConnection: string;
  guestMaxConcurrentTurns: number;
  guestExportRoot?: string;
  guestExportMaxRows?: number;
  stateDbPath: string;
  codexBin?: string;
  logLevel: "debug" | "info" | "warn" | "error";
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.parse(env);
  const roots = parsed.ALLOWED_WORKSPACE_ROOTS.map(canonicalDirectory);
  const defaultWorkspace = canonicalDirectory(parsed.DEFAULT_WORKSPACE);
  const guestWorkspaceRoot = parsed.GUEST_WORKSPACE_ROOT ? canonicalDirectory(parsed.GUEST_WORKSPACE_ROOT) : undefined;

  if (!isPathAllowed(defaultWorkspace, roots)) {
    throw new Error("DEFAULT_WORKSPACE 必须位于 ALLOWED_WORKSPACE_ROOTS 中");
  }
  if (parsed.FEISHU_GUEST_MODE_ENABLED && !guestWorkspaceRoot) {
    throw new Error("启用访客模式时必须配置 GUEST_WORKSPACE_ROOT");
  }
  if (parsed.FEISHU_GUEST_MODE_ENABLED && !existsSync(resolve(parsed.GUEST_DB_CONFIG_PATH))) {
    throw new Error(`访客只读数据库配置不存在：${resolve(parsed.GUEST_DB_CONFIG_PATH)}`);
  }
  if (parsed.FEISHU_GUEST_MODE_ENABLED && !parsed.GUEST_DB_GATEWAY_PATH) {
    throw new Error("启用访客模式时必须配置 GUEST_DB_GATEWAY_PATH");
  }
  if (parsed.GUEST_DB_GATEWAY_PATH && !existsSync(resolve(parsed.GUEST_DB_GATEWAY_PATH))) {
    throw new Error(`访客数据库网关不存在：${resolve(parsed.GUEST_DB_GATEWAY_PATH)}`);
  }

  return {
    feishuAppId: parsed.FEISHU_APP_ID,
    feishuAppSecret: parsed.FEISHU_APP_SECRET,
    allowedOpenIds: new Set(parsed.FEISHU_ALLOWED_OPEN_IDS),
    guestModeEnabled: parsed.FEISHU_GUEST_MODE_ENABLED,
    ...(parsed.FEISHU_TENANT_KEY?.trim() ? { feishuTenantKey: parsed.FEISHU_TENANT_KEY.trim() } : {}),
    allowedWorkspaceRoots: roots,
    defaultWorkspace,
    ...(guestWorkspaceRoot ? { guestWorkspaceRoot } : {}),
    guestCodexHome: resolve(parsed.GUEST_CODEX_HOME),
    guestDbConfigPath: resolve(parsed.GUEST_DB_CONFIG_PATH),
    ...(parsed.GUEST_DB_GATEWAY_PATH ? { guestDbGatewayPath: realpathSync(resolve(parsed.GUEST_DB_GATEWAY_PATH)) } : {}),
    ...(parsed.GUEST_PROJECT_INDEX_PATH ? { guestProjectIndexPath: resolve(parsed.GUEST_PROJECT_INDEX_PATH) } : {}),
    guestDbConnection: parsed.GUEST_DB_CONNECTION,
    guestMaxConcurrentTurns: parsed.GUEST_MAX_CONCURRENT_TURNS,
    guestExportRoot: resolve(parsed.GUEST_EXPORT_ROOT),
    guestExportMaxRows: parsed.GUEST_EXPORT_MAX_ROWS,
    stateDbPath: resolve(parsed.STATE_DB_PATH),
    ...(parsed.CODEX_BIN ? { codexBin: parsed.CODEX_BIN } : {}),
    logLevel: parsed.LOG_LEVEL,
  };
}

export function canonicalDirectory(path: string): string {
  const absolute = isAbsolute(path) ? path : resolve(path);
  if (!existsSync(absolute)) throw new Error(`目录不存在：${absolute}`);
  return realpathSync(absolute);
}

export function assertWorkspaceAllowed(path: string, allowedRoots: string[]): string {
  const canonical = canonicalDirectory(path);
  if (!isPathAllowed(canonical, allowedRoots)) {
    throw new Error(`目录不在允许范围内：${canonical}`);
  }
  return canonical;
}

function isPathAllowed(path: string, roots: string[]): boolean {
  return roots.some((root) => {
    const relation = relative(root, path);
    return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
  });
}
