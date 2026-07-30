'use strict';

// 计价器单元测试：验证模型名匹配策略与费用计算准确性。

const test = require('node:test');
const assert = require('node:assert');
const { loadTable, findRate, costOfTokens } = require('../src/pricing/calculator');

// 测试禁用用户价目覆盖，保证用例可重复
const table = loadTable({ overrideFile: false });

test('最长子串匹配：未指定供应商费率的 Opus 版本命中通用条目', () => {
  const r = findRate('claude-opus-4-2026', table);
  assert.strictEqual(r.matched, 'claude-opus-4');
  assert.strictEqual(r.estimated, false);
  assert.strictEqual(r.rate.input, 15);
  assert.strictEqual(r.rate.output, 75);
});

test('精确模型 claude-opus-4-8 使用供应商费率', () => {
  const r = findRate('claude-opus-4-8', table);
  assert.strictEqual(r.matched, 'claude-opus-4-8');
  assert.strictEqual(r.estimated, true);
  assert.strictEqual(r.rate.input, 5);
  assert.strictEqual(r.rate.output, 25);
  assert.strictEqual(r.rate.cacheWrite, 6.25);
  assert.strictEqual(r.rate.cacheRead, 0.5);
});

test('Claude Fable 5 使用官方标准费率且不标记估算', () => {
  const r = findRate('claude-fable-5-20260609', table);
  assert.strictEqual(r.matched, 'claude-fable-5');
  assert.strictEqual(r.estimated, false);
  assert.strictEqual(r.rate.input, 10);
  assert.strictEqual(r.rate.output, 50);
  assert.strictEqual(r.rate.cacheWrite, 12.5);
  assert.strictEqual(r.rate.cacheRead, 1);
});

test('自定义模型 gpt-5.6-terra 命中 gpt-5，且标记为估算', () => {
  const r = findRate('gpt-5.6-terra', table);
  assert.strictEqual(r.matched, 'gpt-5');
  assert.strictEqual(r.estimated, true);
});

test('grok-4.5-build-free 精确匹配且免费', () => {
  const r = findRate('grok-4.5-build-free', table);
  assert.strictEqual(r.matched, 'grok-4.5-build-free');
  assert.strictEqual(r.rate.free, true);
  assert.strictEqual(r.rate.input, 0);
});

test('未知模型回退到 default 并标记估算', () => {
  const r = findRate('totally-unknown-model-xyz', table);
  assert.strictEqual(r.matched, 'default');
  assert.strictEqual(r.estimated, true);
});

test('费用计算精确：通用 Claude Opus 已知用量应为 $12.5325', () => {
  const { cost } = costOfTokens(
    { input: 76498, output: 63838, cacheWrite: 222615, cacheRead: 1615445 },
    'claude-opus-4-2026',
    table
  );
  // 76498*15 + 63838*75 + 222615*18.75 + 1615445*1.5 = 12,532,518.75 (每百万)
  assert.ok(Math.abs(cost - 12.5325) < 0.0001, `实际 ${cost}`);
});

test('费用计算精确：供应商 Claude Opus 样本应为 $0.215923', () => {
  const { cost } = costOfTokens(
    { input: 2, output: 272, cacheWrite: 350, cacheRead: 413851 },
    'claude-opus-4-8',
    table
  );
  assert.ok(Math.abs(cost - 0.215923) < 1e-9, `实际 ${cost}`);
});

test('费用计算精确：Claude Fable 5 样本应为 $0.431846', () => {
  const { cost, estimated } = costOfTokens(
    { input: 2, output: 272, cacheWrite: 350, cacheRead: 413851 },
    'claude-fable-5-20260609',
    table
  );
  assert.ok(Math.abs(cost - 0.431846) < 1e-9, `实际 ${cost}`);
  assert.strictEqual(estimated, false);
});

test('免费模型费用为 0', () => {
  const { cost, free } = costOfTokens(
    { input: 1000, output: 2000, cacheWrite: 0, cacheRead: 5000 },
    'grok-4.5-build-free',
    table
  );
  assert.strictEqual(cost, 0);
  assert.strictEqual(free, true);
});
