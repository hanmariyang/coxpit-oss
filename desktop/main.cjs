// Coxpit Desktop — Electron shell over the coxpit daemon.
// One daemon per machine: if a daemon already owns ~/.coxpit (npm/launchd install),
// attach to it instead of spawning a second one — two daemons on one DB would
// settle each other's live runs as orphans. Only when none is running do we embed
// our own (ELECTRON_RUN_AS_NODE; libsql/node-pty are N-API prebuilds, no rebuilds).
const { app, BrowserWindow, shell, Menu, dialog, ipcMain, safeStorage, globalShortcut, screen } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');

const EMBED_PORT = Number(process.env.COXPIT_PORT || 8321);
// 데스크톱 앱의 기본 진입 = 터미널 우선 셸(cockpit). 보드는 앱 안에서 "← Board" 로 오갈 수 있고, 웹 `/` 는 그대로 보드.
// 좁은/터치 화면은 cockpit 이 스스로 보드(`/`)로 리다이렉트하므로 모바일은 자동으로 보드에 남는다.
const ENTRY_PATH = process.env.COXPIT_ENTRY || '/cockpit';
const DATA_DIR = path.join(os.homedir(), '.coxpit');
// 탈출용 격리 인스턴스 — 잠긴 데몬을 못 뚫을 때 별도 데이터 폴더로 자기 데몬을 띄운다(락·포트 충돌 0).
const PRIVATE_DIR = path.join(os.homedir(), '.coxpit-desktop');
const CRED_PATH = path.join(DATA_DIR, 'desktop-cred.bin');
let boardOrigin = { host: '127.0.0.1', port: EMBED_PORT }; // where the window points (embedded or attached)
let daemon = null;
let daemonDir = DATA_DIR;   // 현재 임베드 데몬의 데이터 폴더(기본 or 격리)
let win = null;
let restarting = false;     // 의도된 데몬 재시작 중 — exit 핸들러가 에러 페이지 대신 respawn 을 기다림
let hud = null;             // v5.28 K — 떠 있는 작은 창(HUD). 본 창과 **수명이 다르다**.

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
    try { await waitHealth(); await win.loadURL('http://127.0.0.1:' + port + ENTRY_PATH); win.setTitle('Coxpit — private local'); }
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
      if (win && !win.isDestroyed()) await win.loadURL('http://127.0.0.1:' + port + ENTRY_PATH);
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
  win.on('closed', () => { win = null; });   // HUD 가 남아 있어도 본 창을 다시 열 수 있게 참조를 비운다
  // 외부 링크는 시스템 브라우저로
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  // 페이지 <title> 대신 attach 상태를 창 제목으로 유지
  const winTitle = daemon ? 'Coxpit' : 'Coxpit — attached to :' + boardOrigin.port;
  win.webContents.on('page-title-updated', (e) => { e.preventDefault(); win.setTitle(winTitle); });
  win.setTitle(winTitle);
  try {
    await waitHealth();
    await win.loadURL('http://' + boardOrigin.host + ':' + boardOrigin.port + ENTRY_PATH);
  } catch (e) {
    await win.loadURL('data:text/html,<body style="background:%230b0d12;color:%23e25b67;font-family:monospace;padding:40px">coxpit daemon failed to start: ' + String(e.message) + '</body>');
  }
}

