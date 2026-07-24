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
    // 右上角放「今日」；模型名放到工具名 title，脚注只留入/出/存芯片以压低卡片高度
    card.innerHTML = `
      <div class="card-glow"></div>
      <div class="card-head">
        <span class="tool-dot"></span>
        <span class="tool-name">${t.name}</span>
        <span class="tool-today">今日 +0</span>
      </div>
      <div class="card-main">
        <div class="metric"><span class="num tokens">0</span><span class="unit">tokens</span></div>
        <span class="num cost">$0</span>
      </div>
      <div class="bar"><div class="bar-fill"></div></div>
      <div class="card-foot">
        <div class="stat-chips">
          <span class="chip chip-in">入 <b class="chip-in-val">0</b></span>
          <span class="chip chip-out">出 <b class="chip-out-val">0</b></span>
          <span class="chip chip-cache">存 <b class="chip-cache-val">0</b></span>
        </div>
      </div>
      <div class="bubble-layer"></div>`;
    wrap.appendChild(card);
    refs[t.key] = {
      card,
      tokens: card.querySelector('.tokens'),
      cost: card.querySelector('.cost'),
      nameEl: card.querySelector('.tool-name'),
      today: card.querySelector('.tool-today'),
      bar: card.querySelector('.bar-fill'),
      chipIn: card.querySelector('.chip-in-val'),
      chipOut: card.querySelector('.chip-out-val'),
      chipCache: card.querySelector('.chip-cache-val'),
      chips: card.querySelector('.stat-chips'),
      bubbles: card.querySelector('.bubble-layer'),
    };
    prev[t.key] = { tokens: 0, cost: 0 };
  }
  refs.grandTokens = document.getElementById('grandTokens');
  refs.grandCost = document.getElementById('grandCost');
  refs.periodToday = document.getElementById('periodToday');
  refs.periodWeek = document.getElementById('periodWeek');
  refs.periodBars = document.getElementById('periodBars');
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

    const modelLabel = d ? pickMainModel(d.models) : '';
    // 模型名改到悬停提示，右上角让位给「今日」
    r.nameEl.title = modelLabel && modelLabel !== '—' ? modelLabel : t.name;

    const pct = grandTotal > 0 ? (tokens / grandTotal) * 100 : 0;
    r.bar.style.width = pct.toFixed(1) + '%';

    const src = snapshot.sources && snapshot.sources.tools && snapshot.sources.tools[t.key];
    r.card.classList.toggle('is-muted', !!(src && src.status !== 'ok' && tokens === 0));

    if (d && tokens > 0) {
      const cache = d.tokens.cacheWrite + d.tokens.cacheRead;
      r.chipIn.textContent = formatCompact(d.tokens.input);
      r.chipOut.textContent = formatCompact(d.tokens.output);
      r.chipCache.textContent = formatCompact(cache);
      r.chips.hidden = false;
      r.today.textContent = `今日 +${formatCompact(d.today.total)}`;
      r.today.title = modelLabel ? `主力模型：${modelLabel}` : '';
    } else if (src) {
      r.chips.hidden = true;
      if (src.status === 'missing') {
        r.today.textContent = '目录缺失';
      } else if (src.status === 'empty') {
        r.today.textContent = '暂无会话';
      } else if (src.status === 'error') {
        r.today.textContent = '读取失败';
      } else {
        r.today.textContent = '无数据';
      }
      r.today.title = `${src.message || ''}\n${src.hint || ''}\n${src.root || ''}`;
      r.card.title = `${src.label}\n${src.root}\n${src.message || ''}`;
    } else {
      r.chips.hidden = true;
      r.today.textContent = '无数据';
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

  // 今日 / 近 7 日（折叠态也保留，方便一眼看到账单节奏）
  updatePeriod(snapshot);
  updateEmptyBanner(snapshot);

  // 状态栏
  const time = new Date(snapshot.generatedAt).toLocaleTimeString('zh-CN');
  refs.updatedAt.textContent = '更新于 ' + time;
  const notes = [];
  if (snapshot.grand.estimated) notes.push('含估算定价');
  if (snapshot.sources && snapshot.sources.allQuiet) notes.push('无会话数据');
  else if (snapshot.sources && snapshot.sources.anyMissing) notes.push('部分源目录缺失');
  // anyMissing may not exist - use missing count
  else if (snapshot.sources && snapshot.sources.missing > 0) notes.push('部分源目录缺失');
  else if (snapshot.sources && snapshot.sources.errors > 0) notes.push('部分源读取异常');
  refs.estimateNote.textContent = notes.join(' · ');

  // 收银音效：本帧任一工具有增长且未静音时，响一声。
  if (anyIncrease && !muted) {
    playCashRegister();
  }
}

