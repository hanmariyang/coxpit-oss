// Coxpit Desktop — Electron shell over the coxpit daemon.
// One daemon per machine: if a daemon already owns ~/.coxpit (npm/launchd install),
// attach to it instead of spawning a second one — two daemons on one DB would
// settle each other's live runs as orphans. Only when none is running do we embed
// our own (ELECTRON_RUN_AS_NODE; libsql/node-pty are N-API prebuilds, no rebuilds).
const { app, BrowserWindow, shell, Menu, dialog, ipcMain, safeStorage } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');

const EMBED_PORT = Number(process.env.COXPIT_PORT || 8321);
const DATA_DIR = path.join(os.homedir(), '.coxpit');
// 탈출용 격리 인스턴스 — 잠긴 데몬을 못 뚫을 때 별도 데이터 폴더로 자기 데몬을 띄운다(락·포트 충돌 0).
const PRIVATE_DIR = path.join(os.homedir(), '.coxpit-desktop');
const CRED_PATH = path.join(DATA_DIR, 'desktop-cred.bin');
let boardOrigin = { host: '127.0.0.1', port: EMBED_PORT }; // where the window points (embedded or attached)
let daemon = null;
let daemonDir = DATA_DIR;   // 현재 임베드 데몬의 데이터 폴더(기본 or 격리)
let win = null;
let restarting = false;     // 의도된 데몬 재시작 중 — exit 핸들러가 에러 페이지 대신 respawn 을 기다림

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 데몬이 락에 기록한 실제 포트 읽기(자동 포트 이동 후 실주소를 안다).
function readLockPort(dataDir) {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(dataDir, 'daemon.lock.json'), 'utf8'));
    return Number.isInteger(lock.port) && Number.isInteger(lock.pid) ? { pid: lock.pid, port: lock.port } : null;
  } catch { return null; }
}
// 스폰한 데몬이 락에 자기 포트를 쓸 때까지 폴링 → 실제 포트 반환(자기 pid 확인으로 stale 락 무시).
async function awaitDaemonPort(dataDir, childPid, tries = 80) {
  for (let i = 0; i < tries; i++) {
    const lk = readLockPort(dataDir);
    if (lk && lk.pid === childPid) return lk.port;
    await sleep(150);
  }
  return null;
}

// 자격 증명 저장(safeStorage=OS 키체인) — 매번 사인인 방지.
function saveCred(user, pass) {
  try { if (safeStorage.isEncryptionAvailable()) fs.writeFileSync(CRED_PATH, safeStorage.encryptString(JSON.stringify({ user, pass }))); } catch { /* */ }
}
function loadCred() {
  try { if (safeStorage.isEncryptionAvailable() && fs.existsSync(CRED_PATH)) return JSON.parse(safeStorage.decryptString(fs.readFileSync(CRED_PATH))); } catch { /* */ }
  return null;
}
function clearCred() { try { fs.unlinkSync(CRED_PATH); } catch { /* */ } }

// v3.2 이하 데스크톱은 DB 를 Electron userData 에 뒀다 — 공유 기본 경로로 1회 이관.
function migrateLegacyDb() {
  const oldDb = path.join(app.getPath('userData'), 'coxpit.db');
  const newDb = path.join(DATA_DIR, 'coxpit.db');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(oldDb) && !fs.existsSync(newDb)) {
      fs.copyFileSync(oldDb, newDb);
      fs.renameSync(oldDb, oldDb + '.migrated');
    }
  } catch (e) {
    console.error('[coxpit] legacy DB migration failed:', e);
  }
}

function probeHealth(host, port, timeout = 1200) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/api/health', timeout }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(res.statusCode === 200 && JSON.parse(body).name === 'coxpit'); }
        catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// 이미 도는 데몬 찾기: ~/.coxpit 의 락 파일 → 없으면 표준 포트 8210(레거시 cwd-DB 데몬 대비).
async function findRunningDaemon() {
  const candidates = [];
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'daemon.lock.json'), 'utf8'));
    if (Number.isInteger(lock.port)) {
      candidates.push({ host: lock.host === '0.0.0.0' || !lock.host ? '127.0.0.1' : lock.host, port: lock.port });
    }
  } catch { /* no lock */ }
  candidates.push({ host: '127.0.0.1', port: 8210 });
  for (const c of candidates) {
    if (await probeHealth(c.host, c.port)) return c;
  }
  return null;
}

