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

// 解析单个 Codex session 文件，返回按本地日聚合的事件（可能多天）。
// 关键：last_token_usage 是单轮增量，按事件所属本地日分组累加，
// 从而今日/按日统计只计入当天实际发生的轮次，而非整 session 归到最后一天。
// 若日志未提供 last_token_usage，则退化为取最后一个 total_token_usage 快照
// （此路径无单轮增量，仍按最后事件时间戳产出单个事件）。
async function collectFile(fileMeta) {
  let model = null;
  let sessionId = path.basename(fileMeta.path, '.jsonl');
  let lastTs = null;

  let lastTotal = null; // 最后一个 total_token_usage 快照
  // 按本地日期键分组累加单轮增量
  const byDay = new Map();
  let sawLast = false;

  await readJsonl(fileMeta.path, (rec) => {
    if (!rec || !rec.payload) {
      return;
    }
    if (rec.type === 'session_meta') {
      if (rec.payload.model) model = rec.payload.model;
      if (rec.payload.session_id) sessionId = rec.payload.session_id;
      if (rec.timestamp) lastTs = Date.parse(rec.timestamp);
    } else if (rec.type === 'turn_context' && rec.payload.model) {
      model = rec.payload.model;
    } else if (rec.type === 'event_msg' && rec.payload.type === 'token_count') {
      const info = rec.payload.info || rec.payload;
      if (info.total_token_usage) {
        lastTotal = info.total_token_usage;
      }
      if (info.last_token_usage) {
        const l = readUsage(info.last_token_usage);
        let dayTs = rec.timestamp ? Date.parse(rec.timestamp) : lastTs;
        if (Number.isNaN(dayTs)) dayTs = Date.now();
        lastTs = dayTs;
        const key = localDayKey(dayTs);
        let acc = byDay.get(key);
        if (!acc) {
          acc = { input: 0, cachedInput: 0, output: 0, reasoning: 0, ts: dayTs };
          byDay.set(key, acc);
        }
        acc.input += l.input;
        acc.cachedInput += l.cachedInput;
        acc.output += l.output;
        acc.reasoning += l.reasoning;
        sawLast = true;
      }
      if (rec.timestamp) lastTs = Date.parse(rec.timestamp);
    }
  });

  const events = [];
  if (sawLast) {
    for (const [, acc] of byDay) {
      const nonCachedInput = Math.max(0, acc.input - acc.cachedInput);
      if (nonCachedInput === 0 && acc.output === 0 && acc.cachedInput === 0) continue;
      events.push({
        tool: 'codex',
        model: model || 'gpt-5-codex',
        ts: acc.ts,
        sessionId,
        input: nonCachedInput,
        output: acc.output,
        cacheWrite: 0,
        cacheRead: acc.cachedInput,
        dedupeKey: `codex:${sessionId}:${localDayKey(acc.ts)}`,
      });
    }
  } else if (lastTotal) {
    // 无单轮增量：退化为最后快照，按最后时间戳产出单个事件
    const usage = readUsage(lastTotal);
    const nonCachedInput = Math.max(0, usage.input - usage.cachedInput);
    if (nonCachedInput !== 0 || usage.output !== 0 || usage.cachedInput !== 0) {
      events.push({
        tool: 'codex',
        model: model || 'gpt-5-codex',
        ts: Number.isNaN(lastTs) ? null : lastTs,
        sessionId,
        input: nonCachedInput,
        output: usage.output,
        cacheWrite: 0,
        cacheRead: usage.cachedInput,
        dedupeKey: `codex:${sessionId}`,
      });
    }
  }

  return events;
}

// 本地时区日期键 YYYY-MM-DD（与 aggregator.localDayKey 保持一致）。
function localDayKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function listSourceFiles() {
  return listFiles(rootOf('codex'), '.jsonl');
}

module.exports = { collectFile, listSourceFiles, readUsage };
