// Converts an OpenAI chat.completions SSE stream into Anthropic Messages SSE events.
import { newId, safeToolId, parseArgs, mapStopReason } from './translate.js';

export const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

export class StreamTranslator {
  constructor(model, prefix = '') {
    this.model = model;
    this.prefix = prefix;
    this.started = false;
    this.index = 0;
    this.textOpen = false;
    this.tools = new Map(); // openai tool index -> { id, name, args }
    this.finish = null;
    this.usage = { input_tokens: 0, output_tokens: 0 };
  }

  start() {
    if (this.started) return '';
    this.started = true;
    let out = sse('message_start', {
      message: {
        id: newId('msg_'), type: 'message', role: 'assistant', model: this.model, content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    if (this.prefix) out += this.text(this.prefix);
    return out;
  }

  text(t) {
    let out = '';
    if (!this.textOpen) {
      out += sse('content_block_start', { index: this.index, content_block: { type: 'text', text: '' } });
      this.textOpen = true;
    }
    return out + sse('content_block_delta', { index: this.index, delta: { type: 'text_delta', text: t } });
  }

  /** Feed one parsed OpenAI chunk; returns Anthropic SSE text to write. */
  push(chunk) {
    let out = this.start();
    if (chunk.usage) {
      this.usage.input_tokens = chunk.usage.prompt_tokens ?? this.usage.input_tokens;
      this.usage.output_tokens = chunk.usage.completion_tokens ?? this.usage.output_tokens;
    }
    const choice = chunk.choices?.[0];
    if (!choice) return out;
    const d = choice.delta || {};
    if (typeof d.content === 'string' && d.content) out += this.text(d.content);
    // Tool calls are buffered and emitted whole at the end: robust against providers that
    // interleave, repeat or omit indexes, and Claude Code does not need partial tool args.
    for (const [i, tc] of (d.tool_calls || []).entries()) {
      let key = tc.index ?? i;
      const existing = this.tools.get(key);
      if (existing && tc.id && existing.id && tc.id !== existing.id) key = `${key}:${tc.id}`;
      const t = this.tools.get(key) || { id: tc.id, name: '', args: '' };
      if (tc.id) t.id = tc.id;
      if (tc.function?.name) t.name = tc.function.name;
      if (tc.function?.arguments) t.args += typeof tc.function.arguments === 'string'
        ? tc.function.arguments : JSON.stringify(tc.function.arguments);
      this.tools.set(key, t);
    }
    if (choice.finish_reason) this.finish = choice.finish_reason;
    return out;
  }

  end() {
    let out = this.start();
    if (this.textOpen) {
      out += sse('content_block_stop', { index: this.index });
      this.index++;
      this.textOpen = false;
    }
    for (const t of this.tools.values()) {
      if (!t.name) continue;
      const input = parseArgs(t.args);
      out += sse('content_block_start', { index: this.index, content_block: { type: 'tool_use', id: safeToolId(t.id), name: t.name, input: {} } });
      out += sse('content_block_delta', { index: this.index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
      out += sse('content_block_stop', { index: this.index });
      this.index++;
    }
    const hasTools = [...this.tools.values()].some((t) => t.name);
    out += sse('message_delta', {
      delta: { stop_reason: mapStopReason(this.finish, hasTools), stop_sequence: null },
      usage: { input_tokens: this.usage.input_tokens, output_tokens: this.usage.output_tokens },
    });
    out += sse('message_stop', {});
    return out;
  }
}

/** Async-iterate `data:` payloads (parsed JSON) from an SSE byte stream. */
export async function* readSSE(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { yield JSON.parse(payload); } catch { /* ignore keep-alives / junk */ }
    }
  }
}
