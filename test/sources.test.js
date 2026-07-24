'use strict';

// 采集源健康检查单元测试。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { probeSources, sourcesStatusLine, probeOne } = require('../src/core/sources');

test('probeOne：目录不存在为 missing', () => {
  const root = path.join(os.tmpdir(), 'tokenrec-no-such-' + Date.now());
  const prev = process.env.TOKENREC_CLAUDE_DIR;
  process.env.TOKENREC_CLAUDE_DIR = root;
  // 重新加载 paths 才能吃到 env——paths 在模块加载时固化 HOME 与默认路径。
  // 这里改为直接测 probeSources 对 mock collector 的 empty/ok，missing 用假 collector + 临时改法：
  // probeOne 使用 rootOf，依赖 env。删除 require cache 后重载。
  delete require.cache[require.resolve('../src/shared/paths')];
  delete require.cache[require.resolve('../src/core/sources')];
  const sources = require('../src/core/sources');
  const info = sources.probeOne('claude', {
    listSourceFiles: () => {
      throw new Error('should not list');
    },
  });
  assert.strictEqual(info.status, 'missing');
  assert.ok(info.message.includes('不存在'));
  if (prev == null) delete process.env.TOKENREC_CLAUDE_DIR;
  else process.env.TOKENREC_CLAUDE_DIR = prev;
  delete require.cache[require.resolve('../src/shared/paths')];
  delete require.cache[require.resolve('../src/core/sources')];
});

test('probeSources：empty 与 ok', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenrec-src-'));
  const collectors = {
    claude: { listSourceFiles: () => [] },
    codex: {
      listSourceFiles: () => [{ path: path.join(dir, 'a.jsonl'), mtimeMs: 1, size: 1 }],
    },
    grok: { listSourceFiles: () => [] },
  };
  // 让三源目录都存在：写入 env 并重载
  process.env.TOKENREC_CLAUDE_DIR = dir;
  process.env.TOKENREC_CODEX_DIR = dir;
  process.env.TOKENREC_GROK_DIR = dir;
  delete require.cache[require.resolve('../src/shared/paths')];
  delete require.cache[require.resolve('../src/core/sources')];
  const { probeSources: probe } = require('../src/core/sources');
  const s = probe(collectors);
  assert.strictEqual(s.tools.claude.status, 'empty');
  assert.strictEqual(s.tools.codex.status, 'ok');
  assert.strictEqual(s.tools.codex.fileCount, 1);
  assert.strictEqual(s.allQuiet, false);
  assert.ok(s.totalFiles === 1);

  delete process.env.TOKENREC_CLAUDE_DIR;
  delete process.env.TOKENREC_CODEX_DIR;
  delete process.env.TOKENREC_GROK_DIR;
  delete require.cache[require.resolve('../src/shared/paths')];
  delete require.cache[require.resolve('../src/core/sources')];
});

test('sourcesStatusLine 汇总异常文案', () => {
  const line = sourcesStatusLine({
    allQuiet: false,
    tools: {
      claude: { label: 'Claude Code', status: 'missing' },
      codex: { label: 'Codex', status: 'ok' },
    },
  });
  assert.ok(line.includes('Claude Code'));
  assert.ok(!line.includes('Codex目录'));
});

test('allQuiet 时 banner 非空', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenrec-quiet-'));
  process.env.TOKENREC_CLAUDE_DIR = dir;
  process.env.TOKENREC_CODEX_DIR = dir;
  process.env.TOKENREC_GROK_DIR = dir;
  delete require.cache[require.resolve('../src/shared/paths')];
  delete require.cache[require.resolve('../src/core/sources')];
  const { probeSources: probe } = require('../src/core/sources');
  const s = probe({
    claude: { listSourceFiles: () => [] },
    codex: { listSourceFiles: () => [] },
    grok: { listSourceFiles: () => [] },
  });
  assert.strictEqual(s.allQuiet, true);
  assert.ok(s.banner && s.banner.length > 0);
  delete process.env.TOKENREC_CLAUDE_DIR;
  delete process.env.TOKENREC_CODEX_DIR;
  delete process.env.TOKENREC_GROK_DIR;
  delete require.cache[require.resolve('../src/shared/paths')];
  delete require.cache[require.resolve('../src/core/sources')];
});
