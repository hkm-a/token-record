'use strict';

// Claude Code 采集器。
// 数据来源：~/.claude/projects/<项目>/<sessionId>.jsonl
// 每个 assistant 消息一行，携带 message.usage 与 message.model。
//
// 查漏补缺（借鉴 ccusage 经验）：
//  - 去重：同一 API 响应会因会话 fork/resume 在多个 jsonl 中重复出现，
//    必须用 (message.id + requestId) 组唯一键，否则花费翻倍。去重在聚合层统一执行，
//    本采集器只为每个事件产出 dedupeKey，从而支持“按文件缓存 + 增量刷新”。
//  - 缓存分离：cache_creation 与 cache_read 单价不同，分别保留原始字段。
//  - 合成消息：model 为 <synthetic> 或用量全 0 的行跳过。

const path = require('path');
const { readJsonl } = require('../shared/jsonl');
const { listFiles } = require('../shared/files');
const { rootOf } = require('../shared/paths');

// 将一行记录标准化为统一用量事件；非计费行返回 null。
function normalize(record, filePath) {
  if (!record || record.type !== 'assistant') {
    return null;
  }
  const msg = record.message;
  if (!msg || !msg.usage) {
    return null;
  }
  const model = msg.model;
  if (!model || model === '<synthetic>') {
    return null;
  }

  const u = msg.usage;
  const input = u.input_tokens || 0;
  const output = u.output_tokens || 0;
  const cacheWrite = u.cache_creation_input_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  if (input === 0 && output === 0 && cacheWrite === 0 && cacheRead === 0) {
    return null;
  }

  const parsedTs = record.timestamp ? Date.parse(record.timestamp) : NaN;
  const dedupeKey =
    msg.id || record.requestId
      ? `claude:${msg.id || ''}:${record.requestId || ''}`
      : `claude:${filePath}:${record.uuid || ''}`;

  return {
    tool: 'claude',
    model,
    ts: Number.isNaN(parsedTs) ? null : parsedTs,
    sessionId: record.sessionId || path.basename(filePath, '.jsonl'),
    input,
    output,
    cacheWrite,
    cacheRead,
    dedupeKey,
  };
}

// 解析单个会话文件，返回其全部候选用量事件（不去重）。增量刷新按文件调用。
async function collectFile(fileMeta) {
  const events = [];
  await readJsonl(fileMeta.path, (record) => {
    const ev = normalize(record, fileMeta.path);
    if (ev) {
      events.push(ev);
    }
  });
  return events;
}

// 列出全部 Claude 会话文件（含 mtime/size，供增量检测）。
function listSourceFiles() {
  return listFiles(rootOf('claude'), '.jsonl');
}

module.exports = { collectFile, listSourceFiles, normalize };
