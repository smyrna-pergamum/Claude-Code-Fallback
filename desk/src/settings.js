// Reads and edits cc-fallback's provider list (API keys, custom APIs, local models).
// The config file belongs to cc-fallback; we reuse its own loader so defaults and merging match.
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findCli, proxyCommand } from './fallback.js';

async function ccf() {
  const cli = findCli();
  if (!cli) throw new Error('cc-fallback was not found. Install it (npm install -g cc-fallback) or set CC_FALLBACK_BIN.');
  return import(pathToFileURL(join(dirname(cli), '..', 'src', 'config.js')).href);
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** How a provider gets its key, without ever revealing it. */
function keyInfo(p, resolveKey) {
  if (p.type === 'anthropic' && !p.apiKey) return { kind: 'login', text: 'Your Claude login' };
  if (p.local) return { kind: 'none', text: 'Local, no key needed' };
  const keys = [].concat(p.apiKey || []);
  if (!keys.length) return { kind: p.keyless ? 'none' : 'missing', text: p.keyless ? 'No key needed' : 'No key yet' };
  const parts = keys.map((k) => {
    if (typeof k === 'string' && k.startsWith('env:')) return `${k.slice(4)} ${resolveKey(k) ? '(set)' : '(not set)'}`;
    return `saved ••••${String(k).slice(-4)}`;
  });
  const usable = keys.some((k) => resolveKey(k));
  return { kind: usable ? 'ok' : (p.keyless ? 'none' : 'missing'), text: parts.join(', ') };
}

export async function getProviders() {
  const m = await ccf();
  const cfg = m.loadConfig();
  return {
    configPath: m.CONFIG_PATH,
    providers: cfg.providers.map((p) => {
      const { apiKey, ...rest } = p;
      return { ...rest, key: keyInfo(p, m.resolveKey), usable: m.isConfigured({ ...p, enabled: true }) };
    }),
  };
}

/**
 * Saves the edited, ordered list. Each entry may carry `newKey` (replaces the stored key with this
 * value), `clearKey` (removes it) and `originalName` (to find its stored key after a rename).
 */
export async function saveProviders(list) {
  const m = await ccf();
  const cfg = m.loadConfig();
  const old = new Map(cfg.providers.map((p) => [p.name, p]));
  const seen = new Set();
  const out = [];
  for (const e of list) {
    const name = String(e.name || '').trim().toLowerCase();
    if (!NAME.test(name)) throw new Error(`Invalid name "${e.name}": use lowercase letters, digits, - or _.`);
    if (seen.has(name)) throw new Error(`Two providers are named "${name}".`);
    seen.add(name);
    if (!['openai', 'anthropic'].includes(e.type)) throw new Error(`${name}: unknown type.`);
    if (!/^https?:\/\/\S+$/.test(e.baseUrl || '')) throw new Error(`${name}: the base URL must start with http:// or https://.`);
    const prev = old.get(e.originalName || name) || {};
    const p = { name, type: e.type, baseUrl: e.baseUrl.trim().replace(/\/$/, '') };
    for (const k of ['model', 'smallModel']) if (e[k]?.trim()) p[k] = e[k].trim();
    for (const k of ['maxTokens', 'contextWindow', 'maxConcurrent', 'cooldownMinutes']) if (Number(e[k]) > 0) p[k] = Number(e[k]);
    for (const k of ['local', 'keyless']) if (e[k]) p[k] = true;
    if (e.enabled === false) p.enabled = false;
    // Advanced fields the form does not show are kept as they were.
    for (const k of ['models', 'extraBody', 'headers', 'reasoningEffort', 'strictSchema', 'streamUsage']) if (prev[k] !== undefined) p[k] = prev[k];
    if (e.newKey?.trim()) p.apiKey = e.newKey.trim();
    else if (!e.clearKey && prev.apiKey !== undefined) p.apiKey = prev.apiKey;
    if (p.type === 'openai' && !p.model) throw new Error(`${name}: a model is required ("auto" picks an installed local model).`);
    out.push(p);
  }
  const { providers, ...rest } = cfg;
  await mkdir(dirname(m.CONFIG_PATH), { recursive: true });
  await writeFile(m.CONFIG_PATH, JSON.stringify({ ...rest, providers: out }, null, 2) + '\n');
  try { await proxyCommand('reload'); } catch { /* proxy not running: it reads the file when it starts */ }
  return getProviders();
}

/** Asks a provider for its model list, to check the URL/key and fill the model picker. */
export async function testProvider(e) {
  const m = await ccf();
  const prev = m.loadConfig().providers.find((p) => p.name === (e.originalName || e.name)) || {};
  const key = e.newKey?.trim() || (e.clearKey ? '' : [].concat(prev.apiKey || []).map(m.resolveKey).find(Boolean) || '');
  const base = String(e.baseUrl || '').trim().replace(/\/$/, '');
  if (!/^https?:\/\//.test(base)) return { ok: false, error: 'Enter a base URL first.' };
  if (base.includes('{env:')) return { ok: false, error: 'This URL uses an environment variable; test it from the terminal.' };
  const headers = {};
  if (e.type === 'anthropic') { if (key) headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; } else if (key) headers.authorization = `Bearer ${key}`;
  try {
    const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(8000) });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    let ids = [];
    try { ids = (JSON.parse(text).data || JSON.parse(text).models || []).map((x) => x.id || x.name).filter(Boolean); } catch { /* not JSON */ }
    return { ok: true, models: ids.slice(0, 300) };
  } catch (err) {
    return { ok: false, error: err.cause?.code === 'ECONNREFUSED' ? 'Nothing is listening at this address. Is the local server running?' : err.message };
  }
}
