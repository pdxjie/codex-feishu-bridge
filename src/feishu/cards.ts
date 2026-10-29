import type { ApprovalRequest, CodexThread } from "../codex/types.js";
import type { ProjectGroup } from "../projects.js";

type Card = Record<string, unknown>;

export function sessionsCard(threads: CodexThread[], activeThreadId: string | null): Card {
  const elements: Record<string, unknown>[] = [];
  if (threads.length === 0) {
    elements.push(markdown("暂无可用的 Codex 会话。"));
  }

  for (const thread of threads) {
    const active = thread.id === activeThreadId;
    const title = thread.name?.trim() || firstLine(thread.preview) || "未命名会话";
    elements.push(
      markdown(
        `${active ? "**✅ 当前会话**\n" : ""}**${escapeMarkdown(title)}**\n` +
          `目录：\`${escapeMarkdown(thread.cwd)}\`\n` +
          `更新时间：${formatTime(thread.updatedAt)}\n` +
          `ID：\`${thread.id}\``,
      ),
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            type: active ? "default" : "primary",
            text: { tag: "plain_text", content: active ? "当前会话" : "切换到此会话" },
            value: { action: "switch_thread", threadId: thread.id },
          },
        ],
      },
      { tag: "hr" },
    );
  }

  return card("Codex 会话", elements, "blue");
}

export function projectsCard(groups: ProjectGroup[], activeProjectId: string | null, page = 0, pageSize = 8): Card {
  const totalPages = Math.max(1, Math.ceil(groups.length / pageSize));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const elements: Record<string, unknown>[] = [
    markdown(`共 ${groups.length} 个项目分组 · 第 ${safePage + 1}/${totalPages} 页`),
  ];
  for (const group of groups.slice(safePage * pageSize, (safePage + 1) * pageSize)) {
    const archivedCount = group.threads.filter((thread) => thread.archived).length;
    const activeCount = group.threads.length - archivedCount;
    const roots = group.roots.length > 0 ? group.roots.map((root) => `\`${escapeMarkdown(root)}\``).join("\n") : "无项目目录";
    elements.push(
      markdown(
        `${group.id === activeProjectId ? "**✅ 当前项目**\n" : ""}**${escapeMarkdown(group.name)}**\n` +
          `${roots}\n会话：${activeCount} 个活跃${archivedCount > 0 ? `，${archivedCount} 个已归档` : ""}`,
      ),
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            type: "primary",
            text: { tag: "plain_text", content: "查看会话" },
            value: { action: "open_project", projectId: group.id, page: 0 },
          },
          ...(group.project
            ? [
                {
                  tag: "button",
                  type: "default",
                  text: { tag: "plain_text", content: "新建会话" },
                  value: { action: "new_in_project", projectId: group.id },
                },
              ]
            : []),
        ],
      },
      { tag: "hr" },
    );
  }
  if (groups.length === 0) elements.push(markdown("暂无 Codex 项目。"));
  const navigation: Record<string, unknown>[] = [];
  if (safePage > 0) {
    navigation.push({
      tag: "button",
      text: { tag: "plain_text", content: "上一页" },
      value: { action: "list_projects", page: safePage - 1 },
    });
  }
  if (safePage + 1 < totalPages) {
    navigation.push({
      tag: "button",
      text: { tag: "plain_text", content: "下一页" },
      value: { action: "list_projects", page: safePage + 1 },
    });
  }
  if (navigation.length > 0) elements.push({ tag: "action", actions: navigation });
  return card("Codex 项目", elements, "blue");
}

