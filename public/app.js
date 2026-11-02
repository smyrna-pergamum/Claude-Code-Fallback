// CC Desk UI: sessions sidebar, streaming chat, tool approvals and cc-fallback status.
const token = new URLSearchParams(location.search).get('token');
const $ = (id) => document.getElementById(id);
const state = { cwd: '', sessionId: null, runId: null, source: null, live: null, tools: new Map(), status: null };

async function api(path, opts = {}) {
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
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}
function md(text) {
  const out = [];
  const parts = String(text).split(/```/);
  parts.forEach((part, i) => {
    if (i % 2) {
      const body = part.replace(/^[\w+-]*\n/, '');
      out.push(`<pre><code>${esc(body.replace(/\n$/, ''))}</code></pre>`);
      return;
    }
    for (const block of part.split(/\n{2,}/)) {
      const lines = block.split('\n').filter((l) => l.trim());
      if (!lines.length) continue;
      if (lines.every((l) => /^\s*([-*]|\d+\.)\s/.test(l))) {
        const tag = /^\s*\d+\./.test(lines[0]) ? 'ol' : 'ul';
        out.push(`<${tag}>${lines.map((l) => `<li>${inline(l.replace(/^\s*([-*]|\d+\.)\s/, ''))}</li>`).join('')}</${tag}>`);
      } else if (/^#{1,4}\s/.test(lines[0]) && lines.length === 1) {
        out.push(`<p><b>${inline(lines[0].replace(/^#+\s/, ''))}</b></p>`);
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
function add(el) { $('empty')?.remove(); chat.appendChild(el); scroll(); return el; }
function div(cls, html) { const d = document.createElement('div'); d.className = cls; if (html != null) d.innerHTML = html; return d; }

function toolSummary(name, input = {}) {
  const v = input.command || input.file_path || input.path || input.pattern || input.url || input.description || input.query
    || Object.values(input).find((x) => typeof x === 'string') || '';
  return String(v).split('\n')[0].slice(0, 200);
}

function render(ev) {
  switch (ev.type) {
    case 'user': add(div('msg user')).textContent = ev.text; break;
    case 'text_delta':
      if (!state.live) state.live = add(div('msg assistant live'));
      state.live.dataset.raw = (state.live.dataset.raw || '') + ev.text;
      state.live.innerHTML = md(state.live.dataset.raw);
      scroll();
      break;
    case 'text':
      if (state.live) { state.live.innerHTML = md(ev.text); state.live.classList.remove('live'); state.live = null; } else add(div('msg assistant', md(ev.text)));
      break;
    case 'tool_use': {
      finishLive();
      const d = document.createElement('details');
      d.className = 'tool msg';
      d.innerHTML = `<summary><span class="name">${esc(ev.name)}</span><span class="sum">${esc(toolSummary(ev.name, ev.input))}</span><span class="st wait">…</span></summary><pre class="in">${esc(JSON.stringify(ev.input, null, 2))}</pre>`;
      state.tools.set(ev.id, d);
      add(d);
      break;
    }
    case 'tool_result': {
      const d = state.tools.get(ev.id);
      if (!d) break;
      const st = d.querySelector('.st');
      st.className = `st ${ev.isError ? 'err' : 'ok'}`;
      st.textContent = ev.isError ? 'error' : 'done';
      const pre = document.createElement('pre');
      pre.textContent = ev.text.length > 8000 ? ev.text.slice(0, 8000) + '\n…' : ev.text;
      d.appendChild(pre);
      break;
    }
    case 'permission': renderPermission(ev); break;
    case 'permission_answered': {
      const card = document.querySelector(`[data-perm="${ev.id}"]`);
      if (card) { card.classList.add('answered'); card.querySelector('.btns').textContent = ev.decision === 'deny' ? 'Declined' : 'Allowed'; }
      break;
    }
    case 'session':
      state.sessionId = ev.sessionId;
      break;
    case 'init':
      $('runState').textContent = `${ev.model} · ${ev.permissionMode}`;
      break;
    case 'result': {
      finishLive();
      const secs = ev.durationMs ? `${Math.round(ev.durationMs / 1000)} s` : '';
      add(div(`msg meta`)).textContent = ev.ok ? `Done ${secs}` : `Stopped: ${ev.subtype} ${ev.text || ''}`;
      break;
    }
    case 'error': finishLive(); add(div('msg error')).textContent = ev.message; break;
    case 'done': runEnded(); break;
    default: break;
  }
}
function finishLive() { if (state.live) { state.live.classList.remove('live'); state.live = null; } }

function renderPermission(ev) {
  finishLive();
  const card = div('perm msg');
  card.dataset.perm = ev.id;
  card.innerHTML = `<div class="q">Allow <code>${esc(ev.toolName)}</code>?</div>
    ${ev.reason ? `<div class="hint">${esc(ev.reason)}</div>` : ''}
    <pre>${esc(JSON.stringify(ev.input, null, 2))}</pre>
    <div class="btns"><button class="primary" data-d="allow">Allow</button>
    ${ev.canAlways ? '<button data-d="always">Always allow</button>' : ''}<button data-d="deny">Deny</button></div>`;
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
  $('prompt').disabled = false;
}
function runEnded() {
  state.source?.close();
  state.source = null;
  state.runId = null;
  setBusy(false);
  $('runState').textContent = '';
  loadSessions();
  refreshStatus();
}

async function send(text) {
  if (!text.trim() || state.runId) return;
  if (!state.cwd) { alert('Pick a folder first.'); return; }
  render({ type: 'user', text });
  if (!state.sessionId) $('title').textContent = text.split('\n')[0].slice(0, 80);
  setBusy(true);
  $('runState').textContent = 'Starting…';
  try {
    const { runId, viaProxy } = await api('/api/send', {
      method: 'POST',
      body: { prompt: text, cwd: state.cwd, sessionId: state.sessionId, model: $('model').value, permissionMode: $('mode').value },
    });
    if (!viaProxy) add(div('msg meta')).textContent = 'cc-fallback is not running: this message goes straight to Claude, without fallback.';
    state.runId = runId;
    state.source = new EventSource(`/api/runs/${runId}/events?token=${token}`);
    state.source.onmessage = (m) => render(JSON.parse(m.data));
    state.source.onerror = () => { if (state.runId === runId) runEnded(); };
  } catch (e) {
    render({ type: 'error', message: e.message });
    setBusy(false);
  }
}

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('prompt').value;
  $('prompt').value = '';
  send(text);
});
$('prompt').addEventListener('keydown', (e) => {
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
    li.innerHTML = `<div class="t">${esc(s.title)}</div><div class="d">${ago(s.at)}${s.branch ? ` · ${esc(s.branch)}` : ''}</div>`;
    li.title = s.title;
    if (s.id === state.sessionId) li.classList.add('active');
    li.addEventListener('click', () => openSession(s));
    ul.appendChild(li);
  }
}
function clearChat(title) {
  chat.innerHTML = '';
  state.tools.clear();
  state.live = null;
  $('title').textContent = title;
}
async function openSession(s) {
  if (state.runId) return;
  state.sessionId = s.id;
  clearChat(s.title);
  for (const it of await api(`/api/sessions/${s.id}/messages?dir=${encodeURIComponent(state.cwd)}`)) render(it);
  document.querySelectorAll('#sessions li').forEach((li) => li.classList.toggle('active', li.title === s.title));
}
$('newChat').addEventListener('click', () => {
  if (state.runId) return;
  newChat();
  $('prompt').focus();
});
function newChat() {
  state.sessionId = null;
  clearChat('New chat');
  const hint = div('empty', `<p>New chat in <code>${esc(state.cwd)}</code>.</p><p class="hint">Older chats of this folder are on the left.</p>`);
  hint.id = 'empty';
  chat.appendChild(hint);
  document.querySelectorAll('#sessions li.active').forEach((li) => li.classList.remove('active'));
}

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
  const free = (status?.providers || []).filter((p) => p.configured && p.type === 'openai' && p.model !== 'auto');
  sel.innerHTML = `<optgroup label="Claude"><option value="">Default</option><option>claude-opus-5-5</option><option>claude-sonnet-5-5</option><option>claude-haiku-5-5</option></optgroup>`
    + (free.length ? `<optgroup label="Free via cc-fallback">${free.map((p) => `<option value="${esc(`${p.name},${p.model}`)}">${esc(p.name)} · ${esc(p.model)}</option>`).join('')}</optgroup>` : '');
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}
async function refreshStatus() {
  const s = await api('/api/fallback').catch(() => ({ up: false }));
  state.status = s;
  const dot = $('dot');
  if (!s.up) {
    dot.className = 'dot bad';
    $('statusText').textContent = 'cc-fallback is off: no fallback (click to start)';
  } else {
    const claude = s.providers.find((p) => p.name === 'claude');
    const paused = s.providers.filter((p) => p.pausedFor);
    dot.className = `dot ${claude?.pausedFor ? 'warn' : 'ok'}`;
    $('statusText').textContent = `cc-fallback: ${s.forced ? `forced → ${s.forced}` : 'auto'} · last answer: ${s.lastUsed || '–'}`
      + (claude?.pausedFor ? ` · Claude limit, back in ${claude.pausedFor}` : paused.length ? ` · ${paused.length} paused` : '');
  }
  fillModels(s);
  if (!$('statusPanel').hidden) renderStatusPanel();
}
function renderStatusPanel() {
  const s = state.status;
  const panel = $('statusPanel');
  if (!s?.up) {
    panel.innerHTML = '<p>The proxy is not running.</p><div class="row-actions"><button id="startProxy" class="primary">Start cc-fallback</button></div>';
    $('startProxy').onclick = async () => { panel.innerHTML = 'Starting…'; await api('/api/fallback/start', { method: 'POST' }).catch(() => {}); refreshStatus(); };
    return;
  }
  const rows = s.providers.filter((p) => p.configured).map((p) => `<tr><td><b>${esc(p.name)}</b></td><td>${esc(p.model)}</td>
    <td>${p.pausedFor ? `paused ${esc(p.pausedFor)}` : 'ready'}</td><td>${p.ok || p.failed ? `ok ${p.ok} / failed ${p.failed}` : ''}</td>
    <td><button data-use="${esc(p.name)}">Use</button></td></tr>`).join('');
  panel.innerHTML = `<table>${rows}</table><div class="row-actions"><button data-use="auto" class="primary">Automatic</button><button id="resetCd">Retry Claude now</button></div>`;
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
document.addEventListener('click', (e) => {
  if (!e.target.closest('footer')) $('statusPanel').hidden = true;
});

// ---- start ----
(async () => {
  const info = await api('/api/info');
  setFolder(info.defaultDir);
  refreshStatus();
  setInterval(refreshStatus, 5000);
  $('prompt').focus();
})();
