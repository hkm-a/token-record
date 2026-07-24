'use strict';

// 快照存储：组装三个采集器，做“按文件增量缓存”，产出聚合快照并与上一帧比较得到增量。
// 设计意图：
//  - 实时刷新时，未变化的会话文件（mtime+size 未变）直接复用上次解析结果，避免全量重解析；
//  - 保留上一帧快照以计算 delta，供 UI 触发“数值变化动画/增量气泡”；
//  - 快照可持久化到 .cache/snapshot.json，重启后从上次值平滑过渡而非从 0 跳变；
//  - 按日汇总写入 .cache/daily.json，供历史曲线与导出复用。

const path = require('path');
const fs = require('fs');

const claude = require('../collectors/claude');
const codex = require('../collectors/codex');
const grok = require('../collectors/grok');
const { aggregate } = require('./aggregator');
const { loadTable } = require('../pricing/calculator');
const { probeSources } = require('./sources');

const COLLECTORS = { claude, codex, grok };

// 比较相邻两帧快照，得到每个工具与总量的 token/花费增量。
function diffSnapshots(prev, next) {
  const d = { tools: {}, grand: { tokenDelta: 0, costDelta: 0 } };
  const names = new Set([
    ...(prev ? Object.keys(prev.tools) : []),
    ...Object.keys(next.tools),
  ]);
  for (const name of names) {
    const a = prev && prev.tools[name];
    const b = next.tools[name];
    d.tools[name] = {
      tokenDelta: (b ? b.total : 0) - (a ? a.total : 0),
      costDelta: (b ? b.cost : 0) - (a ? a.cost : 0),
    };
  }
  d.grand.tokenDelta = next.grand.total - (prev ? prev.grand.total : 0);
  d.grand.costDelta = next.grand.cost - (prev ? prev.grand.cost : 0);
  return d;
}

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

// 把 byDay 打成 CSV 文本（date,tool,tokens,cost）。
function byDayToCsv(byDay) {
  const lines = ['date,tool,tokens,cost'];
  const dates = Object.keys(byDay || {}).sort();
  for (const date of dates) {
    const day = byDay[date];
    const tools = day.tools || {};
    const names = Object.keys(tools).sort();
    if (names.length === 0) {
      lines.push(`${date},all,${day.total || 0},${(day.cost || 0).toFixed(6)}`);
      continue;
    }
    for (const name of names) {
      const t = tools[name];
      lines.push(`${date},${name},${t.total || 0},${(t.cost || 0).toFixed(6)}`);
    }
  }
  return lines.join('\n') + '\n';
}

class Store {
  constructor(opts = {}) {
    this.table = opts.table || loadTable(opts.pricingFile, { overrideFile: opts.overrideFile });
    this.fileCache = new Map(); // path -> { mtimeMs, size, events }
    this.last = null; // 上一帧快照
    const cacheDir = opts.cacheDir || path.join(__dirname, '..', '..', '.cache');
    this.snapshotFile = opts.snapshotFile || path.join(cacheDir, 'snapshot.json');
    this.dailyFile = opts.dailyFile || path.join(cacheDir, 'daily.json');
    this.keepDays = opts.keepDays != null ? opts.keepDays : 90;
  }

  // 增量收集全部事件：命中缓存则复用，否则重新解析该文件。
  async computeEvents() {
    const all = [];
    const alive = new Set();
    for (const collector of Object.values(COLLECTORS)) {
      let files = [];
      try {
        files = collector.listSourceFiles();
      } catch (_err) {
        files = [];
      }
      for (const f of files) {
        alive.add(f.path);
        const cached = this.fileCache.get(f.path);
        let events;
        if (cached && cached.mtimeMs === f.mtimeMs && cached.size === f.size) {
          events = cached.events;
        } else {
          events = await collector.collectFile(f);
          this.fileCache.set(f.path, { mtimeMs: f.mtimeMs, size: f.size, events });
        }
        for (const e of events) {
          all.push(e);
        }
      }
    }
    // 清理已删除文件的缓存，避免内存泄漏与幽灵数据。
    for (const key of [...this.fileCache.keys()]) {
      if (!alive.has(key)) {
        this.fileCache.delete(key);
      }
    }
    return all;
  }

  // 刷新一帧：返回 { snapshot, delta, isFirst }。
  // snapshot.sources 携带各采集目录是否存在、会话文件数与空态文案。
  async refresh() {
    const isFirst = this.last === null;
    const sources = probeSources(COLLECTORS);
    const events = await this.computeEvents();
    const snapshot = aggregate(events, this.table);
    snapshot.sources = sources;
    const delta = diffSnapshots(this.last, snapshot);
    this.last = snapshot;
    return { snapshot, delta, isFirst };
  }

  // 读取持久化的上一帧（用于启动时平滑过渡）。
  loadPersisted() {
    try {
      const s = JSON.parse(fs.readFileSync(this.snapshotFile, 'utf8'));
      this.last = s;
      return s;
    } catch (_err) {
      return null;
    }
  }

  // 持久化当前帧，并合并写入按日历史。
  persist(snapshot) {
    try {
      fs.mkdirSync(path.dirname(this.snapshotFile), { recursive: true });
      fs.writeFileSync(this.snapshotFile, JSON.stringify(snapshot));
    } catch (_err) {
      // 持久化失败不影响主流程
    }
    this.persistDaily(snapshot);
  }

  // 合并 byDay 到 daily.json。
  persistDaily(snapshot) {
    if (!snapshot || !snapshot.byDay) return null;
    try {
      let existing = {};
      try {
        existing = JSON.parse(fs.readFileSync(this.dailyFile, 'utf8'));
      } catch (_err) {
        existing = {};
      }
      const hist = mergeDailyHistory(
        existing,
        snapshot.byDay,
        snapshot.generatedAt,
        this.keepDays
      );
      fs.mkdirSync(path.dirname(this.dailyFile), { recursive: true });
      fs.writeFileSync(this.dailyFile, JSON.stringify(hist, null, 2));
      return hist;
    } catch (_err) {
      return null;
    }
  }

  // 读取按日历史（若无则返回空对象）。
  loadDaily() {
    try {
      return JSON.parse(fs.readFileSync(this.dailyFile, 'utf8'));
    } catch (_err) {
      return {};
    }
  }

  // 导出 CSV 到指定路径；默认用当前快照 byDay。
  exportCsv(filePath, byDay) {
    const data = byDay || (this.last && this.last.byDay) || {};
    const csv = byDayToCsv(data);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, csv, 'utf8');
    return filePath;
  }
}

module.exports = { Store, diffSnapshots, mergeDailyHistory, byDayToCsv };