export function projectThreadsCard(
  group: ProjectGroup,
  activeThreadId: string | null,
  page: number,
  pageSize = 6,
): Card {
  const totalPages = Math.max(1, Math.ceil(group.threads.length / pageSize));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const threads = group.threads.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const elements: Record<string, unknown>[] = [
    markdown(`共 ${group.threads.length} 个会话 · 第 ${safePage + 1}/${totalPages} 页`),
  ];

  if (threads.length === 0) elements.push(markdown("这个项目还没有会话，可以点击下方按钮新建。"));
  for (const thread of threads) {
    const active = thread.id === activeThreadId;
    const title = thread.name?.trim() || firstLine(thread.preview) || "未命名会话";
    elements.push(
      { tag: "hr" },
      markdown(
        `${active ? "**✅ 当前会话**\n" : ""}${thread.archived ? "📦 **已归档**\n" : ""}` +
          `**${escapeMarkdown(title)}**\n更新时间：${formatTime(thread.updatedAt)}\nID：\`${thread.id}\``,
      ),
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            type: active ? "default" : "primary",
            text: { tag: "plain_text", content: active ? "当前会话" : thread.archived ? "恢复并切换" : "切换" },
            value: {
              action: "switch_thread",
              threadId: thread.id,
              projectId: group.id,
              archived: Boolean(thread.archived),
            },
          },
        ],
      },
    );
  }

  const navigation: Record<string, unknown>[] = [];
  if (safePage > 0) {
    navigation.push({
      tag: "button",
      text: { tag: "plain_text", content: "上一页" },
      value: { action: "open_project", projectId: group.id, page: safePage - 1 },
    });
  }
  if (safePage + 1 < totalPages) {
    navigation.push({
      tag: "button",
      text: { tag: "plain_text", content: "下一页" },
      value: { action: "open_project", projectId: group.id, page: safePage + 1 },
    });
  }
  if (group.project) {
    navigation.push({
      tag: "button",
      type: "primary",
      text: { tag: "plain_text", content: "在项目中新建会话" },
      value: { action: "new_in_project", projectId: group.id },
    });
  }
  navigation.push({
    tag: "button",
    text: { tag: "plain_text", content: "返回项目列表" },
    value: { action: "list_projects" },
  });
  elements.push({ tag: "hr" }, { tag: "action", actions: navigation, layout: "flow" });
  return card(group.name, elements, "wathet");
}

export function currentThreadCard(thread: CodexThread): Card {
  const title = thread.name?.trim() || firstLine(thread.preview) || "未命名会话";
  return card(
    "当前 Codex 会话",
    [
      markdown(
        `**${escapeMarkdown(title)}**\n目录：\`${escapeMarkdown(thread.cwd)}\`\n` +
          `模型：${escapeMarkdown(thread.model ?? "默认")}\nID：\`${thread.id}\``,
      ),
    ],
    "green",
  );
}

export function guestHelpCard(): Card {
  return card(
    "ERP 只读排查助手",
    [
      markdown(
        "请直接发送线上问题、订单号、报错信息或业务现象。机器人会自动在“自主排查”项目中使用你的固定专属会话，并结合指定 ERP 项目源码与生产只读数据分析原因。\n\n" +
          "访客不提供项目、会话列表、切换或新建命令；你无法查看管理员或其他同事的会话，也不能修改源码或线上数据。",
      ),
    ],
    "wathet",
  );
}

export type LiveProgressView = {
  threadTitle: string;
  reasoningSummary?: string;
  plan?: string;
  latestMessage?: string;
  activities?: string[];
  elapsedSeconds?: number;
};

export function runningCard(threadId: string, turnId: string, progress?: LiveProgressView): Card {
  const details = progress
    ? [
        markdown(
          `**会话：${escapeMarkdown(progress.threadTitle)}**\n` +
            `状态：正在执行${typeof progress.elapsedSeconds === "number" ? ` · 已用时 ${formatDuration(progress.elapsedSeconds)}` : ""}`,
        ),
        ...(progress.reasoningSummary
          ? [section("思考摘要（公开）", truncate(progress.reasoningSummary, 3_500))]
          : []),
        ...(progress.plan ? [section("执行计划", truncate(progress.plan, 2_500))] : []),
        ...(progress.activities?.length
          ? [section("实时进度", progress.activities.slice(-8).map((item) => `- ${escapeMarkdown(item)}`).join("\n"))]
          : []),
        ...(progress.latestMessage ? [section("实时公开回复", truncate(progress.latestMessage, 4_500))] : []),
        markdown(`会话 ID：\`${threadId}\`\nTurn：\`${turnId}\``),
      ]
    : [markdown(`任务已提交。\n会话：\`${threadId}\`\nTurn：\`${turnId}\``)];
  return card(
    progress ? `【${truncate(progress.threadTitle.replace(/\s+/g, " ").trim(), 60)}】Codex 正在工作` : "Codex 正在工作",
    [
      ...details,
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            type: "danger",
            text: { tag: "plain_text", content: "停止任务" },
            value: { action: "stop_turn", threadId, turnId },
            confirm: {
              title: { tag: "plain_text", content: "停止任务" },
              text: { tag: "plain_text", content: "确认中断当前 Codex 任务吗？" },
            },
          },
        ],
      },
    ],
    "wathet",
  );
}

