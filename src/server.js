// Local proxy: Claude Code -> (Claude | free cloud APIs | local models), switching on limits.
import http from 'node:http';
import { Readable } from 'node:stream';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig, resolveKey, isConfigured, LOG_PATH } from './config.js';
import { toOpenAIRequest, fromOpenAIResponse, estimateTokens } from './translate.js';
import { StreamTranslator, readSSE, sse } from './stream.js';
import { pickInstalled } from './hardware.js';

// Headers that must never travel between hops. Auth headers are only ever forwarded to Anthropic.
const HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding', 'keep-alive', 'upgrade']);
const RESP_DROP = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);

export function createProxy(config = loadConfig(), { quiet = false, logPath = LOG_PATH } = {}) {
  const state = {
    cooldown: new Map(), // provider name -> { until, reason }
    forced: null,
    lastUsed: null,
    lastAnnounced: 'claude',
    localModels: new Map(), // provider name -> { at, id }
    requests: 0,
  };

  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    if (!quiet) console.error(line);
    if (!logPath) return;
    try { mkdirSync(dirname(logPath), { recursive: true }); appendFileSync(logPath, line + '\n'); } catch { /* ignore */ }
  };

  const providers = () => config.providers.filter(isConfigured);
  const inCooldown = (p) => (state.cooldown.get(p.name)?.until || 0) > Date.now();
  const coolDown = (p, ms, reason) => {
    state.cooldown.set(p.name, { until: Date.now() + ms, reason });
    log(`${p.name}: ${reason} -> paused ${Math.round(ms / 60000)} min`);
  };

  function candidates() {
    const all = providers();
    if (state.forced) {
      const f = all.find((p) => p.name === state.forced);
      if (f) return [f];
    }
    const ready = all.filter((p) => !inCooldown(p));
    // Everything paused: try anyway, soonest-to-recover first, rather than failing outright.
    return ready.length ? ready : all.sort((a, b) => state.cooldown.get(a.name).until - state.cooldown.get(b.name).until);
  }

  async function resolveModel(p, requested) {
    const small = /haiku/i.test(requested || '');
    const wanted = (small && p.smallModel) || p.model;
    if (wanted && wanted !== 'auto') return wanted;
    const cached = state.localModels.get(p.name);
    if (cached && Date.now() - cached.at < 60_000) return cached.id;
    const res = await fetch(`${p.baseUrl}/models`, { signal: AbortSignal.timeout(3000) });
    const ids = ((await res.json()).data || []).map((m) => m.id);
    const id = pickInstalled(ids);
    if (!id) throw Object.assign(new Error('no local model installed'), { code: 'NO_MODEL' });
    state.localModels.set(p.name, { at: Date.now(), id });
    return id;
  }

  function retryAfterMs(res) {
    const ra = Number(res.headers.get('retry-after'));
    if (ra > 0) return ra * 1000;
    const reset = res.headers.get('anthropic-ratelimit-unified-reset');
    if (reset) {
      const t = /^\d+$/.test(reset) ? Number(reset) * 1000 : Date.parse(reset);
      if (t > Date.now()) return t - Date.now();
    }
    return config.cooldownMinutes * 60_000;
  }

  function anthropicHeaders(req, p) {
    const h = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) h[k] = v;
    const key = resolveKey(p.apiKey);
    if (key) { delete h.authorization; h['x-api-key'] = key; }
    return h;
  }

  // Claude rejects tool-use turns without a thinking block when thinking is on; such turns
  // appear after a fallback model answered, so drop thinking for that request.
  function fixThinking(body) {
    if (!body.thinking) return body;
    const lastAsst = [...(body.messages || [])].reverse().find((m) => m.role === 'assistant');
    const blocks = Array.isArray(lastAsst?.content) ? lastAsst.content : [];
    if (blocks.some((b) => b.type === 'tool_use') && !['thinking', 'redacted_thinking'].includes(blocks[0]?.type)) {
      const { thinking, ...rest } = body;
      return rest;
    }
    return body;
  }

  async function callAnthropic(p, req, body) {
    let send = fixThinking(body);
    if (p.model) send = { ...send, model: /haiku/i.test(body.model || '') && p.smallModel ? p.smallModel : p.model };
    return fetch(p.baseUrl.replace(/\/$/, '') + req.url, {
      method: 'POST', headers: anthropicHeaders(req, p), body: JSON.stringify(send),
    });
  }

  async function callOpenAI(p, body) {
    const model = await resolveModel(p, body.model);
    const headers = { 'content-type': 'application/json' };
    const key = resolveKey(p.apiKey);
    if (key) headers.authorization = `Bearer ${key}`;
    Object.assign(headers, p.headers || {});
    const res = await fetch(`${p.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify(toOpenAIRequest(body, p, model)),
    });
    res.modelUsed = model;
    return res;
  }

  async function sendOpenAI(res, upstream, body, p, prefix) {
    const model = `${p.name}/${upstream.modelUsed}`;
    if (!body.stream) {
      const data = await upstream.json();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(fromOpenAIResponse(data, model, prefix)));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const t = new StreamTranslator(model, prefix);
    try {
      for await (const chunk of readSSE(upstream.body)) {
        if (chunk.error) throw new Error(chunk.error.message || JSON.stringify(chunk.error));
        const out = t.push(chunk);
        if (out) res.write(out);
      }
      res.write(t.end());
    } catch (e) {
      log(`${p.name}: stream error: ${e.message}`);
      res.write(t.start() + sse('error', { error: { type: 'api_error', message: `cc-fallback (${p.name}): ${e.message}` } }));
    }
    res.end();
  }

  function pipeRaw(res, upstream) {
    const headers = {};
    upstream.headers.forEach((v, k) => { if (!RESP_DROP.has(k)) headers[k] = v; });
    res.writeHead(upstream.status, headers);
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
  }

  async function handleMessages(req, res, raw) {
    let body;
    try { body = JSON.parse(raw); } catch { return sendError(res, 400, 'invalid_request_error', 'Invalid JSON'); }
    const main = !/haiku/i.test(body.model || '');
    let last = { status: 503, message: 'No provider available. Run `cc-fallback scan` and add an API key or a local model.' };

    for (const p of candidates()) {
      let upstream;
      try {
        upstream = p.type === 'anthropic' ? await callAnthropic(p, req, body) : await callOpenAI(p, body);
      } catch (e) {
        coolDown(p, (p.local ? 1 : 2) * 60_000, e.code === 'NO_MODEL' ? e.message : `unreachable (${e.cause?.code || e.message})`);
        last = { status: 503, message: `${p.name}: ${e.message}` };
        continue;
      }
      if (upstream.ok) {
        if (state.lastUsed !== p.name) log(`using ${p.name}${upstream.modelUsed ? ` (${upstream.modelUsed})` : ''}`);
        state.lastUsed = p.name;
        state.requests++;
        let prefix = '';
        if (main && config.announceSwitch && state.lastAnnounced !== p.name) {
          if (p.type !== 'anthropic') prefix = `> ⚡ cc-fallback: ${p.name} / ${upstream.modelUsed}\n\n`;
          state.lastAnnounced = p.name;
        }
        return p.type === 'anthropic' ? pipeRaw(res, upstream) : sendOpenAI(res, upstream, body, p, prefix);
      }

      const text = await upstream.text().catch(() => '');
      const s = upstream.status;
      last = { status: s, message: `${p.name}: ${text.slice(0, 500)}`, raw: p.type === 'anthropic' ? text : null };
      if (s === 429 || s === 529 || /usage limit|rate.?limit|quota/i.test(text)) coolDown(p, retryAfterMs(upstream), `limit reached (HTTP ${s})`);
      else if (s === 401 || s === 403) coolDown(p, (p.type === 'anthropic' ? 5 : 60) * 60_000, `auth failed (HTTP ${s})`);
      else if (s >= 500) coolDown(p, 60_000, `server error (HTTP ${s})`);
      else if (p.type === 'anthropic' && !p.apiKey) {
        // A 4xx from Claude itself is a real request error: report it unchanged.
        res.writeHead(s, { 'content-type': 'application/json' });
        return res.end(text);
      } else log(`${p.name}: HTTP ${s}, trying next: ${text.slice(0, 200)}`);
    }
    if (last.raw) { res.writeHead(last.status, { 'content-type': 'application/json' }); return res.end(last.raw); }
    sendError(res, last.status, last.status === 429 ? 'rate_limit_error' : 'api_error', last.message);
  }

  async function handleCountTokens(req, res, raw) {
    const claude = providers().find((p) => p.type === 'anthropic' && !p.apiKey);
    if (claude && !inCooldown(claude) && (!state.forced || state.forced === claude.name)) {
      try {
        const up = await fetch(claude.baseUrl + req.url, { method: 'POST', headers: anthropicHeaders(req, claude), body: raw });
        if (up.ok) return pipeRaw(res, up);
      } catch { /* fall through to estimate */ }
    }
    let body = {};
    try { body = JSON.parse(raw); } catch { /* empty */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ input_tokens: estimateTokens(body) }));
  }

  async function passthrough(req, res, raw) {
    const claude = providers().find((p) => p.type === 'anthropic');
    if (!claude) return sendError(res, 404, 'not_found_error', 'No Anthropic upstream configured');
    try {
      const up = await fetch(claude.baseUrl + req.url, {
        method: req.method, headers: anthropicHeaders(req, claude), body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw,
      });
      pipeRaw(res, up);
    } catch (e) { sendError(res, 502, 'api_error', e.message); }
  }

  function status() {
    const now = Date.now();
    return {
      forced: state.forced, lastUsed: state.lastUsed, requests: state.requests,
      providers: config.providers.map((p) => {
        const c = state.cooldown.get(p.name);
        return {
          name: p.name, type: p.type, model: p.model || '(as requested)', configured: isConfigured(p),
          pausedFor: c && c.until > now ? Math.ceil((c.until - now) / 60000) + ' min' : null,
          reason: c && c.until > now ? c.reason : null,
        };
      }),
    };
  }

  function admin(req, res, raw) {
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj, null, 2)); };
    if (req.url === '/_fallback/status') return json(200, status());
    if (req.url === '/_fallback/reset' && req.method === 'POST') { state.cooldown.clear(); log('cooldowns cleared'); return json(200, status()); }
    if (req.url === '/_fallback/use' && req.method === 'POST') {
      let name;
      try { name = JSON.parse(raw).provider; } catch { /* empty */ }
      if (!name || name === 'auto') { state.forced = null; log('mode: auto'); return json(200, status()); }
      if (!config.providers.some((p) => p.name === name)) return json(404, { error: `unknown provider "${name}"` });
      state.forced = name;
      log(`forced provider: ${name}`);
      return json(200, status());
    }
    json(404, { error: 'unknown admin endpoint' });
  }

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const path = req.url.split('?')[0];
    try {
      if (path === '/health') { res.writeHead(200); return res.end('ok'); }
      if (path.startsWith('/_fallback/')) return admin(req, res, raw);
      if (req.method === 'POST' && path === '/v1/messages') return await handleMessages(req, res, raw);
      if (req.method === 'POST' && path === '/v1/messages/count_tokens') return await handleCountTokens(req, res, raw);
      return await passthrough(req, res, raw);
    } catch (e) {
      log(`internal error: ${e.stack || e.message}`);
      if (!res.headersSent) sendError(res, 500, 'api_error', e.message); else res.end();
    }
  });

  return { server, state, status, log };
}

function sendError(res, status, type, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}
