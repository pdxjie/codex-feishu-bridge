import { accessSync, constants } from "node:fs";
import { execFileSync } from "node:child_process";

const macDesktopCodex =
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";

export function discoverCodexBinary(configured?: string): string {
  const candidates = [configured, macDesktopCodex].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue to the next candidate.
    }
  }

  try {
    return execFileSync("which", ["codex"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("找不到 Codex CLI。请通过 CODEX_BIN 指定可执行文件路径。");
  }
}
