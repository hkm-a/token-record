'use strict';

// JSONL 流式读取工具：四个采集器共用。
// 设计意图：会话文件可能很大（数万行），必须逐行流式解析而非整体载入内存；
// 单行 JSON 解析失败时跳过该行而不中断整个文件（容错），因为写入中的文件
// 末尾可能有半行。

const fs = require('fs');
const readline = require('readline');

// 逐行读取 JSONL 文件，对每条成功解析的记录调用 onRecord(obj, lineNo)。
// 返回 Promise，在读取完成后 resolve，附带统计信息。
// 若文件不存在，视为空文件（resolve 空统计），避免调用方到处判断存在性。
function readJsonl(filePath, onRecord) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      resolve({ lines: 0, parsed: 0, skipped: 0 });
      return;
    }
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let lines = 0;
    let parsed = 0;
    let skipped = 0;

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return; // 空行忽略，不计入统计
      }
      lines += 1;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch (_err) {
        skipped += 1; // 坏行（如写入中的半行）跳过
        return;
      }
      parsed += 1;
      try {
        onRecord(obj, lines);
      } catch (err) {
        // 回调内异常不应影响整体读取，但需向上暴露以便定位缺陷。
        rl.close();
        stream.destroy();
        reject(err);
      }
    });

    rl.on('close', () => resolve({ lines, parsed, skipped }));
    stream.on('error', (err) => reject(err));
  });
}

module.exports = { readJsonl };
