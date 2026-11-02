// Local proxy: Claude Code -> (Claude | free cloud APIs | local models), switching on limits.
import http from 'node:http';
import { Readable } from 'node:stream';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig, resolveKey, resolveKeys, resolveUrl, isConfigured, tierOf, LOG_PATH } from './config.js';
import { toOpenAIRequest, fromOpenAIResponse, estimateTokens, takeModelTarget, hasImage } from './translate.js';
import { StreamTranslator, readSSE, sse } from './stream.js';
import { pickInstalled } from './hardware.js';

// Headers that must never travel between hops. Auth headers are only ever forwarded to Anthropic.
const HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding', 'keep-alive', 'upgrade']);
const RESP_DROP = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);
const THINKING = ['enabled', 'adaptive'];

export function createProxy(config = loadConfig(), { quiet = false, logPath = LOG_PATH } = {}) {
  const state = {
    cooldown: new Map(), // provider name, or "name#i" for one key of a pool -> { until, reason }
    forced: null, // "provider" or "provider,model"
    lastUsed: null,
    lastAnnounced: 'claude',
    localModels: new Map(), // provider name -> { at, id }
    inflight: new Map(), // provider name -> open requests
    stats: new Map(), // provider name -> { ok, failed }
    requests: 0,
  };

  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    if (!quiet) console.error(line);
    if (!logPath) return;
    try { mkdirSync(dirname(logPath), { recursive: true }); appendFileSync(logPath, line + '\n'); } catch { /* ignore */ }
  };

  const providers = () => config.providers.filter(isConfigured);
  const until = (name) => state.cooldown.get(name)?.until || 0;
  const inCooldown = (p) => until(p.name) > Date.now();
  const busy = (p) => p.maxConcurrent > 0 && (state.inflight.get(p.name) || 0) >= p.maxConcurrent;
  const count = (p, field) => {
    const s = state.stats.get(p.name) || { ok: 0, failed: 0 };
    s[field]++;
    state.stats.set(p.name, s);
  };
  const coolDown = (name, ms, reason) => {
    state.cooldown.set(name, { until: Date.now() + ms, reason });
    log(`${name}: ${reason} -> paused ${Math.round(ms / 60000)} min`);
  };

  // Kind of request, used to pick preferred targets from config.routes.
  function scenarioOf(body, tokens) {
    const routes = config.routes || {};
    if (tierOf(body.model) === 'haiku' && routes.background?.length) return 'background';
    if (hasImage(body)) return 'image';
    if (tokens > (routes.longContextThreshold ?? Infinity)) return 'longContext';
    if (THINKING.includes(body.thinking?.type)) return 'think';
    return 'default';
  }

  /**
   * Ordered list of { p, model } to try. Claude comes first (except for background requests when a
   * background route is set), then the targets of the request's scenario, then the rest in config
   * order. Paused providers and those whose contextWindow is too small are left out.
   */
  function plan(body, chosen) {
    const all = providers();
    const parse = (t) => {
      const [name, ...model] = String(t).split(',');
      return { p: all.find((p) => p.name === name.trim()), model: model.join(',').trim() || undefined };
    };
    const tokens = estimateTokens(body);
    const scenario = scenarioOf(body, tokens);
    const fits = (p) => !p.contextWindow || tokens <= p.contextWindow;

    if (state.forced && !chosen) {
      const f = parse(state.forced);
      if (f.p) return { scenario: 'forced', targets: [f] };
    }
    const ready = all.filter((p) => !inCooldown(p) && fits(p));
    const targets = [];
    const add = (p, model, force) => {
      if (p && (force || ready.includes(p)) && !targets.some((t) => t.p === p)) targets.push({ p, model });
    };
    const isPassthrough = (p) => p.type === 'anthropic' && !p.apiKey;

    if (chosen) {
      // The user picked a model: try it even if paused; fall back to other free providers, not Claude,
      // because Claude would reject the "provider,model" name.
      const c = parse(chosen);
      if (c.p) {
        add(c.p, c.model, true);
        ready.filter((p) => !isPassthrough(p)).forEach((p) => add(p));
        return { scenario: 'chosen', targets };
      }
      log(`unknown provider in "${chosen}", using the normal order`);
    }
    if (scenario !== 'background') ready.filter((p) => p.type === 'anthropic').forEach((p) => add(p));
    for (const t of config.routes?.[scenario] || []) { const r = parse(t); add(r.p, r.model); }
    ready.forEach((p) => add(p));
    if (!targets.length) {
      // Everything paused: try anyway, soonest-to-recover first, rather than failing outright.
      [...all].sort((a, b) => (fits(b) - fits(a)) || (until(a.name) - until(b.name))).forEach((p) => add(p, undefined, true));
    }
    return { scenario, targets };
  }

  async function resolveModel(p, requested, override) {
    if (override) return override;
    const tier = tierOf(requested);
    const wanted = p.models?.[tier] || (tier === 'haiku' && p.smallModel) || p.model;
    if (wanted && wanted !== 'auto') return wanted;
    const cached = state.localModels.get(p.name);
    if (cached && Date.now() - cached.at < 60_000) return cached.id;
    const res = await fetch(`${resolveUrl(p)}/models`, { signal: AbortSignal.timeout(3000) });
    const ids = ((await res.json()).data || []).map((m) => m.id);
    const id = pickInstalled(ids);
    if (!id) throw Object.assign(new Error('no local model installed'), { code: 'NO_MODEL' });
    state.localModels.set(p.name, { at: Date.now(), id });
    return id;
  }

  /** Keys to try for a provider: [{ key, slot }]; slot names a pool entry for its own cooldown. */
  function keyChoices(p) {
    const keys = resolveKeys(p);
    if (keys.length <= 1) return [{ key: keys[0] || '', slot: null }];
    const all = keys.map((key, i) => ({ key, slot: `${p.name}#${i + 1}` }));
    const ready = all.filter((k) => until(k.slot) <= Date.now());
    return ready.length ? ready : all;
  }

  function retryAfterMs(res, p) {
    const ra = Number(res.headers.get('retry-after'));
    if (ra > 0) return ra * 1000;
    const reset = res.headers.get('anthropic-ratelimit-unified-reset');
    if (reset) {
      const t = /^\d+$/.test(reset) ? Number(reset) * 1000 : Date.parse(reset);
      if (t > Date.now()) return t - Date.now();
    }
    return (p.cooldownMinutes ?? config.cooldownMinutes) * 60_000;
  }

  function anthropicHeaders(req, key) {
    const h = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) h[k] = v;
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

  async function callAnthropic(p, req, body, key, override) {
    let send = fixThinking(body);
    const model = override || p.models?.[tierOf(body.model)] || (tierOf(body.model) === 'haiku' && p.smallModel) || p.model;
    if (model) send = { ...send, model };
    return fetch(resolveUrl(p) + req.url, {
      method: 'POST', headers: anthropicHeaders(req, key), body: JSON.stringify(send),
    });
  }

  async function callOpenAI(p, body, key, override) {
    const model = await resolveModel(p, body.model, override);
    const headers = { 'content-type': 'application/json' };
    if (key) headers.authorization = `Bearer ${key}`;
    Object.assign(headers, p.headers || {});
    const res = await fetch(`${resolveUrl(p)}/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify(toOpenAIRequest(body, p, model)),
    });
    res.modelUsed = model;
    return res;
  }

  async function sendOpenAI(res, upstream, body, p, prefix) {
    const model = `${p.name}/${upstream.modelUsed}`;
    if (!body.stream) {
      const data = await upstream.json();
      res.writeHead(200, { 'content-type': 'application/json', 'x-cc-fallback-provider': p.name });
      res.end(JSON.stringify(fromOpenAIResponse(data, model, prefix)));
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-cc-fallback-provider': p.name,
    });
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

  function pipeRaw(res, upstream, p) {
    const headers = {};
    upstream.headers.forEach((v, k) => { if (!RESP_DROP.has(k)) headers[k] = v; });
    if (p) headers['x-cc-fallback-provider'] = p.name;
    res.writeHead(upstream.status, headers);
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
  }

  async function handleMessages(req, res, raw) {
    let body;
    try { body = JSON.parse(raw); } catch { return sendError(res, 400, 'invalid_request_error', 'Invalid JSON'); }
    const chosen = takeModelTarget(body);
    const main = tierOf(body.model) !== 'haiku';
    const { scenario, targets } = plan(body, chosen);
    let last = { status: 503, message: 'No provider available. Run `cc-fallback scan` and add an API key or a local model.' };

    for (const { p, model: override } of targets) {
      if (busy(p)) { last = { status: 429, message: `${p.name}: busy (maxConcurrent ${p.maxConcurrent})` }; continue; }
      const passthrough = p.type === 'anthropic' && !p.apiKey;
      const keys = keyChoices(p);
      for (const [ki, { key, slot }] of keys.entries()) {
        const moreKeys = ki < keys.length - 1;
        let upstream;
        state.inflight.set(p.name, (state.inflight.get(p.name) || 0) + 1);
        try {
          try {
            upstream = p.type === 'anthropic' ? await callAnthropic(p, req, body, key, override) : await callOpenAI(p, body, key, override);
          } catch (e) {
            count(p, 'failed');
            coolDown(p.name, (p.local ? 1 : 2) * 60_000, e.code === 'NO_MODEL' ? e.message : `unreachable (${e.cause?.code || e.message})`);
            last = { status: 503, message: `${p.name}: ${e.message}` };
            break;
          }
          if (upstream.ok) {
            const label = upstream.modelUsed ? `${p.name} (${upstream.modelUsed})` : p.name;
            if (state.lastUsed !== p.name) log(`using ${label}${scenario === 'default' ? '' : ` [${scenario}]`}`);
            state.lastUsed = p.name;
            state.requests++;
            count(p, 'ok');
            let prefix = '';
            if (main && config.announceSwitch && state.lastAnnounced !== p.name) {
              if (p.type !== 'anthropic') prefix = `> ⚡ cc-fallback: ${p.name} / ${upstream.modelUsed}\n\n`;
              state.lastAnnounced = p.name;
            }
            return p.type === 'anthropic' ? pipeRaw(res, upstream, p) : await sendOpenAI(res, upstream, body, p, prefix);
          }
        } finally {
          state.inflight.set(p.name, state.inflight.get(p.name) - 1);
        }

        count(p, 'failed');
        const text = await upstream.text().catch(() => '');
        const s = upstream.status;
        last = { status: s, message: `${p.name}: ${text.slice(0, 500)}`, raw: p.type === 'anthropic' ? text : null };
        const limited = s === 429 || s === 529 || /usage limit|rate.?limit|quota/i.test(text);
        // With a key pool, a limited or rejected key is paused on its own and the next key is tried.
        if (slot && moreKeys && (limited || s === 401 || s === 403)) {
          coolDown(slot, limited ? retryAfterMs(upstream, p) : 60 * 60_000, `key ${limited ? 'limit reached' : 'rejected'} (HTTP ${s})`);
          continue;
        }
        if (limited) coolDown(p.name, retryAfterMs(upstream, p), `limit reached (HTTP ${s})`);
        else if (s === 401 || s === 403) coolDown(p.name, (p.type === 'anthropic' ? 5 : 60) * 60_000, `auth failed (HTTP ${s})`);
        else if (s >= 500) coolDown(p.name, 60_000, `server error (HTTP ${s})`);
        else if (passthrough) {
          // A 4xx from Claude itself is a real request error: report it unchanged.
          res.writeHead(s, { 'content-type': 'application/json' });
          return res.end(text);
        } else log(`${p.name}: HTTP ${s}, trying next: ${text.slice(0, 200)}`);
        break;
      }
    }
    if (last.raw) { res.writeHead(last.status, { 'content-type': 'application/json' }); return res.end(last.raw); }
    sendError(res, last.status, last.status === 429 ? 'rate_limit_error' : 'api_error', last.message);
  }

  async function handleCountTokens(req, res, raw) {
    const claude = providers().find((p) => p.type === 'anthropic' && !p.apiKey);
    if (claude && !inCooldown(claude) && (!state.forced || state.forced === claude.name)) {
      try {
        const up = await fetch(resolveUrl(claude) + req.url, { method: 'POST', headers: anthropicHeaders(req), body: raw });
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
      const up = await fetch(resolveUrl(claude) + req.url, {
        method: req.method, headers: anthropicHeaders(req, resolveKey(claude.apiKey)), body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw,
      });
      pipeRaw(res, up);
    } catch (e) { sendError(res, 502, 'api_error', e.message); }
  }

  function status() {
    const now = Date.now();
    const paused = (name) => {
      const c = state.cooldown.get(name);
      return c && c.until > now ? { pausedFor: Math.ceil((c.until - now) / 60000) + ' min', reason: c.reason } : { pausedFor: null, reason: null };
    };
    return {
      forced: state.forced, lastUsed: state.lastUsed, requests: state.requests, routes: config.routes || {},
      providers: config.providers.map((p) => {
        const keys = resolveKeys(p);
        return {
          name: p.name, type: p.type, model: p.model || '(as requested)', configured: isConfigured(p),
          keys: keys.length > 1 ? keys.map((_, i) => ({ slot: i + 1, ...paused(`${p.name}#${i + 1}`) })) : undefined,
          inflight: state.inflight.get(p.name) || 0,
          ...(state.stats.get(p.name) || { ok: 0, failed: 0 }),
          ...paused(p.name),
        };
      }),
    };
  }

  function admin(req, res, raw) {
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj, null, 2)); };
    if (req.url === '/_fallback/status') return json(200, status());
    if (req.url === '/_fallback/reset' && req.method === 'POST') { state.cooldown.clear(); log('cooldowns cleared'); return json(200, status()); }
    if (req.url === '/_fallback/reload' && req.method === 'POST') {
      // Re-read the config file (e.g. after keys or providers were edited); port/host need a restart.
      try { config = { ...loadConfig(), port: config.port, host: config.host }; } catch (e) { return json(400, { error: e.message }); }
      state.localModels.clear();
      log('config reloaded');
      return json(200, status());
    }
    if (req.url === '/_fallback/use' && req.method === 'POST') {
      let target;
      try { target = JSON.parse(raw).provider; } catch { /* empty */ }
      if (!target || target === 'auto') { state.forced = null; log('mode: auto'); return json(200, status()); }
      const name = target.split(',')[0].trim();
      if (!config.providers.some((p) => p.name === name)) return json(404, { error: `unknown provider "${name}"` });
      state.forced = target;
      log(`forced provider: ${target}`);
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
