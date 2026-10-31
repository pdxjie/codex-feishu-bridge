import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeApp, renderDesktopTurn, renderRolloutEvent } from '../src/app.js';
import { CodexClient } from '../src/codex/client.js';
import { runningCard, threadResultCard } from '../src/feishu/cards.js';
import { withExecutionDetails } from '../src/feishu/streaming-card.js';
import { Logger } from '../src/logger.js';

function fixture() {
  const app = Object.create(BridgeApp.prototype) as any;
  const updates: any[] = []; const sent: any[] = [];
  const state: any = { threadId: 't', turnId: 'turn', threadTitle: '测试会话', chatId: 'chat', messageId: 'm',
    reasoningSummary: '', plan: '', latestMessage: '', activities: [], startedAt: Date.now(),
    dirty: false, closed: false, lastUpdateAt: Date.now(), timer: null, inFlight: null };
  Object.assign(app, { logger: new Logger('error'), activeTurns: new Map([['t', 'turn']]), liveProgress: new Map([['turn', state]]),
    finalMessages: new Map(), pendingGuestNotifications: new Map(),
    store: { getTurnRoute: () => ({ role: 'owner', chatId: 'chat' }) },
    feishu: { updateCard: async (_: string, card: any) => { updates.push(card); }, sendCard: async (_: string, card: any) => { sent.push(card); return 'new'; } } });
  const event = (method: string, params: any) => app.onCodexNotification({ method, params: { threadId: 't', turnId: 'turn', ...params } });
  const clean = () => { if (state.timer) clearTimeout(state.timer); };
  return { app, state, updates, sent, event, clean };
}

test('增量回复/公开摘要/工具状态在任务结束前可见，隐藏原始思维和工具参数', async () => {
  const f = fixture();
  try {
    f.event('item/agentMessage/delta', { itemId: 'a', delta: '正在核对' });
    f.event('item/agentMessage/delta', { itemId: 'a', delta: '库存。' });
    f.event('item/reasoning/summaryTextDelta', { delta: '先确认库存口径。' });
    f.event('item/reasoning/textDelta', { delta: 'hidden-chain-of-thought' });
    f.event('bridge/tool/started', { item: { id: 'call1', type: 'dynamicToolCall', tool: 'inventory_diagnose', arguments: { sql: 'private-sql' } } });
    f.clean(); f.state.timer = null;
    await f.app.flushLiveProgress(f.state);
    const partial = JSON.stringify(f.updates);
    assert.match(partial, /正在核对库存/); assert.match(partial, /先确认库存口径/); assert.match(partial, /小仆虾正在查询库存证据/);
    assert.doesNotMatch(partial, /hidden-chain|private-sql/);
    f.event('bridge/tool/completed', { item: { id: 'call1', type: 'dynamicToolCall', tool: 'inventory_diagnose', status: 'failed' } });
    assert.match(f.state.tools.get('call1'), /小仆虾遇到阻碍/); assert.equal(f.state.tools.size, 1);
    f.event('item/agentMessage/delta', { itemId: 'final', delta: '最终结论' });
    assert.equal(f.state.latestMessage, '最终结论');
    f.clean(); f.state.timer = null;
    await f.app.finishTurn({ threadId: 't', turn: { id: 'turn', status: 'completed', items: [] } });
    assert.equal(f.sent.length, 0);
    assert.match(JSON.stringify(f.updates.at(-1)), /最终结论.*小仆虾的查证足迹/);
    assert.equal(f.app.liveProgress.size, 0);
  } finally { f.clean(); }
});

test('首卡尚未发送时缓存快速回复和完成事件，原始思维从不缓存', async () => {
  const f = fixture();
  try {
    f.state.messageId = null;
    let finishes = 0;
    f.app.finishTurn = async () => { finishes++; };
    f.event('item/agentMessage/delta', { itemId: 'a', delta: '快速回复' });
    f.event('item/reasoning/textDelta', { delta: 'private' });
    f.event('turn/completed', { turn: { id: 'turn', status: 'completed' } });
    assert.equal(finishes, 0); assert.equal(f.app.pendingGuestNotifications.get('turn').length, 2);
    f.state.messageId = 'm';
    const queued = f.app.pendingGuestNotifications.get('turn'); f.app.pendingGuestNotifications.delete('turn');
    queued.forEach((n: any) => f.app.onCodexNotification(n));
    assert.equal(f.state.latestMessage, '快速回复'); assert.equal(finishes, 1);
  } finally { f.clean(); }
});

test('更新失败保留脏状态并退避；原卡片完成失败时仅补发一张结果', async () => {
  const f = fixture();
  try {
    f.app.feishu.updateCard = async () => { throw new Error('temporary'); };
    f.state.dirty = true;
    await f.app.flushLiveProgress(f.state);
    assert.equal(f.state.dirty, true); assert.equal(f.state.updateFailures, 1); assert.ok(f.state.timer);
    await f.app.deliverResult('chat', '测试会话', '最终结果', false, f.state);
    assert.equal(f.sent.length, 1); assert.match(JSON.stringify(f.sent[0]), /最终结果/);
  } finally { f.clean(); }
});

