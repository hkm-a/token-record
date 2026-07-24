'use strict';

// CLI 校验工具：不启动 UI，直接打印三源聚合结果。
// 用途：本地验证采集与计价是否正确；支持导出按日 CSV。
// 运行：
//   npm run cli
//   node src/cli.js --csv .cache/export.csv

const path = require('path');
const { Store } = require('./core/store');
const { defaultOverridePath } = require('./pricing/calculator');

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const money = (n) => '$' + n.toFixed(n < 1 ? 4 : 2);

const TOOL_LABEL = {
  claude: 'Claude Code',
  codex: 'Codex',
  grok: 'Grok Build',
};

function parseArgs(argv) {
  const out = { csv: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--csv') {
      out.csv = argv[i + 1] || path.join('.cache', 'export.csv');
      i++;
    } else if (argv[i].startsWith('--csv=')) {
      out.csv = argv[i].slice('--csv='.length);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const store = new Store();
  const { snapshot } = await store.refresh();
  store.persist(snapshot);

  const line = '─'.repeat(56);
  console.log('\n  Token 消耗与花费汇总');
  console.log('  生成时间：' + new Date(snapshot.generatedAt).toLocaleString());
  console.log(line);

  const p = snapshot.period || {};
  const today = p.today || { total: 0, cost: 0 };
  const last7 = p.last7 || { total: 0, cost: 0 };
  console.log(`  今日：${fmt(today.total)} tokens · ${money(today.cost)}`);
  console.log(`  近7日：${fmt(last7.total)} tokens · ${money(last7.cost)}`);
  if (p.days && p.days.length) {
    const spark = p.days
      .map((d) => {
        const short = d.date.slice(5);
        return `${short}:${fmt(d.total)}`;
      })
      .join('  ');
    console.log(`  近7日序列：${spark}`);
  }
  console.log(line);

  // 采集源健康状态
  const sources = snapshot.sources;
  if (sources) {
    console.log('  数据源状态');
    for (const t of Object.values(sources.tools || {})) {
      const mark =
        t.status === 'ok' ? '✓' : t.status === 'missing' ? '✗' : t.status === 'empty' ? '○' : '!';
      console.log(`    ${mark} ${t.label}: ${t.message}`);
      console.log(`      路径 ${t.root}`);
    }
    if (sources.banner) {
      console.log(`  提示：${sources.banner}`);
    }
    console.log(line);
  }

  const toolNames = Object.keys(snapshot.tools);
  if (toolNames.length === 0) {
    console.log('  暂无任何用量数据。');
    console.log('  请先使用 Claude Code / Codex / Grok Build 产生本地会话后再刷新。');
  }

  for (const name of toolNames) {
    const t = snapshot.tools[name];
    console.log(`\n  ■ ${TOOL_LABEL[name] || name}${t.estimated ? '  (含估算定价)' : ''}`);
    console.log(`    Token 合计 : ${fmt(t.total)}`);
    console.log(
      `      输入 ${fmt(t.tokens.input)} / 输出 ${fmt(t.tokens.output)} / 缓存写 ${fmt(
        t.tokens.cacheWrite
      )} / 缓存读 ${fmt(t.tokens.cacheRead)}`
    );
    console.log(`    花费       : ${money(t.cost)}`);
    console.log(`    今日       : ${fmt(t.today.total)} tokens / ${money(t.today.cost)}`);
    console.log(`    会话数     : ${t.sessionCount}`);
    for (const [m, mm] of Object.entries(t.models)) {
      const tags = `${mm.free ? ' (免费)' : ''}${mm.estimated ? ' *估算' : ''}`;
      console.log(`      · ${m}: ${fmt(mm.total)} tokens, ${money(mm.cost)}${tags}`);
    }
  }

  const g = snapshot.grand;
  console.log('\n' + line);
  console.log(
    `  总计：${fmt(g.total)} tokens，${money(g.cost)}${g.estimated ? '  (含估算定价)' : ''}`
  );
  console.log(`  价目覆盖：${defaultOverridePath()}（不存在则用内置表）`);

  if (args.csv) {
    const out = path.resolve(args.csv);
    store.exportCsv(out, snapshot.byDay);
    console.log(`  已导出 CSV：${out}`);
  }
  console.log('');
}

main().catch((err) => {
  console.error('运行失败：', err);
  process.exit(1);
});
