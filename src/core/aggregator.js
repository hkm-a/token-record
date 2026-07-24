'use strict';

// 聚合器：把三源的标准化用量事件合并、去重，按工具/模型/日汇总，并计价。
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

// 本地时区日期键 YYYY-MM-DD。
function localDayKey(ts) {
  const d = ts == null ? new Date() : new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 计算本地时区“今日零点”的毫秒时间戳。
function startOfToday(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// 生成以 end 为末日的连续 n 个本地日期键（含 end 当天，从早到晚）。
function listLastNDayKeys(n, endTs = Date.now()) {
  const end = new Date(endTs);
  end.setHours(0, 0, 0, 0);
  const keys = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(end.getDate() - i);
    keys.push(localDayKey(d.getTime()));
  }
  return keys;
}

// 确保 byDay 中有该日桶。
function ensureDay(byDay, dayKey) {
  if (!byDay[dayKey]) {
    byDay[dayKey] = {
      ...emptyBucket(),
      tools: {},
    };
  }
  return byDay[dayKey];
}

// 确保日桶内有某工具的子桶。
function ensureDayTool(dayBucket, tool) {
  if (!dayBucket.tools[tool]) {
    dayBucket.tools[tool] = emptyBucket();
  }
  return dayBucket.tools[tool];
}

// 由 byDay 与当前时刻生成 period（今日 / 近 7 日 / 近 7 日序列）。
function buildPeriod(byDay, now = Date.now()) {
  const todayKey = localDayKey(now);
  const last7Keys = listLastNDayKeys(7, now);

  const sumKeys = (keys) => {
    const out = emptyBucket();
    for (const k of keys) {
      const b = byDay[k];
      if (!b) continue;
      out.tokens.input += b.tokens.input;
      out.tokens.output += b.tokens.output;
      out.tokens.cacheWrite += b.tokens.cacheWrite;
      out.tokens.cacheRead += b.tokens.cacheRead;
      out.total += b.total;
      out.cost += b.cost;
      if (b.estimated) out.estimated = true;
    }
    return { tokens: out.tokens, total: out.total, cost: out.cost, estimated: out.estimated };
  };

  const todayBucket = byDay[todayKey];
  const today = todayBucket
    ? {
        tokens: { ...todayBucket.tokens },
        total: todayBucket.total,
        cost: todayBucket.cost,
        estimated: todayBucket.estimated,
      }
    : { tokens: emptyBucket().tokens, total: 0, cost: 0, estimated: false };

  const days = last7Keys.map((date) => {
    const b = byDay[date];
    return {
      date,
      total: b ? b.total : 0,
      cost: b ? b.cost : 0,
    };
  });

  return {
    todayKey,
    today,
    last7: sumKeys(last7Keys),
    days,
  };
}

// 序列化 byDay，去掉内部可变引用。
function serializeByDay(byDay) {
  const out = {};
  for (const [date, b] of Object.entries(byDay)) {
    const tools = {};
    for (const [name, t] of Object.entries(b.tools || {})) {
      tools[name] = {
        tokens: { ...t.tokens },
        total: t.total,
        cost: t.cost,
        estimated: t.estimated,
      };
    }
    out[date] = {
      tokens: { ...b.tokens },
      total: b.total,
      cost: b.cost,
      estimated: b.estimated,
      tools,
    };
  }
  return out;
}

// 主聚合函数。events：已合并的全部事件；table：定价表。
// opts.now：可注入当前时间，便于测试“今日/近7日”边界。
function aggregate(events, table, opts = {}) {
  const seen = new Set();
  const now = opts.now != null ? opts.now : Date.now();
  const todayStart = startOfToday(now);
  const byDay = {};
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

    const ts = ev.ts != null ? ev.ts : now;
    if (ts >= todayStart) {
      addTokens(t.today, ev);
      t.today.cost += priced.cost;
      if (priced.estimated) t.today.estimated = true;
    }

    // 按本地日累计（跨日历史曲线的数据源）。
    const dayKey = localDayKey(ts);
    const dayBucket = ensureDay(byDay, dayKey);
    addTokens(dayBucket, ev);
    dayBucket.cost += priced.cost;
    if (priced.estimated) dayBucket.estimated = true;
    const dayTool = ensureDayTool(dayBucket, ev.tool);
    addTokens(dayTool, ev);
    dayTool.cost += priced.cost;
    if (priced.estimated) dayTool.estimated = true;

    if (ev.sessionId) {
      t.sessions.add(ev.sessionId);
    }
  }

  // 收尾：sessions 转计数，拼总览与 period。
  const grand = { ...emptyBucket() };
  const toolsOut = {};
  for (const [name, t] of Object.entries(tools)) {
    toolsOut[name] = {
      tokens: t.tokens,
      total: t.total,
      cost: t.cost,
      estimated: t.estimated,
      today: {
        tokens: t.today.tokens,
        total: t.today.total,
        cost: t.today.cost,
        estimated: t.today.estimated,
      },
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

  const byDayOut = serializeByDay(byDay);
  const period = buildPeriod(byDayOut, now);

  return {
    generatedAt: now,
    tools: toolsOut,
    grand,
    byDay: byDayOut,
    period,
  };
}

module.exports = {
  aggregate,
  emptyBucket,
  startOfToday,
  localDayKey,
  listLastNDayKeys,
  buildPeriod,
};
