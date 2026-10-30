import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { createInterface, type Interface } from "node:readline";
import net, { type Socket } from "node:net";
import type { Logger } from "../logger.js";

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
  private bridgeSocket: Socket | null = null;
  private lines: Interface | null = null;
  private desktopPipePath: string | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private controllerThreadId: string | null = null;
  private reconnecting: Promise<void> | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private recoveryThreadIds: string[] = [];
  private lastWakeAt = 0;
  private wakeCandidateOffset = 0;
  private readonly temporaryExternalPins = new Set<string>();

  constructor(private readonly logger: Logger, private readonly options: {
    socketDirectory?: string;
    helperSocketPath?: string;
    healthIntervalMs?: number;
    wakeDesktop?: (threadId: string) => Promise<void>;
    recoveryCandidates?: () => Promise<string[]>;
    wakeCooldownMs?: number;
    wakeTimeoutMs?: number;
    wakePollMs?: number;
  } = {}) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.reconnect();
    if (!this.healthTimer && !this.stopped) {
      this.healthTimer = setInterval(() => {
        if (this.pending.size || this.reconnecting) return;
        void this.healthCheck().catch((error) => this.logger.warn("Desktop 后台探活失败，将自动重试", errorMessage(error)));
      }, this.options.healthIntervalMs ?? 30_000);
      this.healthTimer.unref();
    }
  }

  private reconnect(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("Codex Desktop 客户端已停止"));
    if (!this.reconnecting) {
      this.reconnecting = this.connectOrWakeDesktop().finally(() => { this.reconnecting = null; });
    }
    return this.reconnecting;
  }

  private async connectOrWakeDesktop(): Promise<void> {
    try { await this.connectAvailableHelper(); return; }
    catch (initialError) {
      if (this.stopped || !isDesktopTransportError(initialError)) throw initialError;
      const cooldown = this.options.wakeCooldownMs ?? 60_000;
      if (this.lastWakeAt && Date.now() - this.lastWakeAt < cooldown) throw initialError;
      this.lastWakeAt = Date.now();
      const fallback = await (this.options.recoveryCandidates?.() ?? this.readRecentThreadIdsFromRollouts());
      const cached = this.options.recoveryCandidates
        ? this.recoveryThreadIds.filter((id) => fallback.includes(id)) : this.recoveryThreadIds;
      const allCandidates = [...new Set([...cached, ...fallback])]
        .filter((id) => /^[0-9a-f-]{36}$/i.test(id));
      const offset = this.wakeCandidateOffset % Math.max(1, allCandidates.length);
      const candidates = [...allCandidates.slice(offset), ...allCandidates.slice(0, offset)].slice(0, 3);
      this.wakeCandidateOffset = offset + candidates.length;
      let lastError: unknown = initialError;
      // Opening an existing cold thread lets Desktop start its own MCP helper.
      // Never launch a detached replacement with untrusted process ancestry,
      // send a prompt, or create/fork a thread to recover the transport.
      for (const threadId of candidates) {
        if (this.stopped) break;
        this.logger.warn("Desktop helper 全部不可用，正在通过会话链接唤醒", { threadId });
        try { await (this.options.wakeDesktop ?? openDesktopThread)(threadId); }
        catch (error) { lastError = error; continue; }
        const deadline = Date.now() + (this.options.wakeTimeoutMs ?? 8_000);
        while (!this.stopped && Date.now() < deadline) {
          await delay(this.options.wakePollMs ?? 1_000);
          if (this.stopped) break;
          try {
            await this.connectAvailableHelper();
            this.recoveryThreadIds = [threadId, ...this.recoveryThreadIds.filter((id) => id !== threadId)];
            this.logger.info("Desktop helper 已由桌面会话重新启动，连接恢复", { threadId });
            return;
          } catch (error) { lastError = error; }
        }
      }
      // Throttle from the end of the attempt, including slow Desktop launches.
      this.lastWakeAt = Date.now();
      throw new Error(`Desktop 自动唤醒暂未成功，将继续后台恢复：${errorMessage(lastError)}`);
    }
  }

  private async connectAvailableHelper(): Promise<void> {
    await this.stopHelper();
    this.controllerThreadId = null;
    const socketPaths = await discoverDesktopSocketPaths(this.options.socketDirectory);
    if (socketPaths.length === 0) {
      throw new Error("没有发现 Codex Desktop 本地通道，请先启动并登录 Codex Desktop。");
    }

    const helperPaths = await discoverHelperSocketPaths(this.options.helperSocketPath
      ?? process.env.CODEX_FEISHU_HELPER_SOCKET?.trim() ?? DEFAULT_HELPER_SOCKET);
    const errors: string[] = [];
    for (const helperPath of helperPaths) {
      if (this.stopped) break;
      try { await this.connectHelperDaemon(helperPath); }
      catch (error) { errors.push(errorMessage(error)); continue; }
      for (const socketPath of socketPaths) {
        if (this.stopped) break;
        try {
          this.desktopPipePath = socketPath;
          const ping = await this.request<{ tools?: string[] }>({ method: "ping" }, 5_000);
          const required = ["send_message_to_thread", "read_thread", "list_threads", "list_projects", "create_thread"];
          if (!required.every((name) => ping.tools?.includes(name))) {
            throw new Error("Codex Desktop 缺少会话互通工具，请升级桌面应用。");
          }
          this.logger.info("Codex Desktop 实时会话通道已连接", { socketPath, helperPath });
          return;
        } catch (error) {
          errors.push(errorMessage(error));
          this.logger.warn("Codex Desktop 通道候选连接失败", { socketPath, error: errorMessage(error) });
        }
      }
      await this.stopHelper();
    }
    await this.stopHelper();
    throw new Error(`无法连接 Codex Desktop 实时会话通道，服务会自动重连。请保持 Desktop 运行。${errors.slice(0, 2).join("；") || "Desktop helper 尚未启动"}`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    await this.reconnecting?.catch(() => {});
    await this.stopHelper();
  }

  async sendMessage(threadId: string, prompt: string): Promise<void> {
    await this.ensureThreadLoaded(threadId);
    const callerThreadId = await this.resolveControllerThread(threadId);
    // Never replay a mutation after an ambiguous disconnect/timeout.
    await this.callTool(callerThreadId, "send_message_to_thread", { threadId, prompt });
  }

  async readThread(threadId: string, turnLimit = 3): Promise<DesktopThreadSnapshot> {
    await this.ensureThreadLoaded(threadId);
    return this.readThreadRaw(threadId, turnLimit);
  }

  async refreshExternalThread(threadId: string, turnLimit = 3): Promise<DesktopThreadSnapshot> {
    // 通过 Desktop 自己的工具读取一次，共享 App Server 新建的会话便会进入 Desktop 的实时索引。
    // 与 readThread 不同，这里失败时不通过深链强制切换用户当前正在看的页面。
    return this.readThreadRaw(threadId, turnLimit);
  }

  async ensureThreadLoaded(threadId: string): Promise<void> {
    try {
      await this.readThreadRaw(threadId, 1);
      return;
    } catch (initialError) {
      if (isDesktopTransportError(initialError)) throw initialError;
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
          if (isDesktopTransportError(error)) throw error;
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

  async moveThreadToProject(threadId: string, projectId: string): Promise<void> {
    const callerThreadId = await this.resolveControllerThread(threadId);
    await this.callTool(callerThreadId, "move_thread_to_project", {
      threadId,
      projectId,
    });
  }

  async registerExternalThread(threadId: string, projectId: string): Promise<void> {
    try {
      await this.refreshExternalThread(threadId, 1);
      try { await this.moveThreadToProject(threadId, projectId); return; }
      catch (error) {
        if (!/not available in the sidebar/i.test(errorMessage(error))) throw error;
      }
      const caller = await this.resolveControllerThread(threadId);
      const catalog = await this.callToolJson<{ pinnedThreads?: DesktopThreadSummary[] }>(caller, "list_threads", { limit: 1 });
      const alreadyPinned = catalog.pinnedThreads?.some((thread) => thread.id === threadId) ?? false;
      // A normal pin hydrates the sidebar without resuming a writer. Remember
      // cleanup across retries if the unpin response is lost during reconnect.
      if (!alreadyPinned) {
        this.temporaryExternalPins.add(threadId);
        await this.callTool(caller, "set_thread_pinned", { threadId, pinned: true });
      }
      await this.moveThreadToProject(threadId, projectId);
    } finally {
      if (this.temporaryExternalPins.has(threadId)) {
        const caller = await this.resolveControllerThread(threadId);
        await this.callTool(caller, "set_thread_pinned", { threadId, pinned: false });
        this.temporaryExternalPins.delete(threadId);
      }
    }
  }

  async setThreadTitle(threadId: string, title: string): Promise<void> {
    const callerThreadId = await this.resolveControllerThread(threadId);
    await this.callTool(callerThreadId, "set_thread_title", { threadId, title });
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
    await this.ensureHelperConnected();
    try { await this.request({ method: "ping" }, 5_000); }
    catch { await this.reconnect(); }
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
    const localThreads = threads.filter((thread) => thread.kind === "codex" && (!thread.hostId || thread.hostId === "local"));
    this.recoveryThreadIds = [...new Set([
      ...this.recoveryThreadIds,
      ...localThreads.filter((thread) => thread.id !== targetThreadId).map((thread) => thread.id),
    ])].slice(0, 10);
    const controller = threads.find(
      (thread) => thread.kind === "codex" && thread.id !== targetThreadId && (!thread.hostId || thread.hostId === "local"),
    );
    this.controllerThreadId = controller?.id ?? caller;
    return this.controllerThreadId;
  }

  private async readRecentThreadIdFromRollouts(): Promise<string | null> {
    return (await this.readRecentThreadIdsFromRollouts())[0] ?? null;
  }

  private async readRecentThreadIdsFromRollouts(): Promise<string[]> {
    const sessionsRoot = join(homedir(), ".codex", "sessions");
    const candidates: Array<{ path: string; mtimeMs: number }> = [];
    await collectRecentJsonl(sessionsRoot, candidates, 80);
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const ids: string[] = [];
    for (const candidate of candidates.slice(0, 20)) {
      const match = /rollout-.*-([0-9a-f-]{36})\.jsonl$/i.exec(candidate.path);
      if (match?.[1]) ids.push(match[1]);
    }
    return ids;
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
    await this.ensureHelperConnected();
    const readonly = ["read_thread", "list_threads", "list_projects"].includes(tool);
    if (!readonly) {
      // A harmless probe may reconnect before a mutation is sent. Once sent,
      // a lost reply is ambiguous and must never trigger automatic resubmission.
      try { await this.request({ method: "ping" }, 5_000); }
      catch { await this.reconnect(); }
    }
    const payload = {
      method: "call",
      tool,
      callerThreadId,
      arguments: args,
    };
    let result: ToolResult;
    try { result = await this.request<ToolResult>(payload); }
    catch (error) {
      if (!isDesktopTransportError(error)) throw error;
      if (!readonly) {
        throw new Error(`Desktop 连接中断，${tool} 的执行结果尚未确认；为避免重复执行未自动重发。${errorMessage(error)}`);
      }
      await this.reconnect();
      result = await this.request<ToolResult>(payload);
    }
    if (!result.success) {
      const message = result.contentItems
        .filter((item): item is { type: "inputText"; text: string } => item.type === "inputText")
        .map((item) => item.text)
        .join("\n");
      throw new Error(message || `Codex Desktop 工具 ${tool} 执行失败。`);
    }
    return result;
  }

  private async ensureHelperConnected(): Promise<void> {
    if (this.stopped) throw new Error("Codex Desktop 客户端已停止");
    if (this.reconnecting) return this.reconnecting;
    const daemonConnected = Boolean(this.bridgeSocket && !this.bridgeSocket.destroyed);
    if (daemonConnected) return;
    await this.reconnect();
  }

  private async connectHelperDaemon(path: string): Promise<void> {
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
        socket.destroy();
        reject(error);
      });
    });
    this.bridgeSocket = socket;
    socket.on("error", (error) => {
      if (this.bridgeSocket === socket) this.rejectPending(error);
      socket.destroy();
    });
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
    const socket = this.bridgeSocket;
    if (!socket || socket.destroyed) {
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
      socket.write(line, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
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
    this.lines?.close();
    this.lines = null;
    this.rejectPending(new Error("Codex Desktop helper 已停止。"));
  }
}

