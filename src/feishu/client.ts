import { randomUUID } from "node:crypto";
import { finalCardV2, isStreamingCard, nonStreamingCard, streamTextElements } from "./streaming-card.js";
import * as lark from "@larksuiteoapi/node-sdk";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import type { Logger } from "../logger.js";

export type IncomingMessage = {
  eventId: string;
  openId: string;
  feishuUserId?: string;
  chatId: string;
  messageId: string;
  text: string;
  imageDataUrls?: string[];
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

type StreamEntity = { cardId: string; sequence: number; texts: Map<string, string>; failures: number; tail: Promise<void> };

export class FeishuClient {
  private readonly streams = new Map<string, StreamEntity>();
  private streamingUnavailableUntil = 0;
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
    let cardId: string | undefined;
    if (isStreamingCard(card) && Date.now() >= this.streamingUnavailableUntil) {
      try {
        const created = await this.api.cardkit.v1.card.create({ data: { type: "card_json", data: JSON.stringify(card) } });
        checkCardResponse(created);
        cardId = created.data?.card_id;
        if (!cardId) throw new Error("CardKit未返回card_id");
      } catch {
        this.streamingUnavailableUntil = Date.now() + 10 * 60_000;
        this.logger.warn("飞书原生流式卡片暂不可用，自动使用普通实时卡片");
      }
    }
    const response = await this.api.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "interactive",
        content: JSON.stringify(cardId ? { type: "card", data: { card_id: cardId } } : isStreamingCard(card) ? nonStreamingCard(card) : card) },
    });
    checkCardResponse(response);
    const messageId = response.data?.message_id;
    if (!messageId) throw new Error("飞书发送卡片成功，但响应中没有 message_id");
    if (cardId) this.streams.set(messageId, { cardId, sequence: 0, texts: streamTextElements(card), failures: 0, tail: Promise.resolve() });
    return messageId;
  }

  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    const stream = this.streams.get(messageId);
    if (!stream) {
      const response = await this.api.im.message.patch({ path: { message_id: messageId },
        data: { content: JSON.stringify(isStreamingCard(card) ? nonStreamingCard(card) : card) } });
      checkCardResponse(response);
      return;
    }
    const update = stream.tail.catch(() => undefined).then(async () => {
      if (this.streams.get(messageId) !== stream) return this.updateCard(messageId, card);
      if (!isStreamingCard(card)) {
        try {
          checkCardResponse(await this.api.cardkit.v1.card.settings({ path: { card_id: stream.cardId },
            data: { sequence: ++stream.sequence, uuid: randomUUID(), settings: JSON.stringify({ config: { streaming_mode: false } }) } }));
          checkCardResponse(await this.api.cardkit.v1.card.update({ path: { card_id: stream.cardId },
            data: { sequence: ++stream.sequence, uuid: randomUUID(), card: { type: "card_json", data: JSON.stringify(finalCardV2(card)) } } }));
        } finally { this.streams.delete(messageId); }
        return;
      }
      // Only changed text is sent. Prefix-preserving content triggers Feishu's
      // native typewriter animation and keeps panels/buttons in place.
      const texts = streamTextElements(card);
      for (const id of new Set(["reply", ...texts.keys()])) {
        const content = texts.get(id);
        if (content === undefined || content === stream.texts.get(id)) continue;
        checkCardResponse(await this.api.cardkit.v1.cardElement.content({
          path: { card_id: stream.cardId, element_id: id },
          data: { content, sequence: ++stream.sequence, uuid: randomUUID() },
        }));
        stream.texts.set(id, content);
      }
    });
    stream.tail = update;
    try { await update; stream.failures = 0; }
    catch (error) {
      stream.failures++;
      if (isStreamingCard(card) && stream.failures >= 3) {
        const response = await this.api.im.message.patch({ path: { message_id: messageId },
          data: { content: JSON.stringify(nonStreamingCard(card)) } });
        checkCardResponse(response);
        this.streams.delete(messageId);
        this.logger.warn("流式文本更新连续失败，已切换为普通实时卡片");
        return;
      }
      throw error;
    }
  }

  async sendFile(chatId: string, path: string, fileName: string): Promise<string> {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size <= 0) throw new Error("导出文件为空或不存在。");
    if (metadata.size > 30 * 1024 * 1024) throw new Error("导出文件超过飞书 30 MB 上传限制。");
    const upload = await this.api.im.file.create({
      data: {
        file_type: feishuFileType(fileName),
        file_name: fileName,
        file: createReadStream(path),
      },
    });
    const fileKey = upload?.file_key;
    if (!fileKey) throw new Error("飞书文件上传成功，但响应中没有 file_key。");
    const response = await this.api.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "file",
        content: JSON.stringify({ file_key: fileKey }),
      },
    });
    const messageId = response.data?.message_id;
    if (!messageId) throw new Error("飞书文件消息发送成功，但响应中没有 message_id。");
    return messageId;
  }

  getUserDisplayName(openId: string): Promise<string> {
    const cached = this.displayNameCache.get(openId);
    if (cached) return cached;
    const loading = this.loadUserDisplayName(openId);
    this.displayNameCache.set(openId, loading);
    void loading.then(
      (name) => {
        // 通讯录权限未开通或飞书接口临时失败时，不永久缓存“同事-xxxx”。
        // 后续消息会重新查询，并在权限恢复后自动把会话标题补成真实姓名。
        if (isFallbackDisplayName(name) && this.displayNameCache.get(openId) === loading) {
          this.displayNameCache.delete(openId);
        }
      },
      () => {
        if (this.displayNameCache.get(openId) === loading) this.displayNameCache.delete(openId);
      },
    );
    return loading;
  }

  async getFeishuUserId(openId: string): Promise<string> {
    try {
      const response = await this.api.contact.user.get({
        params: { user_id_type: "open_id" },
        path: { user_id: openId },
      });
      const userId = response.data?.user?.user_id?.trim();
      if (userId) return userId;
    } catch (error) {
      this.logger.warn("读取飞书用户 ID 失败", {
        openId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw new Error("无权访问：无法取得飞书 user_id，不能可靠映射 ERP 身份。");
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
    sender: { sender_id?: { open_id?: string; user_id?: string }; sender_type?: string; tenant_key?: string };
    message: {
      message_id: string;
      chat_id: string;
      message_type: string;
      content: string;
      mentions?: Array<{ key: string }>;
      chat_type?: string;
    };
  }): Promise<void> {
    if (
      !this.messageHandler ||
      (event.message.message_type !== "text" &&
        event.message.message_type !== "image" &&
        event.message.message_type !== "post")
    ) {
      return;
    }
    const openId = event.sender.sender_id?.open_id;
    if (!openId) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(event.message.content) as unknown;
    } catch {
      return;
    }
    let text = "";
    let imageDataUrls: string[] | undefined;
    if (event.message.message_type === "text") {
      if (!isRecord(parsed) || typeof parsed.text !== "string") return;
      text = parsed.text;
      for (const mention of event.message.mentions ?? []) {
        text = text.replaceAll(mention.key, "");
      }
      text = text.trim();
      if (!text) return;
    } else if (event.message.message_type === "image") {
      if (!isRecord(parsed) || typeof parsed.image_key !== "string" || !parsed.image_key) return;
      imageDataUrls = [await this.downloadMessageImage(event.message.message_id, parsed.image_key)];
      text = "请识别并分析这张截图；如果它与 ERP 问题有关，请结合允许访问的项目源码和只读数据定位原因。";
    } else {
      const post = parsePostMessage(parsed);
      text = post.text;
      for (const mention of event.message.mentions ?? []) {
        text = text.replaceAll(mention.key, "");
      }
      text = text.trim();
      const imageKeys = [...new Set(post.imageKeys)].slice(0, 4);
      if (imageKeys.length > 0) {
        imageDataUrls = await Promise.all(
          imageKeys.map((imageKey) => this.downloadMessageImage(event.message.message_id, imageKey)),
        );
      }
      if (!text && imageDataUrls?.length) {
        text = "请识别并分析这些截图；如果它们与 ERP 问题有关，请结合允许访问的项目源码和只读数据定位原因。";
      }
      if (!text) return;
    }

    await this.messageHandler({
      eventId: event.event_id ?? event.message.message_id,
      openId,
      ...(event.sender.sender_id?.user_id ? { feishuUserId: event.sender.sender_id.user_id } : {}),
      chatId: event.message.chat_id,
      messageId: event.message.message_id,
      text,
      ...(imageDataUrls ? { imageDataUrls } : {}),
      ...(event.sender.tenant_key ? { tenantKey: event.sender.tenant_key } : {}),
      ...(event.sender.sender_type ? { senderType: event.sender.sender_type } : {}),
      ...(event.message.chat_type ? { chatType: event.message.chat_type } : {}),
    });
  }

  private async downloadMessageImage(messageId: string, imageKey: string): Promise<string> {
    const response = await this.api.im.messageResource.get({
      params: { type: "image" },
      path: { message_id: messageId, file_key: imageKey },
    });
    const buffer = await readableToBuffer(response.getReadableStream(), 10 * 1024 * 1024);
    const rawContentType = response.headers?.["content-type"];
    const contentType =
      (Array.isArray(rawContentType) ? rawContentType[0] : rawContentType)?.split(";", 1)[0]?.trim() ||
      detectImageContentType(buffer);
    if (!contentType.startsWith("image/")) throw new Error("飞书消息资源不是受支持的图片格式。");
    return `data:${contentType};base64,${buffer.toString("base64")}`;
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

function isFallbackDisplayName(name: string): boolean {
  return /^同事-[A-Za-z0-9]{1,4}$/.test(name);
}

function feishuFileType(fileName: string): "pdf" | "doc" | "xls" | "ppt" | "stream" {
  switch (extname(fileName).toLowerCase()) {
    case ".pdf":
      return "pdf";
    case ".doc":
    case ".docx":
      return "doc";
    case ".xls":
    case ".xlsx":
      return "xls";
    case ".ppt":
    case ".pptx":
      return "ppt";
    default:
      return "stream";
  }
}

function parsePostMessage(value: unknown): { text: string; imageKeys: string[] } {
  if (!isRecord(value)) return { text: "", imageKeys: [] };
  const lines: string[] = [];
  const imageKeys: string[] = [];
  if (typeof value.title === "string" && value.title.trim()) lines.push(value.title.trim());
  const rows = Array.isArray(value.content) ? value.content : [];
  for (const row of rows) {
    const fragments: string[] = [];
    collectPostElements(row, fragments, imageKeys);
    const line = fragments.join("").trim();
    if (line) lines.push(line);
  }
  return { text: lines.join("\n"), imageKeys };
}

function collectPostElements(value: unknown, text: string[], imageKeys: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectPostElements(item, text, imageKeys);
    return;
  }
  if (!isRecord(value)) return;
  const tag = typeof value.tag === "string" ? value.tag : "";
  if (tag === "img" && typeof value.image_key === "string" && value.image_key) {
    imageKeys.push(value.image_key);
    return;
  }
  if (
    (tag === "text" || tag === "a" || tag === "md" || tag === "code_block") &&
    typeof value.text === "string"
  ) {
    text.push(value.text);
  }
  if (Array.isArray(value.content)) collectPostElements(value.content, text, imageKeys);
}

async function readableToBuffer(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > maxBytes) throw new Error("图片超过 10 MB，暂时无法识别。");
    chunks.push(buffer);
  }
  if (size === 0) throw new Error("飞书返回了空图片。");
  return Buffer.concat(chunks, size);
}

function detectImageContentType(buffer: Buffer): string {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") {
    return "image/gif";
  }
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return "application/octet-stream";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


function checkCardResponse(response: { code?: number | undefined; msg?: string | undefined }): void {
  if (response.code !== undefined && response.code !== 0) {
    // Do not log SDK request objects: they may include authorization headers.
    throw new Error(`飞书卡片接口返回错误（code=${response.code}）`);
  }
}
