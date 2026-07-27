'use strict';

// CSV 导出：将 byDay 按日数据转为 CSV 文本。
// 设计意图：从 Store 中分离出来，职责单一，便于测试和不依赖 Store 实例的独立使用。

// 把 byDay 打成 CSV 文本（date,tool,tokens,cost）。
function byDayToCsv(byDay) {
  const lines = ['date,tool,tokens,cost'];
  const dates = Object.keys(byDay || {}).sort();
  for (const date of dates) {
    const day = byDay[date];
    const tools = day.tools || {};
    const names = Object.keys(tools).sort();
    if (names.length === 0) {
      lines.push(`${date},all,${day.total || 0},${(day.cost || 0).toFixed(6)}`);
      continue;
    }
    for (const name of names) {
      const t = tools[name];
      lines.push(`${date},${name},${t.total || 0},${(t.cost || 0).toFixed(6)}`);
    }
  }
  return lines.join('\n') + '\n';
}

module.exports = { byDayToCsv };
