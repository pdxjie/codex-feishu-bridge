import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { disabledMcpOverrides } from '../src/guest/runtime.js';

const source = `[mcp_servers.feishu_desktop_bridge]
command = "/not/executed"
args = ["original-argument"]
[mcp_servers.feishu_desktop_bridge.env]
SECRET = "private-value"
[mcp_servers.remote] # HTTP server
url = "https://example.invalid/private"
[mcp_servers."quoted-name"]
command = "/not/executed"
`;

test('disabled MCP overrides retain a complete transport without credentials or original endpoints', () => {
  const args = disabledMcpOverrides(source);
  assert.equal(args.length, 6);
  assert.ok(args[1]?.includes('feishu_desktop_bridge={enabled=false,command="/usr/bin/false"}'));
  assert.ok(args[3]?.includes('url="http://127.0.0.1:9/disabled-mcp"'));
  assert.doesNotMatch(args.join(' '), /private-value|original-argument|example.invalid|\.env=/);
  assert.deepEqual(disabledMcpOverrides('[features]\napps=false\n'), []);
});

const binary = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
test('installed Codex accepts disabled transports before and after account config removes the original entries', { skip: !existsSync(binary) }, () => {
  const home = mkdtempSync(join(tmpdir(), 'feishu-mcp-config-'));
  try {
    const args = disabledMcpOverrides(source);
    for (const config of [source, '']) {
      writeFileSync(join(home, 'config.toml'), config);
      const result = spawnSync(binary, [...args, 'mcp', 'list', '--json'], {
        env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8', timeout: 10000,
      });
      assert.equal(result.status, 0, result.stderr);
      const servers = JSON.parse(result.stdout).filter((s: { name: string }) => ['feishu_desktop_bridge', 'remote', 'quoted-name'].includes(s.name));
      assert.equal(servers.length, 3);
      assert.ok(servers.every((s: { enabled: boolean }) => s.enabled === false));
    }
    const old = spawnSync(binary, ['-c', 'mcp_servers.feishu_desktop_bridge.enabled=false', 'mcp', 'list'], {
      env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8', timeout: 10000,
    });
    assert.notEqual(old.status, 0);
    assert.match(old.stderr, /invalid transport/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
