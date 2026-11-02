import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxy } from '../src/server.js';
import { toOpenAIRequest, takeModelTarget, hasImage } from '../src/translate.js';
import { tierOf, resolveKeys } from '../src/config.js';

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

test('tiers, key pools, billing header, extraBody and reasoning effort', () => {
  assert.equal(tierOf('claude-haiku-5-5'), 'haiku');
  assert.equal(tierOf('claude-opus-5-5[1m]'), 'opus');
  assert.equal(tierOf('gemini,x'), '');
  process.env.CCF_K1 = 'a';
  delete process.env.CCF_K2;
  assert.deepEqual(resolveKeys({ apiKey: ['env:CCF_K1', 'env:CCF_K2', 'lit'] }), ['a', 'lit']);
  const req = toOpenAIRequest({
    model: 'm', max_tokens: 10, thinking: { type: 'enabled', budget_tokens: 1000 },
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=1' }, { type: 'text', text: 'Be brief.' }],
    messages: [{ role: 'user', content: 'hi' }],
  }, { baseUrl: 'http://x', reasoningEffort: 'high', extraBody: { temperature: 0.2 } }, 'm');
  assert.deepEqual(req.messages[0], { role: 'system', content: 'Be brief.' });
  assert.equal(req.reasoning_effort, 'high');
  assert.equal(req.temperature, 0.2);
});

test('model target from model name or CCF-MODEL tag, tag is stripped', () => {
  assert.equal(takeModelTarget({ model: 'groq,openai/gpt-oss-20b', messages: [] }), 'groq,openai/gpt-oss-20b');
  const body = {
    model: 'claude-sonnet-5-5', system: [{ type: 'text', text: 'You are an agent.' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: '<CCF-MODEL>kilo,kilo-auto/free</CCF-MODEL>\nFind the bug.' }] }],
  };
  assert.equal(takeModelTarget(body), 'kilo,kilo-auto/free');
  assert.equal(body.messages[0].content[0].text, 'Find the bug.');
  assert.equal(takeModelTarget({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'plain' }] }), null);
  assert.equal(hasImage({ messages: [{ role: 'user', content: [{ type: 'tool_result', content: [{ type: 'image', source: {} }] }] }] }), true);
});

// One mock OpenAI-compatible server per provider name records what it was asked.
const hits = [];
let claudeStatus = 200, rejectKey = null, slowMs = 0;
const servers = [];
let proxy, port, mockClaude;

function mockProvider(name) {
  return http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const key = req.headers.authorization?.slice(7);
    hits.push({ name, model: body.model, key });
    if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
    if (key && key === rejectKey) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
      return res.end('{"error":{"message":"rate limit"}}');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: `from ${name}` } }] }));
  });
}

before(async () => {
  mockClaude = http.createServer((req, res) => {
    hits.push({ name: 'claude' });
    res.writeHead(claudeStatus, { 'content-type': 'application/json' });
    res.end(claudeStatus === 200
      ? '{"type":"message","role":"assistant","content":[{"type":"text","text":"from claude"}]}'
      : '{"type":"error","error":{"type":"rate_limit_error","message":"usage limit"}}');
  });
  const cp = await listen(mockClaude);
  const url = {};
  for (const name of ['pool', 'vision', 'big', 'small', 'bg']) {
    const s = mockProvider(name);
    servers.push(s);
    url[name] = `http://127.0.0.1:${await listen(s)}/v1`;
  }
  ({ server: proxy } = createProxy({
    port: 0, host: '127.0.0.1', cooldownMinutes: 30, announceSwitch: false,
    routes: { background: ['bg'], image: ['vision'], longContext: ['big'], longContextThreshold: 2000 },
    providers: [
      { name: 'claude', type: 'anthropic', baseUrl: `http://127.0.0.1:${cp}` },
      { name: 'small', type: 'openai', baseUrl: url.small, keyless: true, model: 'small-m', contextWindow: 3000, maxConcurrent: 1 },
      { name: 'pool', type: 'openai', baseUrl: url.pool, apiKey: ['k1', 'k2'], model: 'pool-m', models: { opus: 'pool-opus' } },
      { name: 'vision', type: 'openai', baseUrl: url.vision, keyless: true, model: 'vision-m' },
      { name: 'big', type: 'openai', baseUrl: url.big, keyless: true, model: 'big-m' },
      { name: 'bg', type: 'openai', baseUrl: url.bg, keyless: true, model: 'bg-m' },
    ],
  }, { quiet: true, logPath: null }));
  port = await listen(proxy);
});
after(() => { proxy.close(); mockClaude.close(); servers.forEach((s) => s.close()); });
beforeEach(async () => {
  hits.length = 0;
  claudeStatus = 200; rejectKey = null; slowMs = 0;
  await fetch(`http://127.0.0.1:${port}/_fallback/reset`, { method: 'POST' });
});

const ask = (body) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ max_tokens: 50, messages: [{ role: 'user', content: 'hi' }], ...body }),
}).then(async (r) => ({ provider: r.headers.get('x-cc-fallback-provider'), body: await r.json() }));

test('Claude first; haiku requests go to the background route before Claude', async () => {
  assert.equal((await ask({ model: 'claude-sonnet-5-5' })).provider, 'claude');
  assert.equal((await ask({ model: 'claude-haiku-5-5' })).provider, 'bg');
  assert.deepEqual(hits.map((h) => h.name), ['claude', 'bg']);
});

test('scenario routes and context window when Claude is limited', async () => {
  claudeStatus = 429;
  const img = await ask({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'http://i' } }] }] });
  assert.equal(img.provider, 'vision');
  const long = await ask({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'x'.repeat(12000) }] });
  assert.equal(long.provider, 'big', 'longContext route; "small" is skipped by its contextWindow');
  assert.equal((await ask({ model: 'claude-sonnet-5-5' })).provider, 'small', 'normal order otherwise');
});

test('per-tier model, key pool rotation, provider,model choice', async () => {
  claudeStatus = 429;
  rejectKey = 'k1';
  const r = await ask({ model: 'groq', messages: [{ role: 'user', content: '<CCF-MODEL>pool</CCF-MODEL>go' }] });
  assert.equal(r.provider, 'pool');
  assert.deepEqual(hits.map((h) => h.key), ['k1', 'k2'], 'k1 limited -> k2 used, no Claude call for a chosen target');
  hits.length = 0;
  await ask({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: '<CCF-MODEL>pool</CCF-MODEL>go' }] });
  assert.deepEqual(hits.map((h) => [h.key, h.model]), [['k2', 'pool-opus']], 'paused key skipped, opus tier mapped');
  hits.length = 0;
  assert.equal((await ask({ model: 'pool,custom-model' })).provider, 'pool');
  assert.equal(hits[0].model, 'custom-model');
});

test('maxConcurrent sends parallel requests to the next provider', async () => {
  claudeStatus = 429;
  slowMs = 150;
  const [a, b] = await Promise.all([ask({ model: 'claude-sonnet-5-5' }), ask({ model: 'claude-sonnet-5-5' })]);
  assert.deepEqual([a.provider, b.provider].sort(), ['pool', 'small']);
});
