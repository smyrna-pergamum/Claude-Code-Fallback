// OpenCode as a second agent: runs the bundled `opencode serve` (one per environment) and turns
// its event stream into the same UI events Claude Code runs produce.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const DATA = join(homedir(), '.cc-desk', 'opencode');
const HOST_ENV = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_AGENT_SDK_.*|ANTHROPIC_BASE_URL|CLAUDE_PID|ELECTRON_RUN_AS_NODE)$/;
export const DEFAULT_MODEL = 'opencode/glm-5.3-flash-free';

export function opencodeBinary() {
  const os = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform];
  try {
    const pkg = require.resolve(`opencode-${os}-${process.arch}/package.json`);
    const bin = join(dirname(pkg), 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
    if (existsSync(bin)) return bin;
  } catch { /* not bundled for this platform */ }
  return null;
}

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// Ask before edits, commands and web fetches, like Claude Code; CC Desk's permission mode
// decides per request whether to answer automatically.
const PERMISSION = JSON.stringify({ edit: 'ask', bash: 'ask', webfetch: 'ask' });

export class OpenCode {
  constructor() {
    this.servers = new Map(); // environment id -> { proc, base, auth, ready }
    this.limits = new Map(); // "provider/model" -> context window (tokens)
    process.on('exit', () => this.stopAll());
  }

  get available() { return !!opencodeBinary(); }
  /** True once OpenCode has been used here, so listing its sessions is worth starting it. */
  get used() { return this.servers.size > 0 || existsSync(join(DATA, 'data')); }

  server(envId = 'local', vars = {}) {
    const existing = this.servers.get(envId);
    if (existing) return existing.ready;
    const bin = opencodeBinary();
    if (!bin) return Promise.reject(new Error('OpenCode is not bundled for this system.'));
    const entry = {};
    entry.ready = (async () => {
      const port = await freePort();
      const password = randomBytes(18).toString('hex');
      const env = {};
      for (const [k, v] of Object.entries(process.env)) if (!HOST_ENV.test(k)) env[k] = v;
      const xdg = (name) => { const p = join(DATA, name); mkdirSync(p, { recursive: true }); return p; };
      Object.assign(env, vars, {
        // Its own data folder: CC Desk's OpenCode never clashes with another OpenCode install.
        XDG_DATA_HOME: xdg('data'), XDG_CONFIG_HOME: xdg('config'), XDG_STATE_HOME: xdg('state'), XDG_CACHE_HOME: xdg('cache'),
        OPENCODE_SERVER_PASSWORD: password, OPENCODE_PERMISSION: PERMISSION,
      });
      entry.proc = spawn(bin, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], { env, stdio: 'ignore', windowsHide: true });
      entry.proc.on('exit', () => { if (this.servers.get(envId) === entry) this.servers.delete(envId); });
      entry.base = `http://127.0.0.1:${port}`;
      entry.auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
      for (let i = 0; i < 100; i++) {
        try { if ((await fetch(`${entry.base}/global/health`, { headers: { authorization: entry.auth } })).ok) return entry; } catch { /* starting */ }
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error('OpenCode did not start.');
    })();
    entry.ready.catch(() => { entry.proc?.kill(); this.servers.delete(envId); });
    this.servers.set(envId, entry);
    return entry.ready;
  }

