'use strict';

// Pi 采集器。
// 数据来源：~/.pi/agent/sessions/<编码cwd>/<sessionId>.jsonl（每文件一个 session）。
// 每条 assistant 消息携带 message.usage，按消息独立产生事件。
//
// 查漏补缺：
//  - 每个 assistant 消息的 usage 是单轮增量，每条消息独立携带精确用量，每条消息一个事件。
//  - input 本身已是非缓存值（cacheRead 是独立字段），无需减除。
//  - 去重：使用消息 id（record.id）作为唯一键。
//  - 合成/系统消息中 usage 全 0 的行跳过。
//  - toolResult 消息不含 usage 数据，跳过。

const path = require('path');
const { readJsonl } = require('../shared/jsonl');
const { listFiles } = require('../shared/files');
const { rootOf } = require('../shared/paths');

// 将一条 message 记录标准化为统一用量事件；非计费行返回 null。
function normalize(record, filePath) {
  if (!record || record.type !== 'message') {
    return null;
  }
  const msg = record.message;
  if (!msg || !msg.usage) {
    return null;
  }
  // 仅 assistant 消息携带有效用量；toolResult/user 行 usage 为全 0 或不存在
  if (msg.role !== 'assistant') {
    return null;
  }
  const model = msg.model;
  if (!model) {
    return null;
  }

  const u = msg.usage;
  const input = u.input || 0;
  const output = u.output || 0;
  const cacheWrite = u.cacheWrite || 0;
  const cacheRead = u.cacheRead || 0;
  if (input === 0 && output === 0 && cacheWrite === 0 && cacheRead === 0) {
    return null;
  }

  const parsedTs = record.timestamp ? Date.parse(record.timestamp) : NaN;

  return {
    tool: 'pi',
    model,
    ts: Number.isNaN(parsedTs) ? null : parsedTs,
    sessionId: record.id || path.basename(filePath, '.jsonl'),
    input,
    output,
    cacheWrite,
    cacheRead,
    dedupeKey: `pi:${record.id}`,
  };
}

// 解析单个 Pi 会话文件，返回其全部候选用量事件。
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

// 列出全部 Pi 会话文件（含 mtime/size，供增量检测）。
function listSourceFiles() {
  return listFiles(rootOf('pi'), '.jsonl');
}

module.exports = { collectFile, listSourceFiles, normalize };
