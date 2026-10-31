import assert from 'node:assert/strict';
import test from 'node:test';
import { BridgeApp } from '../src/app.js';
import { renderMarkdownElements, runningCard, threadResultCard } from '../src/feishu/cards.js';
import { resultMetrics, streamTextElements, taskPresentation, withExecutionDetails } from '../src/feishu/streaming-card.js';

const prompt = 'G10009-BKCH_04 加拿大，亚马逊 10.29-10.30 库存为什么不一致';
const view = { threadTitle: '自主排查@测试', prompt, latestMessage: '', activities: [], startedAt: Date.UTC(2026, 9, 31, 1, 30) };

test('运行卡片保持元素结构稳定；列内状态能增量更新，进度不包含虚构百分比', () => {
  const initial = runningCard('t', 'turn', view);
  const next = runningCard('t', 'turn', { ...view, latestMessage: '已找到库存流水', elapsedSeconds: 12,
    reasoningSummary: '先检查流水来源。', toolActivities: ['◌ 查询库存证据 · inventory_diagnose · 执行中'] });
  const before = streamTextElements(initial), after = streamTextElements(next);
  assert.deepEqual([...before.keys()], [...after.keys()]);
  assert.equal(after.get('started_at'), '小仆虾开始于 09:30　·　发送 `/stop` 可让它收钳');
  assert.equal(after.has('elapsed'), false);
  assert.match(after.get('analysis_preview')!, /查询库存证据|先检查流水来源/);
  assert.match(after.get('activity')!, /查询库存证据/);
  assert.doesNotMatch(after.get('activity')!, /inventory/);
  assert.equal(after.get('reply'), '已找到库存流水');
  assert.ok(before.get('request')!.includes('G10009-BKCH\\_04'));
  assert.match(after.get('stage_flow')!, /✓ 小仆虾已接单.*● 小仆虾查证中.*○ 小仆虾待汇报/);
  assert.match(JSON.stringify(next), /小仆虾忙碌中|小仆虾正在/);
  assert.doesNotMatch(JSON.stringify(next), /\d+%|已确认数据|✓ 分析与执行/);
  assert.ok((next.body as any).elements.filter((e: any) => e.tag === 'collapsible_panel').every((e: any) => !e.expanded));
  const structure = (card: any) => JSON.stringify(card, (key, value) => key === 'content' ? '' : value);
  assert.equal(structure(initial), structure(next), 'updates must not rebuild panels or buttons');
  assert.deepEqual(
    runningCard('t', 'turn', { ...view, elapsedSeconds: 5 }),
    runningCard('t', 'turn', { ...view, elapsedSeconds: 55 }),
    'elapsed time must not trigger running-card updates',
  );
  const animated = streamTextElements(runningCard('t', 'turn', { ...view, animationFrame: 1 }));
  assert.notEqual(animated.get('motion'), before.get('motion'), 'motion frame should animate one stable element');
  assert.deepEqual([...animated.keys()], [...before.keys()], 'animation must not rebuild the card structure');
});

test('请求条件保持原始值，不把时间补成年份、不推断授权页面', () => {
  const p = taskPresentation(prompt);
  assert.equal(p.title, '库存诊断');
  assert.ok(p.conditions.includes('G10009-BKCH_04'));
  assert.ok(p.conditions.includes('10.29-10.30'));
  assert.doesNotMatch(JSON.stringify(p), /2026|权限/);
  assert.equal(taskPresentation('解释一下这段文字').canExport, false);
  assert.deepEqual(taskPresentation('订单112-8095369-6984237').conditions, [], 'order numbers are not dates');
});

