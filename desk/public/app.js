// CC Desk UI: sessions sidebar, streaming chat, tool approvals and cc-fallback status.
import { openSettings } from './settings.js';
import { openEnvironments } from './environments.js';

const token = new URLSearchParams(location.search).get('token');
const $ = (id) => document.getElementById(id);
const state = {
  cwd: '', sessionId: null, runId: null, source: null, live: null, working: null, tools: new Map(), status: null,
  engine: 'claude', env: 'local', envs: [], parts: new Map(), ocModels: null,
};
const agentName = () => (state.engine === 'opencode' ? 'OpenCode' : 'Claude');

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', 'x-desk-token': token },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---- tiny, safe markdown ----
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}
function md(text) {
  const out = [];
  String(text).split(/```/).forEach((part, i) => {
    if (i % 2) {
      out.push(`<pre><code>${esc(part.replace(/^[\w+-]*\n/, '').replace(/\n$/, ''))}</code></pre>`);
      return;
    }
    for (const block of part.split(/\n{2,}/)) {
      const lines = block.split('\n').filter((l) => l.trim());
      if (!lines.length) continue;
      if (lines.every((l) => /^\s*([-*]|\d+\.)\s/.test(l))) {
        const tag = /^\s*\d+\./.test(lines[0]) ? 'ol' : 'ul';
        out.push(`<${tag}>${lines.map((l) => `<li>${inline(l.replace(/^\s*([-*]|\d+\.)\s/, ''))}</li>`).join('')}</${tag}>`);
      } else if (lines.every((l) => /^>\s?/.test(l))) {
        out.push(`<blockquote>${lines.map((l) => inline(l.replace(/^>\s?/, ''))).join('<br>')}</blockquote>`);
      } else if (/^#{1,4}\s/.test(lines[0]) && lines.length === 1) {
        out.push(`<h3>${inline(lines[0].replace(/^#+\s/, ''))}</h3>`);
      } else if (lines[0].startsWith('|')) {
        const rows = lines.filter((l) => !/^\|[\s:|-]+\|$/.test(l)).map((l) => l.replace(/^\||\|$/g, '').split('|'));
        out.push(`<pre>${esc(rows.map((r) => r.map((c) => c.trim()).join('  │  ')).join('\n'))}</pre>`);
      } else {
        out.push(`<p>${lines.map(inline).join('<br>')}</p>`);
      }
    }
  });
  return out.join('');
}

// ---- chat rendering ----
const chat = $('chat');
const scroll = () => { chat.scrollTop = chat.scrollHeight; };
function div(cls, html) { const d = document.createElement('div'); d.className = cls; if (html != null) d.innerHTML = html; return d; }
function add(el) {
  $('empty')?.remove();
  // The "working" line always stays last while a run is going.
  if (state.working && state.working.isConnected) chat.insertBefore(el, state.working); else chat.appendChild(el);
  scroll();
  return el;
}
function setWorking(on, label = 'Working…') {
  if (on) {
    if (!state.working) state.working = div('working', '<span class="spark">✳</span><span class="wl"></span>');
    state.working.querySelector('.wl').textContent = label;
    if (!state.working.isConnected) { chat.appendChild(state.working); scroll(); }
  } else state.working?.remove();
}

function toolSummary(input = {}) {
  const v = input.command || input.file_path || input.path || input.pattern || input.url || input.description || input.query
    || Object.values(input).find((x) => typeof x === 'string') || '';
  return String(v).split('\n')[0].slice(0, 200);
}

