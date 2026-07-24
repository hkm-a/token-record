'use strict';

// 计价器单元测试：验证模型名匹配策略与费用计算准确性。

const test = require('node:test');
const assert = require('node:assert');
const { loadTable, findRate, costOfTokens } = require('../src/pricing/calculator');

// 测试禁用用户价目覆盖，保证用例可重复
const table = loadTable({ overrideFile: false });

test('最长子串匹配：claude-opus-4-8 命中 claude-opus-4', () => {
  const r = findRate('claude-opus-4-8', table);
  assert.strictEqual(r.matched, 'claude-opus-4');
  assert.strictEqual(r.estimated, false);
  assert.strictEqual(r.rate.input, 15);
  assert.strictEqual(r.rate.output, 75);
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

test('费用计算精确：Claude Opus 已知用量应为 $12.5325', () => {
  const { cost } = costOfTokens(
    { input: 76498, output: 63838, cacheWrite: 222615, cacheRead: 1615445 },
    'claude-opus-4-8',
    table
  );
  // 76498*15 + 63838*75 + 222615*18.75 + 1615445*1.5 = 12,532,518.75 (每百万)
  assert.ok(Math.abs(cost - 12.5325) < 0.0001, `实际 ${cost}`);
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
