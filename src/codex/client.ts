import { EventEmitter } from "node:events";
import type { Logger } from "../logger.js";
import { discoverCodexBinary } from "./discovery.js";
import { JsonlRpcProcess } from "./jsonl-rpc.js";
import type {
  ApprovalRequest,
  CodexNotification,
  CodexProject,
  CodexServerRequest,
  CodexThread,
  JsonRpcId,
  ProjectListResponse,
  CodexUserInput,
  ThreadListResponse,
  ThreadResponse,
  TurnStartResponse,
} from "./types.js";

export type DynamicToolSpec = {
  type: "function";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type DynamicToolCall = {
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments: unknown;
};

export type DynamicToolResult = {
  success: boolean;
  contentItems: Array<{ type: "inputText"; text: string }>;
};

type CodexClientOptions = {
  processArgs?: string[];
  processEnv?: NodeJS.ProcessEnv;
  dynamicToolHandler?: (call: DynamicToolCall) => Promise<DynamicToolResult>;
};

const approvalMethods = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);

export class CodexClient extends EventEmitter {
  private readonly rpc: JsonlRpcProcess;
  private readonly loadedThreads = new Set<string>();

  constructor(configuredBinary: string | undefined, private readonly logger: Logger, private readonly options: CodexClientOptions = {}) {
    super();
    const binary = discoverCodexBinary(configuredBinary);
    this.rpc = new JsonlRpcProcess(
      binary,
      options.processArgs ?? ["app-server", "--stdio"],
      logger,
      options.processEnv ?? process.env,
    );
    this.rpc.on("notification", (notification: CodexNotification) => this.emit("notification", notification));
    this.rpc.on("serverRequest", (request: CodexServerRequest) => this.handleServerRequest(request));
    this.rpc.on("exit", (error: Error) => this.emit("exit", error));
  }

  start(): Promise<void> {
    return this.rpc.start();
  }

  stop(): Promise<void> {
    return this.rpc.stop();
  }

  async listThreads(
    limit = 50,
    cursor?: string,
    options: { archived?: boolean; projectId?: string | null } = {},
  ): Promise<ThreadListResponse> {
    const projectFilter = Object.prototype.hasOwnProperty.call(options, "projectId")
      ? { projectId: options.projectId }
      : {};
    return this.rpc.request("thread/list", {
      limit,
      ...(cursor ? { cursor } : {}),
      ...projectFilter,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived: options.archived ?? false,
    });
  }

  async listAllThreads(options: { includeArchived?: boolean } = {}): Promise<CodexThread[]> {
    const active = await this.collectThreads(false);
    if (!options.includeArchived) return active;
    const archived = (await this.collectThreads(true)).map((thread) => ({ ...thread, archived: true }));
    return [...active, ...archived].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async listProjects(): Promise<CodexProject[]> {
    const projects: CodexProject[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.rpc.request<ProjectListResponse>("project/list", {
        limit: 100,
        ...(cursor ? { cursor } : {}),
        sortKey: "position",
        sortDirection: "asc",
      });
      projects.push(...response.data);
      cursor = response.nextCursor ?? undefined;
    } while (cursor);
    return projects;
  }

  async readProject(projectId: string): Promise<CodexProject> {
    const response = await this.rpc.request<{ project: CodexProject }>("project/read", { projectId });
    return response.project;
  }

  async createProject(name: string, roots: string[], idempotencyKey: string): Promise<CodexProject> {
    const response = await this.rpc.request<{ project: CodexProject }>("project/create", {
      name,
      roots: roots.map((path) => ({ path })),
      metadata: {},
      idempotencyKey,
    });
    return response.project;
  }

  async readThread(threadId: string): Promise<CodexThread> {
    const response = await this.rpc.request<{ thread: CodexThread }>("thread/read", {
      threadId,
      includeTurns: false,
    });
    return response.thread;
  }

  async ensureThreadLoaded(threadId: string): Promise<void> {
    if (this.loadedThreads.has(threadId)) return;
    await this.rpc.request<ThreadResponse>("thread/resume", {
      threadId,
      excludeTurns: true,
      approvalPolicy: "on-request",
    });
    this.loadedThreads.add(threadId);
  }

  async createThread(cwd: string, projectId?: string): Promise<CodexThread> {
    const response = await this.rpc.request<ThreadResponse>("thread/start", {
      cwd,
      ...(projectId ? { projectId } : {}),
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      ephemeral: false,
    });
    this.loadedThreads.add(response.thread.id);
    return response.thread;
  }

  async createReadOnlyThread(
    cwd: string,
    developerInstructions: string,
    dynamicTools: DynamicToolSpec[],
    ephemeral = false,
    projectId?: string,
  ): Promise<CodexThread> {
    const response = await this.rpc.request<ThreadResponse>("thread/start", {
      cwd,
      ...(projectId ? { projectId } : {}),
      runtimeWorkspaceRoots: [cwd],
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions,
      dynamicTools,
      environments: [],
      ephemeral,
    });
    this.loadedThreads.add(response.thread.id);
    return response.thread;
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    await this.rpc.request("thread/name/set", { threadId, name });
  }

  async ensureReadOnlyThreadLoaded(
    threadId: string,
    cwd: string,
    developerInstructions?: string,
    dynamicTools?: DynamicToolSpec[],
  ): Promise<void> {
    if (this.loadedThreads.has(threadId)) return;
    await this.rpc.request<ThreadResponse>("thread/resume", {
      threadId,
      excludeTurns: true,
      cwd,
      runtimeWorkspaceRoots: [cwd],
      approvalPolicy: "never",
      sandbox: "read-only",
      ...(developerInstructions ? { developerInstructions } : {}),
      ...(dynamicTools ? { dynamicTools } : {}),
      environments: [],
    });
    this.loadedThreads.add(threadId);
  }

  async startReadOnlyTurn(
    threadId: string,
    cwd: string,
    text: string,
    developerInstructions?: string,
    dynamicTools?: DynamicToolSpec[],
    imageDataUrls: string[] = [],
  ): Promise<string> {
    await this.ensureReadOnlyThreadLoaded(threadId, cwd, developerInstructions, dynamicTools);
    const input: CodexUserInput[] = [
      { type: "text", text, text_elements: [] },
      ...imageDataUrls.map((url): CodexUserInput => ({ type: "image", url, detail: "high" })),
    ];
    const response = await this.rpc.request<TurnStartResponse>("turn/start", {
      threadId,
      input,
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      runtimeWorkspaceRoots: [cwd],
      environments: [],
      turnTrigger: "feishu_guest",
    });
    return response.turn.id;
  }

  async forkThread(
    threadId: string,
    options: { projectId?: string; beforeTurnId?: string } = {},
  ): Promise<CodexThread> {
    const response = await this.rpc.request<ThreadResponse>("thread/fork", {
      threadId,
      ...(options.beforeTurnId ? { beforeTurnId: options.beforeTurnId } : {}),
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      ephemeral: false,
      excludeTurns: true,
      deferGoalContinuation: true,
    });
    const fork = response.thread;
    this.loadedThreads.add(fork.id);

    if (options.projectId) {
      await this.rpc.request("thread/metadata/update", {
        threadId: fork.id,
        projectId: options.projectId,
      });
      fork.projectId = options.projectId;
    }
    const sourceName = fork.name?.trim() || "并行会话";
    const name = sourceName.endsWith("（飞书并行）") ? sourceName : `${sourceName}（飞书并行）`;
    await this.rpc.request("thread/name/set", { threadId: fork.id, name });
    fork.name = name;
    return fork;
  }

  private async collectThreads(archived: boolean): Promise<CodexThread[]> {
    const threads: CodexThread[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.listThreads(100, cursor, { archived });
      threads.push(...response.data);
      cursor = response.nextCursor ?? undefined;
    } while (cursor);
    return threads;
  }

  async startTurn(threadId: string, text: string): Promise<string> {
    await this.ensureThreadLoaded(threadId);
    const response = await this.rpc.request<TurnStartResponse>("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      approvalPolicy: "on-request",
      turnTrigger: "feishu",
    });
    return response.turn.id;
  }