// 붙은 데몬이 basic auth 를 걸어둔 경우(원격 노출 대비 설정) — 자격 증명 프롬프트.
let authPrompt = null;
let authCallbacks = [];
function promptBasicAuth(callback) {
  authCallbacks.push(callback);
  if (authPrompt && !authPrompt.isDestroyed()) return;
  authPrompt = new BrowserWindow({
    width: 380, height: 240, parent: win ?? undefined, modal: true,
    resizable: false, minimizable: false, maximizable: false,
    backgroundColor: '#0b0d12', title: 'Coxpit — sign in',
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload-auth.cjs') },
  });
  authPrompt.setMenuBarVisibility(false);
  authPrompt.setContentSize(380, 300);
  const page = `<body style="background:#0b0d12;color:#dbe2ea;font:13px/1.5 -apple-system,system-ui,sans-serif;padding:24px;margin:0">
    <div style="margin-bottom:4px;font-weight:600">Sign in</div>
    <div style="margin-bottom:14px;color:#8b93a1">The coxpit daemon on :${boardOrigin.port} has an access key set. Enter it, or run your own local one.</div>
    <input id=u placeholder="user (default: admin)" style="display:block;width:100%;box-sizing:border-box;margin-bottom:8px;padding:8px 10px;background:#141822;border:1px solid #2a3140;color:#dbe2ea;border-radius:6px;outline:none">
    <input id=p type=password placeholder="access key" style="display:block;width:100%;box-sizing:border-box;margin-bottom:14px;padding:8px 10px;background:#141822;border:1px solid #2a3140;color:#dbe2ea;border-radius:6px;outline:none">
    <button id=go style="width:100%;padding:9px;background:#4ec9b0;border:0;color:#06231d;font-weight:600;border-radius:6px;cursor:pointer">Sign in</button>
    <button id=loc style="width:100%;margin-top:8px;padding:9px;background:transparent;border:1px solid #2a3140;color:#8b93a1;border-radius:6px;cursor:pointer">Use my own local daemon</button>
    <script>
      const send=()=>coxpitAuth.submit(document.getElementById('u').value||'admin',document.getElementById('p').value);
      document.getElementById('go').onclick=send;
      document.getElementById('loc').onclick=()=>coxpitAuth.useLocal();
      document.getElementById('p').addEventListener('keydown',e=>{if(e.key==='Enter')send()});
      document.getElementById('u').focus();
    </script></body>`;
  authPrompt.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
  authPrompt.on('closed', () => {
    authPrompt = null;
    const pending = authCallbacks; authCallbacks = [];
    for (const cb of pending) cb(); // cancelled — let the 401 page show
  });
}
ipcMain.on('coxpit-auth-submit', (_e, { user, pass }) => {
  saveCred(user, pass);   // OS 키체인에 기억 — 다음 실행부터 자동 시도
  const pending = authCallbacks; authCallbacks = [];
  for (const cb of pending) cb(user, pass);
  if (authPrompt && !authPrompt.isDestroyed()) { authPrompt.removeAllListeners('closed'); authPrompt.close(); authPrompt = null; }
});
ipcMain.on('coxpit-auth-cancel', () => {
  if (authPrompt && !authPrompt.isDestroyed()) authPrompt.close();
});
ipcMain.on('coxpit-use-local', () => {
  const pending = authCallbacks; authCallbacks = [];
  for (const cb of pending) cb();   // 이 요청 인증은 취소(격리 데몬으로 갈아탐)
  if (authPrompt && !authPrompt.isDestroyed()) { authPrompt.removeAllListeners('closed'); authPrompt.close(); authPrompt = null; }
  startPrivateDaemon();
});
let authTries = 0;
app.on('login', (event, _wc, _req, _authInfo, callback) => {
  event.preventDefault();
  authTries++;
  if (authTries === 1) { const c = loadCred(); if (c) { callback(c.user, c.pass); return; } }  // 기억한 키 먼저
  else { clearCred(); }   // 저장한 키가 틀렸다 → 지우고 물어본다
  promptBasicAuth(callback);
});

function daemonRoot() {
  // packaged: resources/daemon ; dev: repo root (this file lives in <root>/desktop)
  return app.isPackaged ? path.join(process.resourcesPath, 'daemon') : path.join(__dirname, '..');
}

// 데몬 스폰 — COXPIT_PORT 는 선호값(점유 시 데몬이 자동으로 빈 포트로 이동). 실제 포트는 락에서 읽는다.
function spawnDaemon({ dataDir, preferPort }) {
  const root = daemonRoot();
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'index.ts')], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      COXPIT_HOST: '127.0.0.1',
      COXPIT_PORT: String(preferPort),
      COXPIT_DB: path.join(dataDir, 'coxpit.db'),
      // 데스크톱 = 로컬 앱: 루프백 전용 바인드라 내부 인증은 끈다.
      COXPIT_AUTH_DISABLED: '1',
    },
    stdio: 'ignore',
  });
  child.on('exit', (code) => {
    daemon = null;
    if (restarting) return; // 의도된 재시작 — 에러 페이지 대신 respawn 이 이어진다
    if (win && !win.isDestroyed()) {
      win.loadURL('data:text/html,<body style="background:%230b0d12;color:%23e25b67;font-family:monospace;padding:40px">coxpit daemon exited (code ' + code + '). Restart the app.</body>');
    }
  });
  return child;
}

