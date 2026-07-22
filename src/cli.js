'use strict';

// CLI 校验工具：不启动 UI，直接打印三源聚合结果。
// 用途：本地验证采集与计价是否正确（CLAUDE.md 要求的可重复本地验证手段）。
// 运行：node src/cli.js  或  npm run cli

const { Store } = require('./core/store');

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const money = (n) => '$' + n.toFixed(n < 1 ? 4 : 2);

const TOOL_LABEL = {
  claude: 'Claude Code',
  codex: 'Codex',
  grok: 'Grok Build',
};

async function main() {
  const store = new Store();
  const { snapshot } = await store.refresh();

  const line = '─'.repeat(56);
  console.log('\n  Token 消耗与花费汇总');
  console.log('  生成时间：' + new Date(snapshot.generatedAt).toLocaleString());
  console.log(line);

  const toolNames = Object.keys(snapshot.tools);
  if (toolNames.length === 0) {
    console.log('  暂无任何用量数据。');
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
  console.log('');
}

main().catch((err) => {
  console.error('运行失败：', err);
  process.exit(1);
});
