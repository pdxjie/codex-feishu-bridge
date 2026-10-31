import { createHash, createHmac, randomBytes } from "node:crypto";

export type NativeExportConfig = { endpoint: string; secretFile: string };
export type NativeExportArgument = "filters" | "erpUserId" | "rowLimit";
export type NativeExportPlan = {
  pagePurviewId: number;
  route: string;
  controllerFile: string;
  controllerMethod: string;
  serviceFile: string;
  className: string;
  factory: "new" | "getInstance";
  dataMethod: string;
  titleMethod: string;
  dataArguments: NativeExportArgument[];
  titleArguments: NativeExportArgument[];
  resultMode: "rows" | "bundle";
  filters: Record<string, unknown>;
  fileName: string;
  sheetName: string;
};
export type NativeExportRequest = { requestId: string; feishuUserId: string; plan: NativeExportPlan };

const PLAN_KEYS = ["pagePurviewId", "route", "controllerFile", "controllerMethod", "serviceFile", "className", "factory", "dataMethod", "titleMethod", "dataArguments", "titleArguments", "resultMode", "filters", "fileName", "sheetName"];
const ARGUMENTS = new Set<NativeExportArgument>(["filters", "erpUserId", "rowLimit"]);

/** Validate a source-discovered declarative plan. There is intentionally no business-kind enum. */
export function validateNativeExport(plan: unknown): NativeExportPlan {
  if (!isRecord(plan) || Object.keys(plan).some((key) => !PLAN_KEYS.includes(key))) throw new Error("导出计划参数无效。");
  const pagePurviewId = positiveInteger(plan.pagePurviewId, "pagePurviewId");
  const route = text(plan.route, "route", 180);
  if (!/^\/[A-Za-z][A-Za-z0-9_-]*(?:\/[A-Za-z][A-Za-z0-9_-]*){1,2}$/.test(route)) throw new Error("ERP导出路由格式无效。");
  const controllerFile = text(plan.controllerFile, "controllerFile", 300);
  if (!/^application\/admin\/(?:controller\/[A-Za-z0-9_]+\.php|App\/Presentation\/Http\/[A-Za-z0-9_]+\/Controller\/[A-Za-z0-9_]+Controller\.php)$/.test(controllerFile)) throw new Error("导出入口必须是ERP Controller源码。");
  const controllerMethod = identifier(plan.controllerMethod, "controllerMethod");
  if (!/export/i.test(controllerMethod) || route.split("/").at(-1)!.toLowerCase() !== controllerMethod.toLowerCase()) throw new Error("导出路由与Controller方法不匹配。");
  const serviceFile = text(plan.serviceFile, "serviceFile", 300);
  if (!/^application\/admin\/(?:service(?:\/[A-Za-z0-9_]+)*\/[A-Za-z0-9_]+Service\.php|App\/Domain\/[A-Za-z0-9_]+\/Service\/[A-Za-z0-9_]+Service\.php)$/.test(serviceFile)) throw new Error("只能调用ERP Service中的导出数据构建方法。");
  const className = text(plan.className, "className", 220);
  if (!/^(?:[A-Za-z_][A-Za-z0-9_]*\\)*[A-Za-z_][A-Za-z0-9_]*Service$/.test(className)) throw new Error("ERP Service类名无效。");
  if (plan.factory !== "new" && plan.factory !== "getInstance") throw new Error("不支持的Service创建方式。");
  const dataMethod = identifier(plan.dataMethod, "dataMethod");
  const titleMethod = identifier(plan.titleMethod, "titleMethod");
  if (!/export/i.test(dataMethod) || /^(?:create|add|update|delete|save|upload|send|dispatch)/i.test(dataMethod) || /^queueExportData$/i.test(dataMethod) || !/(title|header)/i.test(titleMethod)) throw new Error("必须定位ERP已有的只读导出数据和表头方法。");
  const dataArguments = argumentList(plan.dataArguments, "dataArguments");
  const titleArguments = argumentList(plan.titleArguments, "titleArguments");
  if (!dataArguments.includes("filters")) throw new Error("导出数据方法必须接收本次筛选条件。");
  if (plan.resultMode !== "rows" && plan.resultMode !== "bundle") throw new Error("导出结果结构无效。");
  if (!isRecord(plan.filters)) throw new Error("导出筛选条件必须是对象。");
  validateJson(plan.filters, 0);
  const fileName = normalizeFileName(text(plan.fileName, "fileName", 120));
  const sheetName = text(plan.sheetName ?? "ERP导出", "sheetName", 31);
  if (/[\\\/:*?\[\]]/.test(sheetName)) throw new Error("Excel工作表名无效。");
  return {
    pagePurviewId, route, controllerFile, controllerMethod, serviceFile, className,
    factory: plan.factory, dataMethod, titleMethod, dataArguments, titleArguments,
    resultMode: plan.resultMode, filters: stableRecord(plan.filters), fileName, sheetName,
  };
}

