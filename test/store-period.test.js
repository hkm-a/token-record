'use strict';

// 按日历史合并与 CSV 导出测试。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mergeDailyHistory, byDayToCsv, Store } = require('../src/core/store');
const { loadTable, mergeTables } = require('../src/pricing/calculator');
const { aggregate } = require('../src/core/aggregator');

test('mergeDailyHistory 合并并裁剪旧日', () => {
  const existing = {
    '2026-01-01': { total: 1, cost: 0.1 },
    '2026-01-02': { total: 2, cost: 0.2 },
  };
  const byDay = {
    '2026-01-03': {
      total: 3,
      cost: 0.3,
      tokens: { input: 3, output: 0, cacheWrite: 0, cacheRead: 0 },
      tools: { claude: { total: 3, cost: 0.3 } },
    },
  };
  const hist = mergeDailyHistory(existing, byDay, 123, 2);
  assert.ok(!hist['2026-01-01'], '最旧日应被裁剪');
  assert.ok(hist['2026-01-02']);
  assert.ok(hist['2026-01-03']);
  assert.strictEqual(hist['2026-01-03'].updatedAt, 123);
});

test('byDayToCsv 输出表头与分工具行', () => {
  const csv = byDayToCsv({
    '2026-07-24': {
      total: 300,
      cost: 1.5,
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

test('Store.persistDaily 写入 daily.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenrec-'));
  const store = new Store({
    table: loadTable({ overrideFile: false }),
    cacheDir: dir,
  });
  const now = new Date(2026, 6, 24, 12, 0, 0).getTime();
  const snap = aggregate(
    [
      {
        tool: 'claude',
        model: 'claude-opus-4',
        ts: now,
        sessionId: 's',
        input: 1000,
        output: 0,
        cacheWrite: 0,
        cacheRead: 0,
        dedupeKey: 'p1',
      },
    ],
    store.table,
    { now }
  );
  store.persistDaily(snap);
  const daily = JSON.parse(fs.readFileSync(path.join(dir, 'daily.json'), 'utf8'));
  const key = Object.keys(daily)[0];
  assert.ok(key);
  assert.strictEqual(daily[key].total, 1000);
});

test('mergeTables：override 覆盖模型单价', () => {
  const base = loadTable({ overrideFile: false });
  const merged = mergeTables(base, {
    models: {
      'claude-opus-4': { input: 99, output: 99, cacheWrite: 0, cacheRead: 0 },
    },
  });
  assert.strictEqual(merged.models['claude-opus-4'].input, 99);
  assert.strictEqual(base.models['claude-opus-4'].input, 15, '主表不应被就地修改');
});

test('loadTable 读取 override 文件改变费用', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenrec-ov-'));
  const ovPath = path.join(dir, 'pricing.override.json');
  fs.writeFileSync(
    ovPath,
    JSON.stringify({
      models: {
        'claude-opus-4': { input: 1000000, output: 0, cacheWrite: 0, cacheRead: 0 },
      },
    })
  );
  const table = loadTable({ overrideFile: ovPath });
  // 1 token input * 1e6 / 1e6 = $1
  const { costOfTokens } = require('../src/pricing/calculator');
  const { cost } = costOfTokens(
    { input: 1, output: 0, cacheWrite: 0, cacheRead: 0 },
    'claude-opus-4',
    table
  );
  assert.ok(Math.abs(cost - 1) < 1e-9, `实际 ${cost}`);
});
