import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { FeishuClient } from "../src/feishu/client.js";
import { Logger } from "../src/logger.js";

type ClientInternals = {
  api: {
    contact: {
      user: {
        get: (payload: unknown) => Promise<{
          code?: number;
          msg?: string;
          data?: { user?: { name?: string } };
        }>;
      };
    };
  };
  getUserDisplayName: (openId: string) => Promise<string>;
  onMessage: (handler: (message: { text: string; imageDataUrls?: string[] }) => Promise<void>) => void;
  handleMessage: (event: unknown) => Promise<void>;
};

test("飞书用户姓名会被规范化并缓存", async () => {
  const client = new FeishuClient("test-app", "test-secret", new Logger("error")) as unknown as ClientInternals;
  let calls = 0;
  client.api = {
    contact: {
      user: {
        async get() {
          calls += 1;
          return { code: 0, data: { user: { name: "  张   三  " } } };
        },
      },
    },
  };

  assert.equal(await client.getUserDisplayName("ou_test1234"), "张 三");
  assert.equal(await client.getUserDisplayName("ou_test1234"), "张 三");
  assert.equal(calls, 1);
});

test("飞书姓名不可用时安全回退且不阻断任务", async () => {
  const client = new FeishuClient("test-app", "test-secret", new Logger("error")) as unknown as ClientInternals;
  client.api = {
    contact: {
      user: {
        async get() {
          return { code: 0, msg: "success", data: { user: {} } };
        },
      },
    },
  };

  assert.equal(await client.getUserDisplayName("ou_test5678"), "同事-5678");
});

test("飞书兜底姓名不会永久缓存，权限恢复后自动取得真实姓名", async () => {
  const client = new FeishuClient("test-app", "test-secret", new Logger("error")) as unknown as ClientInternals;
  let calls = 0;
  client.api = {
    contact: {
      user: {
        async get() {
          calls += 1;
          return calls === 1
            ? { code: 41050, msg: "no user authority", data: { user: {} } }
            : { code: 0, data: { user: { name: "沈巧玲" } } };
        },
      },
    },
  };

  assert.equal(await client.getUserDisplayName("ou_testaefd"), "同事-aefd");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await client.getUserDisplayName("ou_testaefd"), "沈巧玲");
  assert.equal(calls, 2);
});

test("飞书图片消息会下载并转换为 Codex 可识别的数据 URL", async () => {
  const client = new FeishuClient("test-app", "test-secret", new Logger("error")) as unknown as ClientInternals;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  (client as unknown as { api: unknown }).api = {
    im: {
      messageResource: {
        async get() {
          return {
            getReadableStream: () => Readable.from([png]),
            headers: { "content-type": "image/png" },
          };
        },
      },
    },
  };
  const received: Array<{ text: string; imageDataUrls?: string[]; feishuUserId?: string }> = [];
  client.onMessage(async (message) => {
    received.push(message);
  });

  await client.handleMessage({
    event_id: "event-image",
    sender: { sender_id: { open_id: "ou_image", user_id: "fs_user_image" } },
    message: {
      message_id: "om_image",
      chat_id: "oc_image",
      message_type: "image",
      content: JSON.stringify({ image_key: "img_test" }),
    },
  });

  assert.match(received[0]?.text ?? "", /识别并分析这张截图/);
  assert.equal(received[0]?.feishuUserId, "fs_user_image");
  assert.equal(received[0]?.imageDataUrls?.[0], `data:image/png;base64,${png.toString("base64")}`);
});

test("飞书富文本消息会同时提取说明文字和图片", async () => {
  const client = new FeishuClient("test-app", "test-secret", new Logger("error")) as unknown as ClientInternals;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
  const downloaded: string[] = [];
  (client as unknown as { api: unknown }).api = {
    im: {
      messageResource: {
        async get(payload: { path: { file_key: string } }) {
          downloaded.push(payload.path.file_key);
          return {
            getReadableStream: () => Readable.from([png]),
            headers: { "content-type": "image/png" },
          };
        },
      },
    },
  };
  const received: Array<{ text: string; imageDataUrls?: string[] }> = [];
  client.onMessage(async (message) => {
    received.push(message);
  });

  await client.handleMessage({
    event_id: "event-post",
    sender: { sender_id: { open_id: "ou_post" } },
    message: {
      message_id: "om_post",
      chat_id: "oc_post",
      message_type: "post",
      content: JSON.stringify({
        title: "系统等级问题",
        content: [
          [{ tag: "img", image_key: "img_post" }],
          [{ tag: "text", text: "帮我看下这个ABC的系统等级是怎么算的" }],
        ],
      }),
    },
  });

  assert.equal(received[0]?.text, "系统等级问题\n帮我看下这个ABC的系统等级是怎么算的");
  assert.deepEqual(downloaded, ["img_post"]);
  assert.equal(received[0]?.imageDataUrls?.length, 1);
});

