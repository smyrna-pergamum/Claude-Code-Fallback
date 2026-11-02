// Local HTTP server behind the CC Desk window: serves the UI and drives Claude Code via the Agent SDK.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { RunManager } from './runs.js';
import { proxyBase, isUp, ensureProxy, proxyStatus, proxyCommand } from './fallback.js';
import { getProviders, saveProviders, testProvider } from './settings.js';
import { authStatus, startLogin } from './auth.js';
import { OpenCode } from './opencode.js';
import { environmentsForUi, environmentVars, saveEnvironments } from './environments.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATE_PATH = join(homedir(), '.cc-desk', 'state.json');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const DIRECT = 'https://api.anthropic.com';

const SECRET_RE = /key|token|secret|password|passwd|credential|auth/i;
const ENV_VARS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'CC_FALLBACK_BIN', 'PORT'];
// Names plus values; anything that looks like a secret is masked down to its last 4 characters.
export function envInfo(env = process.env) {
  const names = new Set(ENV_VARS);
  for (const k of Object.keys(env)) if (/^(ANTHROPIC|CC_FALLBACK)_/.test(k)) names.add(k);
  const vars = [...names].sort().map((name) => {
    const v = env[name];
    if (v === undefined || v === '') return { name, value: '(not set)' };
    if (SECRET_RE.test(name)) return { name, value: v.length > 8 ? `••••${v.slice(-4)}` : '••••' };
    return { name, value: v.length > 120 ? `${v.slice(0, 117)}...` : v };
  });
  return { vars };
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch { return { recentDirs: [] }; }
}
async function saveState(state) {
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

const stripTags = (t) => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '');

/** Session transcript -> the same item shapes the live stream produces. */
export function historyItems(messages) {
  const items = [];
  for (const m of messages) {
    if (m.parent_tool_use_id) continue;
    const content = m.message?.content;
    if (m.type === 'user') {
      if (Array.isArray(content)) {
        for (const b of content) if (b.type === 'tool_result') items.push({ type: 'tool_result', id: b.tool_use_id, text: textOf(b.content), isError: !!b.is_error });
      }
      const text = stripTags(textOf(content));
      if (text && !text.startsWith('<command-') && !text.startsWith('<local-command')) items.push({ type: 'user', text });
    } else if (m.type === 'assistant') {
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type === 'text' && b.text) items.push({ type: 'text', text: b.text });
        else if (b.type === 'tool_use') items.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
      }
    }
  }
  return items;
}

