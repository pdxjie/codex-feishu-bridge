import assert from 'node:assert/strict';
import test from 'node:test';
import { InventoryCases } from '../src/guest/inventory-case.js';
import type { ErpAccessContext, GuestAccessGuard } from '../src/guest/erp-access-control.js';

const context: ErpAccessContext = {
  erpUserId: 796, feishuUserId: 'user', userName: 'PMC', roleIds: [50], roleNames: ['PMC'],
  superAdministrator: false, inventoryOperationsRole: false, moduleIds: [74], moduleNames: ['计划'], purviewIds: [1104],
  dataScope: { platforms: [], shops: [], shopMarketplaces: [], categories: [], categoryScopeConfigured: false },
};
const prompt = 'G10009-BKCH_04，加拿大，分渠道库存管理和全渠道库存管理页面的在库库存为什么不一致';
const args = { pagePurviewId: 1104, itemsCode: 'G10009-BKCH_04', countryCode: 'CA' };
function fixture() {
  let allowed = true;
  let changed = false;
  const queries: string[] = [];
  const access = { authorizePage: async (_: unknown, id: number) => {
    if (!allowed) throw new Error('权限不足');
    return { pagePurviewId: id, viewId: changed ? 999 : id === 1103 ? 338 : 339, moduleId: 74, menuUrl: id === 1103 ? '/pmc-stock-manager' : '/channel-pmc-stock-manager', permissionUrl: '/', hasAccess: true };
  } } as unknown as GuestAccessGuard;
  const database = async () => ({ query: async (_: string, sql: string) => {
    queries.push(sql);
    if (sql.includes('FROM mc_country ')) return { rows: sql.includes("english = 'US'") ? [{ id: 1, english: 'US', chinese: '美国' }] : [{ id: 6, english: 'CA', chinese: '加拿大' }] };
    if (sql.includes('SELECT i.id FROM mc_items')) return { rows: [] };
    if (sql.includes('FROM mc_items WHERE')) return { rows: [{ id: 1445, items_code: args.itemsCode, type: 1 }] };
    if (sql.includes('FROM mc_items_vsku')) return { rows: [{ vsku_id: 4000, goods_id: 13165, sku: 'G10009BK02A-A2' }] };
    return { rows: [{ items_id: 1445, country_code: 'CA' }] };
  } });
  return { cases: new InventoryCases(access, database, 'production'), queries, revoke: () => { allowed = false; }, change: () => { changed = true; } };
}

test('PMC以本人页面发起同品同国关联诊断，无需运营/仓储角色；持续核验原页面', async () => {
  const f = fixture();
  f.cases.bindPrompt('t', context, prompt);
  const result = await f.cases.open('t', context, args);
  assert.equal(result.status, 'authorized_related_inventory_diagnosis');
  assert.deepEqual((await f.cases.current('t', context))?.skus, ['G10009BK02A-A2']);
  assert.ok(f.queries.every(sql => !/SELECT \*|price|supplier|password/i.test(sql)));
  f.revoke();
  await assert.rejects(f.cases.current('t', context), /权限不足/);
});

test('工具伪造诊断目的、其他会话、无关品/国家、直接查询均不产生诊断授权', async () => {
  const f = fixture();
  await assert.rejects(f.cases.open('t', context, args), /真实业务问题/);
  f.cases.bindPrompt('t', context, 'G10009-BKCH_04，加拿大，导出仓储模块所有库存流水');
  await assert.rejects(f.cases.open('t', context, args), /不是该品/);
  f.cases.bindPrompt('t', context, prompt);
  await assert.rejects(f.cases.open('other', context, args), /真实业务问题/);
  await assert.rejects(f.cases.open('t', { ...context, erpUserId: 123 }, args), /真实业务问题/);
  await assert.rejects(f.cases.open('t', context, { ...args, purpose: 'diagnosis' }), /不接受/);
  await assert.rejects(f.cases.open('t', context, { ...args, itemsCode: 'SECRET' }), /不是该品/);
  await assert.rejects(f.cases.open('t', context, { ...args, countryCode: 'US' }), /国家/);
  await assert.rejects(f.cases.open('t', context, { ...args, pagePurviewId: 99 }), /尚未登记/);
  f.change();
  await assert.rejects(f.cases.open('t', context, args), /元数据/);
});

test('继续只延续原对象；新直接查询清除授权；writer迁移可延续但新会话不继承', async () => {
  const f = fixture();
  f.cases.bindPrompt('t', context, prompt);
  await f.cases.open('t', context, args);
  f.cases.bindPrompt('t', context, '继续');
  f.cases.bindPrompt('t', context, '继续查渠道批次和仓储流水');
  assert.ok(await f.cases.current('t', context));
  assert.equal(await f.cases.current('new', context), undefined);
  f.cases.bindPrompt('replacement', context, '继续', 't');
  assert.ok(await f.cases.current('replacement', context));
  assert.equal(await f.cases.current('t', context), undefined);
  f.cases.bindPrompt('replacement', context, '给我仓储所有商品的库存');
  assert.equal(await f.cases.current('replacement', context), undefined);
  await assert.rejects(f.cases.open('replacement', context, args), /不是该品/);
});


test('全渠道来源继承ERP临时角色品类限制，角色变化不能沿用更宽的范围', async () => {
  const f = fixture();
  const restricted = { ...context, roleIds: [81] };
  f.cases.bindPrompt('t', restricted, prompt);
  await f.cases.open('t', restricted, { ...args, pagePurviewId: 1103 });
  assert.ok(f.queries.some(sql => sql.includes('FROM mc_spu') && sql.includes('s.category_id = 10')));
  await assert.rejects(f.cases.current('t', restricted), /品类范围/);
});
