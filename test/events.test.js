import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toEvents, childEnv } from '../src/runs.js';
import { historyItems } from '../src/server.js';

test('SDK messages become UI events; subagent internals are skipped', () => {
  assert.deepEqual(toEvents({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } }),
    [{ type: 'text_delta', text: 'hi' }]);
  assert.deepEqual(toEvents({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }),
    [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]);
  assert.deepEqual(toEvents({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a.txt' }] }] } }),
    [{ type: 'tool_result', id: 't1', text: 'a.txt', isError: false }]);
  assert.deepEqual(toEvents({ type: 'assistant', parent_tool_use_id: 't1', message: { content: [{ type: 'text', text: 'inner' }] } }), []);
});

test('history drops reminders and command wrappers', () => {
  const items = historyItems([
    { type: 'user', message: { content: 'Fix it<system-reminder>secret</system-reminder>' } },
    { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } },
  ]);
  assert.deepEqual(items, [{ type: 'user', text: 'Fix it' }, { type: 'text', text: 'Done' }]);
});

test('child env points at the proxy and drops the host app variables', () => {
  process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop';
  process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
  const env = childEnv('http://127.0.0.1:3456');
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3456');
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(env.CLAUDE_CODE_ATTRIBUTION_HEADER, '0');
});