// ══ v5.28 Part K — 데스크톱 HUD: 이미 있는 `/hud` 한 장에 **집을 준다** ═══════════
// 작고, 늘 위에 있고, 단축키로 부르고, 알약 → 목록 → 상세로 자라고, 둔 자리를 기억하고,
// **절대 내 포커스를 뺏지 않는다**. 페이지는 K3~K7 에서 이미 다 만들어졌다 — 여기서는 창만 만든다.
//
// 이 창이 본 창과 다른 점 셋:
//   ① 본 창을 닫아도 **산다**(종료 게이트가 둘 다 없을 때만 내려간다).
//   ② 프레임·그림자가 없다 — 투명 창에 OS 가 덧그리는 네모 그림자는 알약을 사각형으로 만든다.
//   ③ 크기를 **페이지가 요청하고 메인 프로세스가 준다**(창을 만지는 것은 언제나 이쪽이다).
const HUD_PATH = '/hud';
// 크기 표 = **기본값과 최소값**이지 고정값이 아니다. 늘 위에 떠 있는 판은
// 보여줄 것만큼만 커야 하고(그 이상은 투명한 채로 클릭만 먹는 죽은 자리다),
// 온종일 그것을 보는 사람이 결국 모양을 정할 수 있어야 한다. 그래서 순서는 셋이다:
//   ① 알약 — 페이지가 잰 그대로, 크기 조절 불가.
//   ② 목록·상세 — 페이지가 잰 **내용 높이**(fit)로 열리고 화면의 70% 를 넘지 않는다.
//   ③ 사람이 창을 끌었다면 그 크기가 저장되고, 그 상태에서는 그쪽이 언제나 이긴다.
// (v6.3.9) 기본·최소가 한 단 올라갔다 — 의뢰자의 화면은 3840x2160 을 1x 로 쓴다.
// 거기서는 예전 320/680 이 "펼쳐도 작은" 판이었고, 글자 단을 올린 지금은 더 그렇다.
const HUD_SIZES = {
  pill: { w: 140, h: 44, min: { w: 140, h: 44 } },
  list: { w: 340, h: 300, min: { w: 300, h: 240 } },
  detail: { w: 740, h: 460, min: { w: 560, h: 360 } },
};
// 맥의 노치·메뉴바는 workArea 가 이미 빼 준다 — 여기 여백은 그 아래로 한 뼘 더 내리는 값이다.
const HUD_TOP_GAP = 8;
const HUD_ACCELS = ['CommandOrControl+Shift+\\', 'CommandOrControl+Shift+H', 'CommandOrControl+Alt+Space', 'Alt+Space'];
const HUD_DEFAULT_ACCEL = HUD_ACCELS[0];
let hudState = 'pill';       // 페이지가 마지막으로 알려 온 배치 상태
let hudAccel = null;         // 지금 실제로 등록돼 있는 단축키(없으면 null)
let hudSizing = false;       // 우리가 건 setBounds 가 도는 중 — 사람의 손과 구분한다(그 크기는 기억하지 않는다)
let hudUserResizeAt = 0;     // 사람이 마지막으로 창을 끈 시각 — 끄는 도중에 setBounds 로 되받아치지 않는다
let quitting = false;

// 데스크톱 전용 설정 — 데몬 DB 가 아니라 Electron userData 에 둔다(데몬은 이걸 몰라도 된다).
let storeCache = null;
function storePath() { return path.join(app.getPath('userData'), 'desktop-state.json'); }
function store() {
  if (storeCache) return storeCache;
  try { storeCache = JSON.parse(fs.readFileSync(storePath(), 'utf8')); } catch { storeCache = {}; }
  if (!storeCache || typeof storeCache !== 'object') storeCache = {};
  if (!storeCache.hud || typeof storeCache.hud !== 'object') storeCache.hud = {};
  return storeCache;
}
function saveStore() {
  try {
    fs.mkdirSync(path.dirname(storePath()), { recursive: true });
    fs.writeFileSync(storePath(), JSON.stringify(store(), null, 2));
  } catch (e) { console.error('[coxpit] desktop store write failed:', e && e.message); }
}
function hudMode() { return store().hud.mode === 'hidden' ? 'hidden' : 'ambient'; }  // 기본은 ambient
function hudAlive() { return !!(hud && !hud.isDestroyed()); }
function originURL(p) { return 'http://' + boardOrigin.host + ':' + boardOrigin.port + p; }
function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return dflt;   // 0/누락은 "안 쟀다"는 뜻이지 0px 가 아니다
  return Math.max(lo, Math.min(hi, n));
}

