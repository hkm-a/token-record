'use strict';

// shared/date.js 单元测试：验证日期键生成的正确性。

const test = require('node:test');
const assert = require('node:assert');
const { localDayKey } = require('../src/shared/date');

test('localDayKey 从 Date 对象返回 YYYY-MM-DD', () => {
  const d = new Date(2026, 0, 15, 8, 30, 0); // 2026-01-15
  assert.strictEqual(localDayKey(d.getTime()), '2026-01-15');
});

test('localDayKey 处理个位数月与日', () => {
  const d = new Date(2026, 8, 5, 0, 0, 0); // 2026-09-05
  assert.strictEqual(localDayKey(d.getTime()), '2026-09-05');
});

test('localDayKey null 参数返回当天 (不抛异常)', () => {
  const result = localDayKey(null);
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  assert.strictEqual(result, `${y}-${m}-${day}`);
});

test('localDayKey 从 aggregator 导出仍可用（向后兼容）', () => {
  const { localDayKey: aggKey } = require('../src/core/aggregator');
  const d = new Date(2026, 6, 24, 15, 0, 0);
  assert.strictEqual(aggKey(d.getTime()), '2026-07-24');
  assert.strictEqual(aggKey, localDayKey, '应为同一函数引用');
});
