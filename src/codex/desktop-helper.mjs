import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { createInterface } from "node:readline";
import net from "node:net";
import { discoverParentDesktopPipePath } from "./parent-pipe.mjs";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
// User MCP environments may omit the Desktop pipe variable. The helper is
// Desktop-owned, so discover it only from the current process ancestry and
// accept only a current-user Unix socket in the app-tools directory.
const pipePath = process.env.CODEX_APP_TOOLS_PIPE_PATH?.trim() || discoverParentDesktopPipePath();
const bridgeSocketPath = process.env.CODEX_FEISHU_HELPER_SOCKET?.trim();
// Each Desktop-owned MCP process owns its own socket. No shared pathname can
// disappear when another session's helper exits; clients discover all owners.
const ownedSocketPath = bridgeSocketPath
  ? join(dirname(bridgeSocketPath), `${basename(bridgeSocketPath, ".sock")}-${process.pid}.sock`)
  : null;

if (!pipePath) {
  process.stderr.write("缺少由 Codex Desktop 注入的 CODEX_APP_TOOLS_PIPE_PATH\n");
  process.exit(2);
}

class NativePipeClient {
  constructor(path) {
    this.path = path;
    this.socket = null;
    this.connecting = null;
    this.pending = new Map();
    this.pendingData = Buffer.alloc(0);
    this.nextId = 1;
  }

  async request(method, params) {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error("Codex Desktop 通道已关闭");

    const id = this.nextId++;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.onDisconnect(socket, new Error("Codex Desktop 通道请求超时"));
      }, 18_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
    socket.write(encodeFrame(JSON.stringify({ jsonrpc: "2.0", id, method, params })));
    return response;
  }

  async connect() {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection(this.path);
      const timer = setTimeout(() => fail(new Error("Codex Desktop 通道连接超时")), 2_000);
      const fail = (error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      socket.once("error", fail);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.off("error", fail);
        this.socket = socket;
        this.connecting = null;
        socket.on("data", (chunk) => this.onData(socket, chunk));
        socket.on("error", (error) => this.onDisconnect(socket, error));
        socket.on("close", () => this.onDisconnect(socket, new Error("Codex Desktop 通道已关闭")));
        resolve();
      });
    }).catch((error) => {
      this.connecting = null;
      throw error;
    });
    return this.connecting;
  }

  onData(socket, chunk) {
    if (socket !== this.socket) return;
    this.pendingData = Buffer.concat([this.pendingData, chunk]);
    while (this.pendingData.length >= 4) {
      const length = this.pendingData.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) {
        this.onDisconnect(socket, new Error("Codex Desktop 返回的数据过大"));
        socket.destroy();
        return;
      }
      if (this.pendingData.length < length + 4) return;
      const payload = this.pendingData.subarray(4, length + 4);
      this.pendingData = this.pendingData.subarray(length + 4);

      let message;
      try {
        message = JSON.parse(payload.toString("utf8"));
      } catch {
        this.onDisconnect(socket, new Error("Codex Desktop 返回了无效 JSON"));
        socket.destroy();
        return;
      }
      const pending = this.pending.get(Number(message.id));
      if (!pending) continue;
      this.pending.delete(Number(message.id));
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || "Codex Desktop 工具调用失败"));
      else pending.resolve(message.result);
    }
  }

  onDisconnect(socket, error) {
    if (socket !== this.socket) return;
    this.socket = null;
    socket.destroy();
    this.pendingData = Buffer.alloc(0);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    if (this.socket) this.onDisconnect(this.socket, new Error("Codex Desktop 通道已关闭"));
  }
}