// 기본 임베드 데몬 기동 + 실제 포트 read-back → boardOrigin 갱신(선호 포트 점유돼도 안전).
async function startDaemon() {
  daemonDir = DATA_DIR;
  daemon = spawnDaemon({ dataDir: DATA_DIR, preferPort: EMBED_PORT });
  const port = await awaitDaemonPort(DATA_DIR, daemon.pid);
  boardOrigin = { host: '127.0.0.1', port: port ?? EMBED_PORT };
}

// 탈출구 — 잠긴 데몬을 못 뚫을 때: 별도 데이터 폴더(격리) + 인증 없음 + 자동 포트로 자기 데몬을 띄우고
// 창을 거기로. 락·포트 충돌이 구조적으로 불가(다른 폴더). 빈 워크스페이스로 시작된다.
async function startPrivateDaemon() {
  restarting = true;
  if (daemon) { try { daemon.kill(); } catch { /* gone */ } daemon = null; }
  try { fs.mkdirSync(PRIVATE_DIR, { recursive: true }); } catch { /* */ }
  await sleep(300);
  daemonDir = PRIVATE_DIR;
  daemon = spawnDaemon({ dataDir: PRIVATE_DIR, preferPort: EMBED_PORT });
  const port = await awaitDaemonPort(PRIVATE_DIR, daemon.pid) ?? EMBED_PORT;
  boardOrigin = { host: '127.0.0.1', port };
  restarting = false;
  if (win && !win.isDestroyed()) {
    try { await waitHealth(); await win.loadURL('http://127.0.0.1:' + port + '/'); win.setTitle('Coxpit — private local'); }
    catch (e) { /* exit handler surfaces failure */ }
  }
}

function restartEmbeddedDaemon() {
  if (!daemon) {
    dialog.showMessageBox({
      type: 'info', message: 'Attached to an external daemon',
      detail: 'This window is attached to the daemon at http://' + boardOrigin.host + ':' + boardOrigin.port + '/ — restart it where it runs (service manager / CLI).',
    });
    return;
  }
  restarting = true;
  const dir = daemonDir;
  try { daemon.kill(); } catch { /* gone */ }
  setTimeout(async () => {
    daemon = spawnDaemon({ dataDir: dir, preferPort: EMBED_PORT });
    const port = await awaitDaemonPort(dir, daemon.pid) ?? boardOrigin.port;
    boardOrigin = { host: '127.0.0.1', port };
    restarting = false;
    try {
      await waitHealth();
      if (win && !win.isDestroyed()) await win.loadURL('http://127.0.0.1:' + port + '/');
    } catch { /* error page will show via exit handler on next failure */ }
  }, 600);
}

function showDaemonInfo() {
  dialog.showMessageBox({
    type: 'info', message: 'Coxpit daemon',
    detail: (daemon ? 'mode: embedded (runs inside this app)\ndata: ~/.coxpit' : 'mode: attached (external daemon on this machine)')
      + '\nurl: http://' + boardOrigin.host + ':' + boardOrigin.port + '/',
  });
}

function waitHealth(tries = 60) {
  return new Promise((resolve, reject) => {
    const tick = (n) => {
      const req = http.get({ host: boardOrigin.host, port: boardOrigin.port, path: '/api/health', timeout: 900 }, (res) => {
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
  // 페이지 <title> 대신 attach 상태를 창 제목으로 유지
  const winTitle = daemon ? 'Coxpit' : 'Coxpit — attached to :' + boardOrigin.port;
  win.webContents.on('page-title-updated', (e) => { e.preventDefault(); win.setTitle(winTitle); });
  win.setTitle(winTitle);
  try {
    await waitHealth();
    await win.loadURL('http://' + boardOrigin.host + ':' + boardOrigin.port + '/');
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
        { label: 'Daemon Info…', click: showDaemonInfo },
        { label: 'Restart Daemon', click: restartEmbeddedDaemon },
        { label: 'Start Private Local Daemon…', click: startPrivateDaemon },
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
      submenu: [
        { label: 'Check for Updates…', click: checkForUpdatesManually },
        { label: 'Daemon Info…', click: showDaemonInfo },
        { label: 'Restart Daemon', click: restartEmbeddedDaemon },
        { label: 'Start Private Local Daemon…', click: startPrivateDaemon },
      ],
    }] : []),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  buildMenu();
  migrateLegacyDb();
  const running = await findRunningDaemon();
  if (running) {
    boardOrigin = running; // attach — the machine's daemon is the single source of truth
  } else {
    await startDaemon();
  }
  createWindow();
  setupAutoUpdate();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (daemon) { try { daemon.kill(); } catch { /* gone */ } } });