test('完成卡片使用原生表格、保留证据正文，数值卡不计算或提升不确定数据', () => {
  const content = '全渠道库存：25\n分渠道合计：80\n差额：55\n\n已核验来源。\n\n|渠道|在库|\n|---|---|\n|亚马逊|79|\n|TEMU|1|';
  const card = withExecutionDetails(threadResultCard(view.threadTitle, content), view, { content, failed: false });
  const json = JSON.stringify(card);
  assert.match(json, /"tag":"table"/); assert.match(json, /"page_size":5/);
  assert.match(json, /metric_0/); assert.match(json, /已核验来源/);
  assert.doesNotMatch(json, /会话：|Codex 已完成/);
  assert.equal(resultMetrics('可能是：\n全渠道库存：25\n分渠道合计：80').length, 0);
  assert.equal(resultMetrics('```\n全渠道库存：25\n分渠道合计：80\n```').length, 0);
  assert.equal(resultMetrics('全渠道库存：25\n分渠道合计：80')[1]?.value, '80');
  assert.equal(resultMetrics('全渠道库存：25\n分渠道合计：80').length, 2, 'must not invent a difference');
  const code = renderMarkdownElements('```text\n|渠道|在库|\n|---|---|\n|A|1|\n```', true);
  assert.ok(code.every(e => e.tag !== 'table'));
});

function actionsFixture(role: 'owner' | 'guest' = 'guest') {
  const app = Object.create(BridgeApp.prototype) as any;
  let current = 't', routeTurn = 'turn';
  const calls: any[] = [];
  Object.assign(app, { activeTurns: new Map(), resultActions: new Map(),
    store: {
      getTurnRoute: () => ({ openId: 'u', chatId: 'c', turnId: routeTurn, role }),
      getGuestThreadForUser: () => ({ threadId: current }), getUser: () => ({ activeThreadId: current }),
    },
    submitGuestPrompt: async (...args: any[]) => { calls.push({ via: 'guest', args }); },
    submitPrompt: async (...args: any[]) => { calls.push({ via: 'owner', args }); },
  });
  const actions = app.registerResultActions({ threadId: 't', turnId: 'turn', prompt }, '查询结果', false);
  const action = { openId: 'u', chatId: 'c', value: { action: 'result_followup', ...actions[0] } };
  return { app, calls, action, actions, setCurrent: (s: string) => { current = s; }, setTurn: (s: string) => { routeTurn = s; } };
}

test('结果按钮按归属、会话、轮次及角色校验；重放和并发点击只提交一次', async () => {
  const f = actionsFixture();
  await assert.rejects(f.app.handleResultFollowup({ ...f.action, openId: 'another' }, 'guest'), /无权/);
  await assert.rejects(f.app.handleResultFollowup({ ...f.action, chatId: 'another' }, 'guest'), /无权/);
  await assert.rejects(f.app.handleResultFollowup(f.action, 'owner'), /无权/);
  f.setCurrent('new'); await assert.rejects(f.app.handleResultFollowup(f.action, 'guest'), /已更新/);
  f.setCurrent('t'); f.setTurn('new'); await assert.rejects(f.app.handleResultFollowup(f.action, 'guest'), /已更新/);
  f.setTurn('turn'); f.app.activeTurns.set('t', 'active'); await assert.rejects(f.app.handleResultFollowup(f.action, 'guest'), /已有任务/);
  f.app.activeTurns.clear();
  const results = await Promise.allSettled([f.app.handleResultFollowup(f.action, 'guest'), f.app.handleResultFollowup(f.action, 'guest')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].via, 'guest');
  assert.match(f.calls[0].args[2], /重新核验当前用户/); assert.ok(f.calls[0].args[2].includes(prompt));
  await assert.rejects(f.app.handleResultFollowup({ ...f.action, value: { ...f.action.value, kind: 'investigate' } }, 'guest'), /已使用/, 'a different button cannot race the same task');
});

test('操作过期、伪造类型、权限拒绝与失败结果不能执行；管理员走原有提交通道', async () => {
  const f = actionsFixture('owner');
  await assert.rejects(f.app.handleResultFollowup({ ...f.action, value: { ...f.action.value, kind: 'delete' } }, 'owner'), /无效/);
  await f.app.handleResultFollowup(f.action, 'owner');
  assert.equal(f.calls[0].via, 'owner');
  const expired = actionsFixture();
  expired.app.resultActions.get(expired.action.value.token).expiresAt = 0;
  await assert.rejects(expired.app.handleResultFollowup(expired.action, 'guest'), /过期/);
  assert.equal(expired.calls.length, 0);
  assert.deepEqual(f.app.registerResultActions({ prompt, threadId: 't' }, '无权访问', false), []);
  assert.deepEqual(f.app.registerResultActions({ prompt, threadId: 't' }, '错误', true), []);
});
