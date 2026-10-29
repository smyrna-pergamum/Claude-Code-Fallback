import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { toOpenAIRequest, fromOpenAIResponse } from '../src/translate.js';
import { StreamTranslator } from '../src/stream.js';
import { createProxy } from '../src/server.js';
import { recommend, pickInstalled } from '../src/hardware.js';

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

test('request translation: system, tools, tool_use and tool_result', () => {
  const req = toOpenAIRequest({
    model: 'claude-sonnet', max_tokens: 32000, stream: true,
    system: [{ type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'Read', description: 'read', input_schema: { $schema: 'x', type: 'object', properties: { p: { type: 'string' } } } },
      { type: 'web_search_20250305', name: 'web_search' }],
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '..', signature: 's' }, { type: 'text', text: 'ok' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { p: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'data' }] },
        { type: 'text', text: 'continue' }] },
    ],
  }, { baseUrl: 'http://x', maxTokens: 8192 }, 'm');
  assert.equal(req.max_tokens, 8192);
  assert.deepEqual(req.messages[0], { role: 'system', content: 'You are helpful.' });
  assert.equal(req.messages[2].tool_calls[0].function.arguments, '{"p":"a"}');
  assert.equal(req.messages[2].content, 'ok');
  assert.deepEqual(req.messages[3], { role: 'tool', tool_call_id: 'toolu_1', content: 'data' });
  assert.deepEqual(req.messages[4], { role: 'user', content: 'continue' });
  assert.equal(req.tools.length, 1);
  assert.equal(req.tools[0].function.parameters.$schema, undefined);
  assert.deepEqual(req.stream_options, { include_usage: true });
});

test('response translation with tool calls', () => {
  const msg = fromOpenAIResponse({
    choices: [{ finish_reason: 'stop', message: { content: 'x', tool_calls: [{ id: 'bad id!', function: { name: 'Bash', arguments: '{"c":1}' } }] } }],
    usage: { prompt_tokens: 5, completion_tokens: 2 },
  }, 'm');
  assert.equal(msg.stop_reason, 'tool_use');
  assert.match(msg.content[1].id, /^toolu_/);
  assert.deepEqual(msg.content[1].input, { c: 1 });
  assert.equal(msg.usage.input_tokens, 5);
});

test('stream translation emits valid Anthropic event sequence', () => {
  const t = new StreamTranslator('m');
  let out = t.push({ choices: [{ delta: { content: 'Hel' } }] });
  out += t.push({ choices: [{ delta: { content: 'lo' } }] });
  out += t.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: '{"p":' } }] } }] });
  out += t.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }, finish_reason: 'tool_calls' }] });
  out += t.push({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } });
  out += t.end();
  const events = out.trim().split('\n\n').map((e) => JSON.parse(e.split('\n')[1].slice(6)));
  assert.deepEqual(events.map((e) => e.type), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta',
    'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(events[5].content_block.name, 'Read');
  assert.equal(events[6].delta.partial_json, '{"p":"a"}');
  assert.equal(events[8].delta.stop_reason, 'tool_use');
  assert.equal(events[8].usage.output_tokens, 3);
});

test('recommendations respect memory', () => {
  const small = recommend({ mode: 'cpu', ramGB: 16, budgetGB: 8 });
  assert.equal(small.primary.tag, 'qwen2.5-coder:7b');
  const big = recommend({ mode: 'gpu', ramGB: 64, budgetGB: 21.6 });
  assert.equal(big.primary.tag, 'devstral:24b');
  assert.equal(pickInstalled(['nomic-embed-text:latest', 'qwen3:8b', 'gpt-oss:20b']), 'gpt-oss:20b');
});

// End-to-end: Claude returns 429 -> proxy falls back to an OpenAI-compatible server.
let claudeHits = 0, claudeAuth = null, openaiAuth = null, mockClaude, mockOpenAI, proxy, proxyPort;
before(async () => {
  mockClaude = http.createServer((req, res) => {
    claudeHits++;
    claudeAuth = req.headers.authorization;
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120' });
    res.end('{"type":"error","error":{"type":"rate_limit_error","message":"usage limit reached"}}');
  });
  mockOpenAI = http.createServer((req, res) => {
    openaiAuth = req.headers.authorization;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"hello from fallback"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    res.end('data: [DONE]\n\n');
  });
  const cp = await listen(mockClaude), op = await listen(mockOpenAI);
  process.env.TEST_KEY = 'free-key';
  ({ server: proxy } = createProxy({
    port: 0, host: '127.0.0.1', cooldownMinutes: 30, announceSwitch: true,
    providers: [
      { name: 'claude', type: 'anthropic', baseUrl: `http://127.0.0.1:${cp}` },
      { name: 'free', type: 'openai', baseUrl: `http://127.0.0.1:${op}/v1`, apiKey: 'env:TEST_KEY', model: 'free-model' },
    ],
  }, { quiet: true }));
  proxyPort = await listen(proxy);
});
after(() => { proxy.close(); mockClaude.close(); mockOpenAI.close(); });

test('falls back on 429, keeps Claude token away from other providers, then skips paused Claude', async () => {
  const call = () => fetch(`http://127.0.0.1:${proxyPort}/v1/messages?beta=true`, {
    method: 'POST', headers: { authorization: 'Bearer oauth-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  }).then((r) => r.text());
  const first = await call();
  assert.equal(claudeAuth, 'Bearer oauth-secret');
  assert.equal(openaiAuth, 'Bearer free-key');
  assert.match(first, /cc-fallback: free \/ free-model/);
  assert.match(first, /hello from fallback/);
  assert.match(first, /event: message_stop/);
  const second = await call();
  assert.equal(claudeHits, 1, 'Claude is paused after a 429');
  assert.doesNotMatch(second, /cc-fallback: free/, 'switch is announced only once');
  const st = await fetch(`http://127.0.0.1:${proxyPort}/_fallback/status`).then((r) => r.json());
  assert.equal(st.providers[0].pausedFor, '2 min');
});
