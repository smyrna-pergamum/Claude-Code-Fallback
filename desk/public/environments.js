// Environments editor: named sets of environment variables, like Claude Code's environments.
import { api, esc } from './app.js';

const SECRET = /key|token|secret|password|passwd|credential|auth/i;
const el = () => document.getElementById('settings');
let list = [];
let selected = 0;
let onSaved = () => {};

export async function openEnvironments(currentId, saved) {
  onSaved = saved || (() => {});
  list = (await api('/api/environments')).map((e) => ({ ...e, vars: e.vars.map((v) => ({ ...v, keep: !!v.secret })) }));
  selected = Math.max(0, list.findIndex((e) => e.id === currentId));
  el().hidden = false;
  render();
}
function close() { el().hidden = true; el().innerHTML = ''; }

function render() {
  const env = list[selected];
  const local = env.id === 'local';
  el().innerHTML = `<div class="sheet envs">
    <div class="sheet-head"><h2>Environments</h2><button class="icon-btn" data-close title="Close">✕</button></div>
    <p class="muted">An environment is a set of variables a chat runs with (API keys, PATH additions, settings for your tools). Pick it next to the message box.</p>
    <div class="env-edit">
      <ul class="env-list">${list.map((e, i) => `<li class="${i === selected ? 'active' : ''}" data-i="${i}">${esc(e.name)}<span class="muted small">${e.vars.length ? ` · ${e.vars.length}` : ''}</span></li>`).join('')}
        <li class="add" data-add>＋ New environment</li></ul>
      <div class="env-form">
        ${local ? '<p class="muted">Local runs with this computer\'s own environment and nothing added. Create a new environment to add variables.</p>' : `
        <label>Name<input name="envName" value="${esc(env.name)}"></label>
        <div class="vars-head"><span>Variable</span><span>Value</span><span></span></div>
        <div class="vars">${env.vars.map((v, i) => `<div class="var-row" data-v="${i}">
          <input class="vn" value="${esc(v.name)}" placeholder="NAME" spellcheck="false">
          <input class="vv" type="${SECRET.test(v.name) ? 'password' : 'text'}" value="${v.keep ? '' : esc(v.value)}" placeholder="${v.keep ? `saved ${esc(v.value)} · type to replace` : 'value'}" spellcheck="false">
          <button class="icon-btn" data-del-var="${i}" title="Remove">✕</button></div>`).join('')}</div>
        <button class="btn small" data-add-var>＋ Add variable</button>
        <p class="muted small">Values of names with KEY, TOKEN, SECRET or PASSWORD are hidden after saving. Everything is stored on this computer only.</p>
        <div class="row-actions"><button class="btn danger-text" data-del-env>Delete environment</button></div>`}
      </div>
    </div>
    <div class="sheet-foot"><span class="spacer"></span><button class="btn" data-close>Cancel</button><button class="btn primary" data-save>Save</button></div>
  </div>`;
  const root = el();
  root.querySelectorAll('[data-close]').forEach((b) => { b.onclick = close; });
  root.querySelectorAll('.env-list [data-i]').forEach((li) => { li.onclick = () => { read(); selected = +li.dataset.i; render(); }; });
  root.querySelector('[data-add]').onclick = () => {
    read();
    let n = 'New environment', k = 2;
    while (list.some((e) => e.name === n)) n = `New environment ${k++}`;
    list.push({ id: `new-${Date.now()}`, name: n, vars: [] });
    selected = list.length - 1;
    render();
    root.querySelector('[name=envName]')?.select();
  };
  root.querySelector('[data-add-var]')?.addEventListener('click', () => { read(); env.vars.push({ name: '', value: '' }); render(); root.querySelector('.var-row:last-child .vn')?.focus(); });
  root.querySelectorAll('[data-del-var]').forEach((b) => { b.onclick = () => { read(); env.vars.splice(+b.dataset.delVar, 1); render(); }; });
  root.querySelector('[data-del-env]')?.addEventListener('click', () => {
    if (!confirm(`Delete the environment "${env.name}"?`)) return;
    list.splice(selected, 1);
    selected = 0;
    render();
  });
  root.querySelector('[data-save]').onclick = save;
}

/** Copies the form back into `list` (secret values left empty keep their saved value). */
function read() {
  const env = list[selected];
  const form = el().querySelector('.env-form');
  if (!form || env.id === 'local') return;
  env.name = form.querySelector('[name=envName]').value;
  env.vars = [...form.querySelectorAll('.var-row')].map((row, i) => {
    const prev = env.vars[i] || {};
    const name = row.querySelector('.vn').value.trim();
    const value = row.querySelector('.vv').value;
    return prev.keep && !value && name === prev.name ? { name, keep: true, value: prev.value } : { name, value };
  });
}

async function save() {
  read();
  try {
    const body = list.filter((e) => e.id !== 'local').map((e) => ({
      id: e.id, name: e.name, vars: e.vars.map((v) => (v.keep ? { name: v.name, keep: true } : { name: v.name, value: v.value })),
    }));
    const saved = await api('/api/environments', { method: 'POST', body: { environments: body } });
    const name = list[selected]?.name;
    close();
    onSaved(saved, saved.find((e) => e.name === name)?.id);
  } catch (e) { alert(e.message); }
}
