'use strict';

// 计价器：把 token 用量换算为美元花费。
// 设计意图：定价数据与逻辑分离（pricing.json 可独立修改）；模型名做“最长子串匹配”，
// 从而兼容带日期/后缀的模型标识（如 claude-opus-4-8、gpt-5.6-terra）。

const fs = require('fs');
const path = require('path');

// 读取定价表。默认读取同目录 pricing.json；允许传入自定义路径便于测试。
function loadTable(file) {
  const p = file || path.join(__dirname, 'pricing.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// 为模型查找费率：先精确匹配，再取“被模型名包含的最长键”，最后回退默认。
// 返回 { rate, matched, estimated }。
function findRate(model, table) {
  const models = table.models || {};
  if (model && models[model]) {
    const rate = models[model];
    return { rate, matched: model, estimated: !!rate.estimated };
  }
  let bestKey = null;
  let bestLen = 0;
  if (model) {
    for (const key of Object.keys(models)) {
      if (model.includes(key) && key.length > bestLen) {
        bestKey = key;
        bestLen = key.length;
      }
    }
  }
  if (bestKey) {
    const rate = models[bestKey];
    return { rate, matched: bestKey, estimated: !!rate.estimated };
  }
  const def = table.default || { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  return { rate: def, matched: 'default', estimated: true };
}

// 计算一组 token 的花费（美元）。tokens: {input, output, cacheWrite, cacheRead}。
function costOfTokens(tokens, model, table) {
  const { rate, matched, estimated } = findRate(model, table);
  const cost =
    ((tokens.input || 0) * (rate.input || 0) +
      (tokens.output || 0) * (rate.output || 0) +
      (tokens.cacheWrite || 0) * (rate.cacheWrite || 0) +
      (tokens.cacheRead || 0) * (rate.cacheRead || 0)) /
    1e6;
  return { cost, estimated, matched, free: !!rate.free };
}

module.exports = { loadTable, findRate, costOfTokens };