test("飞书导出文件先上传再作为文件消息发送", async () => {
  const client = new FeishuClient("test-app", "test-secret", new Logger("error"));
  const directory = mkdtempSync(join(tmpdir(), "codex-feishu-upload-"));
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "采购明细.xlsx");
  writeFileSync(path, Buffer.from("test-xlsx"));
  const calls: Array<Record<string, unknown>> = [];
  (client as unknown as { api: unknown }).api = {
    im: {
      file: {
        async create(payload: Record<string, unknown>) {
          const data = payload.data as Record<string, unknown>;
          calls.push({ method: "upload", fileType: data.file_type, fileName: data.file_name });
          return { file_key: "file_test" };
        },
      },
      message: {
        async create(payload: Record<string, unknown>) {
          const data = payload.data as Record<string, unknown>;
          calls.push({ method: "message", msgType: data.msg_type, content: data.content });
          return { data: { message_id: "om_file" } };
        },
      },
    },
  };

  assert.equal(await client.sendFile("oc_test", path, "采购明细.xlsx"), "om_file");
  assert.deepEqual(calls, [
    { method: "upload", fileType: "xls", fileName: "采购明细.xlsx" },
    { method: "message", msgType: "file", content: JSON.stringify({ file_key: "file_test" }) },
  ]);
});

test("原生流式卡片只更新变化文本，序号串行递增，并在原卡片结束流式", async () => {
  const { runningCard, threadResultCard } = await import('../src/feishu/cards.js');
  const client = new FeishuClient('test-app', 'test-secret', new Logger('error'));
  const calls: Array<{ method: string; data?: any; path?: any }> = [];
  (client as any).api = {
    cardkit: { v1: {
      card: {
        create: async (p: any) => { calls.push({ method: 'create', ...p }); return { code: 0, data: { card_id: 'card-1' } }; },
        settings: async (p: any) => { calls.push({ method: 'settings', ...p }); return { code: 0 }; },
        update: async (p: any) => { calls.push({ method: 'final', ...p }); return { code: 0 }; },
      },
      cardElement: { content: async (p: any) => { calls.push({ method: 'text', ...p }); return { code: 0 }; } },
    } },
    im: { message: {
      create: async (p: any) => { calls.push({ method: 'send', ...p }); return { code: 0, data: { message_id: 'message-1' } }; },
      patch: async () => { throw new Error('native stream must not replace the whole message'); },
    } },
  };
  const view = { threadTitle: '测试会话', latestMessage: '已' };
  const id = await client.sendCard('chat-test', runningCard('t', 'turn', view));
  assert.equal(JSON.parse(calls.find(c => c.method === 'send')!.data.content).data.card_id, 'card-1');
  await Promise.all([
    client.updateCard(id, runningCard('t', 'turn', { ...view, latestMessage: '已查到' })),
    client.updateCard(id, runningCard('t', 'turn', { ...view, latestMessage: '已查到库存结果' })),
  ]);
  await client.updateCard(id, runningCard('t', 'turn', { ...view, latestMessage: '已查到库存结果' }));
  assert.deepEqual(calls.filter(c => c.method === 'text').map(c => [c.path.element_id, c.data.content, c.data.sequence]), [
    ['reply', '已查到', 1], ['reply', '已查到库存结果', 2],
  ]);
  await client.updateCard(id, threadResultCard('测试会话', '最终结果'));
  assert.deepEqual(calls.filter(c => ['settings', 'final'].includes(c.method)).map(c => [c.method, c.data.sequence]), [['settings', 3], ['final', 4]]);
  assert.equal(JSON.parse(calls.find(c => c.method === 'settings')!.data.settings).config.streaming_mode, false);
  assert.equal((client as any).streams.size, 0);
  assert.equal(calls.filter(c => c.method === 'send').length, 1);
});