export async function discoverDesktopSocketPaths(directory = "/tmp/codex-app-tools"): Promise<string[]> {
  // Codex Desktop 在 macOS 上固定使用 /tmp；os.tmpdir() 通常指向 /var/folders/...，两者并不相同。
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

export function isDesktopTransportError(error: unknown): boolean {
  const code = isRecord(error) ? error.code : undefined;
  if (typeof code === "string" && ["ECONNREFUSED", "ECONNRESET", "ENOENT", "EPIPE", "ETIMEDOUT",
    "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END", "ERR_STREAM_PREMATURE_CLOSE", "ERR_SOCKET_CLOSED"].includes(code)) return true;
  return /ECONNREFUSED|ECONNRESET|ENOENT|EPIPE|stream (?:was )?(?:destroyed|closed)|write after end|socket is closed|连接|通道|调用超时|Desktop 自动唤醒|helper.*(?:关闭|停止|退出|未连接)/i.test(errorMessage(error));
}

export async function discoverHelperSocketPaths(base: string): Promise<string[]> {
  const directory = dirname(base);
  const prefix = `${basename(base, ".sock")}-`;
  let names: string[];
  try { names = await fs.readdir(directory); } catch { return [base]; }
  const entries = await Promise.all(names.filter((name) => name.startsWith(prefix) && name.endsWith(".sock"))
    .map(async (name) => {
      const path = join(directory, name);
      try { const stat = await fs.stat(path); return stat.isSocket() ? { path, time: stat.mtimeMs } : null; }
      catch { return null; }
    }));
  return [...entries.filter((entry) => entry !== null).sort((a, b) => b.time - a.time).map((entry) => entry.path), base];
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
  // Session directories use YYYY/MM/DD names; visit newest first before
  // applying the scan limit, otherwise "recent" selects years-old sessions.
  entries.sort((a, b) => b.name.localeCompare(a.name));
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
    const child = spawn("/usr/bin/open", ["-g", `codex://threads/${threadId}`], { stdio: "ignore" });
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
