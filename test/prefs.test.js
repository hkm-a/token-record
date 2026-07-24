'use strict';

// 偏好模块：位置夹取、隐藏启动、自启参数。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadPrefs,
  savePrefs,
  clampPosition,
  shouldStartHidden,
  buildLoginItemSettings,
} = require('../src/main/prefs');

test('loadPrefs 缺失文件返回默认', () => {
  const p = path.join(os.tmpdir(), 'tokenrec-prefs-missing-' + Date.now() + '.json');
  const prefs = loadPrefs(p);
  assert.strictEqual(prefs.openAtLogin, false);
  assert.strictEqual(prefs.x, null);
});

test('savePrefs / loadPrefs 往返', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenrec-prefs-'));
  const file = path.join(dir, 'prefs.json');
  savePrefs(file, { x: 10, y: 20, openAtLogin: true, compact: true });
  const prefs = loadPrefs(file);
  assert.strictEqual(prefs.x, 10);
  assert.strictEqual(prefs.y, 20);
  assert.strictEqual(prefs.openAtLogin, true);
  assert.strictEqual(prefs.compact, true);
});

test('clampPosition 限制在工作区内', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1080 };
  const a = clampPosition(-100, -50, 400, 600, wa);
  assert.strictEqual(a.x, 0);
  assert.strictEqual(a.y, 0);
  const b = clampPosition(5000, 5000, 400, 600, wa);
  assert.strictEqual(b.x, 1920 - 400);
  assert.strictEqual(b.y, 1080 - 600);
});

test('clampPosition 空坐标返回 null', () => {
  const r = clampPosition(null, null, 400, 600, { x: 0, y: 0, width: 100, height: 100 });
  assert.strictEqual(r.x, null);
  assert.strictEqual(r.y, null);
});

test('shouldStartHidden 识别 --hidden', () => {
  assert.strictEqual(shouldStartHidden(['node', 'app', '--hidden'], false), true);
  assert.strictEqual(shouldStartHidden(['node', 'app'], false), false);
  assert.strictEqual(shouldStartHidden(['node', 'app'], true), true);
});

test('buildLoginItemSettings 打包与开发参数', () => {
  const pack = buildLoginItemSettings(true, {
    packaged: true,
    execPath: 'C:\\\\App\\\\TokenRecord.exe',
    appPath: 'C:\\\\src',
  });
  assert.strictEqual(pack.openAtLogin, true);
  assert.deepStrictEqual(pack.args, ['--hidden']);

  const dev = buildLoginItemSettings(true, {
    packaged: false,
    execPath: 'C:\\\\electron.exe',
    appPath: 'C:\\\\token-record',
  });
  assert.strictEqual(dev.args[0], 'C:\\\\token-record');
  assert.ok(dev.args.includes('--hidden'));

  const off = buildLoginItemSettings(false, {
    packaged: true,
    execPath: 'x',
    appPath: 'y',
  });
  assert.strictEqual(off.openAtLogin, false);
  assert.deepStrictEqual(off.args, []);
});
