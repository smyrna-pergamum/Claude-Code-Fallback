// Claude login for the app: checks it with the Claude Code binary that ships with the Agent SDK,
// and opens that binary's own login in a console window, so no separate install is needed.
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { childEnv } from './runs.js';

const require = createRequire(import.meta.url);

export function claudeBinary() {
  try {
    const pkg = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    const bin = join(dirname(pkg), process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (existsSync(bin)) return bin;
  } catch { /* platform package missing */ }
  return process.platform === 'win32' ? 'claude.cmd' : 'claude';
}

export function authStatus() {
  return new Promise((resolve) => {
    execFile(claudeBinary(), ['auth', 'status'], { env: childEnv(''), timeout: 20000, windowsHide: true }, (err, stdout) => {
      try {
        const s = JSON.parse(stdout);
        resolve({ loggedIn: !!s.loggedIn, method: s.authMethod || null });
      } catch {
        resolve({ loggedIn: false, error: err?.message || 'Could not read the login status' });
      }
    });
  });
}

/** Opens Claude's browser login in a new console window (it may ask to paste a code there). */
export function startLogin() {
  const bin = claudeBinary();
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', `start "Claude login" "${bin}" auth login`], {
      detached: true, stdio: 'ignore', windowsVerbatimArguments: true, env: childEnv(''),
    }).unref();
    return { started: true };
  }
  return { started: false, command: `${bin} auth login` };
}
