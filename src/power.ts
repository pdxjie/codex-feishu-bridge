import { spawn, type ChildProcess } from "node:child_process";
import type { Logger } from "./logger.js";

// -i prevents idle system sleep, -s prevents system sleep on AC power.
// Deliberately omit -d and -u: the display may sleep and the screen may lock.
// -w ties the assertion to the bridge PID even if the bridge is killed abruptly.
export function keepSystemAwake(logger: Logger): () => void {
  if (process.platform !== "darwin") return () => {};
  let child: ChildProcess | null = null;
  let retry: NodeJS.Timeout | undefined;
  let stopped = false;
  const start = () => {
    if (stopped) return;
    child = spawn("/usr/bin/caffeinate", ["-i", "-s", "-w", String(process.pid)], { stdio: "ignore" });
    let scheduled = false;
    const recover = () => {
      if (stopped || scheduled) return;
      scheduled = true;
      logger.warn("系统保活进程退出，5 秒后自动恢复");
      retry = setTimeout(start, 5_000);
      retry.unref();
    };
    child.once("error", recover);
    child.once("exit", recover);
  };
  start();
  logger.info("已启用系统保活：允许锁屏及屏幕休眠，阻止系统空闲休眠");
  return () => {
    stopped = true;
    clearTimeout(retry);
    child?.kill();
  };
}
