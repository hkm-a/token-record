'use strict';

// 渲染层：高信息密度布局——总览副行承载今日/7日，卡片右上角今日，模型名二级显示。

const TOOLS = [
  { key: 'claude', name: 'Claude Code', accent: '#D97757' },
  { key: 'codex', name: 'Codex', accent: '#10A37F' },
  { key: 'pi', name: 'Pi', accent: '#5EBDCF' },
  { key: 'grok', name: 'Grok Build', accent: '#9B8CFF' },
];

const refs = {};
const prev = {};
let prevGrand = { tokens: 0, cost: 0 };
let muted = localStorage.getItem('tr_muted') === '1';

function tidyModel(m) {
  let s = m.replace(/^claude-/, '');
  s = s.replace(/^grok-([\d.]+).*/, 'grok-$1');
  return s;
}

function pickMainModel(models) {
  const entries = Object.entries(models || {});
  if (entries.length === 0) return '';
  entries.sort((a, b) => b[1].total - a[1].total);
  const main = tidyModel(entries[0][0]);
  return entries.length > 1 ? `${main} +${entries.length - 1}` : main;
}

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
        <div class="tool-meta">
          <span class="tool-name">${t.name}</span>
          <span class="tool-model">—</span>
        </div>
        <span class="tool-today">今日 +0</span>
      </div>
      <div class="card-main">
        <div class="metric"><span class="num tokens">0</span><span class="unit">tok</span></div>
        <span class="num cost">$0</span>
      </div>
      <div class="bar"><div class="bar-fill"></div></div>
      <div class="stat-chips">
        <span class="chip">入 <b class="chip-in-val">0</b></span>
        <span class="chip">出 <b class="chip-out-val">0</b></span>
        <span class="chip">存 <b class="chip-cache-val">0</b></span>
      </div>
      <div class="bubble-layer"></div>`;
    wrap.appendChild(card);
    refs[t.key] = {
      card,
      tokens: card.querySelector('.tokens'),
      cost: card.querySelector('.cost'),
      model: card.querySelector('.tool-model'),
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
  refs.grandTokensSub = document.getElementById('grandTokensSub');
  refs.grandCostSub = document.getElementById('grandCostSub');
  refs.periodBars = document.getElementById('periodBars');
  refs.updatedAt = document.getElementById('updatedAt');
  refs.estimateNote = document.getElementById('estimateNote');
}

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
    r.model.textContent = modelLabel || '—';
    r.model.title = modelLabel || '';

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
      r.today.title = '';
    } else if (src) {
      r.chips.hidden = true;
      r.model.textContent = src.status === 'missing' ? '未安装?' : src.status === 'empty' ? '待产生' : '—';
      if (src.status === 'missing') r.today.textContent = '目录缺失';
      else if (src.status === 'empty') r.today.textContent = '暂无会话';
      else if (src.status === 'error') r.today.textContent = '读取失败';
      else r.today.textContent = '无数据';
      r.today.title = `${src.message || ''}\n${src.root || ''}`;
      r.card.title = `${src.label}\n${src.root}\n${src.message || ''}`;
    } else {
      r.chips.hidden = true;
      r.today.textContent = '无数据';
    }

    const dt = delta.tools[t.key] ? delta.tools[t.key].tokenDelta : 0;
    if (!isFirst && dt > 0) {
      spawnBubble(r.bubbles, '+' + formatCompact(dt), t.accent);
      pulse(r.card);
      anyIncrease = true;
    }

    prev[t.key] = { tokens, cost };
  }

  animateValue(refs.grandTokens, prevGrand.tokens, grandTotal, 900, formatCompact);
  animateValue(refs.grandCost, prevGrand.cost, snapshot.grand.cost || 0, 900, formatMoney);
  prevGrand = { tokens: grandTotal, cost: snapshot.grand.cost || 0 };

  updatePeriod(snapshot);
  updateEmptyBanner(snapshot);

  const time = new Date(snapshot.generatedAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  refs.updatedAt.textContent = time;
  const notes = [];
  if (snapshot.grand.estimated) notes.push('估算');
  if (snapshot.sources && snapshot.sources.allQuiet) notes.push('无会话');
  else if (snapshot.sources && snapshot.sources.missing > 0) notes.push('源缺失');
  else if (snapshot.sources && snapshot.sources.errors > 0) notes.push('源异常');
  refs.estimateNote.textContent = notes.join(' · ');

  if (anyIncrease && !muted && document.visibilityState !== 'hidden') playCashRegister();
  // 内容高度可能变化：下一帧请求主进程收紧窗口
  requestAnimationFrame(() => {
    if (window.api && window.api.fitContent) window.api.fitContent();
  });
}

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
  // 单行摘要，避免大段空白占位
  const issues = Object.values(sources.tools || {})
    .filter((t) => t.status !== 'ok')
    .map((t) => `${t.label}:${t.status === 'missing' ? '无目录' : t.status === 'empty' ? '无会话' : '异常'}`)
    .join(' · ');
      body.textContent = issues || sources.banner || '请先使用 Claude / Codex / Pi / Grok 产生本地会话';
}

function updatePeriod(snapshot) {
  const period = snapshot.period || {};
  const today = period.today || { total: 0, cost: 0 };
  const last7 = period.last7 || { total: 0, cost: 0 };

  if (refs.grandTokensSub) {
    refs.grandTokensSub.textContent = `今日 ${formatCompact(today.total || 0)} · 7日 ${formatCompact(
      last7.total || 0
    )}`;
  }
  if (refs.grandCostSub) {
    refs.grandCostSub.textContent = `今日 ${formatMoney(today.cost || 0)} · 7日 ${formatMoney(
      last7.cost || 0
    )}`;
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
      bar.style.height = Math.max(3, Math.round((total / max) * 22)) + 'px';
    }
    if (d.date === todayKey) bar.classList.add('is-today');
    const md = (d.date || '').slice(5);
    bar.title = `${md}: ${formatCompact(total)} · ${formatMoney(d.cost || 0)}`;
    refs.periodBars.appendChild(bar);
  }
}

function bindControls() {
  document.getElementById('btnClose').addEventListener('click', () => {
    if (window.api.hide) window.api.hide();
    else window.api.quit();
  });
  document.getElementById('btnRefresh').addEventListener('click', () => window.api.refreshNow());

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
    // 折叠后只剩两大指标，下一帧收紧窗口
    requestAnimationFrame(() => {
      if (window.api && window.api.fitContent) window.api.fitContent();
    });
  });
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

  let pinned = true;
  const btnPin = document.getElementById('btnPin');
  btnPin.classList.add('pinned');
  btnPin.addEventListener('click', () => {
    pinned = !pinned;
    btnPin.classList.toggle('pinned', pinned);
    window.api.togglePin(pinned);
  });

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
buildCards();
bindControls();
window.api.onSnapshot(handleData);

// 启动后 5 秒自动检查更新
setTimeout(() => {
  if (window.api && window.api.startUpdate) window.api.startUpdate();
}, 5000);

// ─── 更新指示器 ─────────────────────────────────

let updateInfo = null;
let updateState = 'idle'; // idle | available | downloading | ready
const versionEl = document.getElementById('appVersion');

window.api.onUpdateAvailable((info) => {
  updateInfo = info;
  if (updateState === 'idle') {
    versionEl.classList.add('has-update');
    versionEl.title = `点击更新至 v${info.latestVersion}`;
    if (window.api.fitContent) window.api.fitContent();
  }
});

window.api.onUpdateProgress((data) => {
  if (data.status === 'downloading') {
    updateState = 'downloading';
    versionEl.classList.remove('has-update');
    versionEl.textContent = data.percent > 0 ? `${data.percent}%` : '↓';
    versionEl.title = `正在下载 v${data.latestVersion}…`;
  } else if (data.status === 'ready') {
    updateState = 'ready';
    versionEl.textContent = '↻重启';
    versionEl.title = `v${data.latestVersion} 已就绪，点击重启`;
    versionEl.classList.add('has-update');
  }
});

versionEl.addEventListener('click', () => {
  if (updateState === 'ready') {
    if (window.api.applyUpdate) window.api.applyUpdate();
    return;
  }
  if (!updateInfo || updateState !== 'idle' && updateState !== 'available') return;
  // 标记已处理，防止重复点击
  updateState = 'available';
  versionEl.classList.remove('has-update');
  versionEl.title = '检查中…';
  if (window.api.startUpdate) window.api.startUpdate();
});
