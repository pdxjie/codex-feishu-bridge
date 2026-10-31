import { createHash } from "node:crypto";
import { open, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { boundedText, exportRequest, type NativeExportRequest } from "./native-export-protocol.js";

type Manifest = { status: string; fileName?: string; rowCount?: number; bytes?: number; sha256?: string };

export async function runNativeExportWorker(): Promise<void> {
  // Credentials arrive over a private stdin pipe, never argv, environment,
  // generated script, request.json, stdout, or the model's context.
  let input = "";
  for await (const chunk of process.stdin) { input += chunk.toString(); if (input.length > 16384) throw new Error("执行配置超限。"); }
  const { endpoint, secret } = JSON.parse(input) as { endpoint: string; secret: string };
  if (!secret || secret.length < 32) throw new Error("导出服务凭证未配置。");
  const directory = process.cwd();
  const request = JSON.parse(await readFile(join(directory, "request.json"), "utf8")) as NativeExportRequest;
  let result: Manifest;
  try {
    result = JSON.parse(await boundedText(await exportRequest(endpoint, secret, "create", request, 120000), 32768));
  } catch (error) {
    if ([400, 401, 403, 405, 409, 410, 422].includes(Number((error as { status?: number }).status))) throw error;
    // Ambiguous network/5xx failure: only inspect this request, never resubmit.
    result = { status: "running" };
  }
  const deadline = Date.now() + 120000;
  while (result.status === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    result = JSON.parse(await boundedText(await exportRequest(endpoint, secret, "status", request), 32768));
  }
  if (result.status !== "ready") throw new Error(`ERP导出未完成：${result.status}。未自动重复创建任务。`);
  if (!Number.isInteger(result.rowCount) || result.rowCount! < 1 || result.rowCount! > 10000 || !Number.isInteger(result.bytes) || result.bytes! <= 0 || result.bytes! > 30 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(result.sha256 ?? "")) throw new Error("ERP文件元数据不符合导出限制。");
  const response = await exportRequest(endpoint, secret, "download", request, 60000);
  if (!response.headers.get("content-type")?.includes("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") || !response.body) throw new Error("ERP返回的不是Excel文件。");
  const part = join(directory, "result.part");
  const file = await open(part, "w", 0o600);
  let bytes = 0; const hash = createHash("sha256");
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.length;
      if (bytes > 30 * 1024 * 1024 || bytes > result.bytes!) throw new Error("ERP导出文件超过大小限制。");
      hash.update(chunk);
      await file.writeFile(chunk);
    }
  } finally { await file.close(); }
  if (bytes !== result.bytes || hash.digest("hex") !== result.sha256) { await unlink(part); throw new Error("导出文件完整性校验失败。"); }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(part);
  if (workbook.worksheets.length !== 1 || workbook.worksheets[0]!.rowCount - 1 !== result.rowCount) throw new Error("ERP导出文件实际行数与任务记录不一致。");
  await rename(part, join(directory, "result.xlsx"));
  if (typeof result.fileName !== "string" || result.fileName.length < 6 || result.fileName.length > 125 || !result.fileName.toLowerCase().endsWith(".xlsx") || /[\\/\0\r\n]/.test(result.fileName)) throw new Error("ERP返回的导出文件名无效。");
  await writeFile(join(directory, "result.json"), JSON.stringify({ rowCount: result.rowCount, fileName: result.fileName }), { mode: 0o600 });
}
