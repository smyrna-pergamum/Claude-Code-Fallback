// One "run" = one prompt sent to Claude Code through the Agent SDK, streamed to the UI as events.
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { claudeBrowserOptions, ensureBrowserServer } from './browser.js';

// Variables a host (e.g. the Claude desktop app) sets for its own child sessions; they must not
// leak into ours, or Claude Code would act as that host's child and skip our proxy.
const HOST_ENV = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_AGENT_SDK_.*|ANTHROPIC_BASE_URL|CLAUDE_PID)$/;

export function childEnv(baseUrl) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!HOST_ENV.test(k)) env[k] = v;
  if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
  // The attribution line is for Anthropic only; it should not reach free providers.
  env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0';
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'cc-desk/0.4.4';
  return env;
}

const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '');

/** Turns one SDK message into zero or more UI events. */
export function toEvents(msg) {
  const out = [];
  if (msg.parent_tool_use_id) return out; // subagent internals: shown only as the Agent tool card
  if (msg.type === 'stream_event') {
    const e = msg.event;
    if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') out.push({ type: 'text_delta', text: e.delta.text });
  } else if (msg.type === 'assistant') {
    for (const b of msg.message?.content || []) {
      if (b.type === 'text') out.push({ type: 'text', text: b.text });
      else if (b.type === 'tool_use') out.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
    }
    if (msg.error) out.push({ type: 'error', message: String(msg.error) });
  } else if (msg.type === 'user') {
    for (const b of Array.isArray(msg.message?.content) ? msg.message.content : []) {
      if (b.type === 'tool_result') out.push({ type: 'tool_result', id: b.tool_use_id, text: textOf(b.content), isError: !!b.is_error });
    }
  } else if (msg.type === 'system' && msg.subtype === 'init') {
    out.push({ type: 'init', model: msg.model, cwd: msg.cwd, permissionMode: msg.permissionMode, slashCommands: msg.slash_commands || [], mcp: (msg.mcp_servers || []).map((s) => `${s.name}:${s.status}`) });
  } else if (msg.type === 'result') {
    out.push({
      type: 'result', ok: msg.subtype === 'success' && !msg.is_error, subtype: msg.subtype,
      costUsd: msg.total_cost_usd, durationMs: msg.duration_ms, text: msg.result,
    });
  }
  return out;
}

export class RunManager {
  constructor({ baseUrl, opencode }) {
    this.baseUrl = baseUrl; // () => current ANTHROPIC_BASE_URL
    this.runs = new Map();
    this.opencode = opencode;
  }

