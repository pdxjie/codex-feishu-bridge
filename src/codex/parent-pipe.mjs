import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";

const PIPE_PATTERN = /^\/(?:private\/)?tmp\/codex-app-tools\/[0-9a-f-]+\.sock$/i;

function readProcess(pid) {
  return execFileSync("/bin/ps", ["eww", "-p", String(pid), "-o", "ppid=,command="], {
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function validOwnedSocket(path) {
  if (!PIPE_PATTERN.test(path)) return false;
  try {
    const stat = lstatSync(path);
    return stat.isSocket() && stat.uid === process.getuid?.();
  } catch {
    return false;
  }
}

export function discoverParentDesktopPipePath(startPid = process.ppid, reader = readProcess, validator = validOwnedSocket) {
  let pid = startPid;
  for (let depth = 0; depth < 4 && Number.isSafeInteger(pid) && pid > 1; depth += 1) {
    let output;
    try { output = reader(pid); }
    catch { return null; }
    const match = output.match(/(?:^|\s)CODEX_APP_TOOLS_PIPE_PATH=([^\s]+)/);
    if (match?.[1] && validator(match[1])) return match[1];
    const parent = Number.parseInt(output.trimStart().match(/^(\d+)/)?.[1] ?? "", 10);
    if (!Number.isSafeInteger(parent) || parent <= 1 || parent === pid) return null;
    pid = parent;
  }
  return null;
}
