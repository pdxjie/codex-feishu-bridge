import { renderMarkdownElements, type LiveProgressView } from './cards.js';

type Card = Record<string, unknown>;
export type ResultAction = { token: string; kind: 'investigate' | 'export' };
const text = (element_id: string, content: string): Card => ({ tag: 'markdown', element_id, content });
const panel = (id: string, title: string, elements: Card[], expanded = false): Card => ({
  tag: 'collapsible_panel', element_id: id, expanded,
  header: { title: { tag: 'plain_text', content: title } }, elements,
});
const plain = (content: string) => ({ tag: 'plain_text', content });

function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

function startTime(timestamp?: number): string {
  if (!timestamp) return '刚刚开始';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(timestamp));
}

export function taskPresentation(prompt = ''): { title: string; conditions: string[]; canInvestigate: boolean; canExport: boolean } {
  // These labels describe the request, never an inferred ERP authorization or query scope.
  const inventory = /库存|在库|在途|占用|调拨/.test(prompt);
  const diagnosis = /为什么|为何|原因|排查|异常|不一致|追溯|谁用|差异/.test(prompt);
  const exporting = /导出|下载|excel|xlsx/i.test(prompt);
  const title = exporting ? '数据导出' : inventory ? diagnosis ? '库存诊断' : '库存查询' : diagnosis ? '问题排查' : '任务助手';
  const conditions = [...new Set([
    ...(prompt.match(/\b[A-Z][A-Z0-9]*(?:[-_][A-Z0-9]+)+\b/g) ?? []),
    ...(prompt.match(/美国|加拿大|英国|德国|法国|日本|澳大利亚|亚马逊|沃尔玛|Wayfair|TEMU|WFS|FBA/gi) ?? []),
    ...(prompt.match(/(?<![A-Za-z0-9_])(?:\d{4}[-/.])?(?:0?[1-9]|1[0-2])[月./-](?:0?[1-9]|[12]\d|3[01])日?(?:\s*[~～至—-]\s*(?:\d{4}[-/.])?(?:0?[1-9]|1[0-2])[月./-](?:0?[1-9]|[12]\d|3[01])日?)?(?![A-Za-z0-9_])/g) ?? []),
  ])].slice(0, 6);
  return { title, conditions, canInvestigate: diagnosis, canExport: !exporting && /库存|采购|订单|流水|调拨|明细|记录|数据/.test(prompt) };
}

function header(progress: LiveProgressView, status: string, failed = false): Card {
  const title = taskPresentation(progress.prompt).title;
  const statusColor = failed ? 'orange' : status === '已完成' ? 'green' : 'purple';
  const personaStatus = failed ? '小仆虾卡住了' : status === '已完成' ? '小仆虾交卷啦' : '小仆虾忙碌中';
  return { template: failed ? 'orange' : 'purple', title: plain(`✦ ${title}`),
    subtitle: plain((progress.threadTitle || 'Codex 会话').replace(/\s+/g, ' ').slice(0, 60)),
    text_tag_list: [{ tag: 'text_tag', text: plain(personaStatus), color: statusColor }],
  };
}

function requestContext(progress: LiveProgressView): Card[] {
  const p = taskPresentation(progress.prompt);
  if (!progress.prompt) return [];
  return [
    ...(p.conditions.length ? [text('scope', p.conditions.map(value => `\`${value}\``).join('  ·  '))] : []),
    text('request', `_${safeLine(progress.prompt, 150)}_`),
    { tag: 'hr' },
  ];
}

function toolSummary(tools: string[]): string {
  const completed = tools.filter(line => line.startsWith('✓')).length;
  const running = tools.filter(line => line.startsWith('◌')).length;
  const failed = tools.filter(line => line.startsWith('❌')).length;
  return tools.length ? `小仆虾的足迹：${completed} 步完成 · ${running} 步进行中${failed ? ` · ${failed} 步遇到阻碍` : ''}` : '小仆虾正在准备查证工具';
}