test("CardKit不可用时普通卡片仍可用，业务错误不能伪装更新成功", async () => {
  const { runningCard } = await import('../src/feishu/cards.js');
  const client = new FeishuClient('test-app', 'test-secret', new Logger('error'));
  let creates = 0; let sent = ''; let patchCode = 1234;
  (client as any).api = {
    cardkit: { v1: { card: { create: async () => { creates++; return { code: 99991672 }; } } } },
    im: { message: {
      create: async (p: any) => { sent = p.data.content; return { code: 0, data: { message_id: 'm' } }; },
      patch: async () => ({ code: patchCode }),
    } },
  };
  const card = runningCard('t', 'turn');
  await client.sendCard('chat', card); await client.sendCard('chat', card);
  assert.equal(creates, 1);
  assert.equal(JSON.parse(sent).config.streaming_mode, false);
  await assert.rejects(client.updateCard('m', card), /1234/);
  patchCode = 0;
  await client.updateCard('m', card);
});

test("连续流式更新失败会降级同一消息，保留完整最新内容", async () => {
  const { runningCard } = await import('../src/feishu/cards.js');
  const client = new FeishuClient('test-app', 'test-secret', new Logger('error'));
  let patched: any;
  (client as any).api = {
    cardkit: { v1: {
      card: { create: async () => ({ code: 0, data: { card_id: 'c' } }) },
      cardElement: { content: async () => ({ code: 429 }) },
    } },
    im: { message: {
      create: async () => ({ code: 0, data: { message_id: 'm' } }),
      patch: async (p: any) => { patched = JSON.parse(p.data.content); return { code: 0 }; },
    } },
  };
  await client.sendCard('chat', runningCard('t', 'turn'));
  const update = runningCard('t', 'turn', { threadTitle: '测试', latestMessage: '完整最新回复' });
  await assert.rejects(client.updateCard('m', update), /429/);
  await assert.rejects(client.updateCard('m', update), /429/);
  await client.updateCard('m', update);
  assert.match(JSON.stringify(patched), /完整最新回复/);
  assert.equal(patched.config.streaming_mode, false);
  assert.equal((client as any).streams.size, 0);
});

test('新增列内进度和分析动态使用局部流式更新，不重建组件', async () => {
  const { runningCard } = await import('../src/feishu/cards.js');
  const client = new FeishuClient('test-app', 'test-secret', new Logger('error'));
  const updates: string[] = [];
  (client as any).api = {
    cardkit: { v1: {
      card: { create: async () => ({ code: 0, data: { card_id: 'c' } }) },
      cardElement: { content: async (p: any) => { updates.push(p.path.element_id); return { code: 0 }; } },
    } },
    im: { message: {
      create: async () => ({ code: 0, data: { message_id: 'm' } }),
      patch: async () => { throw new Error('must not patch entire card'); },
    } },
  };
  const view = { threadTitle: '测试', prompt: '查询库存', latestMessage: '' };
  await client.sendCard('chat', runningCard('t', 'turn', view));
  const nextView = { ...view, latestMessage: '正在整理结果', elapsedSeconds: 10,
    reasoningSummary: '已核对公开来源', toolActivities: ['✓ 查询只读数据 · database_query · 完成'] };
  const next = runningCard('t', 'turn', nextView);
  await client.updateCard('m', next);
  assert.equal(updates[0], 'reply');
  for (const key of ['signal', 'status', 'stage_flow', 'analysis_preview', 'activity', 'reasoning']) assert.ok(updates.includes(key), key);
  assert.ok(!updates.includes('request') && !updates.includes('started_at'));
  const count = updates.length;
  await client.updateCard('m', next);
  assert.equal(updates.length, count);
  updates.length = 0;
  await client.updateCard('m', runningCard('t', 'turn', { ...nextView, animationFrame: 1 }));
  assert.deepEqual(updates, ['motion'], 'animation frames must update only the lightweight status element');
});
