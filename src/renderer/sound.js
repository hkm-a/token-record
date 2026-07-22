'use strict';

// 收银机音效：用 Web Audio 合成清脆的 "叮-叮"（cha-ching），无需任何外部音频文件。
// 设计意图：数值增长时给出愉悦的听觉反馈；纯合成便于随应用分发，且体积为零。

let _ctx = null;

function audio() {
  if (!_ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    _ctx = new AC();
  }
  if (_ctx.state === 'suspended') {
    _ctx.resume();
  }
  return _ctx;
}

// 一记铃音：基频叠加轻微失谐的谐波，形成金属铃质感，快速指数衰减。
function ding(ac, freq, startAt, duration, peak) {
  const partials = [1, 2.01, 3.03, 4.17]; // 略微失谐 → 更像真实金属铃
  const out = ac.createGain();
  out.gain.value = peak;
  out.connect(ac.destination);
  partials.forEach((mult, i) => {
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq * mult;
    const g = ac.createGain();
    const amp = 1 / (i + 1.5);
    g.gain.setValueAtTime(0, startAt);
    g.gain.linearRampToValueAtTime(amp, startAt + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    osc.connect(g);
    g.connect(out);
    osc.start(startAt);
    osc.stop(startAt + duration + 0.02);
  });
}

// 机械“咔”声：一段短促高通噪声，模拟钱箱弹开的触发感。
function clack(ac, startAt) {
  const len = Math.floor(ac.sampleRate * 0.04);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
  }
  const src = ac.createBufferSource();
  src.buffer = buf;
  const hp = ac.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 1200;
  const g = ac.createGain();
  g.gain.value = 0.09;
  src.connect(hp);
  hp.connect(g);
  g.connect(ac.destination);
  src.start(startAt);
}

let _last = -1;

// 播放一次收银音效。内置节流，避免同一时刻多次触发导致刺耳叠加。
function playCashRegister() {
  let ac;
  try {
    ac = audio();
  } catch (_err) {
    return; // 无音频环境（极少数）静默跳过
  }
  const now = ac.currentTime;
  if (_last >= 0 && now - _last < 0.35) {
    return;
  }
  _last = now;
  clack(ac, now);
  ding(ac, 1046, now + 0.02, 0.5, 0.22); // C6
  ding(ac, 1568, now + 0.13, 0.6, 0.24); // G6：上行五度，典型收银铃走向
}
