'use strict';

// 计价器：把 token 用量换算为美元花费。
// 设计意图：定价数据与逻辑分离（pricing.json 可独立修改）；模型名做“最长子串匹配”，
// 从而兼容带日期/后缀的模型标识（如 claude-opus-4-8、gpt-5.6-terra）。
// 用户可通过 ~/.token-record/pricing.override.json 覆盖单价，无需改仓库文件。

const fs = require('fs');
const path = require('path');
const os = require('os');

// 默认用户覆盖文件路径。
function defaultOverridePath() {
  return path.join(os.homedir(), '.token-record', 'pricing.override.json');
}

// 浅合并模型表：override.models 覆盖同名键；default 字段按键合并。
function mergeTables(base, override) {
  if (!override || typeof override !== 'object') return base;
  const out = {
    ...base,
    models: { ...(base.models || {}) },
  };
  if (override.models && typeof override.models === 'object') {
    for (const [k, v] of Object.entries(override.models)) {
      out.models[k] = { ...(out.models[k] || {}), ...v };
    }
  }
  if (override.default && typeof override.default === 'object') {
    out.default = { ...(base.default || {}), ...override.default };
  }
  if (override._meta && typeof override._meta === 'object') {
    out._meta = { ...(base._meta || {}), ...override._meta };
  }
  return out;
}

// 读取定价表。默认读取同目录 pricing.json；再合并用户覆盖文件。
// opts.file / 位置参数 file：主表路径。
// opts.overrideFile：覆盖表路径；传 false 可禁用覆盖（测试用）。
function loadTable(file, opts = {}) {
  const options = typeof file === 'object' && file !== null ? file : opts;
  const mainFile =
    typeof file === 'string'
      ? file
      : options.file || path.join(__dirname, 'pricing.json');
  const base = JSON.parse(fs.readFileSync(mainFile, 'utf8'));

  let overrideFile = options.overrideFile;
  if (overrideFile === false) {
    return base;
  }
  if (overrideFile == null) {
    overrideFile = process.env.TOKENREC_PRICING_OVERRIDE || defaultOverridePath();
  }

  try {
    const raw = fs.readFileSync(overrideFile, 'utf8');
    const ov = JSON.parse(raw);
    return mergeTables(base, ov);
  } catch (_err) {
    // 无覆盖文件时静默使用主表
    return base;
  }
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

module.exports = {
  loadTable,
  findRate,
  costOfTokens,
  mergeTables,
  defaultOverridePath,
};
