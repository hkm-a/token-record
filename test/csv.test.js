'use strict';

// csv.js 单元测试：CSV 导出格式。

const test = require('node:test');
const assert = require('node:assert');
const { byDayToCsv } = require('../src/core/csv');

test('byDayToCsv 输出表头与多工具行', () => {
  const csv = byDayToCsv({
    '2026-07-24': {
      total: 300, cost: 1.5,
      tools: {
        claude: { total: 100, cost: 1 },
        codex: { total: 200, cost: 0.5 },
      },
    },
  });
  const lines = csv.trim().split('\n');
  assert.strictEqual(lines[0], 'date,tool,tokens,cost');
  assert.ok(lines.some((l) => l.startsWith('2026-07-24,claude,')));
  assert.ok(lines.some((l) => l.startsWith('2026-07-24,codex,')));
});

test('byDayToCsv 空工具列表时回退到 all', () => {
  const csv = byDayToCsv({
    '2026-07-24': { total: 500, cost: 2.5, tools: {} },
  });
  assert.ok(csv.includes('2026-07-24,all,500,2.500000'));
});

test('byDayToCsv 空对象返回仅表头', () => {
  const csv = byDayToCsv({});
  assert.strictEqual(csv.trim(), 'date,tool,tokens,cost');
});

test('byDayToCsv null/undefined 返回仅表头', () => {
  assert.strictEqual(byDayToCsv(null).trim(), 'date,tool,tokens,cost');
  assert.strictEqual(byDayToCsv(undefined).trim(), 'date,tool,tokens,cost');
});
