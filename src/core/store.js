'use strict';

// 快照存储：组装三个采集器，做“按文件增量缓存”，产出聚合快照并与上一帧比较得到增量。
// 设计意图：
//  - 实时刷新时，未变化的会话文件（mtime+size 未变）直接复用上次解析结果，避免全量重解析；
//  - 保留上一帧快照以计算 delta，供 UI 触发“数值变化动画/增量气泡”；
//  - 快照可持久化到 .cache/snapshot.json，重启后从上次值平滑过渡而非从 0 跳变。

const path = require('path');
const fs = require('fs');

const claude = require('../collectors/claude');
const codex = require('../collectors/codex');
const grok = require('../collectors/grok');
const { aggregate } = require('./aggregator');
const { loadTable } = require('../pricing/calculator');

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

class Store {
  constructor(opts = {}) {
    this.table = opts.table || loadTable(opts.pricingFile);
    this.fileCache = new Map(); // path -> { mtimeMs, size, events }
    this.last = null; // 上一帧快照
    this.snapshotFile =
      opts.snapshotFile || path.join(__dirname, '..', '..', '.cache', 'snapshot.json');
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
  async refresh() {
    const isFirst = this.last === null;
    const events = await this.computeEvents();
    const snapshot = aggregate(events, this.table);
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

  // 持久化当前帧。
  persist(snapshot) {
    try {
      fs.mkdirSync(path.dirname(this.snapshotFile), { recursive: true });
      fs.writeFileSync(this.snapshotFile, JSON.stringify(snapshot));
    } catch (_err) {
      // 持久化失败不影响主流程
    }
  }
}

module.exports = { Store, diffSnapshots };