// 全局空态横幅：三源皆无会话文件时展示引导。
function updateEmptyBanner(snapshot) {
  const banner = document.getElementById('emptyBanner');
  const title = document.getElementById('emptyTitle');
  const body = document.getElementById('emptyBody');
  if (!banner || !title || !body) return;

  const sources = snapshot.sources;
  const quiet = !snapshot.grand || !snapshot.grand.total;
  if (!sources || !quiet) {
    banner.hidden = true;
    return;
  }

  banner.hidden = false;
  title.textContent = sources.allQuiet ? '暂无用量数据' : '数据不完整';
  const lines = [];
  if (sources.banner) lines.push(sources.banner);
  for (const t of Object.values(sources.tools || {})) {
    lines.push(`· ${t.label}：${t.message || t.status}`);
    lines.push(`  ${t.hint}`);
  }
  body.textContent = lines.join('\n');
}

// 刷新周期区：文案 + 近 7 日迷你柱。
function updatePeriod(snapshot) {
  const period = snapshot.period || {};
  const today = period.today || { total: 0, cost: 0 };
  const last7 = period.last7 || { total: 0, cost: 0 };
  if (refs.periodToday) {
    refs.periodToday.innerHTML = `<span class="period-cost">${formatMoney(
      today.cost || 0
    )}</span><span class="period-tok">${formatCompact(today.total || 0)} tok</span>`;
  }
  if (refs.periodWeek) {
    refs.periodWeek.innerHTML = `<span class="period-cost">${formatMoney(
      last7.cost || 0
    )}</span><span class="period-tok">${formatCompact(last7.total || 0)} tok</span>`;
  }
  if (!refs.periodBars) return;

  const days = period.days || [];
  const max = Math.max(1, ...days.map((d) => d.total || 0));
  const todayKey = period.todayKey;
  refs.periodBars.innerHTML = '';
  for (const d of days) {
    const bar = document.createElement('div');
    bar.className = 'period-bar';
    const total = d.total || 0;
    if (total <= 0) {
      bar.classList.add('is-empty');
    } else {
      bar.style.height = Math.max(4, Math.round((total / max) * 28)) + 'px';
    }
    if (d.date === todayKey) bar.classList.add('is-today');
    bar.title = `${d.date}: ${formatCompact(total)} tokens · ${formatMoney(d.cost || 0)}`;
    refs.periodBars.appendChild(bar);
  }
}

// 绑定窗口控制按钮。
function bindControls() {
  // 关闭 = 隐藏到托盘（退出请用托盘菜单）
  document.getElementById('btnClose').addEventListener('click', () => {
    if (window.api.hide) window.api.hide();
    else window.api.quit();
  });
  document.getElementById('btnClose').title = '隐藏到托盘';
  document.getElementById('btnRefresh').addEventListener('click', () => window.api.refreshNow());

  // 折叠/展开：仅保留标题栏与总览
  let compact = false;
  const btnMin = document.getElementById('btnMin');
  const applyCompactUi = (on) => {
    compact = !!on;
    document.body.classList.toggle('compact', compact);
    btnMin.textContent = compact ? '▢' : '▁';
    btnMin.title = compact ? '展开' : '折叠';
  };
  btnMin.addEventListener('click', () => {
    applyCompactUi(!compact);
    window.api.setCompact(compact);
  });
  // 主进程恢复折叠偏好
  if (window.api.onPrefs) {
    window.api.onPrefs((p) => {
      if (p && p.compact) applyCompactUi(true);
      if (p && p.version) {
        const el = document.getElementById('appVersion');
        if (el) el.textContent = 'v' + p.version;
      }
    });
  }
  if (window.api.getVersion) {
    window.api.getVersion().then((v) => {
      const el = document.getElementById('appVersion');
      if (el && v) el.textContent = 'v' + v;
    });
  }

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
