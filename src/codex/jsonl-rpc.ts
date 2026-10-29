import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Logger } from "../logger.js";
import type { CodexNotification, CodexServerRequest, JsonRpcId } from "./types.js";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};

type RpcResponse = {
  id: JsonRpcId;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

export class JsonlRpcProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private requestId = 0;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();

  constructor(
    private readonly binary: string,
    private readonly args: string[],
    private readonly logger: Logger,
    private readonly processEnv: NodeJS.ProcessEnv = process.env,
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.child) return;

    const child = spawn(this.binary, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.processEnv,
    });
    this.child = child;

    const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
    stdout.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) this.logger.warn("Codex App Server 输出", text);
    });
    child.on("error", (error) => this.failAll(error));
    child.on("exit", (code, signal) => {
      this.child = null;
      const error = new Error(`Codex App Server 已退出（code=${String(code)}, signal=${String(signal)}）`);
      this.failAll(error);
      this.emit("exit", error);
    });

    await this.request("initialize", {
      clientInfo: {
        name: "codex-feishu-bridge",
        title: "Codex Feishu Bridge",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    child.stdin.end();
    child.kill("SIGTERM");
  }

  request<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    const id = ++this.requestId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex 请求超时：${method}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  respond(id: JsonRpcId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  private write(message: unknown): void {
    if (!this.child?.stdin.writable) throw new Error("Codex App Server 尚未启动");
    this.logger.debug("发送 Codex RPC", message);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.logger.warn("忽略无法解析的 Codex 输出", line);
      return;
    }

    if (!isRecord(message)) return;
    this.logger.debug("收到 Codex RPC", message);

    if ((typeof message.id === "number" || typeof message.id === "string") && !("method" in message)) {
      this.handleResponse(message as RpcResponse);
      return;
    }

    if (typeof message.method === "string" && (typeof message.id === "number" || typeof message.id === "string")) {
      this.emit("serverRequest", message as CodexServerRequest);
      return;
    }

    if (typeof message.method === "string") {
      this.emit("notification", message as CodexNotification);
    }
  }

  private handleResponse(message: RpcResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? `Codex RPC 错误 ${String(message.error.code)}`));
    } else {
      pending.resolve(message.result);
    }
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
