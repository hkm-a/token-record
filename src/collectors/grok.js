'use strict';

// Grok Build 采集器。
// 数据来源：~/.grok/sessions/<编码cwd>/<sessionId>/updates.jsonl（每目录一个 session）。
// token 数据在 method === '_x.ai/session/update' 且 update.sessionUpdate === 'turn_completed'
// 的记录里，params.update.usage 携带单轮用量，并按 modelUsage 细分到模型。
//
// 查漏补缺：
//  - turn_completed.usage 是“单轮增量”，需累加所有轮次得到 session 总量（与 Codex 的累计快照相反）。
//  - inputTokens 含 cachedReadTokens，需减出非缓存输入；outputTokens 含 reasoningTokens。
//  - 优先按 modelUsage 分模型统计；缺失时退化为整体 usage。
//  - 顶层 timestamp 为 Unix 秒，需 ×1000 转毫秒。

const path = require('path');
const { readJsonl } = require('../shared/jsonl');
const { listFiles } = require('../shared/files');
const { rootOf } = require('../shared/paths');

// 累加一段 usage 到按模型分组的累加器。
function accumulate(byModel, model, usage) {
  let acc = byModel.get(model);
  if (!acc) {
    acc = { input: 0, output: 0, cacheRead: 0, reasoning: 0 };
    byModel.set(model, acc);
  }
  acc.input += usage.inputTokens || 0;
  acc.output += usage.outputTokens || 0;
  acc.cacheRead += usage.cachedReadTokens || 0;
  acc.reasoning += usage.reasoningTokens || 0;
}

// 解析单个 Grok session 的 updates.jsonl，返回按模型聚合的事件（可能多个模型）。
async function collectFile(fileMeta) {
  // sessionId 取会话目录名（updates.jsonl 的父目录）。
  const sessionId = path.basename(path.dirname(fileMeta.path));
  const byModel = new Map();
  let ts = null;

  await readJsonl(fileMeta.path, (rec) => {
    const params = rec && rec.params;
    const update = params && params.update;
    if (!update || update.sessionUpdate !== 'turn_completed' || !update.usage) {
      return;
    }
    const usage = update.usage;
    const modelUsage = usage.modelUsage;
    if (modelUsage && typeof modelUsage === 'object') {
      for (const [model, mu] of Object.entries(modelUsage)) {
        accumulate(byModel, model, mu);
      }
    } else {
      accumulate(byModel, 'grok', usage);
    }
    if (typeof rec.timestamp === 'number') {
      ts = rec.timestamp * 1000; // 秒 → 毫秒
    }
  });

  const events = [];
  for (const [model, acc] of byModel) {
    const nonCachedInput = Math.max(0, acc.input - acc.cacheRead);
    if (nonCachedInput === 0 && acc.output === 0 && acc.cacheRead === 0) {
      continue;
    }
    events.push({
      tool: 'grok',
      model,
      ts,
      sessionId,
      input: nonCachedInput,
      output: acc.output,
      cacheWrite: 0,
      cacheRead: acc.cacheRead,
      dedupeKey: `grok:${sessionId}:${model}`,
    });
  }
  return events;
}

function listSourceFiles() {
  // Grok 仅统计 updates.jsonl（含精确 usage），忽略 events/chat_history。
  return listFiles(rootOf('grok'), '.jsonl', 'updates.jsonl');
}

module.exports = { collectFile, listSourceFiles, accumulate };
