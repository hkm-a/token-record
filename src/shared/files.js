'use strict';

// 文件遍历工具：递归列出目录下指定扩展名的文件，并附带 mtime 与 size。
// 设计意图：采集器需要发现所有会话文件；mtime/size 供上层做增量检测
// （文件未变化则跳过重新解析），是实时刷新性能的关键。

const fs = require('fs');
const path = require('path');

// 递归列出 dir 下所有以 ext 结尾的文件。
// 返回 [{ path, mtimeMs, size }]。目录不存在时返回空数组（调用方无需判存在）。
// name 参数可选：仅匹配指定文件名（如 'updates.jsonl'），用于 Grok。
function listFiles(dir, ext, name) {
  const out = [];
  if (!fs.existsSync(dir)) {
    return out;
  }
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (_err) {
      continue; // 无权限或竞态删除，跳过该目录
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        const matchExt = ext ? entry.name.endsWith(ext) : true;
        const matchName = name ? entry.name === name : true;
        if (matchExt && matchName) {
          try {
            const st = fs.statSync(full);
            out.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
          } catch (_err) {
            // 竞态：statSync 时文件已删除，忽略
          }
        }
      }
    }
  }
  return out;
}

module.exports = { listFiles };
