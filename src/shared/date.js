'use strict';

// 本地时区日期键 YYYY-MM-DD。
// 设计意图：四个采集器与聚合器共用同一日期格式化逻辑，避免重复定义。
// 聚合器用它将事件时间戳分桶；采集器用它按天拆分跨日会话。

function localDayKey(ts) {
  const d = ts == null ? new Date() : new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

module.exports = { localDayKey };
