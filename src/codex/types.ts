export type JsonRpcId = number | string;

export type CodexThread = {
  id: string;
  projectId?: string | null;
  name?: string | null;
  preview?: string;
  cwd: string;
  model?: string;
  modelProvider?: string;
  updatedAt: number;
  createdAt: number;
  status?: { type?: string } | null;
  archived?: boolean;
};

export type CodexProject = {
  id: string;
  name: string;
  roots: Array<{ path: string }>;
  metadata: Record<string, string>;
  position: number;
  createdAt: number;
  updatedAt: number;
  recencyAt?: number | null;
};

export type CodexTurn = {
  id: string;
  status: string;
  error?: { message?: string } | null;
  items?: CodexThreadItem[];
};

export type CodexThreadItem = {
  id: string;
  type: string;
  text?: string;
  [key: string]: unknown;
};

export type ThreadListResponse = {
  data: CodexThread[];
  nextCursor?: string | null;
};

export type ProjectListResponse = {
  data: CodexProject[];
  nextCursor?: string | null;
};

export type ThreadResponse = {
  thread: CodexThread;
  model?: string;
  cwd?: string;
};

export type TurnStartResponse = {
  turn: CodexTurn;
};

export type CodexUserInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "image"; url: string; detail?: "auto" | "low" | "high" | "original" };

export type CodexNotification = {
  method: string;
  params?: Record<string, unknown>;
};

export type CodexServerRequest = {
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

export type ApprovalRequest = {
  rpcId: JsonRpcId;
  method: string;
  threadId: string;
  turnId: string;
  command?: string | null;
  cwd?: string | null;
  reason?: string | null;
  grantRoot?: string | null;
  raw: Record<string, unknown>;
};