function render(ev) {
  switch (ev.type) {
    case 'user': {
      const m = add(div('msg user', '<div class="bubble"></div>'));
      m.firstChild.textContent = ev.text;
      break;
    }
    case 'text_delta':
      if (!state.live) state.live = add(div('msg assistant live'));
      state.live.dataset.raw = (state.live.dataset.raw || '') + ev.text;
      state.live.innerHTML = md(state.live.dataset.raw);
      scroll();
      break;
    case 'text':
      if (state.live) { state.live.innerHTML = md(ev.text); state.live.classList.remove('live'); state.live = null; } else add(div('msg assistant', md(ev.text)));
      break;
    // OpenCode sends text per part: a full snapshot (part_text) or an appended piece (part_delta).
    case 'part_text':
    case 'part_delta': {
      let el = state.parts.get(ev.id);
      if (!el) {
        if (!ev.text && ev.type === 'part_text' && !ev.done) break;
        el = add(div('msg assistant live'));
        el.dataset.raw = '';
        state.parts.set(ev.id, el);
      }
      el.dataset.raw = ev.type === 'part_text' ? ev.text : el.dataset.raw + ev.text;
      el.innerHTML = md(el.dataset.raw);
      el.classList.toggle('live', !ev.done);
      scroll();
      break;
    }
    case 'tool_use': {
      finishLive();
      const d = document.createElement('details');
      d.className = `tool msg${state.runId ? ' running' : ''}`;
      d.innerHTML = `<summary><span class="bullet"></span><span class="name">${esc(ev.name)}</span><span class="sum">${esc(toolSummary(ev.input))}</span><span class="chev">▶</span></summary>
        <div class="body"><pre class="in"></pre></div>`;
      d.querySelector('.in').textContent = JSON.stringify(ev.input, null, 2);
      state.tools.set(ev.id, d);
      add(d);
      if (state.runId) setWorking(true, `Running ${ev.name}…`);
      break;
    }
    case 'tool_result': {
      const d = state.tools.get(ev.id);
      if (!d) break;
      d.classList.remove('running');
      d.classList.add(ev.isError ? 'err' : 'ok');
      const pre = document.createElement('pre');
      pre.className = 'out';
      pre.textContent = (ev.text.length > 8000 ? ev.text.slice(0, 8000) + '\n…' : ev.text) || '(no output)';
      d.querySelector('.body').appendChild(pre);
      if (state.runId) setWorking(true, 'Thinking…');
      break;
    }
    case 'permission': renderPermission(ev); break;
    case 'permission_answered': {
      const card = document.querySelector(`[data-perm="${ev.id}"]`);
      if (card) {
        card.classList.add('answered');
        card.querySelector('.btns').outerHTML = `<div class="answer">${ev.decision === 'deny' ? 'Declined' : ev.decision === 'always' ? 'Always allowed' : 'Allowed'}</div>`;
      }
      setWorking(true, 'Working…');
      break;
    }
    case 'session': state.sessionId = ev.sessionId; break;
    case 'init': $('runState').textContent = ev.model; break;
    case 'result':
      finishLive();
      if (!ev.ok) add(div('msg meta')).textContent = `Stopped (${ev.subtype})`;
      break;
    case 'error': finishLive(); add(div('msg error')).textContent = ev.message; break;
    case 'done': runEnded(); break;
    default: break;
  }
}
function finishLive() {
  if (state.live) { state.live.classList.remove('live'); state.live = null; }
  for (const el of state.parts.values()) el.classList.remove('live');
}

function renderPermission(ev) {
  finishLive();
  setWorking(true, 'Waiting for your approval…');
  const card = div('perm msg');
  card.dataset.perm = ev.id;
  const target = toolSummary(ev.input);
  card.innerHTML = `<div class="q">Allow ${agentName()} to use <code>${esc(ev.toolName)}</code>${target ? ` on <code>${esc(target.slice(0, 80))}</code>` : ''}?</div>
    ${ev.reason ? `<div class="why">${esc(ev.reason)}</div>` : ''}
    <pre></pre>
    <div class="btns"><button class="btn primary" data-d="allow">Allow once</button>
    ${ev.canAlways ? '<button class="btn" data-d="always">Always allow</button>' : ''}<button class="btn" data-d="deny">Deny</button></div>`;
  card.querySelector('pre').textContent = JSON.stringify(ev.input, null, 2);
  card.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    card.querySelectorAll('button').forEach((x) => { x.disabled = true; });
    api(`/api/runs/${state.runId}/permission`, { method: 'POST', body: { permId: ev.id, decision: b.dataset.d } }).catch((e) => alert(e.message));
  }));
  add(card);
  card.querySelector('button').focus();
}

