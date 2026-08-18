// Coxpit Desktop — Electron shell that embeds the daemon and opens the board.
// The daemon runs on Electron's node (ELECTRON_RUN_AS_NODE) from bundled sources;
// native deps (libsql, node-pty) are N-API prebuilds, so no ABI rebuilds needed.
const { app, BrowserWindow, shell, Menu, dialog } = require('electron');
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

let updater = null;          // electron-updater autoUpdater (packaged 에서만)
let manualCheck = false;     // 메뉴에서 수동 확인 중이면 결과를 다이얼로그로 보여준다
let updateDownloaded = null; // 받아둔 버전

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    updater = autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true; // 다음 종료 때 조용히 설치

    autoUpdater.on('error', (e) => {
      if (manualCheck) { manualCheck = false; dialog.showMessageBox({ type: 'warning', message: 'Update check failed', detail: String(e && e.message || e) }); }
    });
    autoUpdater.on('update-not-available', () => {
      if (manualCheck) { manualCheck = false; dialog.showMessageBox({ type: 'info', message: 'You are up to date', detail: 'Coxpit ' + app.getVersion() + ' is the latest version.' }); }
    });
    autoUpdater.on('update-available', (info) => {
      if (manualCheck) dialog.showMessageBox({ type: 'info', message: 'Update available — downloading', detail: 'Coxpit ' + info.version + ' is downloading in the background.' });
    });
    autoUpdater.on('update-downloaded', async (info) => {
      updateDownloaded = info.version;
      if (!manualCheck) return; // 자동 경로는 조용히 — 종료 시 설치
      manualCheck = false;
      const { response } = await dialog.showMessageBox({
        type: 'info', message: 'Coxpit ' + info.version + ' is ready',
        detail: 'Restart now to apply the update, or it installs automatically when you quit.',
        buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
      });
      if (response === 0) autoUpdater.quitAndInstall();
    });

    autoUpdater.checkForUpdates().catch(() => { /* ignore */ });
    // 이후 6시간마다 재확인
    setInterval(() => autoUpdater.checkForUpdates().catch(() => { /* ignore */ }), 6 * 60 * 60 * 1000);
  } catch { /* updater 미동봉 빌드 — skip */ }
}

function checkForUpdatesManually() {
  if (!app.isPackaged || !updater) {
    dialog.showMessageBox({ type: 'info', message: 'Dev build', detail: 'Auto-update runs only in packaged builds.' });
    return;
  }
  if (updateDownloaded) {
    dialog.showMessageBox({
      type: 'info', message: 'Coxpit ' + updateDownloaded + ' is ready',
      detail: 'Restart now to apply the update.',
      buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
    }).then(({ response }) => { if (response === 0) updater.quitAndInstall(); });
    return;
  }
  manualCheck = true;
  updater.checkForUpdates().catch(() => { /* error handler shows dialog */ });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: checkForUpdatesManually },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    ...(!isMac ? [{
      label: 'Help',
      submenu: [{ label: 'Check for Updates…', click: checkForUpdatesManually }],
    }] : []),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  startDaemon();
  createWindow();
  setupAutoUpdate();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (daemon) { try { daemon.kill(); } catch { /* gone */ } } });
