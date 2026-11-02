// Electron shell: starts the local server in-process and shows it in a window.
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

if (!app.requestSingleInstanceLock()) app.quit();

let win;
async function createWindow() {
  const { startServer } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'server.js')).href);
  const { url } = await startServer({ quiet: true });
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 760, minHeight: 520, title: 'CC Desk', autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'public', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  // Links open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => { if (!target.startsWith(url.split('?')[0])) e.preventDefault(); });
  await win.loadURL(url);
}

ipcMain.handle('pick-folder', async (_e, current) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: current || undefined });
  return r.canceled ? null : r.filePaths[0];
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(createWindow).catch((e) => { dialog.showErrorBox('CC Desk', e.stack || String(e)); app.quit(); });
app.on('window-all-closed', () => app.quit());