  interruptTurn(threadId: string, turnId: string): Promise<unknown> {
    return this.rpc.request("turn/interrupt", { threadId, turnId });
  }

  unarchiveThread(threadId: string): Promise<unknown> {
    return this.rpc.request("thread/unarchive", { threadId });
  }

  archiveThread(threadId: string): Promise<unknown> {
    this.loadedThreads.delete(threadId);
    return this.rpc.request("thread/archive", { threadId });
  }

  unsubscribeThread(threadId: string): Promise<unknown> {
    this.loadedThreads.delete(threadId);
    return this.rpc.request("thread/unsubscribe", { threadId });
  }

  resolveApproval(rpcId: JsonRpcId, decision: "accept" | "decline" | "cancel"): void {
    this.rpc.respond(rpcId, { decision });
  }

  private handleServerRequest(request: CodexServerRequest): void {
    if (request.method === "item/tool/call") {
      void this.handleDynamicToolCall(request);
      return;
    }
    if (!approvalMethods.has(request.method)) {
      this.logger.warn("收到暂不支持的 Codex 服务端请求，已拒绝", request);
      this.rpc.respondError(request.id, -32601, `Unsupported server request: ${request.method}`);
      return;
    }

    const params = request.params ?? {};
    const threadId = stringValue(params.threadId);
    const turnId = stringValue(params.turnId);
    if (!threadId || !turnId) {
      this.rpc.respond(request.id, { decision: "decline" });
      return;
    }

    const approval: ApprovalRequest = {
      rpcId: request.id,
      method: request.method,
      threadId,
      turnId,
      command: nullableString(params.command),
      cwd: nullableString(params.cwd),
      reason: nullableString(params.reason),
      grantRoot: nullableString(params.grantRoot),
      raw: params,
    };
    this.emit("approval", approval);
  }

  private async handleDynamicToolCall(request: CodexServerRequest): Promise<void> {
    if (!this.options.dynamicToolHandler) {
      this.rpc.respond(request.id, {
        success: false,
        contentItems: [{ type: "inputText", text: "Dynamic tools are disabled." }],
      });
      return;
    }
    const params = request.params ?? {};
    const threadId = stringValue(params.threadId);
    const turnId = stringValue(params.turnId);
    const callId = stringValue(params.callId);
    const tool = stringValue(params.tool);
    if (!threadId || !turnId || !callId || !tool) {
      this.rpc.respond(request.id, {
        success: false,
        contentItems: [{ type: "inputText", text: "Invalid dynamic tool request." }],
      });
      return;
    }
    try {
      const result = await this.options.dynamicToolHandler({
        threadId,
        turnId,
        callId,
        tool,
        arguments: params.arguments,
      });
      this.rpc.respond(request.id, result);
    } catch (error) {
      this.rpc.respond(request.id, {
        success: false,
        contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : String(error) }],
      });
    }
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
