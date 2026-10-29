import "dotenv/config";
import { CodexClient } from "./codex/client.js";
import { DesktopCodexClient } from "./codex/desktop-client.js";
import { Logger } from "./logger.js";
import { groupThreadsByProject } from "./projects.js";

async function main(): Promise<void> {
  const logger = new Logger("warn");
  const codex = new CodexClient(process.env.CODEX_BIN, logger);
  const desktop = new DesktopCodexClient(logger);
  try {
    await Promise.all([codex.start(), desktop.start()]);
    const desktopHealth = await desktop.healthCheck();
    const [projects, threads] = await Promise.all([
      codex.listProjects(),
      codex.listAllThreads({ includeArchived: true }),
    ]);
    const groups = groupThreadsByProject(projects, threads);
    console.log(`Codex App Server 连接正常，共读取 ${projects.length} 个项目、${threads.length} 个会话：`);
    console.log(`Codex Desktop 同会话通道正常（控制会话：${desktopHealth.controllerThreadId}）`);
    for (const group of groups) {
      const archived = group.threads.filter((thread) => thread.archived).length;
      console.log(`- ${group.name}: ${group.threads.length - archived} 个活跃，${archived} 个已归档`);
    }
  } finally {
    await Promise.all([desktop.stop(), codex.stop()]);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
