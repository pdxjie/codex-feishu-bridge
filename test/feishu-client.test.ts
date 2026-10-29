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
