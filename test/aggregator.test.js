'use strict';

// 聚合器单元测试：验证去重、按工具/今日/按日汇总与总览合计。

const test = require('node:test');
const assert = require('node:assert');
const {
  aggregate,
  localDayKey,
  listLastNDayKeys,
  buildPeriod,
} = require('../src/core/aggregator');
const { loadTable } = require('../src/pricing/calculator');

const table = loadTable({ overrideFile: false });

function ev(overrides) {
  return {
    tool: 'claude',
    model: 'claude-opus-4-8',
    ts: Date.now(),
    sessionId: 's1',
    input: 100,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
    dedupeKey: 'k1',
    ...overrides,
  };
}

test('相同 dedupeKey 只计一次', () => {
  const snap = aggregate([ev({}), ev({})], table);
  assert.strictEqual(snap.tools.claude.tokens.input, 100);
});

test('不同工具分别汇总，grand 为合计', () => {
  const snap = aggregate(
    [
      ev({ tool: 'claude', dedupeKey: 'a', input: 100 }),
      ev({ tool: 'grok', model: 'grok-4.5-build-free', dedupeKey: 'b', input: 200 }),
    ],
    table
  );
  assert.strictEqual(snap.tools.claude.tokens.input, 100);
  assert.strictEqual(snap.tools.grok.tokens.input, 200);
  assert.strictEqual(snap.grand.tokens.input, 300);
});

test('今日用量单独统计，历史不计入今日', () => {
  const old = Date.now() - 3 * 24 * 3600 * 1000; // 3 天前
  const snap = aggregate(
    [
      ev({ dedupeKey: 'today', input: 100, ts: Date.now() }),
      ev({ dedupeKey: 'old', input: 500, ts: old }),
    ],
    table
  );
  assert.strictEqual(snap.tools.claude.total, 600); // 总量含历史
  assert.strictEqual(snap.tools.claude.today.total, 100); // 今日仅当天
});

test('会话去重计数', () => {
  const snap = aggregate(
    [
      ev({ dedupeKey: 'x', sessionId: 's1' }),
      ev({ dedupeKey: 'y', sessionId: 's1' }),
      ev({ dedupeKey: 'z', sessionId: 's2' }),
    ],
    table
  );
  assert.strictEqual(snap.tools.claude.sessionCount, 2);
});

test('估算模型使总量标记为 estimated', () => {
  const snap = aggregate([ev({ model: 'gpt-5.6-terra', dedupeKey: 'e', tool: 'codex' })], table);
  assert.strictEqual(snap.tools.codex.estimated, true);
  assert.strictEqual(snap.grand.estimated, true);
});

test('byDay：两天事件落入不同日期键', () => {
  const now = new Date(2026, 6, 24, 15, 0, 0).getTime(); // 本地 2026-07-24
  const todayTs = new Date(2026, 6, 24, 10, 0, 0).getTime();
  const ydayTs = new Date(2026, 6, 23, 10, 0, 0).getTime();
  const snap = aggregate(
    [
      ev({ dedupeKey: 'd1', input: 100, ts: todayTs, tool: 'claude' }),
      ev({ dedupeKey: 'd0', input: 400, ts: ydayTs, tool: 'codex', model: 'gpt-5' }),
    ],
    table,
    { now }
  );
  const kToday = localDayKey(todayTs);
  const kYday = localDayKey(ydayTs);
  assert.ok(snap.byDay[kToday], '应有今日 byDay');
  assert.ok(snap.byDay[kYday], '应有昨日 byDay');
  assert.strictEqual(snap.byDay[kToday].total, 100);
  assert.strictEqual(snap.byDay[kYday].total, 400);
  assert.strictEqual(snap.byDay[kToday].tools.claude.total, 100);
  assert.strictEqual(snap.byDay[kYday].tools.codex.total, 400);
});

test('period.today 与 tools 今日合计一致；last7 覆盖近 7 日', () => {
  const now = new Date(2026, 6, 24, 18, 0, 0).getTime();
  const day = (offset, hour = 12) => {
    const d = new Date(2026, 6, 24, hour, 0, 0);
    d.setDate(d.getDate() + offset);
    return d.getTime();
  };
  const events = [
    ev({ dedupeKey: 't', input: 100, ts: day(0), tool: 'claude' }), // 今日
    ev({ dedupeKey: 'y1', input: 200, ts: day(-1), tool: 'claude' }),
    ev({ dedupeKey: 'y3', input: 300, ts: day(-3), tool: 'grok', model: 'grok-4.5-build-free' }),
    ev({ dedupeKey: 'old', input: 9000, ts: day(-10), tool: 'codex', model: 'gpt-5' }), // 10 天前，不进 last7
  ];
  const snap = aggregate(events, table, { now });

  assert.strictEqual(snap.period.today.total, 100);
  assert.strictEqual(snap.period.todayKey, localDayKey(now));

  // 工具今日合计应与 period.today 对齐（仅 claude 有今日）
  const toolTodaySum = Object.values(snap.tools).reduce((s, t) => s + t.today.total, 0);
  assert.strictEqual(toolTodaySum, snap.period.today.total);

  // last7 = 今日100 + 昨日200 + 3日前300 = 600；不含 10 日前
  assert.strictEqual(snap.period.last7.total, 600);
  assert.strictEqual(snap.period.days.length, 7);
  assert.strictEqual(snap.period.days[6].date, localDayKey(now));
  assert.strictEqual(snap.period.days[6].total, 100);
});

test('listLastNDayKeys 生成连续 n 日', () => {
  const end = new Date(2026, 0, 10, 8, 0, 0).getTime();
  const keys = listLastNDayKeys(3, end);
  assert.deepStrictEqual(keys, ['2026-01-08', '2026-01-09', '2026-01-10']);
});

test('buildPeriod 空 byDay 时今日与近7日为 0', () => {
  const now = new Date(2026, 6, 24, 12, 0, 0).getTime();
  const p = buildPeriod({}, now);
  assert.strictEqual(p.today.total, 0);
  assert.strictEqual(p.last7.total, 0);
  assert.strictEqual(p.days.length, 7);
});
