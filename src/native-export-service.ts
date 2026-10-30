import "dotenv/config";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { promises as fs, createReadStream } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { validateEndpoint } from "./guest/native-export-protocol.js";

// A private loopback adapter, not an ERP web server. Each request gets its own
// bounded PHP CLI process; no arbitrary route, script or filesystem input.
const project = resolve(process.env.ERP_NATIVE_EXPORT_PROJECT_ROOT ?? join(homedir(), "Desktop/mc"));
const php = process.env.ERP_NATIVE_EXPORT_PHP_BIN ?? join(homedir(), "Library/PhpWebStudy/env/php/php");
const root = resolve(process.env.GUEST_EXPORT_ROOT ?? "data/exports", "erp-native-server");
const secretFile = process.env.ERP_NATIVE_EXPORT_SECRET_FILE;
const endpoint = new URL(validateEndpoint(process.env.ERP_NATIVE_EXPORT_URL ?? "http://127.0.0.1:23419/native-export"));
if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/native-export" || endpoint.search || !secretFile) throw new Error("本机导出服务需要127.0.0.1地址、/native-export路径和私有凭证文件。");
await fs.mkdir(root, { recursive: true, mode: 0o700 });
const privateRoot = await fs.realpath(root);
const script = join(project, "tools/codex-export-local.php");
await fs.access(script);
const childEnv = {
  PATH: process.env.PATH, TZ: "Asia/Shanghai",
  MC_BRIDGE_EXPORT_ROOT: privateRoot,
  MC_BRIDGE_EXPORT_SECRET_FILE: resolve(secretFile),
  MC_BRIDGE_EXPORT_DB_CONFIG_FILE: resolve(process.env.GUEST_DB_CONFIG_PATH ?? join(homedir(), ".config/mc-ai/connections.json")),
};
let active = 0;
const children = new Set<ReturnType<typeof spawn>>();
function phpRequest(input: Record<string, unknown>): Promise<{ statusCode: number; result: Record<string, unknown> }> {
  return new Promise((resolveRequest, reject) => {
    const child = spawn(php, ["-d", "memory_limit=512M", "-d", "display_errors=0", script], { cwd: project, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    children.add(child);
    let output = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        const safe = line.match(/Codex local export failed: [A-Za-z_\\]+ at [A-Za-z0-9_.-]+:\d+$/);
        if (safe) process.stderr.write(safe[0] + "\n");
      }
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 180000);
    child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); if (Buffer.byteLength(output) > 65536) child.kill("SIGKILL"); });
    child.once("error", () => { clearTimeout(timeout); children.delete(child); reject(new Error("PHP执行器无法启动")); });
    child.once("close", (code) => {
      clearTimeout(timeout); children.delete(child);
      try {
        if (code !== 0) throw new Error();
        const response = JSON.parse(output);
        if (!Number.isInteger(response.statusCode) || response.statusCode < 200 || response.statusCode > 599 || !response.result || typeof response.result !== "object") throw new Error();
        resolveRequest(response);
      } catch { reject(new Error("PHP执行器未返回有效结果")); }
    });
    child.stdin!.on("error", () => undefined);
    child.stdin!.end(JSON.stringify(input));
  });
}
const server = createServer(async (req, res) => {
  const json = (status: number, value: unknown) => {
    if (res.destroyed || res.headersSent) return;
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(value));
  };
  if (req.url === "/health" && req.method === "GET") { json(200, { status: "running", active }); return; }
  if (req.url !== "/native-export" || req.method !== "POST") { json(404, { message: "Not found" }); return; }
  if (active >= 4) { json(429, { message: "当前导出任务较多，请稍后重试" }); return; }
  ++active;
  try {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 32768) { json(413, { message: "导出请求过大" }); return; }
      chunks.push(Buffer.from(chunk));
    }
    const action = String(req.headers["x-codex-export-action"] ?? "");
    const response = await phpRequest({ action, raw: Buffer.concat(chunks).toString("utf8"), headers: {
      timestamp: String(req.headers["x-codex-export-time"] ?? ""), nonce: String(req.headers["x-codex-export-nonce"] ?? ""), signature: String(req.headers["x-codex-export-signature"] ?? ""),
    } });
    if (action === "download" && response.statusCode === 200 && typeof response.result.path === "string") {
      const path = response.result.path;
      const metadata = await fs.lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || !(await fs.realpath(path)).startsWith(privateRoot + sep)) throw new Error("导出文件位置异常");
      if (res.destroyed) return;
      res.writeHead(200, { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-length": metadata.size, "cache-control": "no-store" });
      await pipeline(createReadStream(path), res);
    } else {
      delete response.result.path;
      json(response.statusCode, response.result);
    }
  } catch (error) {
    // Never log PHP output, SQL, identities, input or credential values.
    process.stderr.write(`Local export request failed: ${error instanceof Error ? error.name : "Error"}\n`);
    json(503, { message: "本机ERP导出服务暂时不可用" });
  } finally { --active; }
});
server.requestTimeout = 20000;
server.listen(Number(endpoint.port), "127.0.0.1", () => process.stdout.write("Local ERP export service listening on loopback\n"));
const cleanup = setInterval(() => {
  const child = spawn(php, [join(project, "tools/bridge-export-cleanup.php")], { cwd: project, env: childEnv, stdio: "ignore" });
  child.on("error", () => undefined);
}, 3600000);
cleanup.unref();
const stop = () => {
  clearInterval(cleanup);
  server.close();
  // Let in-flight exports finish before an ordinary service shutdown.
  const forced = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); process.exit(0); }, 185000);
  forced.unref();
};
process.once("SIGTERM", stop); process.once("SIGINT", stop);