function publicActivity(line: string): string {
  // Older snapshots may still contain an internal tool identifier between the
  // business label and status. Keep the user-facing trail free of SDK names.
  return line.replace(/\s*·\s*[A-Za-z][A-Za-z0-9_.:/-]{1,100}\s*·\s*(执行中|完成|失败)\s*$/, ' · $1');
}

function columns(items: { label: string; value: string; id: string }[]): Card {
  return { tag: 'column_set', flex_mode: 'flow', background_style: 'grey',
    columns: items.map(item => ({ tag: 'column', width: 'weighted', weight: 1, vertical_align: 'top',
      elements: [text(item.id, `${item.label}\n**${item.value}**`)] })),
  };
}

type RunningStage = 'understand' | 'verify' | 'answer';

function runningState(view: LiveProgressView, tools: string[]): {
  stage: RunningStage; current: string; steps: string;
} {
  const active = [...tools].reverse().find(line => line.startsWith('◌'));
  const completed = tools.filter(line => line.startsWith('✓')).length;
  const stage: RunningStage = active ? 'verify' : view.latestMessage ? 'answer' : completed ? 'verify' : 'understand';
  const current = stage === 'answer'
    ? '正在把结论整理清楚'
    : active
      ? `正在${safeLine(active.replace(/^◌\s*/, '').replace(/^小仆虾正在/, '').split('·')[0] || '核验业务证据', 80)}`
      : completed
        ? '正在把查到的线索串起来'
        : '正在拆解问题';
  const marker = (target: RunningStage, label: string): string => {
    const order: RunningStage[] = ['understand', 'verify', 'answer'];
    const currentIndex = order.indexOf(stage), targetIndex = order.indexOf(target);
    return `${targetIndex < currentIndex ? '✓' : targetIndex === currentIndex ? '●' : '○'} ${label}`;
  };
  return {
    stage,
    current,
    steps: [marker('understand', '小仆虾已接单'), marker('verify', '小仆虾查证中'), marker('answer', '小仆虾待汇报')].join('　──　'),
  };
}

function motionStatus(view: LiveProgressView, state: ReturnType<typeof runningState>, tools: string[]): string {
  const frame = Math.abs(view.animationFrame ?? 0) % 6;
  const spark = ['✦', '✧', '·', '✧', '✦', '·'][frame];
  const dots = ['·', '··', '···'][frame % 3];
  const active = tools.some(line => line.startsWith('◌'));
  const hint = state.stage === 'answer'
    ? '回答正在实时生成，内容会持续出现在下方'
    : active
      ? '正在通过受控只读能力核验业务证据'
      : state.stage === 'verify'
        ? '正在整理已取得的证据并继续交叉核对'
        : '正在拆解问题、识别对象和查询范围';
  return `**🦐 ${spark} 小仆虾${state.current}${dots}**\n${hint}`;
}

