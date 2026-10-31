import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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
  const sourceConfig = readFileSync(sourceConfigPath, "utf8");

  return {
    args: [
      "app-server",
      "--stdio",
      ...disabledMcpOverrides(sourceConfig),
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
      "--disable",
      "remote_plugin",
      "--disable",
      "memories",
    ],
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG ?? "en_US.UTF-8",
      LC_ALL: process.env.LC_ALL,
      USER: process.env.USER,
      LOGNAME: process.env.LOGNAME,
      HOME: guestCodexHome,
      // 共享管理员的线程/项目索引，访客会话才能实时显示在 Desktop 的“自主排查”项目下。
      // 能力隔离由上面的禁用开关、空 environments、只读 sandbox 和动态工具白名单共同强制。
      CODEX_HOME: sourceHome,
    },
  };
}

export function disabledMcpOverrides(source: string): string[] {
  const overrides = new Map<string, string>();
  const sections = [...source.matchAll(/^\s*\[mcp_servers\.([A-Za-z0-9_-]+|"[A-Za-z0-9_-]+"|'[A-Za-z0-9_-]+')\][ \t]*(?:#.*)?$/gm)];
  for (const section of sections) {
    const name = section[1]!.replace(/^["']|["']$/g, '');
    const rest = source.slice(section.index! + section[0].length);
    const next = rest.search(/^\s*\[/m);
    const body = next < 0 ? rest : rest.slice(0, next);
    // Codex reloads config for requests. After account/config switching the
    // original server may disappear, leaving an enabled=false-only invalid
    // transport. Keep a complete, disabled transport in the process override.
    // No original commands, arguments, credentials or endpoints are copied.
    const transport = /^\s*url\s*=/m.test(body)
      ? 'url="http://127.0.0.1:9/disabled-mcp"'
      : 'command="/usr/bin/false"';
    overrides.set(name, `mcp_servers.${name}={enabled=false,${transport}}`);
  }
  return [...overrides.values()].flatMap(value => ['-c', value]);
}