function section(title: string, content: string): Record<string, unknown> {
  return markdown(`**${title}**\n${content}`);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder > 0 ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分`;
}

export function parallelForkCard(originalThreadId: string, forkThreadId: string): Card {
  return card(
    "已创建并行会话",
    [
      markdown(
        "原会话正在被桌面端或另一任务占用，已从其现有历史创建独立分支并继续执行。\n" +
          `原会话：\`${originalThreadId}\`\n并行会话：\`${forkThreadId}\`\n\n` +
          "后续消息将发送到新的并行会话，原任务不会被中断。",
      ),
    ],
    "orange",
  );
}

export function resultCard(title: string, content: string, failed = false): Card {
  return card(
    title,
    [markdown(truncate(content || "任务已结束，但没有返回文本结果。", 12_000))],
    failed ? "red" : "green",
  );
}

export function threadResultCard(threadTitle: string, content: string, failed = false): Card {
  const safeTitle = truncate(threadTitle.replace(/\s+/g, " ").trim() || "未命名会话", 60);
  const status = failed ? "Codex 任务未完成" : "Codex 已完成";
  const result = truncate(content || "任务已结束，但没有返回文本结果。", 12_000);
  return card(
    `【${safeTitle}】${status}`,
    [markdown(`**会话：${escapeMarkdown(safeTitle)}**\n\n${result}`)],
    failed ? "red" : "green",
  );
}

export function approvalCard(approvalId: string, request: ApprovalRequest): Card {
  const details = request.command
    ? `命令：\n\`\`\`\n${escapeCodeBlock(request.command)}\n\`\`\``
    : request.grantRoot
      ? `请求访问：\`${escapeMarkdown(request.grantRoot)}\``
      : "Codex 请求执行受保护操作。";
  const context = [
    details,
    request.cwd ? `目录：\`${escapeMarkdown(request.cwd)}\`` : null,
    request.reason ? `原因：${escapeMarkdown(request.reason)}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return card(
    "需要你的批准",
    [
      markdown(context),
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            type: "primary",
            text: { tag: "plain_text", content: "仅本次允许" },
            value: { action: "resolve_approval", approvalId, decision: "accept" },
          },
          {
            tag: "button",
            type: "danger",
            text: { tag: "plain_text", content: "拒绝" },
            value: { action: "resolve_approval", approvalId, decision: "decline" },
          },
        ],
      },
    ],
    "orange",
  );
}

export function helpCard(): Card {
  return card(
    "Codex 飞书助手",
    [
      markdown(
        "直接发送文字即可继续当前 Codex 会话。\n\n" +
          "**命令**\n" +
          "- `/codex sessions`：列出项目及项目内全部会话\n" +
          "- `/codex projects`：列出项目及项目内全部会话\n" +
          "- `/codex project <项目ID>`：打开项目会话列表\n" +
          "- `/codex current`：查看当前会话\n" +
          "- `/codex use <会话ID>`：切换会话\n" +
          "- `/codex new`：准备在当前项目中新建会话，下一条消息作为首条任务\n" +
          "- `/codex new <绝对目录>`：准备在已登记的 Desktop 项目中新建会话\n" +
          "- `/codex stop`：停止当前任务\n" +
          "- `/codex help`：查看帮助",
      ),
    ],
    "blue",
  );
}

function card(title: string, elements: Record<string, unknown>[], template: string): Card {
  return {
    config: { wide_screen_mode: true, enable_forward: false },
    header: {
      template,
      title: { tag: "plain_text", content: title },
    },
    elements,
  };
}

function markdown(content: string): Record<string, unknown> {
  return { tag: "markdown", content };
}

function formatTime(timestampSeconds: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestampSeconds * 1000));
}

function firstLine(text?: string): string | null {
  if (!text) return null;
  const line = text.split(/\r?\n/, 1)[0]?.trim();
  return line ? truncate(line, 60) : null;
}

function truncate(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length)}\n\n…内容过长，已截断`;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}\[\]()#+\-.!]/g, "\\$&");
}

function escapeCodeBlock(text: string): string {
  return text.replace(/```/g, "` ` `");
}