  /** engine: 'claude' (default) or 'opencode'; vars: the chosen environment's variables. */
  /** fallback: Claude Code run options to continue with if OpenCode's free models are at their limit. */
  start({ prompt, cwd, sessionId, model, permissionMode, engine = 'claude', envId = 'local', vars = {}, dirs = [], browser = false, fallback = null }) {
    const run = {
      id: randomUUID(), sessionId: sessionId || null, cwd, engine, events: [], clients: new Set(),
      pending: new Map(), done: false, q: null, abort: new AbortController(), stop: null,
    };
    this.runs.set(run.id, run);
    const emit = (ev) => {
      run.events.push(ev);
      const line = `data: ${JSON.stringify(ev)}\n\n`;
      for (const c of run.clients) c.write(line);
    };
    run.emit = emit;
    const finish = () => {
      run.done = true;
      emit({ type: 'done' });
      for (const c of run.clients) c.end();
      run.clients.clear();
      setTimeout(() => this.runs.delete(run.id), 10 * 60_000).unref();
    };

    if (engine === 'opencode') {
      run.hasFallback = !!fallback;
      this.opencode.prompt(run, { prompt, cwd, sessionId, model, permissionMode, envId, vars, dirs, browser })
        .catch((e) => emit({ type: 'error', message: e.message }))
        .then(() => {
          if (!(run.limitHit && fallback)) return finish();
          this.onOpenCodeLimit?.();
          // Same chat, same stream: the message goes on in Claude Code through cc-fallback.
          emit({ type: 'notice', text: "OpenCode's free models are at their usage limit too. Continuing with Claude Code through cc-fallback's free providers." });
          emit({ type: 'engine', engine: 'claude' });
          const inner = this.start(fallback);
          run.delegate = inner;
          run.stop = () => this.interrupt(inner.id);
          inner.clients.add({
            write: (line) => { const ev = JSON.parse(line.slice(6)); if (ev.type !== 'done') emit(ev); },
            end: () => finish(),
          });
        });
      return run;
    }

    const canUseTool = (toolName, input, { signal, suggestions, decisionReason }) => new Promise((resolve) => {
      const permId = randomUUID();
      const answer = (decision) => resolve(decision === 'deny' ? { behavior: 'deny', message: 'The user declined this action.' }
        : { behavior: 'allow', updatedInput: input, ...(decision === 'always' && suggestions?.length ? { updatedPermissions: suggestions } : {}) });
      run.pending.set(permId, { answer, interrupt: () => resolve({ behavior: 'deny', message: 'Interrupted', interrupt: true }) });
      signal?.addEventListener('abort', () => {
        if (run.pending.delete(permId)) resolve({ behavior: 'deny', message: 'Cancelled' });
      });
      emit({ type: 'permission', id: permId, toolName, input, reason: decisionReason || null, canAlways: !!suggestions?.length });
    });

    const startQuery = (browserUrl) => query({
      prompt,
      options: {
        cwd, model: model || undefined, resume: sessionId || undefined, additionalDirectories: dirs.length ? dirs : undefined,
        permissionMode: permissionMode || 'default',
        allowDangerouslySkipPermissions: permissionMode === 'bypassPermissions',
        includePartialMessages: true,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        env: { ...childEnv(this.baseUrl()), ...vars },
        // Also as flag settings: an `env` in the user's ~/.claude/settings.json would otherwise win.
        settings: { env: { ANTHROPIC_BASE_URL: this.baseUrl(), CLAUDE_CODE_ATTRIBUTION_HEADER: '0', ...vars } },
        abortController: run.abort,
        canUseTool,
        ...claudeBrowserOptions(browserUrl),
        stderr: (d) => { if (/error/i.test(d)) emit({ type: 'log', text: d.slice(0, 500) }); },
      },
    });

    (async () => {
      try {
        // The shared browser server keeps the window open between messages.
        const browserUrl = browser ? await ensureBrowserServer().catch(() => null) : null;
        run.q = startQuery(browserUrl);
        for await (const msg of run.q) {
          if (!run.sessionId && msg.session_id) { run.sessionId = msg.session_id; emit({ type: 'session', sessionId: msg.session_id }); }
          for (const ev of toEvents(msg)) emit(ev);
          if (msg.type === 'result') {
            // Context window use, the numbers Claude Code's own context meter shows.
            try {
              const u = await run.q.getContextUsage({ detail: 'summary' });
              emit({ type: 'context', used: u.totalTokens, max: u.maxTokens });
            } catch { /* older CLI or session already closed */ }
          }
        }
      } catch (e) {
        emit({ type: 'error', message: e.message });
      } finally {
        finish();
      }
    })();
    return run;
  }

  /** Attaches an SSE response; replays what was already emitted. */
  attach(runId, res) {
    const run = this.runs.get(runId);
    if (!run) return false;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    for (const ev of run.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    if (run.done) { res.end(); return true; }
    run.clients.add(res);
    res.on('close', () => run.clients.delete(res));
    return true;
  }

  answer(runId, permId, decision) {
    const run = this.runs.get(runId);
    if (run?.delegate && !run.pending.has(permId)) return this.answer(run.delegate.id, permId, decision);
    const p = run?.pending.get(permId);
    if (!p) return false;
    run.pending.delete(permId);
    Promise.resolve(p.answer(decision)).catch((e) => run.emit({ type: 'error', message: e.message }));
    run.emit({ type: 'permission_answered', id: permId, decision });
    return true;
  }

  async interrupt(runId) {
    const run = this.runs.get(runId);
    if (!run || run.done) return false;
    for (const [id, p] of run.pending) { (p.interrupt || (() => p.answer('deny')))(); run.pending.delete(id); }
    if (run.stop) { await run.stop(); return true; }
    try { await run.q.interrupt(); } catch { run.abort.abort(); }
    return true;
  }
}
