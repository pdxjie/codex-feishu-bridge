import "dotenv/config";
import { BridgeApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.logLevel);
  const app = new BridgeApp(config, logger);

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info(`收到 ${signal}，正在停止服务`);
    await app.stop();
    process.exit(0);
  };

  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));

  await app.start();
  logger.info("Codex 飞书桥接服务已启动");
}

main().catch((error: unknown) => {
  const logger = new Logger("error");
  logger.error("服务启动失败", error instanceof Error ? { message: error.message, stack: error.stack } : error);
  process.exitCode = 1;
});
