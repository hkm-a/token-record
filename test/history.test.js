'use strict';

// history.js 单元测试：按日历史合并与裁剪。

const test = require('node:test');
const assert = require('node:assert');
const { mergeDailyHistory } = require('../src/core/history');

test('mergeDailyHistory 合并新日并保留旧日', () => {
  const existing = { '2026-01-01': { total: 1, cost: 0.1 } };
  const byDay = {
    '2026-01-02': {
      total: 2, cost: 0.2,
      tokens: { input: 2, output: 0, cacheWrite: 0, cacheRead: 0 },
      tools: {},
    },
  };
  const hist = mergeDailyHistory(existing, byDay, 456, 90);
  assert.ok(hist['2026-01-01'], '旧日保留');
  assert.ok(hist['2026-01-02'], '新日加入');
  assert.strictEqual(hist['2026-01-02'].updatedAt, 456);
});

test('mergeDailyHistory 裁剪最旧日超出 keepDays', () => {
  const existing = {
    '2026-01-01': { total: 1, cost: 0.1 },
    '2026-01-02': { total: 2, cost: 0.2 },
    '2026-01-03': { total: 3, cost: 0.3 },
  };
  const byDay = {
    '2026-01-04': {
      total: 4, cost: 0.4,
      tokens: { input: 4, output: 0, cacheWrite: 0, cacheRead: 0 },
      tools: {},
    },
  };
  const hist = mergeDailyHistory(existing, byDay, 789, 3);
  assert.ok(!hist['2026-01-01'], '最旧日被裁剪');
  assert.ok(hist['2026-01-02'], '第二日保留');
  assert.ok(hist['2026-01-03'], '第三日保留');
  assert.ok(hist['2026-01-04'], '新日保留');
  assert.strictEqual(Object.keys(hist).length, 3);
});

test('mergeDailyHistory 空 existing 时从 byDay 新建', () => {
  const byDay = {
    '2026-06-01': {
      total: 10, cost: 1,
      tokens: { input: 10, output: 0, cacheWrite: 0, cacheRead: 0 },
      tools: {},
    },
  };
  const hist = mergeDailyHistory(null, byDay, 999, 90);
  assert.strictEqual(hist['2026-06-01'].total, 10);
  assert.strictEqual(Object.keys(hist).length, 1);
});

test('mergeDailyHistory 空 byDay 时返回 existing 的副本', () => {
  const existing = { '2026-01-01': { total: 1, cost: 0.1 } };
  const hist = mergeDailyHistory(existing, {}, 0, 90);
  assert.strictEqual(hist['2026-01-01'].total, 1);
  assert.ok(hist !== existing, '应为新对象');
});