test('动态工具桥接开始和失败事件不包含参数或结果正文', async () => {
  const client = new CodexClient('/bin/true', new Logger('error'), { dynamicToolHandler: async () => { throw new Error('private error'); } });
  const events: any[] = []; const replies: any[] = [];
  (client as any).rpc = { respond: (_: unknown, data: unknown) => replies.push(data) };
  client.on('notification', n => events.push(n));
  await (client as any).handleDynamicToolCall({ id: 'rpc', method: 'item/tool/call', params: {
    threadId: 't', turnId: 'turn', callId: 'call1', tool: 'database_query', arguments: { sql: 'private-sql' },
  } });
  assert.equal(events.length, 2); assert.equal(events[1].params.item.status, 'failed');
  assert.doesNotMatch(JSON.stringify(events), /private-sql|private error/); assert.equal(replies[0].success, false);
});

test('卡片有稳定流式元素与停止动作；最终保留可折叠执行记录；Desktop优先展示正在生成的最终回复', () => {
  const running = JSON.stringify(runningCard('thread-secret-id', 'turn-secret-id', { threadTitle: '测试', latestMessage: '逐步回复' }));
  assert.match(running, /streaming_mode.*true/); assert.match(running, /collapsible_panel/); assert.match(running, /stop_turn/);
  assert.doesNotMatch(running, /会话 ID|Turn：/);
  const final = withExecutionDetails(threadResultCard('测试', '结论'), { threadTitle: '测试', activities: ['✓ database_query · 完成'], reasoningSummary: '公开摘要', elapsedSeconds: 65 });
  assert.match(JSON.stringify(final), /小仆虾的查证足迹/); assert.match(JSON.stringify(final), /公开摘要/);
  const view = renderDesktopTurn({ id: 'turn', status: 'inProgress', items: [
    { id: 'a', type: 'agentMessage', phase: 'commentary', text: '旧的进度' },
    { id: 'b', type: 'agentMessage', phase: 'final_answer', text: '正在生成的最终答案' },
  ] });
  assert.equal(view.latestMessage, '正在生成的最终答案');
  const tool = renderRolloutEvent({ type: 'event_msg', payload: { type: 'item_started', item: { type: 'McpToolCall', tool: 'database_query', arguments: 'secret' } } });
  assert.match(JSON.stringify(tool), /小仆虾正在查询只读数据/); assert.doesNotMatch(JSON.stringify(tool), /database_query|secret/);
});


test('首卡发送失败也会消费缓存的完成事件，最终结果仍能送达', async () => {
  const f = fixture();
  try {
    f.state.messageId = null;
    let calls = 0;
    f.app.feishu.sendCard = async (_: string, card: unknown) => {
      if (++calls === 1) throw new Error('temporary');
      f.sent.push(card); return 'final-card';
    };
    f.event('item/agentMessage/delta', { itemId: 'final', delta: '快速完成的结果' });
    f.event('turn/completed', { turn: { id: 'turn', status: 'completed', items: [] } });
    await f.app.publishInitialProgress(f.state);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.state.closed, true); assert.equal(f.app.pendingGuestNotifications.size, 0);
    assert.equal(f.sent.length, 1); assert.match(JSON.stringify(f.sent), /快速完成的结果/);
  } finally { f.clean(); }
});

test('结束时正在失败的进度请求不会阻断最终结果；旧停止按钮不会停止新任务', async () => {
  const f = fixture();
  try {
    f.state.inFlight = Promise.reject(new Error('in-flight failure'));
    f.app.finalMessages.set('turn', '最终结果');
    await f.app.finishTurn({ threadId: 't', turn: { id: 'turn', status: 'completed', items: [] } });
    assert.match(JSON.stringify(f.updates.at(-1)), /最终结果/);
    f.state.closed = false;
    f.app.liveProgress.set('desktop-task', f.state);
    assert.equal(f.app.resolveCardTurnId('t', 'desktop-task'), 'turn');
    f.app.liveProgress.delete('desktop-task');
    f.app.activeTurns.set('t', 'new-turn');
    assert.throws(() => f.app.resolveCardTurnId('t', 'desktop-task'), /已结束/);
  } finally { f.clean(); }
});

test('完成事件没有文本时保留用户已经看到的流式正文', async () => {
  const f = fixture();
  try {
    f.state.latestMessage = '这是流式阶段已经完整展示的最终结论。';
    f.app.finalMessages.set('turn', '  \n  ');
    await f.app.finishTurn({ threadId: 't', turn: { id: 'turn', status: 'completed', items: [] } });
    const result = JSON.stringify(f.updates.at(-1));
    assert.match(result, /这是流式阶段已经完整展示的最终结论/);
    assert.doesNotMatch(result, /任务已结束，但没有返回文本结果|任务状态：completed/);
  } finally { f.clean(); }
});

test('Desktop 最终快照落盘稍慢时使用最后一段公开流式正文', async () => {
  const f = fixture();
  try {
    f.state.latestMessage = 'Desktop 中刚刚流式生成的完整回答。';
    await f.app.finishDesktopTurn('t', 'turn', { id: 'turn', status: 'completed', items: [] }, '');
    const result = JSON.stringify(f.updates.at(-1));
    assert.match(result, /Desktop 中刚刚流式生成的完整回答/);
    assert.doesNotMatch(result, /任务已结束，但没有返回文本结果|任务状态：completed/);
  } finally { f.clean(); }
});
