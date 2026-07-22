'use strict';

// 聚合器单元测试：验证去重、按工具/今日汇总与总览合计。

const test = require('node:test');
const assert = require('node:assert');
const { aggregate } = require('../src/core/aggregator');
const { loadTable } = require('../src/pricing/calculator');

const table = loadTable();

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