// ── 자리: 화면마다 따로 기억한다(모니터를 옮겨 다니는 것이 이 사용자에겐 일상이다) ──────
function hudDisplay() {
  try { return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()); }
  catch { return screen.getPrimaryDisplay(); }
}
function hudPosFor(display, w, h) {
  const wa = display.workArea;
  const saved = (store().hud.pos || {})[String(display.id)];
  let x = saved ? saved.x : Math.round(wa.x + (wa.width - w) / 2);
  let y = saved ? saved.y : wa.y + HUD_TOP_GAP;
  // 늘어날 때(알약 120 → 상세 570)도 같은 규칙으로 화면 안에 물린다.
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - w));
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - h));
  return { x, y };
}
function rememberHudPos() {
  if (!hudAlive()) return;
  const b = hud.getBounds();
  const pos = store().hud.pos || (store().hud.pos = {});
  try { pos[String(screen.getDisplayMatching(b).id)] = { x: b.x, y: b.y }; } catch { return; }
  saveStore();
}
function placeHudOnCursorDisplay() {
  if (!hudAlive()) return;
  const b = hud.getBounds();
  const p = hudPosFor(hudDisplay(), b.width, b.height);
  hud.setBounds({ x: p.x, y: p.y, width: b.width, height: b.height });
}

// ── 크기: 페이지가 원하는 것을 말하고, 여기서 화면에 맞춰 준다 ────────────────────
// 같은 모서리에서 자란다 — 지금 x/y 를 그대로 두고 폭·높이만 바꾼 뒤 workArea 로 물린다.
// 화면이 허락하는 최대 — 높이는 workArea 의 **70%**(늘 위에 뜨는 판이 화면을 다 먹어서는 안 된다),
// 폭은 가장자리 여백만 뺀다. 최소값보다 작아지는 일은 없다(작은 화면에서도 뒤집히지 않게).
function hudMaxFor(wa, min) {
  return {
    w: Math.max(min.w, Math.round(wa.width) - 24),
    h: Math.max(min.h, Math.round(wa.height * 0.7)),
  };
}
function savedHudSize(state) {
  const s = (store().hud.size || {})[state];
  if (!s) return null;
  const w = Math.round(Number(s.w)), h = Math.round(Number(s.h));
  return Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0 ? { w, h } : null;
}
// **사람이 끈 크기만** 기억한다. 우리가 준 크기까지 저장하면 첫 fit 이 그대로 굳어
// 그다음부터는 내용이 자라도 창이 따라가지 않는다 — 그러면 이 재설계가 없느니만 못해진다.
function rememberHudSize() {
  if (!hudAlive() || hudSizing) return;
  if (hudState === 'pill') return;            // 알약은 고정이라 기억할 크기가 없다
  const b = hud.getBounds();
  const sizes = store().hud.size || (store().hud.size = {});
  sizes[hudState] = { w: b.width, h: b.height };
  saveStore();
}
function applyHudSize(state, want) {
  if (!hudAlive()) return;
  // 페이지는 내용이 자랄 때마다 크기를 말한다 — 그 보고가 **사람이 끌고 있는 창**을 되받아쳐서는 안 된다.
  // 배치가 바뀌는 순간(알약↔목록↔상세)만은 예외다: 그건 사용자가 시킨 전환이지 보고가 아니다.
  const changing = !!HUD_SIZES[state] && state !== hudState;
  if (!changing && Date.now() - hudUserResizeAt < 700) return;
  if (HUD_SIZES[state]) hudState = state;
  const base = HUD_SIZES[hudState] || HUD_SIZES.pill;
  const b = hud.getBounds();
  let wa;
  try { wa = screen.getDisplayMatching(b).workArea; } catch { wa = { x: b.x, y: b.y, width: 1280, height: 800 }; }
  const min = base.min;
  const max = hudMaxFor(wa, min);
  // 사람이 정한 크기 > 페이지가 잰 크기(fit) > 기본값. 알약만은 늘 잰 값 그대로다.
  const saved = hudState === 'pill' ? null : savedHudSize(hudState);
  let w, h;
  if (hudState === 'pill') {
    w = clampInt(want && want.w, 80, Math.min(420, wa.width), base.w);
    h = clampInt(want && want.h, 22, Math.max(120, wa.height), base.h);
  } else if (saved) {
    w = clampInt(saved.w, min.w, max.w, base.w);
    h = clampInt(saved.h, min.h, max.h, base.h);
  } else {
    w = clampInt(want && want.w, min.w, max.w, base.w);
    h = clampInt(want && want.fit ? want.h : base.h, min.h, max.h, base.h);
  }
  hudSizing = true;
  // 크기 조절은 **상태마다 다르다** — 알약은 잰 값에 못 박히고(최소=최대), 목록·상세는 사람이 끌 수 있다.
  try { hud.setResizable(hudState !== 'pill'); } catch { /* 플랫폼별 */ }
  const floor = hudState === 'pill' ? { w, h } : min;
  const cap = hudState === 'pill' ? { w, h } : max;
  try {
    // 순서가 중요하다. 이전 상태의 한계가 아직 걸려 있어서(알약의 최대 42px, 목록의 최소 200px)
    // 곧바로 새 값을 주면 한쪽이 다른 쪽을 막는다 — 먼저 최소를 풀고, 최대를 주고, 최소를 올린다.
    hud.setMinimumSize(1, 1);
    hud.setMaximumSize(cap.w, cap.h);
    hud.setMinimumSize(floor.w, floor.h);
  } catch { /* 플랫폼별 */ }
  const x = Math.max(wa.x, Math.min(b.x, wa.x + wa.width - w));
  const y = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - h));
  hud.setBounds({ x, y, width: w, height: h });
  setTimeout(() => { hudSizing = false; }, 200);   // 우리가 낸 resize 가 다 지나간 뒤에 손을 뗀다
  // 숨김 모드에서 알약으로 접혔다 = 볼일이 끝났다 → 화면에서 내린다.
  if (hudMode() === 'hidden' && hudState === 'pill' && hud.isVisible()) hud.hide();
}
ipcMain.on('hud:size', (e, want) => {
  if (!hudAlive() || e.sender !== hud.webContents) return;   // HUD 창만이 자기 크기를 말할 수 있다
  applyHudSize(String((want && want.state) || ''), want || {});
});
// 머리의 x — **치웠다**는 것은 잠깐 접은 것이 아니라 "지금은 보고 싶지 않다"는 뜻이다.
// 그래서 모드까지 hidden 으로 못 박는다(다시 켤 때 알약이 혼자 돌아오지 않게). 돌아오는 문은 단축키 하나다.
ipcMain.on('hud:hide', (e) => {
  if (!hudAlive() || e.sender !== hud.webContents) return;   // HUD 창만이 자기를 치울 수 있다
  setHudMode('hidden');                                      // applyHudMode -> hideHud, 메뉴 라디오까지 같이 따라간다
});

// ── 페이지에 한 걸음 시키기 ────────────────────────────────────────────────
// 페이지의 배치 전환은 이미 키보드로 다 열려 있다(알약에서 Enter = 펼침, Escape = 한 겹 닫기).
// 그래서 창 쪽에서는 **키 한 번을 보내면 끝**이다 — `/hud` 는 데스크톱을 위한 코드를 한 줄도 갖지 않는다.
function sendHudKey(key) {
  if (!hudAlive()) return;
  hud.webContents.executeJavaScript(
    "document.dispatchEvent(new KeyboardEvent('keydown',{key:" + JSON.stringify(key) + ",bubbles:true,cancelable:true}))",
  ).catch(() => { /* 아직 로드 전 — 다음 호출에서 */ });
}
function expandHud() { if (hudState === 'pill') sendHudKey('Enter'); }
function collapseHud() {
  if (hudState === 'pill') return;
  if (hudState === 'detail') sendHudKey('Escape');   // 상세 → 목록
  sendHudKey('Escape');                              // 목록 → 알약
}
function showHudAmbient() {
  if (!hudAlive()) return;
  if (!hud.isVisible()) hud.showInactive();          // 조용히 떠 있을 뿐 — 앞 창의 포커스를 건드리지 않는다
}
function hideHud() {
  if (!hudAlive()) return;
  collapseHud();
  hud.hide();
}
function summonHud() {
  if (!hudAlive()) return;
  placeHudOnCursorDisplay();
  hud.show();
  hud.focus();                                       // 불러낸 것은 사용자다 — 이때만 포커스를 가져간다
  expandHud();
}
function applyHudMode() {
  if (!hudAlive()) return;
  if (hudMode() === 'ambient') { collapseHud(); showHudAmbient(); }
  else hideHud();
}
function setHudMode(mode) {
  store().hud.mode = mode === 'hidden' ? 'hidden' : 'ambient';
  saveStore();
  applyHudMode();
  buildMenu();
}

// ── 창 ────────────────────────────────────────────────────────────────────
async function createHudWindow() {
  if (hudAlive()) return hud;
  const p = hudPosFor(hudDisplay(), HUD_SIZES.pill.w, HUD_SIZES.pill.h);
  hud = new BrowserWindow({
    x: p.x, y: p.y, width: HUD_SIZES.pill.w, height: HUD_SIZES.pill.h,
    frame: false, transparent: true, backgroundColor: '#00000000',
    hasShadow: false,          // 투명 창의 OS 그림자는 알약 바깥에 네모로 번진다 — 끈다
    // 알약으로 시작하니 처음엔 고정이다. 목록·상세로 가면 applyHudSize 가 setResizable(true) 로 풀어 준다.
    resizable: false, movable: true, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, focusable: true, show: false, title: 'Coxpit HUD',
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload-hud.cjs') },
  });
  hud.setAlwaysOnTop(true, 'floating');
  try { hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* 플랫폼별 */ }
  hud.setMenuBarVisibility(false);
  hudState = 'pill';

  // 페이지는 브라우저에서 단독으로 열려도 어두워야 하므로 자기 지면을 칠한다.
  // 창이 투명일 때만 그 지면을 걷어낸다 — 알약의 둥근 모서리가 살아야 한다.
  hud.webContents.on('did-finish-load', () => {
    if (!hudAlive()) return;
    hud.webContents.insertCSS('html,body{background:transparent!important}').catch(() => { /* */ });
  });
  hud.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  // 상세의 "코크핏에서 열기" 는 **이 작은 창을 갈아치우지 않는다** — 본 창으로 보낸다.
  hud.webContents.on('will-navigate', (e, url) => {
    let pathname = '';
    try { pathname = new URL(url).pathname; } catch { /* 이상한 URL — 그냥 막는다 */ }
    if (pathname === HUD_PATH) return;
    e.preventDefault();
    openInMainWindow(url);
  });
  hud.on('moved', rememberHudPos);
  hud.on('will-resize', () => { if (!hudSizing) hudUserResizeAt = Date.now(); });   // 끄는 중 — 손을 대지 않는다
  hud.on('resized', rememberHudSize);   // 사람이 끈 크기는 **그 상태의 크기**로 남는다(다음부터 fit 을 이긴다)
  hud.on('blur', () => { if (!quitting && hudMode() === 'hidden') hideHud(); });
  hud.on('closed', () => { hud = null; });

  try {
    await waitHealth();
    await hud.loadURL(originURL(HUD_PATH));
  } catch (e) {
    console.error('[coxpit] HUD could not load /hud:', e && e.message);   // 본 창이 이미 실패를 보여준다
  }
  if (hudMode() === 'ambient') showHudAmbient();
  return hud;
}

async function openInMainWindow(url) {
  if (!win || win.isDestroyed()) await createWindow();
  if (!win || win.isDestroyed()) return;
  try { await win.loadURL(url); } catch { /* 에러 페이지가 뜬다 */ }
  win.show(); win.focus();
}

// ── 전역 단축키 ────────────────────────────────────────────────────────────
// ambient = 펼치기/접기 토글 · hidden = 불러내기/내리기.
function hudAccelWanted() { return process.env.COXPIT_HUD_ACCEL || store().hud.accel || HUD_DEFAULT_ACCEL; }
function registerHudShortcut() {
  if (hudAccel) { try { globalShortcut.unregister(hudAccel); } catch { /* */ } hudAccel = null; }
  const want = hudAccelWanted();
  try {
    if (globalShortcut.register(want, () => { toggleHud(); })) { hudAccel = want; return true; }
    // 다른 앱이 이미 쥐고 있다 — 앱을 죽이지 않는다. 메뉴에서 다른 키로 바꾸면 된다.
    console.error('[coxpit] HUD shortcut is already taken by another app: ' + want);
  } catch (e) {
    console.error('[coxpit] HUD shortcut could not be registered (' + want + '):', e && e.message);
  }
  return false;
}
function setHudAccel(accel) {
  store().hud.accel = accel;
  saveStore();
  const ok = registerHudShortcut();
  buildMenu();
  if (!ok) {
    dialog.showMessageBox({
      type: 'warning', message: 'That shortcut is taken',
      detail: accel + ' is already registered by another app. Pick a different one from HUD > Shortcut.',
    });
  }
}
async function toggleHud() {
  if (!hudAlive()) await createHudWindow();
  if (!hudAlive()) return;
  if (hudMode() === 'hidden') {
    if (hud.isVisible() && hudState !== 'pill') hideHud();
    else summonHud();
    return;
  }
  showHudAmbient();
  if (hudState === 'pill') { hud.show(); hud.focus(); expandHud(); }
  else collapseHud();
}
// TODO(K2, 선택): "다음 대기로 점프" 두 번째 단축키 — 어떤 run 이 대기인지는 페이지가 알고
// 창은 모른다. 정직하게 하려면 그 순서를 페이지가 창에 알려주는 통로가 하나 더 필요해서,
// K1/K2 본체를 막지 않도록 여기서 멈춘다.

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

// HUD 메뉴 — 모드 둘과 단축키 몇 개. 그 이상은 이 창의 값어치를 넘는다.
function hudMenu() {
  return {
    label: 'HUD',
    submenu: [
      // 가속기를 메뉴에 **달지 않는다** — 전역 단축키가 이미 쥐고 있어서 앱이 앞에 있을 때 두 번 불린다.
      { label: 'Toggle HUD' + (hudAccel ? '  (' + hudAccel + ')' : '  (shortcut unavailable)'), click: () => { toggleHud(); } },
      { type: 'separator' },
      { label: 'Ambient (pill always visible)', type: 'radio', checked: hudMode() === 'ambient', click: () => setHudMode('ambient') },
      { label: 'Hidden (hotkey only)', type: 'radio', checked: hudMode() === 'hidden', click: () => setHudMode('hidden') },
      { type: 'separator' },
      {
        label: 'Shortcut',
        submenu: HUD_ACCELS.map((a) => ({
          label: a + (hudAccel === a ? '' : hudAccelWanted() === a ? '  (unavailable)' : ''),
          type: 'radio', checked: hudAccelWanted() === a, click: () => setHudAccel(a),
        })),
      },
    ],
  };
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
    hudMenu(),
    ...(!isMac ? [{
      label: 'Help',
      submenu: [
        { label: 'Check for Updates…', click: checkForUpdatesManually },
        { label: 'Daemon Info…', click: showDaemonInfo },
        { label: 'Restart Daemon', click: restartEmbeddedDaemon },
        { label: 'Start Private Local Daemon…', click: startPrivateDaemon },
        { type: 'separator' },
        // HUD 가 살아 있으면 창을 다 닫아도 앱이 남는다 — 맥이 아닌 곳에도 나갈 문이 필요하다.
        { label: 'Quit Coxpit', click: () => { quitting = true; app.quit(); } },
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
  createHudWindow();          // 본 창과 나란히 — ambient 면 알약이 뜨고, hidden 이면 숨은 채 단축키를 기다린다
  registerHudShortcut();
  buildMenu();                // 등록된 단축키를 메뉴에 반영
  // HUD 가 살아 있으면 창 개수가 0 이 되지 않는다 — 독 클릭은 **본 창**의 유무로 판단한다.
  app.on('activate', () => { if (!win || win.isDestroyed()) createWindow(); });
});
// 종료 게이트 — 본 창 **또는** HUD 가 살아 있는 동안 앱은 산다(본 창을 닫는 것이 HUD 를 죽이지 않는다).
// hidden 모드의 HUD 는 닫힌 게 아니라 안 보일 뿐이라 이 핸들러 자체가 불리지 않는다.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !hudAlive()) app.quit();
});
app.on('before-quit', () => {
  quitting = true;
  if (daemon) { try { daemon.kill(); } catch { /* gone */ } }
});
app.on('will-quit', () => { globalShortcut.unregisterAll(); });
