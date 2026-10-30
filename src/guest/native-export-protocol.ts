import { createHash, createHmac, randomBytes } from "node:crypto";

export type NativeExportConfig = { endpoint: string; secretFile: string };
export type NativeExportRequest = { requestId: string; feishuUserId: string; kind: string; filters: Record<string, unknown> };
export const PURCHASE_EXPORT_FIELDS = ["order_no", "create_order_time", "sku", "origin_sku", "goods_name", "number", "surplus_number", "plan_transport_number", "estimate_date", "contract_status_text", "supplier_info_name", "supplier_header_name", "purchase_price", "mc_purchase_price", "currency_code"];
export const NATIVE_EXPORT_CATALOG = [
  { kind: "channel_stock", name: "ERP渠道库存列表", pagePermission: 881, filters: ["sku（可选）", "platformId（必填渠道ID）", "countryId（可选）", "storehouseId（可选）"], fields: "原ERP固定的8列：库存批次、仓库、商品名称、SKU、入库数量、剩余库存、渠道、国家。", note: "需要该页面权限；联合排查能力不替代整页原生导出权限。" },
  { kind: "purchase_orders", name: "ERP采购单商品明细", pagePermission: 22, exportPermission: 895, filters: ["startDate（必填YYYY-MM-DD）", "endDate（必填，含当天，最多31天）", "sku（可选，沿用ERP按SKU匹配采购单的口径，可能包括同单其他商品）", "fields（可选）"], fields: PURCHASE_EXPORT_FIELDS, note: "复用ERP归属和字段权限；不是按SKU精确筛选的自定义明细表。" },
];

export function validateNativeExport(kind: unknown, filters: unknown): { kind: string; filters: Record<string, unknown> } {
  if (kind !== "channel_stock" && kind !== "purchase_orders") throw new Error("暂无法确认数据授权范围：该原生导出尚未接入。");
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) throw new Error("导出筛选条件必须是对象。");
  const f = filters as Record<string, unknown>;
  const allowed = kind === "channel_stock" ? ["sku", "platformId", "countryId", "storehouseId"] : ["startDate", "endDate", "sku", "fields"];
  if (Object.keys(f).some((key) => !allowed.includes(key))) throw new Error("原生导出不接受自定义URL、脚本、SQL、用户身份或未登记的筛选条件。");
  if (f.sku !== undefined && (typeof f.sku !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(f.sku))) throw new Error("SKU格式无效。");
  if (kind === "channel_stock") {
    if (f.platformId === undefined) throw new Error("请明确导出渠道。");
    for (const key of ["platformId", "countryId", "storehouseId"]) {
      if (f[key] !== undefined && (typeof f[key] !== "number" || !Number.isSafeInteger(f[key]) || Number(f[key]) <= 0)) throw new Error(`无效参数 ${key}`);
    }
  } else {
    for (const key of ["startDate", "endDate"]) {
      const value = f[key];
      if (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error("请提供有效起止日期 YYYY-MM-DD。");
    }
    const days = (Date.parse(String(f.endDate)) - Date.parse(String(f.startDate))) / 86400000;
    if (days < 0 || days >= 31) throw new Error("日期范围必须正序且不超过31天。");
    if (f.fields !== undefined && (!Array.isArray(f.fields) || f.fields.length === 0 || f.fields.length > PURCHASE_EXPORT_FIELDS.length || f.fields.some((v) => typeof v !== "string" || !PURCHASE_EXPORT_FIELDS.includes(v)))) throw new Error("导出字段尚未登记或不允许。");
  }
  return { kind, filters: Object.fromEntries(Object.entries(f).sort(([a], [b]) => a.localeCompare(b))) };
}

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
    const text = await boundedText(response, 8192);
    let message = "原生导出服务调用失败";
    try { const result = JSON.parse(text); if (typeof result.message === "string") message = result.message.slice(0, 300); } catch { /* never expose an HTML error or credentials */ }
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