  async call(srv, method, path, dir, body) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`${srv.base}${path}${dir ? `${sep}directory=${encodeURIComponent(dir)}` : ''}`, {
      method, headers: { authorization: srv.auth, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`OpenCode ${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? null : res.json();
  }

  stop(envId) { this.servers.get(envId)?.proc?.kill(); this.servers.delete(envId); }
  stopAll() { for (const id of [...this.servers.keys()]) this.stop(id); }

  async sessions(dir) {
    const srv = await this.server();
    const list = await this.call(srv, 'GET', '/session?roots=true', dir);
    return list.filter((s) => !s.parentID).map((s) => ({
      id: s.id, title: s.title || '(untitled)', at: s.time?.updated || s.time?.created || 0, engine: 'opencode',
    }));
  }

  async models(dir) {
    const srv = await this.server();
    const p = await this.call(srv, 'GET', '/provider', dir);
    const out = [];
    for (const prov of p.all.filter((x) => p.connected.includes(x.id))) {
      for (const [id, m] of Object.entries(prov.models)) {
        if (m.limit?.context) this.limits.set(`${prov.id}/${id}`, m.limit.context);
        out.push({ id: `${prov.id}/${id}`, name: `${prov.name || prov.id} · ${m.name || id}`, free: /free|big-pickle/.test(id) });
      }
    }
    return out.sort((a, b) => (b.free - a.free) || a.id.localeCompare(b.id));
  }

  /** Session transcript -> UI items. */
  async history(sessionId, dir) {
    const srv = await this.server();
    const items = [];
    let used = 0;
    for (const { info, parts } of await this.call(srv, 'GET', `/session/${sessionId}/message`, dir)) {
      if (info.role === 'assistant' && info.tokens) used = (info.tokens.input || 0) + (info.tokens.cache?.read || 0) + (info.tokens.cache?.write || 0) || used;
      for (const part of parts) {
        if (part.type === 'text' && part.text && !part.synthetic) items.push({ type: info.role === 'user' ? 'user' : 'text', text: part.text });
        else if (part.type === 'tool') {
          items.push({ type: 'tool_use', id: part.callID, name: part.tool, input: part.state?.input || {} });
          if (part.state?.status === 'completed') items.push({ type: 'tool_result', id: part.callID, text: part.state.output || '' });
          if (part.state?.status === 'error') items.push({ type: 'tool_result', id: part.callID, text: part.state.error || 'error', isError: true });
        }
      }
    }
    if (used) items.push({ type: 'context', used });
    return items;
  }

  /**
   * Runs one prompt. `run` is the RunManager's run (emit, pending); resolves when the session is idle.
   * Permission mode: bypass answers every request, acceptEdits answers edits; plan uses the plan agent.
   */
  async prompt(run, { prompt, cwd, sessionId, model, permissionMode, envId, vars, dirs = [] }) {
    const srv = await this.server(envId, vars);
    const dir = cwd;
    let sid = sessionId;
    if (!sid) {
      sid = (await this.call(srv, 'POST', '/session', dir, {})).id;
    }
    run.sessionId = sid;
    run.emit({ type: 'session', sessionId: sid });
    const [providerID, ...rest] = String(model || DEFAULT_MODEL).split('/');
    if (!this.limits.size) await this.models(dir).catch(() => {}); // context window sizes for the meter
    run.emit({ type: 'init', model: `OpenCode · ${providerID}/${rest.join('/')}` });

    const ac = new AbortController();
    run.stop = async () => { try { await this.call(srv, 'POST', `/session/${sid}/abort`, dir); } catch { ac.abort(); } };
    const events = await fetch(`${srv.base}/event?directory=${encodeURIComponent(dir)}`, { headers: { authorization: srv.auth }, signal: ac.signal });

    const roles = new Map(); // messageID -> role
    const tools = new Map(); // callID -> status already shown
    const reply = (id, decision) => this.call(srv, 'POST', `/permission/${id}/reply`, dir, { reply: decision === 'deny' ? 'reject' : decision === 'always' ? 'always' : 'once' });

    await this.call(srv, 'POST', `/session/${sid}/prompt_async`, dir, {
      model: { providerID, modelID: rest.join('/') }, agent: permissionMode === 'plan' ? 'plan' : undefined,
      parts: [{ type: 'text', text: dirs.length ? `${prompt}

(Also part of this chat: ${dirs.join(', ')})` : prompt }],
    });

    const decoder = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of events.body) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = block.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          let e;
          try { e = JSON.parse(line.slice(5)); } catch { continue; }
          const p = e.properties || {};
          if (p.sessionID && p.sessionID !== sid) continue;
          if (e.type === 'message.updated') roles.set(p.info.id, p.info.role);
          else if (e.type === 'message.part.delta' && p.field === 'text' && roles.get(p.messageID) === 'assistant') {
            run.emit({ type: 'part_delta', id: p.partID, text: p.delta });
          } else if (e.type === 'message.part.updated') {
            const part = p.part;
            if (part.type === 'step-finish' && part.tokens) {
              const t = part.tokens;
              const used = (t.input || 0) + (t.cache?.read || 0) + (t.cache?.write || 0);
              if (used) run.emit({ type: 'context', used, max: this.limits.get(`${providerID}/${rest.join('/')}`) || 0 });
            } else if (part.type === 'text' && roles.get(part.messageID) === 'assistant' && !part.synthetic) {
              run.emit({ type: 'part_text', id: part.id, text: part.text || '', done: !!part.time?.end });
            } else if (part.type === 'tool') {
              const st = part.state || {};
              if (!tools.has(part.callID) && st.status !== 'pending') {
                tools.set(part.callID, true);
                run.emit({ type: 'tool_use', id: part.callID, name: part.tool, input: st.input || {} });
              }
              if (st.status === 'completed') run.emit({ type: 'tool_result', id: part.callID, text: st.output || '' });
              if (st.status === 'error') {
                if (!tools.has(part.callID)) run.emit({ type: 'tool_use', id: part.callID, name: part.tool, input: st.input || {} });
                run.emit({ type: 'tool_result', id: part.callID, text: st.error || 'error', isError: true });
              }
            }
          } else if (e.type === 'permission.asked') {
            // Folders the user added to the chat (and attachments) count as part of it.
            const inAdded = (pat) => dirs.some((d) => String(pat).replace(/[\\/]\*+$/, '').toLowerCase().startsWith(d.toLowerCase()));
            const auto = permissionMode === 'bypassPermissions' || (permissionMode === 'acceptEdits' && p.permission === 'edit')
              || (p.permission === 'external_directory' && p.patterns?.length && p.patterns.every(inAdded));
            if (auto) { await reply(p.id, 'allow'); continue; }
            run.pending.set(p.id, { answer: (d) => reply(p.id, d) });
            run.emit({ type: 'permission', id: p.id, toolName: p.permission, input: { patterns: p.patterns, ...p.metadata }, canAlways: true });
          } else if (e.type === 'session.error') {
            const err = p.error || {};
            if (err.name !== 'MessageAbortedError') run.emit({ type: 'error', message: err.data?.message || err.name || 'OpenCode error' });
          } else if (e.type === 'session.idle') {
            run.emit({ type: 'result', ok: true, subtype: 'success' });
            ac.abort();
            return;
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') throw err;
    }
  }
}
