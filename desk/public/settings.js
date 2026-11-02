// "Models & API keys": edit cc-fallback's providers (keys, custom APIs, local AI) and their order.
import { api, esc, refreshStatus } from './app.js';

const LOCAL_PRESETS = [
  { label: 'Ollama', name: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  { label: 'LM Studio', name: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1' },
  { label: 'llama.cpp server', name: 'llamacpp', baseUrl: 'http://127.0.0.1:8080/v1' },
  { label: 'Other local server', name: 'local', baseUrl: 'http://127.0.0.1:8000/v1' },
];
const API_PRESETS = [
  { label: 'Custom (OpenAI-compatible)', name: 'custom', type: 'openai', baseUrl: 'https://' },
  { label: 'Custom (Anthropic-compatible)', name: 'custom-anthropic', type: 'anthropic', baseUrl: 'https://' },
  { label: 'OpenAI', name: 'openai', type: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-luna' },
  { label: 'DeepSeek', name: 'deepseek', type: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: 'Together AI', name: 'together', type: 'openai', baseUrl: 'https://api.together.xyz/v1' },
];

const el = () => document.getElementById('settings');
let list = [];
let configPath = '';
let dirty = false;

export async function openSettings() {
  const root = el();
  root.hidden = false;
  root.innerHTML = '<div class="sheet"><p class="muted">Loading…</p></div>';
  try {
    const data = await api('/api/providers');
    list = data.providers.map((p) => ({ ...p, originalName: p.name }));
    configPath = data.configPath;
    dirty = false;
    renderList();
  } catch (e) {
    root.innerHTML = `<div class="sheet"><p class="error-text">${esc(e.message)}</p><div class="sheet-foot"><button class="btn" data-close>Close</button></div></div>`;
    root.querySelector('[data-close]').onclick = close;
  }
}
function close() {
  if (dirty && !confirm('Discard unsaved changes?')) return;
  el().hidden = true;
  el().innerHTML = '';
}
el().addEventListener('mousedown', (e) => { if (e.target === el()) close(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el().hidden) close(); });

const kindOf = (p) => (p.key?.kind === 'login' ? 'claude' : p.local ? 'local' : 'cloud');
const badge = { claude: 'Claude', local: 'Local', cloud: 'API' };

function renderList() {
  const root = el();
  root.innerHTML = `<div class="sheet">
    <div class="sheet-head"><h2>Models &amp; API keys</h2><button class="icon-btn" data-close title="Close">✕</button></div>
    <p class="muted">Tried top to bottom. Claude goes first; the others take over when it hits its limit. Use ↑ ↓ to change the order.</p>
    <div class="add-row">
      <div class="menu"><button class="btn" data-menu="api">＋ Add API</button>
        <div class="menu-list" hidden>${API_PRESETS.map((p, i) => `<button data-api="${i}">${esc(p.label)}</button>`).join('')}</div></div>
      <div class="menu"><button class="btn" data-menu="local">＋ Add local AI</button>
        <div class="menu-list" hidden>${LOCAL_PRESETS.map((p, i) => `<button data-local="${i}">${esc(p.label)}</button>`).join('')}</div></div>
    </div>
    <ul class="prov-list">${list.map((p, i) => {
      const k = kindOf(p);
      return `<li class="${p.enabled === false ? 'off' : ''}">
        <label class="switch" title="Use this provider"><input type="checkbox" data-on="${i}" ${p.enabled === false ? '' : 'checked'}><span></span></label>
        <div class="pinfo"><div><b>${esc(p.name)}</b> <span class="tag ${k}">${badge[k]}</span></div>
          <div class="muted small">${esc(p.model || (k === 'claude' ? 'model you pick in the chat' : ''))}</div></div>
        <div class="kstate ${esc(p.key?.kind || '')}">${esc(p.key?.text || '')}</div>
        <div class="order"><button class="icon-btn" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button><button class="icon-btn" data-down="${i}" ${i === list.length - 1 ? 'disabled' : ''}>↓</button></div>
        <button class="btn small" data-edit="${i}" ${k === 'claude' ? 'disabled title="Uses your Claude login"' : ''}>${p.key?.kind === 'missing' ? 'Add key' : 'Edit'}</button>
      </li>`;
    }).join('')}</ul>
    <div class="sheet-foot"><span class="muted small">Saved in ${esc(configPath)} on this computer.</span><span class="spacer"></span>
      <button class="btn" data-close>Cancel</button><button class="btn primary" data-save ${dirty ? '' : 'disabled'}>Save</button></div>
  </div>`;
  root.querySelectorAll('[data-close]').forEach((b) => { b.onclick = close; });
  root.querySelectorAll('[data-menu]').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); const m = b.nextElementSibling; root.querySelectorAll('.menu-list').forEach((x) => { if (x !== m) x.hidden = true; }); m.hidden = !m.hidden; };
  });
  root.querySelector('.sheet').addEventListener('click', () => root.querySelectorAll('.menu-list').forEach((x) => { x.hidden = true; }));
  root.querySelectorAll('[data-api]').forEach((b) => { b.onclick = () => { const t = API_PRESETS[b.dataset.api]; editProvider(-1, { name: uniqueName(t.name), type: t.type, baseUrl: t.baseUrl, model: t.model || '', maxTokens: 16000 }); }; });
  root.querySelectorAll('[data-local]').forEach((b) => {
    b.onclick = () => {
      const t = LOCAL_PRESETS[b.dataset.local];
      const existing = list.findIndex((p) => p.baseUrl === t.baseUrl);
      if (existing >= 0) return editProvider(existing);
      editProvider(-1, { name: uniqueName(t.name), type: 'openai', baseUrl: t.baseUrl, model: 'auto', local: true, maxTokens: 8192 });
    };
  });
  root.querySelectorAll('[data-on]').forEach((c) => { c.onchange = () => { list[c.dataset.on].enabled = c.checked; dirty = true; renderList(); }; });
  root.querySelectorAll('[data-up]').forEach((b) => { b.onclick = () => move(+b.dataset.up, -1); });
  root.querySelectorAll('[data-down]').forEach((b) => { b.onclick = () => move(+b.dataset.down, 1); });
  root.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => editProvider(+b.dataset.edit); });
  root.querySelector('[data-save]').onclick = save;
}
function move(i, d) {
  const j = i + d;
  [list[i], list[j]] = [list[j], list[i]];
  dirty = true;
  renderList();
}
function uniqueName(base) {
  let n = base, i = 2;
  while (list.some((p) => p.name === n)) n = `${base}-${i++}`;
  return n;
}

