'use strict';

// 采集源健康检查：目录是否存在、会话文件数量、空态文案。
// 与聚合解耦，供 Store / CLI / UI 共用。

const fs = require('fs');
const { rootOf } = require('../shared/paths');

const SOURCE_META = {
  claude: {
    label: 'Claude Code',
    hint: '~/.claude/projects/*/*.jsonl',
    how: '使用 Claude Code 产生会话后会出现用量',
  },
  codex: {
    label: 'Codex',
    hint: '~/.codex/sessions/**/*.jsonl',
    how: '使用 Codex 产生会话后会出现用量',
  },
  grok: {
    label: 'Grok Build',
    hint: '~/.grok/sessions/**/updates.jsonl',
    how: '使用 Grok Build 产生会话后会出现用量',
  },
  pi: {
    label: 'Pi',
    hint: '~/.pi/agent/sessions/**/*.jsonl',
    how: '使用 Pi 产生会话后会出现用量',
  },
};

// 探测单个源：missing | empty | ok | error
function probeOne(name, collector) {
  const meta = SOURCE_META[name] || { label: name, hint: '', how: '' };
  const root = rootOf(name);
  const base = {
    key: name,
    label: meta.label,
    root,
    hint: meta.hint,
    how: meta.how,
    exists: false,
    fileCount: 0,
    status: 'missing',
    message: '',
  };

  try {
    if (!fs.existsSync(root)) {
      base.status = 'missing';
      base.message = `目录不存在：${root}`;
      return base;
    }
    base.exists = true;
    let files = [];
    try {
      files = collector.listSourceFiles() || [];
    } catch (err) {
      base.status = 'error';
      base.message = String(err && err.message ? err.message : err);
      return base;
    }
    base.fileCount = files.length;
    if (files.length === 0) {
      base.status = 'empty';
      base.message = `已找到目录，但尚无会话文件（${meta.hint}）`;
      return base;
    }
    base.status = 'ok';
    base.message = `${files.length} 个会话文件`;
    return base;
  } catch (err) {
    base.status = 'error';
    base.message = String(err && err.message ? err.message : err);
    return base;
  }
}

// collectors: { claude, codex, grok, pi }
function probeSources(collectors) {
  const tools = {};
  let missing = 0;
  let empty = 0;
  let errors = 0;
  let totalFiles = 0;

  for (const [name, collector] of Object.entries(collectors)) {
    const info = probeOne(name, collector);
    tools[name] = info;
    totalFiles += info.fileCount || 0;
    if (info.status === 'missing') missing++;
    else if (info.status === 'empty') empty++;
    else if (info.status === 'error') errors++;
  }

  const names = Object.keys(tools);
  const allQuiet = totalFiles === 0; // 四源都没有可解析文件
  const lines = [];
  for (const name of names) {
    const t = tools[name];
    if (t.status !== 'ok') {
      lines.push(`${t.label}：${t.message}`);
    }
  }

  let banner = '';
  if (allQuiet) {
    banner =
      '暂无用量数据。请确认已安装并使用过 Claude Code / Codex / Pi / Grok Build；会话目录见各卡片提示。';
  } else if (missing > 0 || errors > 0) {
    banner = `部分数据源不可用（缺失 ${missing} · 错误 ${errors}）。详见状态栏或 CLI。`;
  }

  return {
    tools,
    totalFiles,
    missing,
    empty,
    errors,
    allQuiet,
    banner,
    issues: lines,
  };
}

// 生成状态栏短文案
function sourcesStatusLine(sources) {
  if (!sources) return '';
  if (sources.allQuiet) return '无会话数据';
  const parts = [];
  for (const t of Object.values(sources.tools || {})) {
    if (t.status === 'ok') continue;
    if (t.status === 'missing') parts.push(`${t.label}目录缺失`);
    else if (t.status === 'empty') parts.push(`${t.label}无会话`);
    else if (t.status === 'error') parts.push(`${t.label}异常`);
  }
  return parts.join(' · ');
}

module.exports = {
  SOURCE_META,
  probeOne,
  probeSources,
  sourcesStatusLine,
};
