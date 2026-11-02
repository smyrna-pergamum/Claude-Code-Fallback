// Browser control for both agents: the bundled Playwright MCP server drives a real browser window
// (Chrome if installed, otherwise Edge) with CC Desk's own profile, never the user's.
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const HOME = join(homedir(), '.cc-desk');
export const SERVER = 'browser';

// Looking and navigating run without asking; anything that acts on a page asks first.
export const AUTO_TOOLS = [
  'browser_snapshot', 'browser_take_screenshot', 'browser_console_messages', 'browser_network_requests', 'browser_network_request',
  'browser_find', 'browser_wait_for', 'browser_navigate', 'browser_navigate_back', 'browser_tabs', 'browser_resize', 'browser_hover', 'browser_close',
];
export const ASK_TOOLS = [
  'browser_click', 'browser_type', 'browser_fill_form', 'browser_select_option', 'browser_press_key', 'browser_drag', 'browser_drop',
  'browser_file_upload', 'browser_handle_dialog', 'browser_evaluate', 'browser_run_code_unsafe', 'browser_emulate_media',
];

function channel() {
  if (process.platform !== 'win32') return 'chrome';
  const chrome = ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA']
    .map((v) => process.env[v] && join(process.env[v], 'Google', 'Chrome', 'Application', 'chrome.exe'));
  return chrome.some((p) => p && existsSync(p)) ? 'chrome' : 'msedge'; // Edge ships with Windows
}

/** How to start the MCP server: { command, args, env }, or null if it isn't bundled. */
export function browserServer() {
  let cli;
  // The package exports only package.json and its index, so find cli.js next to package.json.
  try { cli = join(dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js'); } catch { return null; }
  if (!existsSync(cli)) return null;
  const profile = join(HOME, 'browser-profile');
  const output = join(HOME, 'browser-output');
  mkdirSync(profile, { recursive: true });
  mkdirSync(output, { recursive: true });
  // Inside Electron its own binary runs as Node, so the installed app needs no Node.
  const env = process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {};
  return {
    command: process.execPath,
    args: [cli, '--browser', channel(), '--user-data-dir', profile, '--output-dir', output],
    env,
  };
}

/** Claude Code (Agent SDK) options: the MCP server and the tools it may use without asking. */
export function claudeBrowserOptions() {
  const s = browserServer();
  if (!s) return {};
  return {
    mcpServers: { [SERVER]: { type: 'stdio', command: s.command, args: s.args, env: { ...process.env, ...s.env } } },
    allowedTools: AUTO_TOOLS.map((t) => `mcp__${SERVER}__${t}`),
  };
}

/** OpenCode config: the MCP server, plus "ask" rules for its acting tools. */
export function opencodeBrowserConfig() {
  const s = browserServer();
  if (!s) return { mcp: {}, permission: {} };
  return {
    mcp: { [SERVER]: { type: 'local', command: [s.command, ...s.args], environment: s.env, enabled: true } },
    permission: Object.fromEntries(ASK_TOOLS.map((t) => [`${SERVER}_${t}`, 'ask'])),
  };
}
