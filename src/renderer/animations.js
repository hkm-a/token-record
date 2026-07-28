'use strict';

// 渲染层动画原语：数字滚动、增量气泡、脉冲高亮。
// 设计意图：把“数值变化的设计感”集中在这里，供 app.js 调度。
// 全部基于 requestAnimationFrame / CSS 动画，避免第三方依赖。

// 数字滚动（count-up）：在 duration 内从 from 平滑过渡到 to，用 formatter 格式化显示。
// 采用 easeOutExpo 缓动，收尾自然；对同一元素重入时取消上一段动画避免抖动。
function animateValue(el, from, to, duration, formatter) {
  if (!el) return;
  // 拖拽中不跑动画，直接跳到终值
  if (document.body.classList.contains('dragging')) {
    el.textContent = formatter(to);
    return;
  }
  if (el._raf) {
    cancelAnimationFrame(el._raf);
    el._raf = null;
  }
  const diff = to - from;
  if (Math.abs(diff) < 1e-9) {
    el.textContent = formatter(to);
    return;
  }
  const start = performance.now();
  function frame(now) {
    // 如果中途开始拖拽，立即跳到终值
    if (document.body.classList.contains('dragging')) {
      el.textContent = formatter(to);
      el._raf = null;
      return;
    }
    let t = (now - start) / duration;
    if (t > 1) t = 1;
    const eased = t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
    el.textContent = formatter(from + diff * eased);
    if (t < 1) {
      el._raf = requestAnimationFrame(frame);
    } else {
      el._raf = null;
    }
  }
  el._raf = requestAnimationFrame(frame);
}

// 增量气泡：在 layer 中生成一个上浮淡出的 “+N” 标签，动画结束后自动移除。
function spawnBubble(layer, text, accent) {
  if (!layer) return;
  const b = document.createElement('span');
  b.className = 'bubble';
  b.textContent = text;
  if (accent) {
    b.style.color = accent;
    b.style.textShadow = `0 0 12px ${accent}`;
  }
  // 轻微水平抖动，避免多次气泡完全重叠。
  const jitter = (Math.sin(layer.childElementCount * 1.7) * 10).toFixed(1);
  b.style.setProperty('--bubble-x', jitter + 'px');
  layer.appendChild(b);
  b.addEventListener('animationend', () => b.remove());
  // 兜底移除，避免个别环境不触发 animationend 导致堆积。
  setTimeout(() => b.remove(), 2000);
}

// 脉冲高亮：给元素重放一次脉冲动画（先移除类再强制重排以重启动画）。
function pulse(el) {
  if (!el) return;
  el.classList.remove('pulse');
  void el.offsetWidth; // 强制重排，重启 CSS 动画
  el.classList.add('pulse');
}

// 数字格式化：紧凑写法（1.23B / 123M / 12.3K），适配悬浮小窗。
// 每档按数量级递减小数位，保持约 4 位有效字符宽度。
function formatCompact(n) {
  const v = Math.max(0, n);
  if (v >= 1e11) return (v / 1e9).toFixed(0) + 'B';
  if (v >= 1e10) return (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e8) return (v / 1e6).toFixed(0) + 'M';
  if (v >= 1e7) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e4) return (v / 1e3).toFixed(1) + 'K';
  if (v >= 1e3) return (v / 1e3).toFixed(2) + 'K';
  return Math.round(v).toString();
}

// 完整千分位（用于细分明细）。
function formatFull(n) {
  return Math.round(Math.max(0, n)).toLocaleString('en-US');
}

// 金额格式化：小于 1 美元保留 4 位，避免显示成 $0.00。
function formatMoney(n) {
  const v = Math.max(0, n);
  if (v === 0) return '$0';
  if (v < 1) return '$' + v.toFixed(4);
  if (v < 100) return '$' + v.toFixed(2);
  return '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}