// ---- sending ----
function setBusy(busy) {
  $('send').hidden = busy;
  $('stop').hidden = !busy;
}
function runEnded() {
  state.source?.close();
  state.source = null;
  state.runId = null;
  setWorking(false);
  document.querySelectorAll('details.tool.running').forEach((d) => d.classList.remove('running'));
  setBusy(false);
  $('runState').textContent = '';
  loadSessions();
  refreshStatus();
}

async function send(text) {
  if (!text.trim() && !pendingFiles.length || state.runId) return;
  if (!state.cwd) { alert('Pick a folder first.'); return; }
  let full = text;
  if (pendingFiles.length) {
    const paths = pendingFiles.map((f) => f.path).join('\n');
    full = (full ? full + '\n\n' : '') + `Attached files (paths on this machine):\n${paths}`;
  }
  render({ type: 'user', text: full });
  if (!state.sessionId) $('title').textContent = (text || pendingFiles[0]?.name || 'Attachment').slice(0, 80);
  setBusy(true);
  setWorking(true, 'Thinking…');
  try {
    const { runId, viaProxy } = await api('/api/send', {
      method: 'POST',
      body: {
        prompt: full, cwd: state.cwd, sessionId: state.sessionId, model: $('model').value, effort: $('effort').value || undefined,
        permissionMode: $('mode').value, engine: state.engine, environment: state.env,
      },
    });
    pendingFiles = [];
    renderAttachments();
    if (!viaProxy && state.engine === 'claude') add(div('msg meta')).textContent = 'cc-fallback is not running: this message goes straight to Claude, without fallback.';
    state.runId = runId;
    state.source = new EventSource(`/api/runs/${runId}/events?token=${token}`);
    state.source.onmessage = (m) => render(JSON.parse(m.data));
    state.source.onerror = () => { if (state.runId === runId) runEnded(); };
  } catch (e) {
    setWorking(false);
    render({ type: 'error', message: e.message });
    setBusy(false);
  }
}

const promptEl = $('prompt');
const attachmentsEl = $('attachments');
let pendingFiles = [];
function renderAttachments() {
  if (!pendingFiles.length) { attachmentsEl.hidden = true; attachmentsEl.innerHTML = ''; return; }
  attachmentsEl.hidden = false;
  attachmentsEl.innerHTML = pendingFiles.map((f, i) => `<span class="chip">${esc(f.name)} <button type="button" data-i="${i}" title="Remove">×</button></span>`).join('');
  attachmentsEl.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { pendingFiles.splice(Number(b.dataset.i), 1); renderAttachments(); }));
}
async function uploadFile(file) {
  const fd = new FormData();
  fd.append('file', file, file.name);
  const res = await fetch('/api/upload', { method: 'POST', headers: { 'x-desk-token': token }, body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  pendingFiles.push({ name: file.name, path: data.path });
  renderAttachments();
}
$('attach').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async (e) => {
  for (const f of e.target.files) { try { await uploadFile(f); } catch (err) { alert(err.message); } }
  e.target.value = '';
});
const grow = () => { promptEl.style.height = 'auto'; promptEl.style.height = `${promptEl.scrollHeight}px`; };
promptEl.addEventListener('input', grow);
$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = promptEl.value;
  promptEl.value = '';
  grow();
  send(text);
});
promptEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); }
});
$('stop').addEventListener('click', () => state.runId && api(`/api/runs/${state.runId}/interrupt`, { method: 'POST' }));