function encodeFrame(text) {
  const payload = Buffer.from(text, "utf8");
  if (payload.length > MAX_FRAME_BYTES) throw new Error("Codex Desktop 请求过大");
  const frame = Buffer.alloc(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

const nativeByPath = new Map();
const toolsByPath = new Map();

function getNative() {
  // 只允许连接 Desktop 注入给当前受信任 MCP 进程的 pipe。
  // 不接受桥接客户端传入的路径，避免新版 Desktop 的进程身份校验
  // 拒绝连接，也避免误连 /tmp 中其他账号或旧宿主遗留的 socket。
  const targetPath = pipePath;
  let native = nativeByPath.get(targetPath);
  if (!native) {
    native = new NativePipeClient(targetPath);
    nativeByPath.set(targetPath, native);
  }
  return { native, targetPath };
}

async function listTools() {
  const { native, targetPath } = getNative();
  const result = await native.request("tools/list", { threadStartKind: "all" });
  if (!result || !Array.isArray(result.tools)) throw new Error("Codex Desktop 工具目录无效");
  toolsByPath.set(targetPath, new Map(result.tools.map((tool) => [tool.name, tool])));
  return result.tools;
}

async function callTool(request) {
  const { native, targetPath } = getNative();
  if (!toolsByPath.has(targetPath)) await listTools();
  const toolsByName = toolsByPath.get(targetPath);
  const tool = toolsByName.get(request.tool);
  if (!tool) throw new Error(`Codex Desktop 不支持工具：${request.tool}`);
  return native.request("tools/call", {
    arguments: request.arguments ?? {},
    callerSource: "codex",
    callId: request.callId || `feishu-${randomUUID()}`,
    namespace: tool.namespace,
    threadId: request.callerThreadId,
    tool: request.tool,
    turnId: request.turnId || `feishu-${randomUUID()}`,
  });
}

async function handle(message) {
  if (message.method === "ping") {
    const tools = await listTools();
    return { tools: tools.map((tool) => tool.name) };
  }
  if (message.method === "call") return callTool(message);
  throw new Error(`不支持的 helper 方法：${message.method}`);
}

function handleLine(line, send) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ id: null, error: { message: "无效 JSON" } });
    return;
  }
  Promise.resolve(handle(message)).then(
    (result) => send({ id: message.id, result }),
    (error) => send({ id: message.id, error: { message: error instanceof Error ? error.message : String(error) } }),
  );
}

let bridgeServer = null;
if (bridgeSocketPath) {
  // 在受信任的 Codex 进程链仍然存在时提前建立 Desktop 连接；宿主会校验连接方进程来源。
  if (pipePath) await listTools({}).catch((error) => process.stderr.write(`Desktop 预连接失败，将在请求时重试：${error.message}\n`));
  mkdirSync(dirname(bridgeSocketPath), { recursive: true, mode: 0o700 });
  {
    bridgeServer = net.createServer((socket) => {
      socket.on("error", () => socket.destroy());
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk;
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) handleLine(line, (response) => {
            if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
          });
        }
      });
    });
    bridgeServer.listen(ownedSocketPath, () => chmodSync(ownedSocketPath, 0o600));
  }

  // 作为 Codex Desktop 的轻量 MCP 常驻进程运行。Desktop 负责启动它，因此满足本地通道的进程校验。
  const mcpLines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  mcpLines.on("line", (line) => {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return;
    }
    if (request.method === "initialize" && request.id != null) {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: request.params?.protocolVersion || "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "codex-feishu-desktop-bridge", version: "0.2.0" },
          },
        })}\n`,
      );
    } else if (request.method === "tools/list" && request.id != null) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [] } })}\n`);
    } else if (request.method === "ping" && request.id != null) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} })}\n`);
    }
  });
} else {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => handleLine(line, (response) => process.stdout.write(`${JSON.stringify(response)}\n`)));
}

function shutdown() {
  for (const native of nativeByPath.values()) native.close();
  bridgeServer?.close();
  if (ownedSocketPath && bridgeServer) {
    try {
      unlinkSync(ownedSocketPath);
    } catch {
      // 已经不存在。
    }
  }
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
if (!bridgeSocketPath) process.stdin.once("end", shutdown);
