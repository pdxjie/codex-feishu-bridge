import assert from 'node:assert/strict';
import test from 'node:test';
// The helper runtime is plain ESM so Desktop can start it without tsx.
// @ts-expect-error JavaScript runtime module intentionally has no declarations.
import { discoverParentDesktopPipePath } from '../src/codex/parent-pipe.mjs';

test('Desktop pipe is discovered from a bounded parent chain', () => {
  const rows = new Map([
    [30, '20 node helper'],
    [20, '10 codex app-server CODEX_APP_TOOLS_PIPE_PATH=/tmp/codex-app-tools/current.sock OTHER=x'],
  ]);
  const seen: number[] = [];
  const result = discoverParentDesktopPipePath(30, (pid: number) => {
    seen.push(pid); return rows.get(pid) ?? '';
  }, (path: string) => path === '/tmp/codex-app-tools/current.sock');
  assert.equal(result, '/tmp/codex-app-tools/current.sock');
  assert.deepEqual(seen, [30, 20]);
});

test('Desktop pipe rejects unvalidated paths and stops at malformed ancestry', () => {
  assert.equal(discoverParentDesktopPipePath(30, () => '20 node CODEX_APP_TOOLS_PIPE_PATH=/tmp/attacker.sock', () => false), null);
  assert.equal(discoverParentDesktopPipePath(30, () => 'invalid output', () => true), null);
});