// ---- sessions ----
const ago = (t) => {
  const s = (Date.now() - t) / 1000;
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString();
};
async function loadSessions() {
  if (!state.cwd) return;
  const list = await api(`/api/sessions?dir=${encodeURIComponent(state.cwd)}`).catch(() => []);
  const ul = $('sessions');
  ul.innerHTML = '';
  for (const s of list) {
    const li = document.createElement('li');
    li.innerHTML = `<div class="t">${esc(s.title)}</div><div class="d">${s.engine === 'opencode' ? '<span class="tag oc">OpenCode</span> ' : ''}${ago(s.at)}${s.branch ? ` · ${esc(s.branch)}` : ''}</div>`;
    li.title = s.title;
    li.dataset.id = s.id;
    if (s.id === state.sessionId) li.classList.add('active');
    li.addEventListener('click', () => openSession(s));
    ul.appendChild(li);
  }
}
function clearChat(title) {
  chat.innerHTML = '';
  state.tools.clear();
  state.parts.clear();
  state.live = null;
  $('title').textContent = title;
}
async function openSession(s) {
  if (state.runId) return;
  state.sessionId = s.id;
  setEngine(s.engine === 'opencode' ? 'opencode' : 'claude');
  clearChat(s.title);
  for (const it of await api(`/api/sessions/${s.id}/messages?dir=${encodeURIComponent(state.cwd)}`)) render(it);
  document.querySelectorAll('#sessions li').forEach((li) => li.classList.toggle('active', li.dataset.id === s.id));
}
function newChat() {
  state.sessionId = null;
  clearChat('New session');
  const hint = div('empty', `<span class="spark">✳</span><h2>What should we work on?</h2>
    <p>in <code>${esc(state.cwd)}</code></p><p>${state.engine === 'opencode'
    ? 'OpenCode with free models: no Claude limit involved.'
    : 'Claude first, free models when the limit is reached.'}</p>`);
  hint.id = 'empty';
  chat.appendChild(hint);
  document.querySelectorAll('#sessions li.active').forEach((li) => li.classList.remove('active'));
}
$('newChat').addEventListener('click', () => { if (!state.runId) { newChat(); promptEl.focus(); } });

function setFolder(dir) {
  state.cwd = dir;
  $('folderName').textContent = dir;
  $('folderBtn').title = dir;
  newChat();
  loadSessions();
}
$('folderBtn').addEventListener('click', async () => {
  const dir = window.desk?.pickFolder ? await window.desk.pickFolder(state.cwd) : prompt('Folder path:', state.cwd);
  if (dir) setFolder(dir);
});

