import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type GuestCodexRuntime = {
  args: string[];
  env: NodeJS.ProcessEnv;
};

export function prepareGuestCodexRuntime(guestCodexHome: string): GuestCodexRuntime {
  const sourceHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const sourceConfigPath = join(sourceHome, "config.toml");
  const sourceAuthPath = join(sourceHome, "auth.json");
  if (!existsSync(sourceConfigPath)) throw new Error(`找不到管理员 Codex 配置：${sourceConfigPath}`);
  if (!existsSync(sourceAuthPath)) throw new Error(`找不到管理员 Codex 登录凭据：${sourceAuthPath}`);

  mkdirSync(guestCodexHome, { recursive: true, mode: 0o700 });
  chmodSync(guestCodexHome, 0o700);
  const minimalConfig = extractModelConfig(readFileSync(sourceConfigPath, "utf8"));
  writeFileSync(join(guestCodexHome, "config.toml"), minimalConfig, { mode: 0o600 });
  chmodSync(join(guestCodexHome, "config.toml"), 0o600);
  copyFileSync(sourceAuthPath, join(guestCodexHome, "auth.json"));
  chmodSync(join(guestCodexHome, "auth.json"), 0o600);

  const auth = JSON.parse(readFileSync(sourceAuthPath, "utf8")) as Record<string, unknown>;
  const apiKey = typeof auth.OPENAI_API_KEY === "string" ? auth.OPENAI_API_KEY : process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("管理员 Codex 凭据中没有可供隔离访客执行器使用的 API Key。");

  return {
    args: [
      "app-server",
      "--stdio",
      "--disable",
      "shell_tool",
      "--disable",
      "apps",
      "--disable",
      "browser_use",
      "--disable",
      "computer_use",
      "--disable",
      "image_generation",
      "--disable",
      "multi_agent",
      "--disable",
      "worktrees",
    ],
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG ?? "en_US.UTF-8",
      LC_ALL: process.env.LC_ALL,
      USER: process.env.USER,
      LOGNAME: process.env.LOGNAME,
      HOME: guestCodexHome,
      CODEX_HOME: guestCodexHome,
      OPENAI_API_KEY: apiKey,
    },
  };
}

function extractModelConfig(source: string): string {
  const lines = source.split(/\r?\n/);
  const providerLine = lines.find((line) => /^\s*model_provider\s*=/.test(line));
  const modelLine = lines.find((line) => /^\s*model\s*=/.test(line));
  const effortLine = lines.find((line) => /^\s*model_reasoning_effort\s*=/.test(line));
  if (!providerLine || !modelLine) throw new Error("管理员 Codex 配置缺少 model_provider 或 model。");
  const provider = /model_provider\s*=\s*["']([^"']+)["']/.exec(providerLine)?.[1];
  if (!provider) throw new Error("无法解析管理员 Codex model_provider。");

  const sectionHeader = `[model_providers.${provider}]`;
  const sectionIndex = lines.findIndex((line) => line.trim() === sectionHeader);
  if (sectionIndex < 0) throw new Error(`管理员 Codex 配置缺少 ${sectionHeader}。`);
  const section: string[] = [];
  for (let index = sectionIndex; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (index > sectionIndex && /^\s*\[/.test(line)) break;
    section.push(line);
  }

  return [
    providerLine,
    modelLine,
    ...(effortLine ? [effortLine] : []),
    "",
    ...section,
    "",
    "[features]",
    "shell_tool = false",
    "apps = false",
    "browser_use = false",
    "computer_use = false",
    "image_generation = false",
    "multi_agent = false",
    "worktrees = false",
    "",
  ].join("\n");
}
