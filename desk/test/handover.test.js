import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeLimit, transcript, handoverPrompt } from '../src/handover.js';

test('Claude counts as limited only while cc-fallback has it paused for a limit', () => {
  const st = (c) => ({ up: true, providers: [{ name: 'claude', ...c }] });
  assert.deepEqual(claudeLimit(st({ pausedFor: '42 min', reason: 'limit reached (HTTP 429)' })), { limited: true, backIn: '42 min' });
  assert.equal(claudeLimit(st({ pausedFor: '5 min', reason: 'auth failed (HTTP 401)' })).limited, false);
  assert.equal(claudeLimit(st({})).limited, false);
  assert.equal(claudeLimit({ up: false }).limited, false);
});

test('transcript keeps the newest part and summarizes tools', () => {
  const t = transcript([
    { type: 'user', text: 'Fix the bug' },
    { type: 'tool_use', name: 'Bash', input: { command: 'npm test\nmore' } },
    { type: 'tool_result', text: 'boom', isError: true },
    { type: 'text', text: 'Fixed.' },
  ]);
  assert.equal(t, 'User: Fix the bug\n[assistant used Bash: npm test]\n[that tool failed: boom]\nAssistant: Fixed.');
  assert.match(transcript([{ type: 'user', text: 'x'.repeat(50) }], 20), /^\[…earlier part left out…\]\nx{20}$/);
  const p = handoverPrompt({ to: 'opencode', cwd: 'C:\\p', history: t, prompt: 'next' });
  assert.match(p, /Claude Code is unavailable/);
  assert.match(p, /User: Fix the bug/);
  assert.match(p, /The user's new message:\nnext$/);
});