// ---- models & cc-fallback status ----
function fillModels(status) {
  const sel = $('model');
  const keep = sel.value;
  if (state.engine === 'opencode') {
    const models = state.ocModels || [];
    const free = models.filter((m) => m.free), other = models.filter((m) => !m.free);
    sel.innerHTML = !models.length ? '<option value="">Loading OpenCode models…</option>'
      : (free.length ? `<optgroup label="Free in OpenCode">${free.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</optgroup>` : '')
        + (other.length ? `<optgroup label="Your OpenCode providers">${other.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</optgroup>` : '');
    sel.value = [...sel.options].some((o) => o.value === keep) ? keep : (models.find((m) => m.id === 'opencode/glm-5.3-flash-free') || models[0])?.id || '';
    return;
  }
  const free = (status?.providers || []).filter((p) => p.configured && p.type === 'openai' && p.model !== 'auto');
  sel.innerHTML = `<optgroup label="Claude"><option value="">Default model</option><option value="claude-opus-5-5">Opus 5.5</option><option value="claude-sonnet-5-5">Sonnet 5.5</option><option value="claude-haiku-5-5">Haiku 5.5</option></optgroup>`
    + (free.length ? `<optgroup label="Directly, via cc-fallback">${free.map((p) => `<option value="${esc(`${p.name},${p.model}`)}">${esc(p.name)} · ${esc(p.model)}</option>`).join('')}</optgroup>` : '');
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}
export async function refreshStatus() {
  const s = await api('/api/fallback').catch(() => ({ up: false }));
  state.status = s;
  const dot = $('dot');
  if (!s.up) {
    dot.className = 'dot bad';
    $('statusText').textContent = 'cc-fallback off · click to start';
  } else {
    const claude = s.providers.find((p) => p.name === 'claude');
    dot.className = `dot ${claude?.pausedFor ? 'warn' : 'ok'}`;
    $('statusText').textContent = claude?.pausedFor ? `Claude limit · back in ${claude.pausedFor} · using ${s.lastUsed || 'free models'}`
      : `cc-fallback ${s.forced ? `→ ${s.forced}` : 'on'} · last: ${s.lastUsed || '–'}`;
  }
  fillModels(s);
  if (!$('statusPanel').hidden) renderStatusPanel();
}
function renderStatusPanel() {
  const s = state.status;
  const panel = $('statusPanel');
  if (!s?.up) {
    panel.innerHTML = '<p>The cc-fallback proxy is not running.</p><div class="row-actions"><button id="startProxy" class="btn primary">Start cc-fallback</button></div>';
    $('startProxy').onclick = async () => { panel.innerHTML = 'Starting…'; await api('/api/fallback/start', { method: 'POST' }).catch(() => {}); refreshStatus(); };
    return;
  }
  const rows = s.providers.filter((p) => p.configured).map((p) => `<tr><td><b>${esc(p.name)}</b></td><td title="${esc(p.model)}">${esc(p.model)}</td>
    <td>${p.pausedFor ? `paused ${esc(p.pausedFor)}` : 'ready'}</td><td>${p.ok || p.failed ? `${p.ok} ok / ${p.failed} failed` : ''}</td>
    <td><button class="btn small" data-use="${esc(p.name)}">${s.forced === p.name ? 'Forced' : 'Use'}</button></td></tr>`).join('');
  panel.innerHTML = `<table>${rows}</table><div class="row-actions"><button data-use="auto" class="btn primary">Automatic</button><button id="resetCd" class="btn">Retry Claude now</button></div>`;
  panel.querySelectorAll('[data-use]').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/fallback/use', { method: 'POST', body: { provider: b.dataset.use } }).catch((e) => alert(e.message));
    refreshStatus();
  }));
  $('resetCd').onclick = async () => { await api('/api/fallback/reset', { method: 'POST' }); refreshStatus(); };
}
$('statusBtn').addEventListener('click', () => {
  const panel = $('statusPanel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) renderStatusPanel();
});
document.addEventListener('click', (e) => { if (!e.target.closest('#status')) $('statusPanel').hidden = true; });
$('settingsBtn').addEventListener('click', () => openSettings());

// ---- Claude login ----
async function checkLogin() {
  const s = await api('/api/auth').catch(() => ({ loggedIn: true })); // unknown: don't nag
  $('loginBar').hidden = s.loggedIn;
  return s.loggedIn;
}
$('loginBtn').addEventListener('click', async () => {
  const r = await api('/api/auth/login', { method: 'POST' });
  if (!r.started) { alert(`Run this in a terminal, then come back:\n\n${r.command}`); return; }
  $('loginBtn').textContent = 'Finish in the browser and the console window…';
  $('loginBtn').disabled = true;
  const timer = setInterval(async () => {
    if (await checkLogin()) { clearInterval(timer); $('loginBtn').disabled = false; $('loginBtn').textContent = 'Log in to Claude'; }
  }, 3000);
});

// Demo mode (?demo=1): lets the screenshot script fill the UI without real sessions.
const demo = new URLSearchParams(location.search).has('demo');
if (demo) {
  window.ccDeskDemo = {
    render, clearChat, setWorking, fillModels,
    folder(label) { state.cwd = label; $('folderName').textContent = label; },
    sessions(list) {
      $('sessions').innerHTML = list.map((s, i) => `<li class="${i === 0 ? 'active' : ''}"><div class="t">${esc(s[0])}</div><div class="d">${esc(s[1])}</div></li>`).join('');
    },
    status(text, cls) { $('dot').className = `dot ${cls}`; $('statusText').textContent = text; },
  };
}

// ---- start ----
(async () => {
  const info = await api('/api/info');
  setFolder(info.defaultDir);
  if (demo) return;
  refreshStatus();
  setInterval(refreshStatus, 5000);
  checkLogin();
  promptEl.focus();
})();

// ---- environment drawer ----
const envPanel = $('envPanel');
async function syncEnv() {
  $('envCwd').textContent = state.cwd || '—';
  const em = $('envModel');
  em.innerHTML = $('model').innerHTML;
  em.value = $('model').value;
  $('envMode').value = $('mode').value;
  $('envProxy').textContent = state.status?.up ? (state.status.lastUsed || 'on') : 'off';
  const env = await api('/api/env').catch(() => ({ vars: [] }));
  $('envVars').innerHTML = env.vars.map((v) => `<li><span class="k">${esc(v.name)}</span><span class="v">${esc(v.value)}</span></li>`).join('') || '<li><span class="v">none</span></li>';
}
$('envBtn').addEventListener('click', () => { envPanel.hidden = !envPanel.hidden; if (!envPanel.hidden) syncEnv(); });
envPanel.querySelector('[data-close]').addEventListener('click', () => { envPanel.hidden = true; });
$('envModel').addEventListener('change', (e) => { $('model').value = e.target.value; });
$('envMode').addEventListener('change', (e) => { $('mode').value = e.target.value; });
$('model').addEventListener('change', () => { $('envModel').value = $('model').value; });
$('mode').addEventListener('change', () => { $('envMode').value = $('mode').value; });
setInterval(() => { if (!envPanel.hidden) { $('envProxy').textContent = state.status?.up ? (state.status.lastUsed || 'on') : 'off'; } }, 5000);

// ---- agent: Claude Code or OpenCode ----
async function loadOpenCodeModels() {
  if (state.ocModels?.length) return;
  fillModels(state.status);
  const r = await api(`/api/opencode?dir=${encodeURIComponent(state.cwd)}`).catch((e) => ({ error: e.message }));
  if (!r.available) { alert(r.error || 'OpenCode is not available in this build.'); setEngine('claude'); return; }
  state.ocModels = r.models;
  fillModels(state.status);
}
function setEngine(engine) {
  state.engine = engine;
  $('agent').value = engine;
  $('effort').hidden = engine === 'opencode'; // effort is a Claude Code setting
  promptEl.placeholder = engine === 'opencode' ? 'Ask OpenCode to do something…' : 'Ask Claude Code to do something…';
  $('envAgent').textContent = engine === 'opencode' ? 'OpenCode' : 'Claude Code';
  if (engine === 'opencode') loadOpenCodeModels(); else fillModels(state.status);
}
$('agent').addEventListener('change', (e) => {
  if (state.runId) { e.target.value = state.engine; return; }
  // A chat belongs to one agent: switching starts a new chat.
  if (state.sessionId) newChat();
  setEngine(e.target.value);
  if (!state.sessionId) newChat();
  promptEl.focus();
});

// ---- environments ----
function fillEnvironments() {
  const opts = state.envs.map((e) => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('') + '<option value="__edit">Edit environments…</option>';
  for (const id of ['envSel', 'envPick']) { $(id).innerHTML = opts; $(id).value = state.env; }
  const env = state.envs.find((e) => e.id === state.env);
  $('envOwnVars').innerHTML = env?.vars.length
    ? env.vars.map((v) => `<li><span class="k">${esc(v.name)}</span><span class="v">${esc(v.value)}</span></li>`).join('')
    : `<li><span class="v">${env?.id === 'local' ? 'none (Local adds nothing)' : 'none'}</span></li>`;
}
async function loadEnvironments() {
  state.envs = await api('/api/environments').catch(() => [{ id: 'local', name: 'Local', vars: [] }]);
  try { const saved = localStorage.getItem('ccdesk.env'); if (saved && state.envs.some((e) => e.id === saved)) state.env = saved; } catch { /* storage off */ }
  if (!state.envs.some((e) => e.id === state.env)) state.env = 'local';
  fillEnvironments();
}
function chooseEnvironment(id) {
  if (id === '__edit') {
    fillEnvironments();
    openEnvironments(state.env, (envs, savedId) => { state.envs = envs; if (savedId) chooseEnvironment(savedId); else fillEnvironments(); });
    return;
  }
  state.env = id;
  try { localStorage.setItem('ccdesk.env', id); } catch { /* storage off */ }
  fillEnvironments();
}
$('envSel').addEventListener('change', (e) => chooseEnvironment(e.target.value));
$('envPick').addEventListener('change', (e) => chooseEnvironment(e.target.value));
$('envEdit').addEventListener('click', () => chooseEnvironment('__edit'));
loadEnvironments();
setEngine('claude');