function editProvider(index, draft) {
  const p = draft || { ...list[index] };
  const isNew = index < 0;
  const hasKey = !isNew && ['ok'].includes(p.key?.kind) && !p.local;
  const root = el();
  root.innerHTML = `<div class="sheet">
    <div class="sheet-head"><h2>${isNew ? (p.local ? 'Add local AI' : 'Add API') : `Edit ${esc(p.name)}`}</h2><button class="icon-btn" data-back title="Back">✕</button></div>
    <form class="pform" autocomplete="off">
      <label>Name<input name="name" value="${esc(p.name)}" required pattern="[a-z0-9][a-z0-9_\\-]{0,31}" title="lowercase letters, digits, - or _"></label>
      <label>API type<select name="type">
        <option value="openai" ${p.type !== 'anthropic' ? 'selected' : ''}>OpenAI-compatible (most providers, Ollama, LM Studio)</option>
        <option value="anthropic" ${p.type === 'anthropic' ? 'selected' : ''}>Anthropic-compatible</option></select></label>
      <label class="wide">Base URL<input name="baseUrl" value="${esc(p.baseUrl || '')}" placeholder="https://api.example.com/v1" required></label>
      <label class="wide">API key${p.key?.text && !isNew ? ` <span class="muted small">(now: ${esc(p.key.text)})</span>` : ''}
        <input name="newKey" type="password" placeholder="${hasKey ? 'Leave empty to keep the current key' : p.local ? 'Usually not needed for local servers' : 'Paste the key'}"></label>
      <div class="checks wide">
        <label class="check"><input type="checkbox" name="local" ${p.local ? 'checked' : ''}> Runs on this computer</label>
        <label class="check"><input type="checkbox" name="keyless" ${p.keyless ? 'checked' : ''}> No key needed</label>
        ${hasKey ? '<label class="check"><input type="checkbox" name="clearKey"> Remove the saved key</label>' : ''}
      </div>
      <label class="wide">Model
        <span class="with-btn"><input name="model" list="modelList" value="${esc(p.model || '')}" placeholder="model id, or auto for local servers"><button type="button" class="btn" data-test>Test &amp; list models</button></span>
        <datalist id="modelList"></datalist></label>
      <div class="test-out wide muted small"></div>
      <label>Model for quick background tasks <span class="muted small">(optional)</span><input name="smallModel" list="modelList" value="${esc(p.smallModel || '')}"></label>
      <label>Max output tokens<input name="maxTokens" type="number" min="256" value="${esc(p.maxTokens || '')}" placeholder="8192"></label>
      <label>Context window <span class="muted small">(tokens, optional)</span><input name="contextWindow" type="number" min="1000" value="${esc(p.contextWindow || '')}"></label>
    </form>
    <div class="sheet-foot">${isNew ? '' : '<button class="btn danger-text" data-del>Delete</button>'}<span class="spacer"></span>
      <button class="btn" data-back>Cancel</button><button class="btn primary" data-ok>${isNew ? 'Add' : 'Done'}</button></div>
  </div>`;
  const form = root.querySelector('form');
  const read = () => {
    const f = Object.fromEntries(new FormData(form));
    return {
      ...p, name: f.name.trim().toLowerCase(), type: f.type, baseUrl: f.baseUrl.trim(), model: f.model.trim(), smallModel: f.smallModel.trim(),
      maxTokens: f.maxTokens, contextWindow: f.contextWindow, local: !!f.local, keyless: !!f.keyless,
      newKey: f.newKey || p.newKey || '', clearKey: !!f.clearKey,
    };
  };
  root.querySelectorAll('[data-back]').forEach((b) => { b.onclick = renderList; });
  root.querySelector('[data-test]').onclick = async () => {
    const out = root.querySelector('.test-out');
    out.textContent = 'Testing…';
    const r = await api('/api/providers/test', { method: 'POST', body: read() }).catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) { out.innerHTML = `<span class="error-text">✕ ${esc(r.error)}</span>`; return; }
    root.querySelector('#modelList').innerHTML = r.models.map((m) => `<option value="${esc(m)}">`).join('');
    out.innerHTML = `<span class="ok-text">✓ Connected.</span> ${r.models.length ? `${r.models.length} models found: pick one in the Model field.` : 'No model list returned; type the model id.'}`;
  };
  root.querySelector('[data-del]')?.addEventListener('click', () => {
    if (!confirm(`Delete ${p.name}?`)) return;
    list.splice(index, 1);
    dirty = true;
    renderList();
  });
  root.querySelector('[data-ok]').onclick = () => {
    if (!form.reportValidity()) return;
    const v = read();
    if (!v.model && v.type === 'openai') { alert('Enter a model (or "auto" for a local server).'); return; }
    if (list.some((x, i) => x.name === v.name && i !== index)) { alert(`There is already a provider named ${v.name}.`); return; }
    v.key = { kind: v.newKey ? 'ok' : v.clearKey ? 'missing' : p.key?.kind, text: v.newKey ? 'new key (not saved yet)' : v.clearKey ? 'key will be removed' : p.key?.text };
    if (isNew) list.splice(list.findIndex((x) => x.local) >= 0 && !v.local ? list.findIndex((x) => x.local) : list.length, 0, v);
    else list[index] = v;
    dirty = true;
    renderList();
  };
  form.querySelector(isNew ? '[name=name]' : '[name=newKey]').focus();
}

async function save() {
  const btn = el().querySelector('[data-save]');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const data = await api('/api/providers', { method: 'POST', body: { providers: list } });
    list = data.providers.map((p) => ({ ...p, originalName: p.name }));
    dirty = false;
    renderList();
    refreshStatus();
  } catch (e) {
    alert(e.message);
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}
