'use strict';

// Codex 采集器。
// 数据来源：~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl（每文件一个 session）。
// token 数据在 event_msg 记录中，payload.type === 'token_count'。
//
// 查漏补缺（关键陷阱）：
//  - total_token_usage 是“累计快照”，同一 session 内多个 token_count 事件的 total 递增。
//    绝不能累加所有 total（会重复计数）。正确做法：累加每个事件的 last_token_usage（单轮增量）；
//    若日志未提供 last_token_usage，则退化为取最后一个 total_token_usage 快照。
//  - OpenAI 口径：input_tokens 已包含 cached_input_tokens，需减出非缓存输入；
//    output_tokens 已包含 reasoning_output_tokens，直接作为输出计费。

const path = require('path');
const { readJsonl } = require('../shared/jsonl');
const { listFiles } = require('../shared/files');
const { rootOf } = require('../shared/paths');

// 从 total/last 结构安全读取字段（兼容不同字段命名）。
function readUsage(u) {
  return {
    input: u.input_tokens || 0,
    cachedInput: u.cached_input_tokens || u.cache_read_input_tokens || 0,
    output: u.output_tokens || 0,
    reasoning: u.reasoning_output_tokens || 0,
  };
}

// 解析单个 Codex session 文件，返回 0 或 1 个聚合事件（session 级）。
async function collectFile(fileMeta) {
  let model = null;
  let sessionId = path.basename(fileMeta.path, '.jsonl');
  let ts = null;

  let lastTotal = null; // 最后一个 total_token_usage 快照
  const sumLast = { input: 0, cachedInput: 0, output: 0, reasoning: 0 };
  let sawLast = false;

  await readJsonl(fileMeta.path, (rec) => {
    if (!rec || !rec.payload) {
      return;
    }
    if (rec.type === 'session_meta') {
      if (rec.payload.model) model = rec.payload.model;
      if (rec.payload.session_id) sessionId = rec.payload.session_id;
      if (rec.timestamp) ts = Date.parse(rec.timestamp);
    } else if (rec.type === 'turn_context' && rec.payload.model) {
      model = rec.payload.model;
    } else if (rec.type === 'event_msg' && rec.payload.type === 'token_count') {
      const info = rec.payload.info || rec.payload;
      if (info.total_token_usage) {
        lastTotal = info.total_token_usage;
      }
      if (info.last_token_usage) {
        const l = readUsage(info.last_token_usage);
        sumLast.input += l.input;
        sumLast.cachedInput += l.cachedInput;
        sumLast.output += l.output;
        sumLast.reasoning += l.reasoning;
        sawLast = true;
      }
      if (rec.timestamp) ts = Date.parse(rec.timestamp);
    }
  });

  let usage;
  if (sawLast) {
    usage = sumLast;
  } else if (lastTotal) {
    usage = readUsage(lastTotal);
  } else {
    return []; // 无 token 数据（例如中途失败的 session）
  }

  const nonCachedInput = Math.max(0, usage.input - usage.cachedInput);
  if (nonCachedInput === 0 && usage.output === 0 && usage.cachedInput === 0) {
    return [];
  }

  return [
    {
      tool: 'codex',
      model: model || 'gpt-5-codex',
      ts: Number.isNaN(ts) ? null : ts,
      sessionId,
      input: nonCachedInput,
      output: usage.output,
      cacheWrite: 0,
      cacheRead: usage.cachedInput,
      dedupeKey: `codex:${sessionId}`,
    },
  ];
}

function listSourceFiles() {
  return listFiles(rootOf('codex'), '.jsonl');
}

module.exports = { collectFile, listSourceFiles, readUsage };
