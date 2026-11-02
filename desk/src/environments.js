// Environments, like Claude Code's: named sets of environment variables a chat runs with.
// "Local" (no extra variables) always exists. Values of secret-looking names never leave as-is.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const FILE = process.env.CC_DESK_ENVIRONMENTS || join(homedir(), '.cc-desk', 'environments.json');
const SECRET = /key|token|secret|password|passwd|credential|auth/i;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOCAL = { id: 'local', name: 'Local', vars: {} };

export async function loadEnvironments() {
  let list = [];
  try { list = JSON.parse(await readFile(FILE, 'utf8')); } catch { /* none yet */ }
  if (!Array.isArray(list)) list = [];
  return [LOCAL, ...list.filter((e) => e.id !== 'local')];
}

export const isSecret = (name) => SECRET.test(name);
const mask = (v) => (v.length > 8 ? `••••${v.slice(-4)}` : '••••');

/** For the UI: secret values are masked and marked so the editor can keep them unchanged. */
export async function environmentsForUi() {
  return (await loadEnvironments()).map((e) => ({
    id: e.id, name: e.name,
    vars: Object.entries(e.vars || {}).map(([name, value]) => (isSecret(name) ? { name, value: mask(value), secret: true } : { name, value })),
  }));
}

export async function environmentVars(id) {
  return (await loadEnvironments()).find((e) => e.id === id)?.vars || {};
}

/**
 * Saves the edited list. A secret entry sent back with `keep: true` keeps its stored value.
 * Returns the ids whose variables changed (their OpenCode servers must restart).
 */
export async function saveEnvironments(input) {
  const old = new Map((await loadEnvironments()).map((e) => [e.id, e]));
  const out = [];
  const changed = [];
  const names = new Set();
  for (const e of input) {
    if (e.id === 'local') continue;
    const name = String(e.name || '').trim();
    if (!name) throw new Error('Every environment needs a name.');
    if (names.has(name.toLowerCase()) || name.toLowerCase() === 'local') throw new Error(`There is already an environment named "${name}".`);
    names.add(name.toLowerCase());
    const prev = old.get(e.id);
    const vars = {};
    for (const v of e.vars || []) {
      const key = String(v.name || '').trim();
      if (!key) continue;
      if (!VAR_NAME.test(key)) throw new Error(`"${key}" is not a valid variable name (letters, digits and _; not starting with a digit).`);
      if (v.keep && prev?.vars?.[key] !== undefined) vars[key] = prev.vars[key];
      else vars[key] = String(v.value ?? '');
    }
    const id = prev ? e.id : randomUUID();
    if (!prev || JSON.stringify(prev.vars) !== JSON.stringify(vars)) changed.push(id);
    out.push({ id, name, vars });
  }
  for (const id of old.keys()) if (id !== 'local' && !out.some((e) => e.id === id)) changed.push(id);
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(out, null, 2) + '\n');
  return changed;
}
