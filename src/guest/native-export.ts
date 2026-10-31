import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import type { DynamicToolCall } from "../codex/client.js";
import type { Logger } from "../logger.js";
import type { ErpAccessContext } from "./erp-access-control.js";
import type { GuestExportFile } from "./export-files.js";
import { boundedText, exportRequest, validateNativeExport, type NativeExportConfig, type NativeExportRequest } from "./native-export-protocol.js";

export class NativeExportManager {
  private readonly filesByTurn = new Map<string, Map<string, GuestExportFile>>();
  private readonly requests = new Map<string, NativeExportRequest>();
  private readonly running = new Map<string, Promise<GuestExportFile>>();

  constructor(private readonly root: string, private readonly config: NativeExportConfig | undefined, private readonly logger: Logger) {}

  catalog() {
    return { configured: Boolean(this.config), discovery: "dynamic_source_plan", maxRows: 10000, maxBytes: 30 * 1024 * 1024, format: "xlsx",
      workflow: ["确认用户意图与ERP页面权限", "用project_search/project_read_file定位Controller导出入口", "定位Service中返回数据与表头的方法", "提交一次性受控导出计划"],
      message: this.config ? "不使用业务类型白名单；从ERP源码动态发现已有导出能力，由PHP二次校验源码、路由、本人权限和生产只读连接。" : "原生导出服务未配置。" };
  }

  async create(call: DynamicToolCall, context: ErpAccessContext, args: Record<string, unknown>): Promise<GuestExportFile> {
    if (!this.config) throw new Error("ERP原生导出入口尚未部署/配置；同事不需要提供登录凭证，请管理员完成服务接入。");
    if (Object.keys(args).some((key) => key !== "plan")) throw new Error("原生导出只接受从ERP源码定位的受控计划。");
    const plan = validateNativeExport(args.plan);
    const digest = createHash("sha256").update(JSON.stringify([call.threadId, call.turnId, context.feishuUserId, plan])).digest("hex");
    const requestId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
    let running = this.running.get(requestId);
    if (!running) {
      running = this.execute({ requestId, feishuUserId: context.feishuUserId, plan });
      this.running.set(requestId, running);
    }
    try {
      const file = await running;
      const files = this.filesByTurn.get(call.turnId) ?? new Map();
      files.set(file.path, file);
      this.filesByTurn.set(call.turnId, files);
      return file;
    } finally { if (this.running.get(requestId) === running) this.running.delete(requestId); }
  }

  takeFiles(turnId: string): GuestExportFile[] {
    const files = [...(this.filesByTurn.get(turnId)?.values() ?? [])];
    this.filesByTurn.delete(turnId);
    return files;
  }

  async authorizeDelivery(file: GuestExportFile): Promise<void> {
    const request = this.requests.get(file.path);
    if (!request || !this.config) return;
    const response = await exportRequest(this.config.endpoint, await this.secret(), "status", request, 10000);
    const state = JSON.parse(await boundedText(response, 32768));
    if (state.status !== "ready") throw new Error("原生导出已过期或授权发生变化，请重新发起。");
  }

  async removeSentFiles(files: GuestExportFile[]): Promise<void> {
    for (const file of files) {
      const request = this.requests.get(file.path);
      if (!request || !this.config) continue;
      try {
        const secret = await this.secret();
        const response = await exportRequest(this.config.endpoint, secret, "ack", request, 10000);
        await response.body?.cancel();
      } catch {
        this.logger.warn("ERP导出远端清理未确认，将由过期清理处理", { requestId: request.requestId });
      }
      await fs.rm(dirname(file.path), { recursive: true, force: true });
      this.requests.delete(file.path);
    }
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      const path = join(this.root, entry.name);
      if (Date.now() - (await fs.stat(path)).mtimeMs > 86400000) await fs.rm(path, { recursive: true, force: true });
    }
  }

  private async secret(): Promise<string> {
    const path = this.config!.secretFile;
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("导出服务凭证文件需为当前用户私有文件（权限0600）。");
    const secret = (await fs.readFile(path, "utf8")).trim();
    if (secret.length < 32) throw new Error("导出服务凭证长度不足。");
    return secret;
  }

  private async execute(request: NativeExportRequest): Promise<GuestExportFile> {
    const secret = await this.secret();
    const directory = join(this.root, request.requestId);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const worker = new URL(`./native-export-worker${extname(import.meta.url)}`, import.meta.url).href;
    await fs.writeFile(join(directory, "request.json"), JSON.stringify(request), { mode: 0o600 });
    await fs.writeFile(join(directory, "runner.mjs"), `import { runNativeExportWorker } from ${JSON.stringify(worker)};\nrunNativeExportWorker().catch(e => { process.stderr.write(String(e.message).slice(0,500)); process.exitCode=1; });\n`, { mode: 0o600 });
    this.logger.info("ERP原生导出脚本启动", { requestId: request.requestId, route: request.plan.route, service: request.plan.className, method: request.plan.dataMethod });
    const loader = extname(import.meta.url) === ".ts" ? ["--import", createRequire(import.meta.url).resolve("tsx")] : [];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--max-old-space-size=256", ...loader, join(directory, "runner.mjs")], {
        cwd: directory, env: { PATH: process.env.PATH, TZ: "Asia/Shanghai" }, stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-1000); });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 310000);
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0) reject(new Error(`原生导出未完成：${stderr.replaceAll(secret, "[REDACTED]") || "执行器超时或退出"}`));
        else resolve();
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(JSON.stringify({ endpoint: this.config!.endpoint, secret }));
    });
    const info = JSON.parse(await fs.readFile(join(directory, "result.json"), "utf8")) as { rowCount: number; fileName: string };
    const file: GuestExportFile = { path: join(directory, "result.xlsx"), fileName: info.fileName, rowCount: info.rowCount, format: "xlsx" };
    this.requests.set(file.path, request);
    return file;
  }
}
