import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";
import net, { type Socket } from "node:net";
import type { Logger } from "../logger.js";

const DEFAULT_CUA_NODE = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node";
const DEFAULT_HELPER_SOCKET = join(homedir(), "Library", "Application Support", "CodexFeishuBridge", "desktop-helper.sock");
const REQUEST_TIMEOUT_MS = 20_000;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type HelperResponse = {
  id: number | null;
  result?: unknown;
  error?: { message?: string };
};

type ToolResult = {
  success: boolean;
  contentItems: Array<
    | { type: "inputText"; text: string }
    | { type: "inputImage"; imageUrl: string }
    | { type: "inputAudio"; audioUrl: string }
  >;
};

export type DesktopThreadItem = {
  id?: string;
  type: string;
  text?: string;
  phase?: string;
  summary?: unknown;
  status?: string;
  [key: string]: unknown;
};

export type DesktopTurnSnapshot = {
  id: string;
  status: string;
  error?: { message?: string } | null;
  startedAt?: number | null;
  completedAt?: number | null;
  items: DesktopThreadItem[];
};

export type DesktopThreadSnapshot = {
  schemaVersion: number;
  thread: {
    id: string;
    kind: string;
    hostId?: string;
    title?: string;
    preview?: string;
    cwd?: string;
    updatedAt?: number;
    status?: { type?: string };
  };
  turns: DesktopTurnSnapshot[];
};

type DesktopThreadSummary = {
  id: string;
  kind: string;
  hostId?: string;
};

export type DesktopProjectSummary = {
  projectId: string;
  projectKind: string;
  label: string;
  path?: string;
  hostId?: string;
  isGitRepository?: boolean;
};

export type DesktopCreatedThread = {
  threadId: string;
  hostId?: string;
};

export type DesktopRolloutCursor = {
  threadId: string;
  path: string | null;
  offset: number;
};

export type DesktopRolloutEvent = Record<string, unknown>;

export class DesktopThreadUnavailableError extends Error {
  constructor(readonly threadId: string, message?: string) {
    super(message ?? `会话 ${threadId} 不存在于 Codex Desktop，可能是尚未落盘的临时空会话。`);
    this.name = "DesktopThreadUnavailableError";
  }
}

