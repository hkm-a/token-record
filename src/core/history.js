'use strict';

// 按日历史管理：将 byDay 快照合并到持久化历史，裁剪超期天数。
// 设计意图：从 Store 中分离出来，职责单一，便于测试。

// 将 byDay 合并进历史文件；只保留最近 keepDays 天。
function mergeDailyHistory(existing, byDay, generatedAt, keepDays = 90) {
  const hist = existing && typeof existing === 'object' ? { ...existing } : {};
  for (const [date, day] of Object.entries(byDay || {})) {
    hist[date] = {
      total: day.total,
      cost: day.cost,
      tokens: day.tokens,
      tools: day.tools,
      updatedAt: generatedAt,
    };
  }
  const keys = Object.keys(hist).sort();
  if (keys.length > keepDays) {
    const drop = keys.slice(0, keys.length - keepDays);
    for (const k of drop) delete hist[k];
  }
  return hist;
}

module.exports = { mergeDailyHistory };