export function streamingRunningCard(threadId: string, turnId: string, progress?: LiveProgressView): Card {
  const view = progress ?? { threadTitle: 'Codex 会话' };
  const tools = (view.toolActivities ?? []).map(publicActivity);
  const state = runningState(view, tools);
  const completed = tools.filter(line => line.startsWith('✓')).length;
  const recentSummary = view.reasoningSummary?.trim().split(/\n+/).filter(Boolean).at(-1);
  return {
    schema: '2.0',
    config: { update_multi: true, enable_forward: false, streaming_mode: true,
      summary: { content: `【${view.threadTitle}】${taskPresentation(view.prompt).title} · 小仆虾忙碌中` } },
    header: header(view, '执行中'),
    body: { elements: [
      ...requestContext(view),
      text('motion', motionStatus(view, state, tools)),
      { tag: 'hr' },
      text('answer_heading', '**小仆虾的回答 · 实时生成**'),
      text('reply', view.latestMessage?.slice(0, 16000) || '_小仆虾正在忙，分析结果会在这里逐步展开。_'),
      { tag: 'hr' },
      columns([
        { id: 'status', label: '当前阶段', value: state.stage === 'understand' ? '小仆虾拆题中' : state.stage === 'verify' ? '小仆虾查证中' : '小仆虾汇报中' },
        { id: 'signal', label: '证据轨迹', value: tools.length ? `${completed} 项完成${tools.some(line => line.startsWith('◌')) ? ' · 仍在执行' : ''}` : '正在建立分析路径' },
      ]),
      text('stage_flow', state.steps),
      text('analysis_preview', `**小仆虾的最新动态**\n${recentSummary ? safeLine(recentSummary, 160) : `小仆虾${state.current}`}`),
      panel('work_panel', '小仆虾的查证足迹', [
        text('activity', `${toolSummary(tools)}\n\n${[...tools.slice(-16), ...(view.activities ?? []).slice(-3)].map(line => `• ${safeLine(line)}`).join('\n') || '小仆虾已接单'}`),
        text('full_plan', view.plan?.slice(0, 3000) || '尚无公开执行计划'),
      ]),
      panel('reasoning_panel', '小仆虾的分析摘要', [text('reasoning', view.reasoningSummary?.slice(0, 6000) || '小仆虾整理出公开分析摘要后，会在这里持续更新。')]),
      { tag: 'hr' },
      { tag: 'column_set', flex_mode: 'flow', columns: [
        { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center',
          elements: [text('started_at', `小仆虾开始于 ${startTime(view.startedAt)}　·　发送 \`/stop\` 可让它收钳`)] },
        { tag: 'column', width: 'auto', vertical_align: 'center', elements: [
          { tag: 'button', type: 'default', text: plain('让小仆虾停一下'),
            behaviors: [{ type: 'callback', value: { action: 'stop_turn', threadId, turnId } }],
            confirm: { title: plain('让小仆虾收钳'), text: plain('停止当前任务？小仆虾已经生成的内容会保留。') } },
        ] },
      ] },
    ] },
  };
}

export function isStreamingCard(card: Card): boolean {
  return card.schema === '2.0' && (card.config as Card | undefined)?.streaming_mode === true;
}

export function streamTextElements(card: Card): Map<string, string> {
  const result = new Map<string, string>();
  const visit = (elements: unknown) => {
    if (!Array.isArray(elements)) return;
    for (const element of elements) {
      if (!element || typeof element !== 'object') continue;
      if (element.tag === 'markdown' && typeof element.element_id === 'string' && typeof element.content === 'string') result.set(element.element_id, element.content);
      visit(element.elements);
      visit(element.columns);
    }
  };
  visit((card.body as Card | undefined)?.elements);
  return result;
}

export function nonStreamingCard(card: Card): Card {
  return { ...card, config: { ...(card.config as Card), streaming_mode: false } };
}

export function finalCardV2(card: Card): Card {
  if (card.schema === '2.0') return nonStreamingCard(card);
  return { schema: '2.0', config: { enable_forward: false, update_multi: true, streaming_mode: false },
    header: card.header, body: { elements: card.elements } };
}

function safeLine(value: string, limit = 180): string {
  const line = value.replace(/\s+/g, ' ').trim();
  return (line.length > limit ? `${line.slice(0, limit)}…` : line).replace(/[\\`*_<>\[\]]/g, '\\$&');
}

// Highlight only complete scalar lines. Do not calculate values or promote
// tentative numbers to facts; the original answer and qualifications remain below.
export function resultMetrics(content: string): { label: string; value: string; id: string }[] {
  if (/推断|可能|假设|示例|尚未|未核实|无法确认/.test(content)) return [];
  const metrics: { label: string; value: string; id: string }[] = [];
  let fence = false;
  for (const raw of content.split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; continue; }
    if (fence) continue;
    const line = raw.replace(/^[\s>*-]+/, '').replace(/[*`]/g, '').trim();
    const match = line.match(/^([^：:]{2,18})[：:]\s*([+-]?[\d,]+(?:\.\d+)?\s*(?:件|条|单|个|台|套)?)$/);
    if (!match || !/库存|在库|在途|合计|差额|数量|记录数|导出行数/.test(match[1]!)) continue;
    if (/预计|预估|约|未|不|示例/.test(match[1]!)) continue;
    metrics.push({ label: safeLine(match[1]!), value: match[2]!, id: `metric_${metrics.length}` });
    if (metrics.length === 3) break;
  }
  return metrics.length >= 2 ? metrics : [];
}

