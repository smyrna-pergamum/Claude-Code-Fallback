// Browser control for both agents: the bundled Playwright MCP server drives a real browser window
// (Chrome if installed, otherwise Edge) with CC Desk's own profile, never the user's.
// CC Desk starts the window itself (with a DevTools port) and one Playwright MCP HTTP server
// attached to it, so the window and its tabs outlive each message; a browser launched by the MCP
// server per message would close, or lose its page, as soon as each reply ended.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer, connect } from 'node:net';
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

/** Chrome if installed, otherwise Edge (it ships with Windows). */
function browserExe() {
  const roots = ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'].map((v) => process.env[v]).filter(Boolean);
  const win = [
    ...roots.map((r) => join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    ...roots.map((r) => join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
  ];
  const mac = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  const linux = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return (process.platform === 'win32' ? win : process.platform === 'darwin' ? mac : linux).find((p) => existsSync(p)) || null;
}

let browser = null; // { proc, cdp }
const cdpAlive = async (cdp) => { try { return (await fetch(`${cdp}/json/version`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } };

/** Starts the browser window CC Desk owns (or reuses it); resolves to its DevTools endpoint. */
async function ensureBrowser() {
  if (browser && await cdpAlive(browser.cdp)) return browser.cdp;
  const exe = browserExe();
  if (!exe) throw new Error('Neither Chrome nor Edge was found.');
  const port = await freePort();
  const profile = join(HOME, 'browser-profile');
  mkdirSync(profile, { recursive: true });
  const proc = spawn(exe, [
    `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore', detached: false });
  browser = { proc, cdp: `http://127.0.0.1:${port}` };
  proc.on('exit', () => { if (browser?.proc === proc) browser = null; });
  for (let i = 0; i < 100; i++) {
    if (await cdpAlive(browser.cdp)) return browser.cdp;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('The browser did not start.');
}

function cliPath() {
  // The package exports only package.json and its index, so find cli.js next to package.json.
  try {
    const cli = join(dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');
    return existsSync(cli) ? cli : null;
  } catch { return null; }
}

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const portOpen = (port) => new Promise((resolve) => {
  const c = connect(port, '127.0.0.1', () => { c.destroy(); resolve(true); });
  c.on('error', () => resolve(false));
});

let server = null; // { proc, url, ready }

/**
 * Starts the browser window and the MCP server attached to it; resolves to the MCP URL, or null
 * if Playwright MCP isn't bundled. If the user closed the window, both are started again.
 */
export async function ensureBrowserServer() {
  if (server && !(browser && await cdpAlive(browser.cdp))) stopBrowserServer(); // window was closed
  if (server) return server.ready;
  const cli = cliPath();
  if (!cli) return null;
  server = {};
  server.ready = (async () => {
    const cdp = await ensureBrowser();
    const port = await freePort();
    const output = join(HOME, 'browser-output');
    mkdirSync(output, { recursive: true });
    // Inside Electron its own binary runs as Node, so the installed app needs no Node.
    const env = { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
    server.proc = spawn(process.execPath, [
      cli, '--port', String(port), '--host', '127.0.0.1', '--shared-browser-context',
      '--cdp-endpoint', cdp, '--output-dir', output,
    ], { env, stdio: 'ignore', windowsHide: true });
    server.proc.on('exit', () => { server = null; });
    for (let i = 0; i < 100; i++) {
      if (await portOpen(port)) return `http://127.0.0.1:${port}/mcp`;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error('The browser server did not start.');
  })();
  server.ready.catch(() => { stopBrowserServer(); });
  return server.ready;
}

export function stopBrowserServer({ closeWindow = true } = {}) {
  server?.proc?.kill();
  server = null;
  if (closeWindow) { browser?.proc?.kill(); browser = null; }
}
process.on('exit', stopBrowserServer);

/** Claude Code (Agent SDK) options: the shared server and the tools it may use without asking. */
export function claudeBrowserOptions(url) {
  if (!url) return {};
  return {
    mcpServers: { [SERVER]: { type: 'http', url } },
    allowedTools: AUTO_TOOLS.map((t) => `mcp__${SERVER}__${t}`),
  };
}

/** OpenCode config: the shared server, plus "ask" rules for its acting tools. */
export function opencodeBrowserConfig(url) {
  if (!url) return { mcp: {}, permission: {} };
  return {
    mcp: { [SERVER]: { type: 'remote', url, enabled: true } },
    permission: Object.fromEntries(ASK_TOOLS.map((t) => [`${SERVER}_${t}`, 'ask'])),
  };
}
