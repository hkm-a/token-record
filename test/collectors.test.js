'use strict';

// 采集器单元测试：用临时 JSONL 文件覆盖三源解析的关键陷阱。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const claude = require('../src/collectors/claude');
const codex = require('../src/collectors/codex');
const grok = require('../src/collectors/grok');

function tmpFile(name, lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenrec-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
  return file;
}

test('Claude：解析 usage、生成去重键、跳过合成消息', async () => {
  const file = tmpFile('s.jsonl', [
    {
      type: 'assistant',
      requestId: 'r1',
      timestamp: '2026-07-23T00:00:00Z',
      sessionId: 's',
      message: {
        id: 'm1',
        model: 'claude-opus-4-8',
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 100,
        },
      },
    },
    // 合成消息：应跳过
    { type: 'assistant', message: { model: '<synthetic>', usage: { output_tokens: 5 } } },
    // 用量全 0：应跳过
    { type: 'assistant', message: { id: 'm2', model: 'claude-opus-4-8', usage: {} } },
  ]);

  const evs = await claude.collectFile({ path: file });
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0].input, 10);
  assert.strictEqual(evs[0].output, 20);
  assert.strictEqual(evs[0].cacheWrite, 5);
  assert.strictEqual(evs[0].cacheRead, 100);
  assert.strictEqual(evs[0].dedupeKey, 'claude:m1:r1');
});

test('Codex：累加 last_token_usage（非累计 total）并减出非缓存输入', async () => {
  const file = tmpFile('rollout.jsonl', [
    { type: 'session_meta', timestamp: '2026-07-22T00:00:00Z', payload: { model: 'gpt-5.6-terra', session_id: 'cs' } },
    {
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 },
          last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 },
        },
      },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 250, cached_input_tokens: 90, output_tokens: 25 },
          last_token_usage: { input_tokens: 150, cached_input_tokens: 50, output_tokens: 15 },
        },
      },
    },
  ]);

  const evs = await codex.collectFile({ path: file });
  assert.strictEqual(evs.length, 1);
  // last 累加：input 100+150=250, cached 40+50=90, output 10+15=25
  assert.strictEqual(evs[0].input, 160); // 250 - 90 非缓存
  assert.strictEqual(evs[0].output, 25);
  assert.strictEqual(evs[0].cacheRead, 90);
  assert.strictEqual(evs[0].model, 'gpt-5.6-terra');
});

test('Codex：无 last_token_usage 时退化取最后一个 total 快照', async () => {
  const file = tmpFile('rollout2.jsonl', [
    { type: 'session_meta', payload: { model: 'gpt-5.6-terra', session_id: 'cs2' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } } } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 300, cached_input_tokens: 0, output_tokens: 40 } } } },
  ]);
  const evs = await codex.collectFile({ path: file });
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0].input, 300); // 取最后 total，不累加
  assert.strictEqual(evs[0].output, 40);
});

test('Codex：失败会话（无 token 事件）返回空', async () => {
  const file = tmpFile('fail.jsonl', [
    { type: 'session_meta', payload: { model: 'gpt-5.6-terra', session_id: 'cs3' } },
    { type: 'event_msg', payload: { type: 'task_complete', error: { message: '503' } } },
  ]);
  const evs = await codex.collectFile({ path: file });
  assert.strictEqual(evs.length, 0);
});

test('Grok：累加各轮 turn_completed，按模型分组并减出非缓存输入', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenrec-'));
  const sid = 'gs-123';
  const sdir = path.join(dir, sid);
  fs.mkdirSync(sdir);
  const file = path.join(sdir, 'updates.jsonl');
  fs.writeFileSync(
    file,
    [
      {
        timestamp: 1784735192,
        method: '_x.ai/session/update',
        params: {
          update: {
            sessionUpdate: 'turn_completed',
            usage: {
              inputTokens: 1000,
              outputTokens: 50,
              cachedReadTokens: 800,
              modelUsage: { 'grok-4.5-build-free': { inputTokens: 1000, outputTokens: 50, cachedReadTokens: 800 } },
            },
          },
        },
      },
      {
        timestamp: 1784735300,
        method: '_x.ai/session/update',
        params: {
          update: {
            sessionUpdate: 'turn_completed',
            usage: {
              inputTokens: 500,
              outputTokens: 30,
              cachedReadTokens: 400,
              modelUsage: { 'grok-4.5-build-free': { inputTokens: 500, outputTokens: 30, cachedReadTokens: 400 } },
            },
          },
        },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n')
  );

  const evs = await grok.collectFile({ path: file });
  assert.strictEqual(evs.length, 1);
  const e = evs[0];
  assert.strictEqual(e.model, 'grok-4.5-build-free');
  // 累加：input 1500, cachedRead 1200 → 非缓存 300；output 80
  assert.strictEqual(e.input, 300);
  assert.strictEqual(e.output, 80);
  assert.strictEqual(e.cacheRead, 1200);
  assert.strictEqual(e.sessionId, sid);
});