export class DesktopCodexClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private bridgeSocket: Socket | null = null;
  private lines: Interface | null = null;
  private desktopPipePath: string | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private controllerThreadId: string | null = null;

  constructor(private readonly logger: Logger) {}

  async start(): Promise<void> {
    if (this.child) return;
    const socketPaths = await discoverDesktopSocketPaths();
    if (socketPaths.length === 0) {
      throw new Error("没有发现 Codex Desktop 本地通道，请先启动并登录 Codex Desktop。");
    }

    let lastError: unknown;
    let daemonConnected = false;
    try {
      await this.connectHelperDaemon();
      daemonConnected = true;
    } catch (error) {
      this.logger.warn("Codex Desktop helper 常驻进程尚未连接，尝试临时进程", errorMessage(error));
    }
    for (const socketPath of socketPaths) {
      try {
        if (!daemonConnected) await this.startHelper(socketPath);
        this.desktopPipePath = socketPath;
        const ping = await this.request<{ tools?: string[] }>({ method: "ping" }, 5_000);
        const required = ["send_message_to_thread", "read_thread", "list_threads", "list_projects", "create_thread"];
        if (!required.every((name) => ping.tools?.includes(name))) {
          throw new Error("Codex Desktop 缺少会话互通工具，请升级桌面应用。");
        }
        this.logger.info("Codex Desktop 实时会话通道已连接", { socketPath });
        return;
      } catch (error) {
        lastError = error;
        this.logger.warn("Codex Desktop 通道候选连接失败", { socketPath, error: errorMessage(error) });
        if (!daemonConnected) await this.stopHelper();
      }
    }
    await this.stopHelper();
    throw new Error(`无法连接 Codex Desktop 实时会话通道：${errorMessage(lastError)}`);
  }

  async stop(): Promise<void> {
    await this.stopHelper();
  }

  async sendMessage(threadId: string, prompt: string): Promise<void> {
    await this.ensureThreadLoaded(threadId);
    const callerThreadId = await this.resolveControllerThread(threadId);
    let lastError: unknown;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (attempt > 0) await delay(300 * attempt);
      try {
        await this.callTool(callerThreadId, "send_message_to_thread", { threadId, prompt });
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async readThread(threadId: string, turnLimit = 3): Promise<DesktopThreadSnapshot> {
    await this.ensureThreadLoaded(threadId);
    return this.readThreadRaw(threadId, turnLimit);
  }

  async ensureThreadLoaded(threadId: string): Promise<void> {
    try {
      await this.readThreadRaw(threadId, 1);
      return;
    } catch (initialError) {
      if (!(await this.hasLocalRollout(threadId))) {
        throw new DesktopThreadUnavailableError(threadId);
      }

      // App Tool 的 navigate_to_codex_page 会先 thread/read，因而无法打开真正的冷会话。
      // Desktop 自己的深链会走正常 thread/resume 流程。
      await openDesktopThread(threadId);
      let lastError: unknown = initialError;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await delay(250 + attempt * 100);
        try {
          await this.readThreadRaw(threadId, 1);
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw new Error(`Codex Desktop 无法加载会话 ${threadId}：${errorMessage(lastError)}`);
    }
  }

  async listProjects(): Promise<DesktopProjectSummary[]> {
    const callerThreadId = await this.resolveControllerThread("");
    const result = await this.callToolJson<{ projects?: DesktopProjectSummary[] }>(callerThreadId, "list_projects", {});
    return result.projects ?? [];
  }

  async createThread(prompt: string, projectId: string, title?: string): Promise<DesktopCreatedThread> {
    const callerThreadId = await this.resolveControllerThread("");
    return this.callToolJson<DesktopCreatedThread>(callerThreadId, "create_thread", {
      prompt,
      ...(title?.trim() ? { title: title.trim() } : {}),
      target: {
        type: "project",
        projectId,
        environment: { type: "local" },
      },
    });
  }

  async hasLocalRollout(threadId: string): Promise<boolean> {
    const sessionsRoot = join(homedir(), ".codex", "sessions");
    return (await findRolloutForThread(sessionsRoot, threadId)) !== null;
  }

  async createRolloutCursor(threadId: string, includeExisting = false): Promise<DesktopRolloutCursor> {
    const sessionsRoot = join(homedir(), ".codex", "sessions");
    const path = await findRolloutForThread(sessionsRoot, threadId);
    if (!path) return { threadId, path: null, offset: 0 };
    const stat = await fs.stat(path);
    return { threadId, path, offset: includeExisting ? 0 : stat.size };
  }

  async readRolloutEvents(cursor: DesktopRolloutCursor): Promise<DesktopRolloutEvent[]> {
    if (!cursor.path) {
      const sessionsRoot = join(homedir(), ".codex", "sessions");
      cursor.path = await findRolloutForThread(sessionsRoot, cursor.threadId);
      if (!cursor.path) return [];
    }

    let stat;
    try {
      stat = await fs.stat(cursor.path);
    } catch {
      cursor.path = null;
      cursor.offset = 0;
      return [];
    }
    if (stat.size < cursor.offset) cursor.offset = 0;
    if (stat.size === cursor.offset) return [];

    // 一次最多读取 2 MiB；只推进到完整换行，避免把半条 JSON 或半个 UTF-8 字符当成事件。
    const length = Math.min(stat.size - cursor.offset, 2 * 1024 * 1024);
    const handle = await fs.open(cursor.path, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, cursor.offset);
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.lastIndexOf(0x0a);
      if (newline < 0) return [];
      cursor.offset += newline + 1;
      return chunk
        .subarray(0, newline)
        .toString("utf8")
        .split("\n")
        .flatMap((line) => {
          if (!line.trim()) return [];
          try {
            const value = JSON.parse(line) as unknown;
            return isRecord(value) ? [value] : [];
          } catch {
            return [];
          }
        });
    } finally {
      await handle.close();
    }
  }

  private async readThreadRaw(threadId: string, turnLimit: number): Promise<DesktopThreadSnapshot> {
    const callerThreadId = await this.resolveControllerThread(threadId);
    return this.callToolJson<DesktopThreadSnapshot>(callerThreadId, "read_thread", {
      threadId,
      turnLimit,
      includeOutputs: false,
      maxOutputCharsPerItem: 8_000,
    });
  }

  async healthCheck(): Promise<{ socketConnected: true; controllerThreadId: string }> {
    const controllerThreadId = await this.resolveControllerThread("");
    return { socketConnected: true, controllerThreadId };
  }

  private async resolveControllerThread(targetThreadId: string): Promise<string> {
    if (this.controllerThreadId && this.controllerThreadId !== targetThreadId) return this.controllerThreadId;

    const bootstrapCaller = targetThreadId || this.controllerThreadId;
    if (!bootstrapCaller) {
      const fallback = await this.readRecentThreadIdFromRollouts();
      if (!fallback) throw new Error("找不到可用于连接 Codex Desktop 的本机会话。");
      this.controllerThreadId = fallback;
    }
    const caller = bootstrapCaller || this.controllerThreadId;
    if (!caller) throw new Error("找不到 Codex Desktop 调用会话。");

    const catalog = await this.callToolJson<{
      pinnedThreads?: DesktopThreadSummary[];
      threads?: DesktopThreadSummary[];
    }>(caller, "list_threads", { limit: 50 });
    const threads = [...(catalog.pinnedThreads ?? []), ...(catalog.threads ?? [])];
    const controller = threads.find(
      (thread) => thread.kind === "codex" && thread.id !== targetThreadId && (!thread.hostId || thread.hostId === "local"),
    );
    this.controllerThreadId = controller?.id ?? caller;
    return this.controllerThreadId;
  }

  private async readRecentThreadIdFromRollouts(): Promise<string | null> {
    const sessionsRoot = join(homedir(), ".codex", "sessions");
    const candidates: Array<{ path: string; mtimeMs: number }> = [];
    await collectRecentJsonl(sessionsRoot, candidates, 80);
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const candidate of candidates.slice(0, 20)) {
      const match = /rollout-.*-([0-9a-f-]{36})\.jsonl$/i.exec(candidate.path);
      if (match?.[1]) return match[1];
    }
    return null;
  }

  private async callToolJson<T>(callerThreadId: string, tool: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.callTool(callerThreadId, tool, args);
    const text = result.contentItems.find((item): item is { type: "inputText"; text: string } => item.type === "inputText")?.text;
    if (!text) throw new Error(`Codex Desktop 工具 ${tool} 没有返回文本结果。`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Codex Desktop 工具 ${tool} 返回了无效 JSON。`);
    }
  }

  private async callTool(
    callerThreadId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const result = await this.request<ToolResult>({
      method: "call",
      tool,
      callerThreadId,
      arguments: args,
    });
    if (!result.success) {
      const message = result.contentItems
        .filter((item): item is { type: "inputText"; text: string } => item.type === "inputText")
        .map((item) => item.text)
        .join("\n");
      throw new Error(message || `Codex Desktop 工具 ${tool} 执行失败。`);
    }
    return result;
  }

  private async startHelper(socketPath: string): Promise<void> {
    const nodePath = process.env.CODEX_DESKTOP_NODE?.trim() || DEFAULT_CUA_NODE;
    if (!existsSync(nodePath)) throw new Error(`找不到 Codex Desktop Node：${nodePath}`);
    const helperPath = fileURLToPath(new URL("./desktop-helper.mjs", import.meta.url));
    if (!existsSync(helperPath)) throw new Error(`找不到 Desktop helper：${helperPath}`);

    const child = spawn(nodePath, [helperPath], {
      env: { ...process.env, CODEX_APP_TOOLS_PIPE_PATH: socketPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) this.logger.warn("Codex Desktop helper 输出", message);
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.lines?.close();
      this.lines = null;
      this.rejectPending(new Error(`Codex Desktop helper 已退出（code=${String(code)}, signal=${String(signal)}）`));
    });
  }

  private async connectHelperDaemon(): Promise<void> {
    const path = process.env.CODEX_FEISHU_HELPER_SOCKET?.trim() || DEFAULT_HELPER_SOCKET;
    const socket = net.createConnection(path);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("连接 Desktop helper 超时"));
      }, 2_000);
      timer.unref();
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    this.bridgeSocket = socket;
    this.lines = createInterface({ input: socket, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.handleLine(line));
    socket.once("close", () => {
      if (this.bridgeSocket !== socket) return;
      this.bridgeSocket = null;
      this.lines?.close();
      this.lines = null;
      this.rejectPending(new Error("Codex Desktop helper 常驻连接已关闭。"));
    });
  }

  private request<T>(payload: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const child = this.child;
    const socket = this.bridgeSocket;
    if ((!child?.stdin || child.stdin.destroyed) && (!socket || socket.destroyed)) {
      return Promise.reject(new Error("Codex Desktop helper 未连接。"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex Desktop 工具调用超时。"));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      const line = `${JSON.stringify({ id, desktopPipePath: this.desktopPipePath, ...payload })}\n`;
      if (socket && !socket.destroyed) socket.write(line);
      else child?.stdin.write(line);
    });
  }

  private handleLine(line: string): void {
    let response: HelperResponse;
    try {
      response = JSON.parse(line) as HelperResponse;
    } catch {
      this.logger.warn("忽略 Codex Desktop helper 的无效输出", line.slice(0, 500));
      return;
    }
    if (typeof response.id !== "number") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.error) pending.reject(new Error(response.error.message || "Codex Desktop helper 请求失败。"));
    else pending.resolve(response.result);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async stopHelper(): Promise<void> {
    const socket = this.bridgeSocket;
    this.bridgeSocket = null;
    socket?.destroy();
    const child = this.child;
    this.child = null;
    this.lines?.close();
    this.lines = null;
    this.rejectPending(new Error("Codex Desktop helper 已停止。"));
    if (!child) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_000);
      timer.unref();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export async function discoverDesktopSocketPaths(): Promise<string[]> {
  // Codex Desktop 在 macOS 上固定使用 /tmp；os.tmpdir() 通常指向 /var/folders/...，两者并不相同。
  const directory = "/tmp/codex-app-tools";
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch {
    return [];
  }
  const sockets = await Promise.all(
    names
      .filter((name) => name.endsWith(".sock"))
      .map(async (name) => {
        const path = join(directory, name);
        try {
          const stat = await fs.stat(path);
          return { path, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      }),
  );
  return sockets
    .filter((entry): entry is { path: string; mtimeMs: number } => entry !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((entry) => entry.path);
}

async function collectRecentJsonl(
  directory: string,
  output: Array<{ path: string; mtimeMs: number }>,
  limit: number,
): Promise<void> {
  if (output.length >= limit) return;
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (output.length >= limit) break;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectRecentJsonl(path, output, limit);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      try {
        const stat = await fs.stat(path);
        output.push({ path, mtimeMs: stat.mtimeMs });
      } catch {
        // 文件可能正在被 Codex Desktop 轮换，忽略即可。
      }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openDesktopThread(threadId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) throw new DesktopThreadUnavailableError(threadId, "无效的 Codex 会话 ID。");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/open", [`codex://threads/${threadId}`], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`无法打开 Codex Desktop 会话（exit=${String(code)}）。`));
    });
  });
}

async function findRolloutForThread(directory: string, threadId: string): Promise<string | null> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findRolloutForThread(path, threadId);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(threadId)) {
      return path;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
