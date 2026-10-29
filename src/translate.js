// Anthropic Messages API  <->  OpenAI Chat Completions translation.
import { randomBytes } from 'node:crypto';

export const newId = (prefix) => prefix + randomBytes(12).toString('hex');

const VALID_TOOL_ID = /^[a-zA-Z0-9_-]{1,64}$/;
export const safeToolId = (id) => (id && VALID_TOOL_ID.test(id) ? id : newId('toolu_'));

// JSON-schema keywords some OpenAI-compatible backends (notably Gemini) reject.
const STRICT_DROP = new Set(['$schema', 'additionalProperties', 'propertyNames', 'exclusiveMinimum',
  'exclusiveMaximum', 'patternProperties', 'const', 'examples', 'default', '$id', '$ref', '$defs', 'definitions']);

export function cleanSchema(schema, strict) {
  if (Array.isArray(schema)) return schema.map((s) => cleanSchema(s, strict));
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === '$schema') continue;
    if (strict && STRICT_DROP.has(k)) continue;
    if (strict && k === 'format' && !['enum', 'date-time'].includes(v)) continue;
    out[k] = k === 'properties'
      ? Object.fromEntries(Object.entries(v || {}).map(([pk, pv]) => [pk, cleanSchema(pv, strict)]))
      : cleanSchema(v, strict);
  }
  return out;
}

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
};

const imagePart = (block) => {
  const src = block.source || {};
  const url = src.type === 'base64' ? `data:${src.media_type};base64,${src.data}` : src.url;
  return url ? { type: 'image_url', image_url: { url } } : null;
};

function userParts(blocks) {
  const parts = [];
  for (const b of blocks) {
    if (b.type === 'text') parts.push({ type: 'text', text: b.text });
    else if (b.type === 'image') { const p = imagePart(b); if (p) parts.push(p); }
    else if (b.type === 'document') parts.push({ type: 'text', text: '[document omitted]' });
  }
  return parts;
}

// Collapse text-only part lists to a plain string: the most widely supported shape.
const simplify = (parts) => (parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('\n') : parts);

function convertMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    const blocks = m.content || [];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const toolCalls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
      const msg = { role: 'assistant', content: text || (toolCalls.length ? null : '') };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
      continue;
    }
    // user: tool results must directly follow the assistant tool_calls, so emit them first.
    const extraImages = [];
    for (const b of blocks.filter((x) => x.type === 'tool_result')) {
      let content = textOf(b.content);
      if (Array.isArray(b.content)) {
        for (const ib of b.content.filter((x) => x.type === 'image')) { const p = imagePart(ib); if (p) extraImages.push(p); }
      }
      if (b.is_error) content = `Error: ${content}`;
      out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: content || '(empty)' });
    }
    const parts = [...userParts(blocks.filter((x) => x.type !== 'tool_result')), ...extraImages];
    if (parts.length) out.push({ role: 'user', content: simplify(parts) });
  }
  return out;
}

function convertToolChoice(tc) {
  if (!tc) return undefined;
  if (tc.type === 'any') return 'required';
  if (tc.type === 'tool') return { type: 'function', function: { name: tc.name } };
  if (tc.type === 'none') return 'none';
  return 'auto';
}

/** Anthropic request body -> OpenAI chat.completions body for `provider`. */
export function toOpenAIRequest(body, provider, model) {
  const strict = provider.strictSchema ?? /generativelanguage\.googleapis/.test(provider.baseUrl || '');
  const messages = [];
  const system = typeof body.system === 'string' ? body.system : textOf(body.system);
  if (system) messages.push({ role: 'system', content: system });
  messages.push(...convertMessages(body.messages || []));

  const req = { model, messages, stream: !!body.stream };
  const maxTokens = provider.maxTokens ? Math.min(body.max_tokens || provider.maxTokens, provider.maxTokens) : body.max_tokens;
  if (maxTokens) req.max_tokens = maxTokens;
  if (body.temperature != null) req.temperature = body.temperature;
  if (body.top_p != null) req.top_p = body.top_p;
  if (body.stop_sequences?.length) req.stop = body.stop_sequences;
  if (req.stream && provider.streamUsage !== false) req.stream_options = { include_usage: true };

  // Only client tools (with input_schema); server tools like web_search have no OpenAI equivalent.
  const tools = (body.tools || []).filter((t) => t.input_schema).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description || '', parameters: cleanSchema(t.input_schema, strict) },
  }));
  if (tools.length && body.tool_choice?.type !== 'none') {
    req.tools = tools;
    const tc = convertToolChoice(body.tool_choice);
    if (tc && tc !== 'auto') req.tool_choice = tc;
  }
  return req;
}

export function mapStopReason(finish, hasTools) {
  if (hasTools) return 'tool_use';
  if (finish === 'length') return 'max_tokens';
  if (finish === 'tool_calls' || finish === 'function_call') return 'tool_use';
  return 'end_turn';
}

export function parseArgs(str) {
  if (!str) return {};
  try { const v = JSON.parse(str); return v && typeof v === 'object' ? v : { value: v }; } catch { return { _raw: str }; }
}

/** OpenAI non-streaming response -> Anthropic message. `prefix` is optional text prepended. */
export function fromOpenAIResponse(data, model, prefix = '') {
  const choice = data.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  const text = prefix + (typeof msg.content === 'string' ? msg.content : textOf(msg.content));
  if (text) content.push({ type: 'text', text });
  for (const tc of msg.tool_calls || []) {
    content.push({ type: 'tool_use', id: safeToolId(tc.id), name: tc.function?.name, input: parseArgs(tc.function?.arguments) });
  }
  const hasTools = content.some((b) => b.type === 'tool_use');
  return {
    id: newId('msg_'), type: 'message', role: 'assistant', model, content,
    stop_reason: mapStopReason(choice.finish_reason, hasTools), stop_sequence: null,
    usage: { input_tokens: data.usage?.prompt_tokens || 0, output_tokens: data.usage?.completion_tokens || 0 },
  };
}

// Rough token estimate for /v1/messages/count_tokens when Claude is unavailable.
export function estimateTokens(body) {
  const s = JSON.stringify({ s: body.system, m: body.messages, t: body.tools });
  return Math.ceil(s.length / 3.5);
}