export async function startServer({ port = 0, host = '127.0.0.1', quiet = false } = {}) {
  const token = randomBytes(24).toString('hex');
  const state = loadState();
  let proxyUp = await ensureProxy();
  const opencode = new OpenCode();
  const runs = new RunManager({ baseUrl: () => (proxyUp ? proxyBase() : DIRECT), opencode });

  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const body = async (req) => {
    let raw = '';
    for await (const c of req) raw += c;
    try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
  };

  async function api(req, res, url) {
    const p = url.pathname;
    const m = (re) => p.match(re);
    if (req.method === 'GET' && p === '/api/info') {
      return json(res, 200, { home: homedir(), recentDirs: state.recentDirs, defaultDir: state.recentDirs[0] || join(homedir(), 'Documents') });
    }
    if (req.method === 'GET' && p === '/api/sessions') {
      const dir = url.searchParams.get('dir') || undefined;
      // includeProgrammatic: chats started from this app are SDK sessions too.
      const list = await listSessions({ dir, limit: 200, includeProgrammatic: true }).catch(() => []);
      const claude = list.map((s) => ({ id: s.sessionId, title: s.customTitle || s.summary || s.firstPrompt || '(untitled)', at: s.lastModified, cwd: s.cwd, branch: s.gitBranch, engine: 'claude' }));
      // OpenCode's sessions too, once it has been used (listing them starts its server).
      const oc = dir && opencode.available && opencode.used ? await opencode.sessions(dir).catch(() => []) : [];
      return json(res, 200, [...claude, ...oc].sort((a, b) => b.at - a.at));
    }
    let r;
    if (req.method === 'GET' && (r = m(/^\/api\/sessions\/([\w-]+)\/messages$/))) {
      const dir = url.searchParams.get('dir') || undefined;
      if (r[1].startsWith('ses_')) return json(res, 200, await opencode.history(r[1], dir));
      const msgs = await getSessionMessages(r[1], { dir });
      return json(res, 200, historyItems(msgs));
    }
    if (req.method === 'GET' && p === '/api/opencode') {
      if (!opencode.available) return json(res, 200, { available: false, models: [] });
      try { return json(res, 200, { available: true, models: await opencode.models(url.searchParams.get('dir') || undefined) }); } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (req.method === 'GET' && p === '/api/environments') return json(res, 200, await environmentsForUi());
    if (req.method === 'POST' && p === '/api/environments') {
      try {
        // Variables reach OpenCode when its server starts, so restart the ones that changed.
        for (const id of await saveEnvironments((await body(req)).environments || [])) opencode.stop(id);
        return json(res, 200, await environmentsForUi());
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && p === '/api/send') {
      const b = await body(req);
      const cwd = resolve(b.cwd || '');
      if (!b.prompt?.trim()) return json(res, 400, { error: 'empty prompt' });
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return json(res, 400, { error: `folder not found: ${cwd}` });
      proxyUp = await isUp() || await ensureProxy();
      state.recentDirs = [cwd, ...state.recentDirs.filter((d) => d !== cwd)].slice(0, 10);
      saveState(state).catch(() => {});
      const engine = b.engine === 'opencode' ? 'opencode' : 'claude';
      const envId = b.environment || 'local';
      const run = runs.start({
        prompt: b.prompt, cwd, sessionId: b.sessionId, model: b.model, permissionMode: b.permissionMode,
        engine, envId, vars: await environmentVars(envId),
      });
      return json(res, 200, { runId: run.id, viaProxy: proxyUp });
    }
    if (req.method === 'GET' && (r = m(/^\/api\/runs\/([\w-]+)\/events$/))) {
      if (!runs.attach(r[1], res)) json(res, 404, { error: 'unknown run' });
      return;
    }
    if (req.method === 'POST' && (r = m(/^\/api\/runs\/([\w-]+)\/permission$/))) {
      const b = await body(req);
      return json(res, runs.answer(r[1], b.permId, b.decision) ? 200 : 404, {});
    }
    if (req.method === 'POST' && (r = m(/^\/api\/runs\/([\w-]+)\/interrupt$/))) {
      return json(res, 200, { ok: await runs.interrupt(r[1]) });
    }
    if (req.method === 'GET' && p === '/api/auth') return json(res, 200, await authStatus());
    if (req.method === 'POST' && p === '/api/auth/login') return json(res, 200, startLogin());
    if (req.method === 'GET' && p === '/api/providers') {
      try { return json(res, 200, await getProviders()); } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (req.method === 'POST' && p === '/api/providers') {
      try { return json(res, 200, await saveProviders((await body(req)).providers || [])); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && p === '/api/providers/test') return json(res, 200, await testProvider(await body(req)));
    if (req.method === 'GET' && p === '/api/fallback') return json(res, 200, await proxyStatus());
    if (req.method === 'POST' && p === '/api/fallback/start') { proxyUp = await ensureProxy(); return json(res, 200, { up: proxyUp }); }
    if (req.method === 'POST' && (r = m(/^\/api\/fallback\/(use|reset)$/))) {
      try { return json(res, 200, await proxyCommand(r[1], await body(req))); } catch (e) { return json(res, 502, { error: e.message }); }
    }
    if (req.method === 'GET' && p === '/api/env') return json(res, 200, envInfo());
    if (req.method === 'POST' && p === '/api/upload') {
      // multipart/form-data single file
      const ct = req.headers['content-type'] || '';
      const m = ct.match(/boundary=(.+)$/);
      if (!m) return json(res, 400, { error: 'no boundary' });
      const boundary = m[1].replace(/^"|"$/g, '');
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const buf = Buffer.concat(chunks);
      const delim = Buffer.from('--' + boundary);
      // find file part
      let idx = 0;
      while (true) {
        const start = buf.indexOf(delim, idx);
        if (start < 0) break;
        const next = buf.indexOf(delim, start + delim.length);
        const part = buf.slice(start, next < 0 ? buf.length : next);
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd > 0) {
          const headers = part.slice(0, headerEnd).toString('utf8');
          const fnm = headers.match(/filename="([^"]*)"/);
          if (fnm) {
            const name = fnm[1] || 'file';
            const data = part.slice(headerEnd + 4);
            // strip trailing CRLF
            const clean = data.endsWith(Buffer.from('\r\n')) ? data.slice(0, -2) : data;
            const dir = join(tmpdir(), 'cc-desk-uploads');
            await mkdir(dir, { recursive: true });
            const path = join(dir, `${randomUUID()}-${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
            await writeFile(path, clean);
            return json(res, 200, { path, name });
          }
        }
        idx = start + delim.length;
        if (next < 0) break;
      }
      return json(res, 400, { error: 'no file' });
    }
    json(res, 404, { error: 'not found' });
  }

  const server = http.createServer(async (req, res) => {
    const addr = server.address();
    // Only this machine's UI may talk to us: right Host (no DNS rebinding) and our token for the API.
    if (![`127.0.0.1:${addr.port}`, `localhost:${addr.port}`].includes(req.headers.host)) { res.writeHead(403); return res.end(); }
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        if ((req.headers['x-desk-token'] || url.searchParams.get('token')) !== token) return json(res, 401, { error: 'bad token' });
        return await api(req, res, url);
      }
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const full = resolve(PUBLIC, file);
      if (!full.startsWith(PUBLIC) || !existsSync(full)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': TYPES[extname(full)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(await readFile(full));
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: e.message }); else res.end();
    }
  });

  await new Promise((r) => server.listen(port, host, r));
  const appUrl = `http://127.0.0.1:${server.address().port}/?token=${token}`;
  if (!quiet) console.log(`CC Desk: ${appUrl}  (proxy ${proxyUp ? 'on' : 'off'})`);
  return { server, url: appUrl, token, close: () => { opencode.stopAll(); server.close(); } };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  startServer({ port: Number(process.env.PORT) || 0 });
}
