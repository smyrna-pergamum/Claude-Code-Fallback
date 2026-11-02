// Finds, checks and starts the cc-fallback proxy the app sends Claude Code through.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function proxyBase() {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(join(homedir(), '.cc-fallback', 'config.json'), 'utf8')); } catch { /* defaults */ }
  return `http://${cfg.host || '127.0.0.1'}:${cfg.port || 3456}`;
}

/**
 * cc-fallback's CLI script: $CC_FALLBACK_BIN, the copy bundled with the installed app, this
 * repository (desk/ lives inside it), or the global npm install.
 */
export function findCli() {
  const candidates = [
    process.env.CC_FALLBACK_BIN,
    process.resourcesPath && join(process.resourcesPath, 'cc-fallback', 'bin', 'cc-fallback.js'),
    join(here, '..', '..', 'bin', 'cc-fallback.js'),
    process.env.APPDATA && join(process.env.APPDATA, 'npm', 'node_modules', 'cc-fallback', 'bin', 'cc-fallback.js'),
    join(homedir(), '.npm-global', 'lib', 'node_modules', 'cc-fallback', 'bin', 'cc-fallback.js'),
    '/usr/local/lib/node_modules/cc-fallback/bin/cc-fallback.js',
  ];
  return candidates.find((p) => p && existsSync(p)) || null;
}

export async function isUp(base = proxyBase()) {
  try { return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}

/** Starts the proxy in the background if it is not running. Returns true when it is up. */
export async function ensureProxy(base = proxyBase()) {
  if (await isUp(base)) return true;
  const cli = findCli();
  if (!cli) return false;
  // Inside Electron, its own binary runs as plain Node, so the installed app needs no Node.
  // Detached: the proxy keeps serving terminal sessions after the window closes.
  const electron = !!process.versions.electron;
  const node = process.env.CC_DESK_NODE || (electron ? process.execPath : 'node');
  spawn(node, [cli, 'start'], {
    detached: true, stdio: 'ignore', windowsHide: true,
    env: electron ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env,
  }).unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 300));
    if (await isUp(base)) return true;
  }
  return false;
}

export async function proxyStatus(base = proxyBase()) {
  try {
    const res = await fetch(`${base}/_fallback/status`, { signal: AbortSignal.timeout(2000) });
    return { up: true, ...(await res.json()) };
  } catch { return { up: false }; }
}

export async function proxyCommand(path, body, base = proxyBase()) {
  const res = await fetch(`${base}/_fallback/${path}`, { method: 'POST', body: JSON.stringify(body || {}) });
  return res.json();
}
