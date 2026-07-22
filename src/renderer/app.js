'use strict';

// 渲染层主逻辑：生成三张固定工具卡，订阅主进程快照，驱动数值滚动与变化动效。
// 三个工具卡固定存在（即使暂无数据也显示为 0），符合“记录三家消耗”的产品预期。

// 工具元信息：品牌名与强调色（品牌色用于卡片强调、进度条、气泡、脉冲）。
const TOOLS = [
  { key: 'claude', name: 'Claude Code', accent: '#D97757' },
  { key: 'codex', name: 'Codex', accent: '#10A37F' },
  { key: 'grok', name: 'Grok Build', accent: '#9B8CFF' },
];

const refs = {}; // key -> 卡片内各元素引用
const prev = {}; // key -> 上次显示的 { tokens, cost }，作为 count-up 起点
let prevGrand = { tokens: 0, cost: 0 };
let muted = localStorage.getItem('tr_muted') === '1'; // 音效开关（持久化）

// 精简模型名，便于在窄卡内显示。
function tidyModel(m) {
  let s = m.replace(/^claude-/, '');
  s = s.replace(/^grok-([\d.]+).*/, 'grok-$1');
  return s;
}

// 从 models 映射中选出主力模型（token 最多），并标注其余模型数量。
function pickMainModel(models) {
  const entries = Object.entries(models || {});
  if (entries.length === 0) return '—';
  entries.sort((a, b) => b[1].total - a[1].total);
  const main = tidyModel(entries[0][0]);
  return entries.length > 1 ? `${main} +${entries.length - 1}` : main;
}

// 生成三张卡片并缓存元素引用。
function buildCards() {
  const wrap = document.getElementById('cards');
  for (const t of TOOLS) {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.setProperty('--accent', t.accent);
    card.innerHTML = `
      <div class="card-glow"></div>
      <div class="card-head">
        <span class="tool-dot"></span>
        <span class="tool-name">${t.name}</span>
        <span class="tool-model">—</span>
      </div>
      <div class="card-main">
        <div class="metric"><span class="num tokens">0</span><span class="unit">tokens</span></div>
        <span class="num cost">$0</span>
      </div>
      <div class="bar"><div class="bar-fill"></div></div>
      <div class="card-foot">
        <span class="breakdown">暂无数据</span>
        <span class="today">今日 +0</span>
      </div>
      <div class="bubble-layer"></div>`;
    wrap.appendChild(card);
    refs[t.key] = {
      card,
      tokens: card.querySelector('.tokens'),
      cost: card.querySelector('.cost'),
      model: card.querySelector('.tool-model'),
      bar: card.querySelector('.bar-fill'),
      breakdown: card.querySelector('.breakdown'),
      today: card.querySelector('.today'),
      bubbles: card.querySelector('.bubble-layer'),
    };
    prev[t.key] = { tokens: 0, cost: 0 };
  }
  refs.grandTokens = document.getElementById('grandTokens');
  refs.grandCost = document.getElementById('grandCost');
  refs.updatedAt = document.getElementById('updatedAt');
  refs.estimateNote = document.getElementById('estimateNote');
}

// 处理一帧快照：更新每张卡与总览，并对增量触发气泡与脉冲。
function handleData(payload) {
  const { snapshot, delta, isFirst } = payload;
  const grandTotal = snapshot.grand.total || 0;
  let anyIncrease = false;

  for (const t of TOOLS) {
    const d = snapshot.tools[t.key];
    const r = refs[t.key];
    const tokens = d ? d.total : 0;
    const cost = d ? d.cost : 0;

    animateValue(r.tokens, prev[t.key].tokens, tokens, 900, formatCompact);
    animateValue(r.cost, prev[t.key].cost, cost, 900, formatMoney);

    r.model.textContent = d ? pickMainModel(d.models) : '—';

    const pct = grandTotal > 0 ? (tokens / grandTotal) * 100 : 0;
    r.bar.style.width = pct.toFixed(1) + '%';

    if (d) {
      const cache = d.tokens.cacheWrite + d.tokens.cacheRead;
      r.breakdown.textContent = `入 ${formatCompact(d.tokens.input)} · 出 ${formatCompact(
        d.tokens.output
      )} · 存 ${formatCompact(cache)}`;
      r.today.textContent = `今日 +${formatCompact(d.today.total)}`;
    }

    // 变化动效：仅在非首帧且确有增长时触发，避免启动瞬间刷屏。
    const dt = delta.tools[t.key] ? delta.tools[t.key].tokenDelta : 0;
    if (!isFirst && dt > 0) {
      spawnBubble(r.bubbles, '+' + formatCompact(dt), t.accent);
      pulse(r.card);
      anyIncrease = true;
    }

    prev[t.key] = { tokens, cost };
  }

  // 总览
  animateValue(refs.grandTokens, prevGrand.tokens, grandTotal, 900, formatCompact);
  animateValue(refs.grandCost, prevGrand.cost, snapshot.grand.cost || 0, 900, formatMoney);
  prevGrand = { tokens: grandTotal, cost: snapshot.grand.cost || 0 };

  // 状态栏
  const time = new Date(snapshot.generatedAt).toLocaleTimeString('zh-CN');
  refs.updatedAt.textContent = '更新于 ' + time;
  refs.estimateNote.textContent = snapshot.grand.estimated ? '含估算定价' : '';

  // 收银音效：本帧任一工具有增长且未静音时，响一声。
  if (anyIncrease && !muted) {
    playCashRegister();
  }
}

// 绑定窗口控制按钮。
function bindControls() {
  document.getElementById('btnClose').addEventListener('click', () => window.api.quit());
  document.getElementById('btnRefresh').addEventListener('click', () => window.api.refreshNow());

  // 折叠/展开：仅保留标题栏与总览
  let compact = false;
  const btnMin = document.getElementById('btnMin');
  btnMin.addEventListener('click', () => {
    compact = !compact;
    document.body.classList.toggle('compact', compact);
    btnMin.textContent = compact ? '▢' : '▁';
    btnMin.title = compact ? '展开' : '折叠';
    window.api.setCompact(compact);
  });

  // 置顶
  let pinned = true;
  const btnPin = document.getElementById('btnPin');
  btnPin.classList.add('pinned');
  btnPin.addEventListener('click', () => {
    pinned = !pinned;
    btnPin.classList.toggle('pinned', pinned);
    window.api.togglePin(pinned);
  });

  // 音效开关（持久化；开启时试听一声）
  const btnMute = document.getElementById('btnMute');
  const refreshMute = () => {
    btnMute.textContent = muted ? '🔇' : '🔊';
    btnMute.classList.toggle('muted', muted);
    btnMute.title = muted ? '音效已关' : '音效已开';
  };
  refreshMute();
  btnMute.addEventListener('click', () => {
    muted = !muted;
    localStorage.setItem('tr_muted', muted ? '1' : '0');
    refreshMute();
    if (!muted) playCashRegister();
  });
}

// 初始化
buildCards();
bindControls();
window.api.onSnapshot(handleData);