export function withExecutionDetails(card: Card, progress: LiveProgressView,
  options?: { content: string; failed: boolean; actions?: ResultAction[] }): Card {
  const result = finalCardV2(card);
  const body = result.body as Card;
  const tools = (progress.toolActivities ?? []).map(publicActivity);
  const metrics = options && !options.failed ? resultMetrics(options.content) : [];
  const summaries = progress.reasoningSummary?.trim().split(/\n+/).filter(Boolean) ?? [];
  const elements: Card[] = options ? [
    ...requestContext(progress),
    ...(metrics.length ? [columns(metrics), text('metric_note', '_数值摘自下方回复，口径和依据请见正文。_')] : []),
    text('result_heading', `**🦐 小仆虾的${options.failed ? '处理结果' : '结论'}**`),
    ...renderMarkdownElements(options.content.slice(0, 12000) || '任务已结束，但没有返回文本结果。', true),
    ...(options.content.length > 12000 ? [text('truncated', '_结果较长，当前展示前 12000 字；可继续追问或请求导出完整明细。_')] : []),
  ] : [...body.elements as Card[]];
  elements.push({ tag: 'hr' });
  if (tools.length || progress.activities?.length || progress.plan) elements.push(panel('work_panel', `小仆虾的查证足迹 · ${tools.length} 个步骤`, [
    text('completed_activity', [...tools.slice(-16), ...(progress.activities ?? []).slice(-4)].map(line => `• ${safeLine(line)}`).join('\n') || '小仆虾已经处理完成'),
    ...(progress.plan ? [text('completed_plan', progress.plan.slice(0, 3000))] : []),
  ]));
  if (progress.reasoningSummary) elements.push(panel('reasoning_panel', `小仆虾的分析摘要 · ${summaries.length} 条`, [text('completed_reasoning', progress.reasoningSummary.slice(0, 6000))]));
  if (options?.actions?.length) elements.push({ tag: 'column_set', flex_mode: 'flow', columns: options.actions.map(action => ({
    tag: 'column', width: 'auto', elements: [{ tag: 'button', type: action.kind === 'investigate' ? 'primary' : 'default',
      text: plain(action.kind === 'export' ? '导出本次明细' : '继续追查原因'),
      behaviors: [{ type: 'callback', value: { action: 'result_followup', token: action.token, kind: action.kind } }],
      confirm: { title: plain('继续当前会话'), text: plain(action.kind === 'export' ? '将按本次问题的范围发起导出，并重新校验数据权限。' : '将沿用本次问题继续只读排查原因。') },
    }],
  })) });
  elements.push(text('duration', `${options?.failed ? '🦐 小仆虾暂时卡住了' : '🦐 小仆虾交卷啦'} · 用时 ${duration(progress.elapsedSeconds ?? 0)}${tools.length ? ` · ${tools.length} 个执行步骤` : ''}`));
  return { ...result,
    ...(options ? { header: header(progress, options.failed ? '未完成' : '已完成', options.failed),
      config: { ...(result.config as Card), summary: { content: `【${progress.threadTitle}】${taskPresentation(progress.prompt).title} · ${options.failed ? '小仆虾卡住了' : '小仆虾交卷啦'}` } } } : {}),
    body: { ...body, elements } };
}
