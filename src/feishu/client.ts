import * as lark from "@larksuiteoapi/node-sdk";
import type { Logger } from "../logger.js";

export type IncomingMessage = {
  eventId: string;
  openId: string;
  chatId: string;
  messageId: string;
  text: string;
  tenantKey?: string;
  senderType?: string;
  chatType?: string;
};

export type CardAction = {
  openId: string;
  chatId: string;
  value: Record<string, unknown>;
};

type MessageHandler = (message: IncomingMessage) => Promise<void>;
type CardActionHandler = (action: CardAction) => Promise<void>;

export class FeishuClient {
  private readonly api: lark.Client;
  private readonly ws: lark.WSClient;
  private readonly dispatcher: lark.EventDispatcher;
  private messageHandler: MessageHandler | null = null;
  private cardActionHandler: CardActionHandler | null = null;
  private readonly displayNameCache = new Map<string, Promise<string>>();

  constructor(
    appId: string,
    appSecret: string,
    private readonly logger: Logger,
  ) {
    this.api = new lark.Client({
      appId,
      appSecret,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.warn,
    });
    this.ws = new lark.WSClient({
      appId,
      appSecret,
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.warn,
      autoReconnect: true,
      source: "codex-feishu-bridge",
      onReady: () => this.logger.info("飞书长连接已建立"),
      onReconnecting: () => this.logger.warn("飞书长连接正在重连"),
      onReconnected: () => this.logger.info("飞书长连接已恢复"),
      onError: (error) => this.logger.error("飞书长连接失败", error.message),
    });
    this.dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.warn }).register({
      "im.message.receive_v1": async (event) => this.handleMessage(event),
      "card.action.trigger": async (event: unknown) => this.handleCardAction(event),
    });
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onCardAction(handler: CardActionHandler): void {
    this.cardActionHandler = handler;
  }

  start(): Promise<void> {
    return this.ws.start({ eventDispatcher: this.dispatcher });
  }

  stop(): void {
    this.ws.close({ force: true });
  }

  async sendText(chatId: string, text: string): Promise<void> {
    await this.api.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
  }

  async sendCard(chatId: string, card: Record<string, unknown>): Promise<string> {
    const response = await this.api.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    });
    const messageId = response.data?.message_id;
    if (!messageId) throw new Error("飞书发送卡片成功，但响应中没有 message_id");
    return messageId;
  }

  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    await this.api.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
  }

  getUserDisplayName(openId: string): Promise<string> {
    const cached = this.displayNameCache.get(openId);
    if (cached) return cached;
    const loading = this.loadUserDisplayName(openId);
    this.displayNameCache.set(openId, loading);
    return loading;
  }

  private async loadUserDisplayName(openId: string): Promise<string> {
    try {
      const response = await this.api.contact.user.get({
        params: { user_id_type: "open_id" },
        path: { user_id: openId },
      });
      const name = response.data?.user?.name?.replace(/\s+/g, " ").trim();
      if (name) return name;
      this.logger.warn("飞书通讯录未返回用户姓名，使用安全回退名称", { openId, code: response.code, msg: response.msg });
    } catch (error) {
      this.logger.warn("读取飞书用户姓名失败，使用安全回退名称", {
        openId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return `同事-${openId.slice(-4) || "未知"}`;
  }

  private async handleMessage(event: {
    event_id?: string;
    sender: { sender_id?: { open_id?: string }; sender_type?: string; tenant_key?: string };
    message: {
      message_id: string;
      chat_id: string;
      message_type: string;
      content: string;
      mentions?: Array<{ key: string }>;
      chat_type?: string;
    };
  }): Promise<void> {
    if (!this.messageHandler || event.message.message_type !== "text") return;
    const openId = event.sender.sender_id?.open_id;
    if (!openId) return;

    let parsed: { text?: unknown };
    try {
      parsed = JSON.parse(event.message.content) as { text?: unknown };
    } catch {
      return;
    }
    if (typeof parsed.text !== "string") return;

    let text = parsed.text;
    for (const mention of event.message.mentions ?? []) {
      text = text.replaceAll(mention.key, "");
    }
    text = text.trim();
    if (!text) return;

    await this.messageHandler({
      eventId: event.event_id ?? event.message.message_id,
      openId,
      chatId: event.message.chat_id,
      messageId: event.message.message_id,
      text,
      ...(event.sender.tenant_key ? { tenantKey: event.sender.tenant_key } : {}),
      ...(event.sender.sender_type ? { senderType: event.sender.sender_type } : {}),
      ...(event.message.chat_type ? { chatType: event.message.chat_type } : {}),
    });
  }

  private async handleCardAction(event: unknown): Promise<void> {
    if (!this.cardActionHandler || !isRecord(event)) return;
    const context = isRecord(event.context) ? event.context : {};
    const operator = isRecord(event.operator) ? event.operator : {};
    const action = isRecord(event.action) ? event.action : {};
    const openId = typeof operator.open_id === "string" ? operator.open_id : null;
    const chatId =
      typeof context.open_chat_id === "string"
        ? context.open_chat_id
        : typeof event.open_chat_id === "string"
          ? event.open_chat_id
          : null;
    const value = isRecord(action.value) ? action.value : null;
    if (!openId || !chatId || !value) return;
    await this.cardActionHandler({ openId, chatId, value });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