function argumentList(value: unknown, field: string): NativeExportArgument[] {
  if (!Array.isArray(value) || value.length > 4 || value.some((item) => typeof item !== "string" || !ARGUMENTS.has(item as NativeExportArgument))) throw new Error(`${field}无效。`);
  return value as NativeExportArgument[];
}

function validateJson(value: unknown, depth: number): void {
  if (depth > 4) throw new Error("导出筛选条件嵌套过深。");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value) || !Number.isSafeInteger(value)) throw new Error("导出数字参数无效。"); return; }
  if (typeof value === "string") { if (value.length > 2000 || /[\0\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error("导出文本参数无效。"); return; }
  if (Array.isArray(value)) { if (value.length > 1000) throw new Error("导出数组参数过大。"); for (const item of value) validateJson(item, depth + 1); return; }
  if (!isRecord(value) || Object.keys(value).length > 200) throw new Error("导出筛选条件无效。");
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) throw new Error(`导出筛选字段无效：${key}`);
    validateJson(item, depth + 1);
  }
}

function stableRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, Array.isArray(item) ? item.map(stableValue) : stableValue(item)]));
}
function stableValue(value: unknown): unknown { return isRecord(value) ? stableRecord(value) : value; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown, field: string, maximum: number): string { if (typeof value !== "string" || value.length < 1 || value.length > maximum) throw new Error(`${field}无效。`); return value; }
function identifier(value: unknown, field: string): string { const result = text(value, field, 100); if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(result)) throw new Error(`${field}无效。`); return result; }
function positiveInteger(value: unknown, field: string): number { if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${field}无效。`); return Number(value); }
function normalizeFileName(value: string): string { if (/[\\/\0\r\n]/.test(value) || value === "." || value === "..") throw new Error("导出文件名无效。"); return value.toLowerCase().endsWith(".xlsx") ? value : `${value}.xlsx`; }

export function validateEndpoint(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw new Error("ERP导出地址必须使用HTTPS（本机测试可用HTTP），不能在URL中携带凭证。");
  return url.href;
}

export function signedHeaders(action: string, body: string, secret: string, timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("hex")): Record<string, string> {
  const canonical = `codex-export-v1\n${action}\n${timestamp}\n${nonce}\n${createHash("sha256").update(body).digest("hex")}`;
  return { "content-type": "application/json", "x-codex-export-action": action, "x-codex-export-time": timestamp, "x-codex-export-nonce": nonce,
    "x-codex-export-signature": createHmac("sha256", secret).update(canonical).digest("hex") };
}

export async function exportRequest(endpoint: string, secret: string, action: string, request: NativeExportRequest, timeout = 30000): Promise<Response> {
  const body = JSON.stringify(request);
  const response = await fetch(validateEndpoint(endpoint), { method: "POST", body, headers: signedHeaders(action, body, secret), redirect: "error", signal: AbortSignal.timeout(timeout) });
  if (!response.ok) {
    const bodyText = await boundedText(response, 8192);
    let message = "原生导出服务调用失败";
    try { const result = JSON.parse(bodyText); if (typeof result.message === "string") message = result.message.slice(0, 300); } catch { /* never expose an HTML error or credentials */ }
    const error = new Error(`${message}（HTTP ${response.status}）`);
    Object.assign(error, { status: response.status });
    throw error;
  }
  return response;
}

export async function boundedText(response: Response, maximum: number): Promise<string> {
  if (!response.body) throw new Error("ERP返回空响应。");
  const chunks: Uint8Array[] = []; let bytes = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    bytes += chunk.length;
    if (bytes > maximum) throw new Error("ERP响应超过大小限制。");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
