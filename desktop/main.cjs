// Coxpit Desktop — Electron shell that embeds the daemon and opens the board.
// The daemon runs on Electron's node (ELECTRON_RUN_AS_NODE) from bundled sources;
// native deps (libsql, node-pty) are N-API prebuilds, so no ABI rebuilds needed.
const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

const PORT = Number(process.env.COXPIT_PORT || 8321);
let daemon = null;
let win = null;

function daemonRoot() {
  // packaged: resources/daemon ; dev: repo root (this file lives in <root>/desktop)
  return app.isPackaged ? path.join(process.resourcesPath, 'daemon') : path.join(__dirname, '..');
}

function startDaemon() {
  const root = daemonRoot();
  daemon = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'index.ts')], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      COXPIT_HOST: '127.0.0.1',
      COXPIT_PORT: String(PORT),
      COXPIT_DB: path.join(app.getPath('userData'), 'coxpit.db'),
      // 데스크톱 = 로컬 앱: 루프백 전용 바인드라 내부 인증은 끈다.
      COXPIT_AUTH_DISABLED: '1',
    },
    stdio: 'ignore',
  });
  daemon.on('exit', (code) => {
    daemon = null;
    if (win && !win.isDestroyed()) {
      win.loadURL('data:text/html,<body style="background:%230b0d12;color:%23e25b67;font-family:monospace;padding:40px">coxpit daemon exited (code ' + code + '). Restart the app.</body>');
    }
  });
}

function waitHealth(tries = 60) {
  return new Promise((resolve, reject) => {
    const tick = (n) => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 900 }, (res) => {
        res.resume();
        res.statusCode === 200 ? resolve() : retry(n);
      });
      req.on('error', () => retry(n));
      req.on('timeout', () => { req.destroy(); retry(n); });
    };
    const retry = (n) => (n <= 0 ? reject(new Error('daemon did not come up')) : setTimeout(() => tick(n - 1), 500));
    tick(tries);
  });
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1480, height: 940,
    minWidth: 900, minHeight: 600,
    backgroundColor: '#0b0d12',
    title: 'Coxpit',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // 외부 링크는 시스템 브라우저로
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  try {
    await waitHealth();
    await win.loadURL('http://127.0.0.1:' + PORT + '/');
  } catch (e) {
    await win.loadURL('data:text/html,<body style="background:%230b0d12;color:%23e25b67;font-family:monospace;padding:40px">coxpit daemon failed to start: ' + String(e.message) + '</body>');
  }
}

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true; // 다음 종료 때 조용히 설치
    autoUpdater.on('error', () => { /* 오프라인 등 — 무해 */ });
    autoUpdater.checkForUpdates().catch(() => { /* ignore */ });
    // 이후 6시간마다 재확인
    setInterval(() => autoUpdater.checkForUpdates().catch(() => { /* ignore */ }), 6 * 60 * 60 * 1000);
  } catch { /* updater 미동봉 빌드 — skip */ }
}

app.whenReady().then(() => {
  startDaemon();
  createWindow();
  setupAutoUpdate();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (daemon) { try { daemon.kill(); } catch { /* gone */ } } });
