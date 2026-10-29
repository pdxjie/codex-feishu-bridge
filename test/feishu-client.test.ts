import assert from "node:assert/strict";
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
