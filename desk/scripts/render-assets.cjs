// Renders build/icon.png from build/icon.svg and takes the README screenshots with demo content.
// Run: npx electron scripts/render-assets.cjs
const { app, BrowserWindow, nativeTheme } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const shots = path.join(root, '..', 'docs', 'screenshots');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function renderIcon() {
  const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'), 'utf8');
  const win = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false, useContentSize: true });
  await win.loadURL(`data:text/html,${encodeURIComponent(`<style>html,body{margin:0;background:transparent}</style>${svg}`)}`);
  await wait(300);
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), img.resize({ width: 512, height: 512 }).toPNG());
  win.destroy();
}

const DEMO = `(() => {
  const d = window.ccDeskDemo;
  d.folder('C:\\\\Projects\\\\weather-app');
  d.sessions([
    ['Add an hourly forecast endpoint', 'just now · main'],
    ['Fix the flaky date test', '2 h ago · main'],
    ['Refactor the settings page', 'yesterday · ui-refresh'],
    ['Explain the caching layer', '3 days ago · main'],
    ['Set up GitHub Actions', 'last week · main'],
  ]);
  d.fillModels({ providers: [
    { name: 'gemini', type: 'openai', model: 'gemini-2.5-flash', configured: true },
    { name: 'kilo', type: 'openai', model: 'kilo-auto/free', configured: true },
  ] });
  d.status('Claude limit · back in 1 h 12 min · using gemini', 'warn');
  d.clearChat('Add an hourly forecast endpoint');
  const R = d.render;
  R({ type: 'user', text: 'Add an hourly forecast endpoint next to the daily one, with a test.' });
  R({ type: 'text', text: "I'll look at how the daily forecast is built first." });
  R({ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/routes/forecast.ts' } });
  R({ type: 'tool_result', id: 't1', text: 'export async function daily(req, res) { … }' });
  R({ type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'dailyForecast', path: 'src' } });
  R({ type: 'tool_result', id: 't2', text: 'src/services/weather.ts:41\\nsrc/routes/forecast.ts:12' });
  R({ type: 'text', text: '> ⚡ cc-fallback: gemini / gemini-2.5-flash\\n\\nThe daily route calls \`dailyForecast()\` and caches the result for 10 minutes. I added:\\n\\n- \`GET /forecast/hourly\` in \`src/routes/forecast.ts\`\\n- \`hourlyForecast()\` in \`src/services/weather.ts\`, using the same cache\\n- a test in \`test/forecast.test.ts\`' });
  R({ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm test -- forecast' } });
  R({ type: 'permission', id: 'p1', toolName: 'Bash', input: { command: 'npm test -- forecast', description: 'Run the forecast tests' }, canAlways: true });
  document.activeElement?.blur();
})()`;

async function screenshot(theme, file, after) {
  nativeTheme.themeSource = theme;
  const win = new BrowserWindow({ width: 1280, height: 800, show: false, useContentSize: true });
  await win.loadURL(`${globalThis.deskUrl}&demo=1`);
  await wait(1800);
  await win.webContents.executeJavaScript(DEMO);
  if (after) await win.webContents.executeJavaScript(after);
  await wait(900);
  // Never publish a local path: fail instead of writing a screenshot that shows one.
  const text = await win.webContents.executeJavaScript('document.body.innerText');
  if (/[A-Z]:\\Users\\|\/home\/|\/Users\//.test(text)) throw new Error(`${file}: a local path is visible`);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(shots, file), img.toPNG());
  win.destroy();
}

const SETTINGS = `(async () => {
  document.getElementById('settingsBtn').click();
  for (let i = 0; i < 300 && !document.querySelector('.prov-list li'); i++) await new Promise((r) => setTimeout(r, 100));
  if (!document.querySelector('.prov-list li')) throw new Error('settings did not load');
  const rows = [...document.querySelectorAll('.prov-list li')];
  const set = (name, text) => { const li = rows.find((r) => r.querySelector('b')?.textContent === name); if (li) { const k = li.querySelector('.kstate'); k.textContent = text; k.className = 'kstate ok'; li.querySelector('[data-edit]').textContent = 'Edit'; } };
  set('gemini', 'saved ••••7f2c');
  set('nvidia', 'saved ••••91ab');
  const foot = document.querySelector('.sheet-foot .muted');
  if (foot) foot.textContent = 'Saved in ~/.cc-fallback/config.json on this computer.';
})()`;

// Keep running between windows (Electron quits when the last window closes by default).
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  fs.mkdirSync(shots, { recursive: true });
  await renderIcon();
  const { startServer } = await import(pathToFileURL(path.join(root, 'src', 'server.js')).href);
  const { url, close } = await startServer({ quiet: true });
  globalThis.deskUrl = url;
  await screenshot('light', 'chat-light.png');
  await screenshot('dark', 'chat-dark.png');
  await screenshot('dark', 'settings.png', SETTINGS);
  close();
  console.log('icon and screenshots written');
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });
