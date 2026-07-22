'use strict';

// 聚合器：把三源的标准化用量事件合并、去重，按工具/模型/今日汇总，并计价。
// 输出结构供 UI 与 CLI 直接消费。

const { costOfTokens } = require('../pricing/calculator');

// 新建一个空的用量桶。
function emptyBucket() {
  return {
    tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    total: 0, // 四类 token 之和
    cost: 0,
    estimated: false, // 是否含估算定价
  };
}

// 把事件的 token 累加进桶。
function addTokens(bucket, ev) {
  bucket.tokens.input += ev.input;
  bucket.tokens.output += ev.output;
  bucket.tokens.cacheWrite += ev.cacheWrite;
  bucket.tokens.cacheRead += ev.cacheRead;
  bucket.total += ev.input + ev.output + ev.cacheWrite + ev.cacheRead;
}

// 计算本地时区“今日零点”的毫秒时间戳。
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// 主聚合函数。events：已合并的全部事件；table：定价表。
function aggregate(events, table) {
  const seen = new Set();
  const todayStart = startOfToday();

  const tools = {};

  for (const ev of events) {
    // 统一去重（Claude 跨文件重复的关键防线）。
    if (ev.dedupeKey) {
      if (seen.has(ev.dedupeKey)) {
        continue;
      }
      seen.add(ev.dedupeKey);
    }

    if (!tools[ev.tool]) {
      tools[ev.tool] = {
        ...emptyBucket(),
        models: {},
        today: emptyBucket(),
        sessions: new Set(),
      };
    }
    const t = tools[ev.tool];

    const priced = costOfTokens(ev, ev.model, table);

    addTokens(t, ev);
    t.cost += priced.cost;
    if (priced.estimated) t.estimated = true;

    if (!t.models[ev.model]) {
      t.models[ev.model] = { ...emptyBucket(), matched: priced.matched, free: priced.free };
    }
    const m = t.models[ev.model];
    addTokens(m, ev);
    m.cost += priced.cost;
    if (priced.estimated) m.estimated = true;

    if (ev.ts && ev.ts >= todayStart) {
      addTokens(t.today, ev);
      t.today.cost += priced.cost;
    }
    if (ev.sessionId) {
      t.sessions.add(ev.sessionId);
    }
  }

  // 收尾：把 sessions 集合转成计数，计算总览。
  const grand = { ...emptyBucket() };
  const toolsOut = {};
  for (const [name, t] of Object.entries(tools)) {
    toolsOut[name] = {
      tokens: t.tokens,
      total: t.total,
      cost: t.cost,
      estimated: t.estimated,
      today: { tokens: t.today.tokens, total: t.today.total, cost: t.today.cost },
      sessionCount: t.sessions.size,
      models: t.models,
    };
    grand.tokens.input += t.tokens.input;
    grand.tokens.output += t.tokens.output;
    grand.tokens.cacheWrite += t.tokens.cacheWrite;
    grand.tokens.cacheRead += t.tokens.cacheRead;
    grand.total += t.total;
    grand.cost += t.cost;
    if (t.estimated) grand.estimated = true;
  }

  return {
    generatedAt: Date.now(),
    tools: toolsOut,
    grand,
  };
}

module.exports = { aggregate, emptyBucket, startOfToday };
