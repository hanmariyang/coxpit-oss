// 클로드 계정은 기기(맥) 단위다(11/03 오너 결정, 시안 v7). 세션별 계정은 없다.
// claude 는 클로드 코드 기본 자격증명만 쓴다: 키체인 「Claude Code-credentials」(= ~/.claude/.credentials.json 과 같은 JSON) + ~/.claude.json 의 oauthAccount.
// 데몬은 계정마다 그 셋의 **사본**을 데이터 폴더 accounts/<메일>.json(600) 에 둔다.
//  · 바꾸기 = 지금 저장소를 현재 계정 사본으로 떠 두고(갱신 토큰이 돌기 때문), 고른 사본을 저장소에 쓴다. claude 는 안 건드린다.
//    새로 뜨는 claude 는 바로 새 계정, 떠 있는 claude 는 다음 토큰 갱신(접속 토큰 8시간) 때 저장소를 다시 읽어 넘어간다.
//  · 더하기 = 숨은 tmux 에서 claude → /login(BROWSER 를 가로채 주소를 받는다) → 앱이 브라우저를 열고 코드를 붙인다 → 클로드 코드가 스스로 저장소에 쓴다 → 사본.
// 토큰 값은 API 응답 · 로그 · 화면 어디에도 싣지 않는다.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = (): string => path.dirname(path.resolve(process.env.COXPIT_DB || path.join(os.homedir(), '.coxpit', 'coxpit.db')));
const accDir = (): string => path.join(dataDir(), 'accounts');
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const okEmail = (e: string): boolean => EMAIL_RE.test(e) && e.length <= 120;
const filePath = (email: string): string => path.join(accDir(), `${email.toLowerCase()}.json`);
const PATH_ENV = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}`;

interface Creds { accessToken?: string; refreshToken?: string; expiresAt?: number; refreshTokenExpiresAt?: number | string; [k: string]: unknown }
interface Saved { email: string; alias?: string; savedAt: number; source: 'login' | 'snapshot'; creds: Creds; oauthAccount: Record<string, unknown> | null }
export interface Account { name: string; email: string; alias?: string; since: number; refreshExpiresAt: number | null; alive: boolean; current: boolean }

// ── 클로드 코드 저장소 읽기 · 쓰기 ──
const credFile = (): string => path.join(os.homedir(), '.claude', '.credentials.json');
const claudeJson = (): string => path.join(os.homedir(), '.claude.json');
const KC_SVC = 'Claude Code-credentials';
function security(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('security', args, { encoding: 'utf8', timeout: 8000 });
  return { ok: r.status === 0, out: r.stdout ?? '' };
}
function readStore(): { creds: Creds | null; raw: Record<string, unknown>; oauthAccount: Record<string, unknown> | null } {
  let raw: Record<string, unknown> = {};
  // 키체인이 먼저(맥의 claude 가 쓰는 곳), 안 읽히면 파일
  const k = process.platform === 'darwin' ? security(['find-generic-password', '-a', os.userInfo().username, '-s', KC_SVC, '-w']) : { ok: false, out: '' };
  if (k.ok && k.out.trim()) { try { raw = JSON.parse(k.out.trim()); } catch { raw = {}; } }
  if (!raw.claudeAiOauth) { try { raw = JSON.parse(fs.readFileSync(credFile(), 'utf8')); } catch { /* 없음 */ } }
  const creds = (raw.claudeAiOauth as Creds | undefined) ?? null;
  let oauthAccount: Record<string, unknown> | null = null;
  try { const j = JSON.parse(fs.readFileSync(claudeJson(), 'utf8')); if (j.oauthAccount && typeof j.oauthAccount === 'object') oauthAccount = j.oauthAccount; } catch { /* 없음 */ }
  return { creds: creds && typeof creds.accessToken === 'string' ? creds : null, raw, oauthAccount };
}
function writeStore(creds: Creds, oauthAccount: Record<string, unknown> | null): void {
  const cur = readStore();
  const raw = { ...cur.raw, claudeAiOauth: creds };
  const txt = JSON.stringify(raw);
  fs.mkdirSync(path.dirname(credFile()), { recursive: true });
  fs.writeFileSync(credFile(), txt, { mode: 0o600 });
  if (process.platform === 'darwin') {
    const r = security(['add-generic-password', '-U', '-a', os.userInfo().username, '-s', KC_SVC, '-w', txt]);
    if (!r.ok) console.warn('[coxpit] 키체인에 못 썼어요(.credentials.json 만 바꿈)');
  }
  if (oauthAccount) {
    try {
      const j = JSON.parse(fs.readFileSync(claudeJson(), 'utf8')); j.oauthAccount = oauthAccount;
      const tmp = `${claudeJson()}.coxpit-${process.pid}`; fs.writeFileSync(tmp, JSON.stringify(j, null, 2), { mode: 0o600 }); fs.renameSync(tmp, claudeJson());
    } catch (e) { console.warn('[coxpit] ~/.claude.json 계정 정보를 못 바꿨어요', (e as Error).message); }
  }
}
/** 이 맥이 지금 로그인된 계정 메일(저장소에 토큰이 있을 때만) */
export function currentEmail(): string | null {
  const s = readStore(); if (!s.creds) return null;
  const e = s.oauthAccount?.emailAddress; return typeof e === 'string' && okEmail(e) ? e.toLowerCase() : null;
}

// ── 사본 ──
function readSaved(email: string): Saved | null { try { return JSON.parse(fs.readFileSync(filePath(email), 'utf8')) as Saved; } catch { return null; } }
function writeSaved(s: Saved): void {
  fs.mkdirSync(accDir(), { recursive: true, mode: 0o700 }); try { fs.chmodSync(accDir(), 0o700); } catch { /* 그대로 */ }
  fs.writeFileSync(filePath(s.email), JSON.stringify(s), { mode: 0o600 });
}
function refreshExpiry(c: Creds): number | null {
  const v = c.refreshTokenExpiresAt; const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}
/** 지금 저장소를 현재 계정 사본으로 떠 둔다(별명은 유지). 저장소가 비었으면 null */
export function snapshotCurrent(source: Saved['source'] = 'snapshot'): string | null {
  const s = readStore(); const email = currentEmail(); if (!s.creds || !email) return null;
  const old = readSaved(email);
  writeSaved({ email, alias: old?.alias, savedAt: Date.now(), source: old?.source === 'login' && source === 'snapshot' ? 'login' : source, creds: s.creds, oauthAccount: s.oauthAccount });
  return email;
}
let lastSnap = 0;
export function listAccounts(): { current: string | null; default: string | null; accounts: Account[] } {
  // 목록을 볼 때마다 현재 계정 사본을 신선하게(갱신 토큰이 돈다). 10분에 한 번
  if (Date.now() - lastSnap > 10 * 60 * 1000) { lastSnap = Date.now(); try { snapshotCurrent(); } catch { /* 다음에 */ } }
  const cur = currentEmail(); const now = Date.now();
  let files: string[] = []; try { files = fs.readdirSync(accDir()).filter((f) => f.endsWith('.json')); } catch { /* 없음 */ }
  const accounts: Account[] = [];
  for (const f of files) {
    const s = readSaved(f.slice(0, -5)); if (!s || !okEmail(s.email) || !s.creds) continue;
    const exp = refreshExpiry(s.creds);
    accounts.push({ name: s.alias || s.email.split('@')[0]!, email: s.email, alias: s.alias, since: s.savedAt, refreshExpiresAt: exp, alive: exp === null || exp > now, current: s.email === cur });
  }
  accounts.sort((a, b) => Number(b.current) - Number(a.current) || a.email.localeCompare(b.email));
  const c = accounts.find((a) => a.current);
  return { current: cur, default: c?.name ?? null, accounts };
}
/** 이 맥의 계정을 사본으로 바꾼다. claude 는 안 건드린다 */
export function switchTo(email: string): { ok: boolean; current: string | null; error?: string } {
  const e = email.toLowerCase(); if (!okEmail(e)) return { ok: false, current: currentEmail(), error: '메일이 이상해요' };
  const s = readSaved(e); if (!s || !s.creds) return { ok: false, current: currentEmail(), error: '그 계정 사본이 없어요' };
  const exp = refreshExpiry(s.creds); if (exp !== null && exp <= Date.now()) return { ok: false, current: currentEmail(), error: '사본의 갱신 토큰이 만료됐어요. 다시 로그인해 주세요' };
  if (currentEmail() === e) return { ok: true, current: e };
  snapshotCurrent();
  writeStore(s.creds, s.oauthAccount);
  lastSnap = Date.now();
  return { ok: true, current: currentEmail() ?? e };
}
export function setAlias(email: string, alias: string): boolean {
  const s = readSaved(email.toLowerCase()); if (!s) return false;
  const a = alias.trim().slice(0, 40); s.alias = a || undefined; writeSaved(s); return true;
}
export function deleteAccount(email: string): { ok: boolean; error?: string } {
  const e = email.toLowerCase(); if (currentEmail() === e) return { ok: false, error: '지금 쓰는 계정은 못 지워요. 먼저 다른 계정으로 바꾸세요' };
  try { fs.unlinkSync(filePath(e)); return { ok: true }; } catch { return { ok: false, error: '그런 계정이 없어요' }; }
}

// ── 로그인(계정 더하기): 숨은 tmux 창에서 claude → /login ──
const LOGIN = 'coxpit-login';
function tmux(args: string[], timeout = 8000): string {
  const r = spawnSync('tmux', args, { encoding: 'utf8', timeout, env: { ...process.env, PATH: PATH_ENV } });
  return r.stdout ?? '';
}
function screen(): string { return tmux(['capture-pane', '-p', '-J', '-t', LOGIN]); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const urlFile = (): string => path.join(accDir(), 'login-url.txt');
const browserShim = (): string => path.join(accDir(), 'login-browser.sh');
let loginPrev: string | null = null;
let loginBefore: string | undefined;

/** 로그인 시작: 주소를 돌려준다(앱이 브라우저를 연다). 전 계정은 사본으로 먼저 떠 둔다 */
export async function loginStart(): Promise<{ url: string; previous: string | null }> {
  tmux(['kill-session', '-t', LOGIN]);
  loginPrev = snapshotCurrent();
  loginBefore = readStore().creds?.accessToken;
  fs.mkdirSync(accDir(), { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(urlFile()); } catch { /* 없음 */ }
  // /login 은 브라우저를 바로 연다. BROWSER 를 이 조각으로 두면 주소를 파일에 적고, 화면엔 「Paste code here」 가 뜬다
  fs.writeFileSync(browserShim(), `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(urlFile())}\n`, { mode: 0o700 });
  // 환경변수 토큰이 섞이지 않게 비우고 띄운다. 심은 COXPIT_CLAUDE_SID 가 없으면 통과한다
  // 빈 전용 폴더에서 띄운다. 처음 보는 폴더면 「trust this folder」 창이 먼저 뜨는데(맥미니 홈이 그랬다, 11/07) 아래에서 넘긴다
  const cwd = path.join(dataDir(), 'login-cwd'); fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
  tmux(['new-session', '-d', '-s', LOGIN, '-x', '160', '-y', '40', '-c', cwd,
    `env -u CLAUDE_CODE_OAUTH_TOKEN -u COXPIT_ACCOUNT -u COXPIT_CLAUDE_SID BROWSER=${JSON.stringify(browserShim())} claude; sleep 600`]);
  const until = async (test: () => boolean, tries: number, ms = 500): Promise<boolean> => { for (let i = 0; i < tries; i++) { if (test()) return true; await sleep(ms); } return test(); };
  if (!(await until(() => /❯/.test(screen()), 60))) { loginCancel(); throw new Error('claude 가 안 떴어요'); }
  if (/trust this folder/i.test(screen())) {   // ❯ No, exit / Yes, I trust this folder
    tmux(['send-keys', '-t', LOGIN, 'Down']); await sleep(200); tmux(['send-keys', '-t', LOGIN, 'Enter']);
    if (!(await until(() => !/trust this folder/i.test(screen()) && /❯/.test(screen()), 40))) { loginCancel(); throw new Error('claude 폴더 확인 창을 못 넘겼어요'); }
  }
  await sleep(600);
  tmux(['send-keys', '-t', LOGIN, '-l', '/login']); await sleep(400); tmux(['send-keys', '-t', LOGIN, 'Enter']);
  if (!(await until(() => /Select login method/.test(screen()), 30))) {
    const tail = screen().split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' / ').slice(0, 200);
    loginCancel(); throw new Error('로그인 메뉴가 안 떴어요' + (tail ? ` (화면: ${tail})` : ''));
  }
  tmux(['send-keys', '-t', LOGIN, 'Enter']);   // 1. Claude account with subscription
  if (!(await until(() => fs.existsSync(urlFile()), 40))) { loginCancel(); throw new Error('로그인 주소를 못 받았어요'); }
  const raw = fs.readFileSync(urlFile(), 'utf8').trim().split('\n')[0] ?? '';
  if (!/^https:\/\/(claude\.com|claude\.ai)\/.*oauth/.test(raw)) { loginCancel(); throw new Error('로그인 주소가 이상해요'); }
  // claude 2.1.3xx 는 BROWSER 에 localhost 콜백 주소를 넘긴다. 폰 브라우저에서 열면 localhost 가 폰이라 연결 거부가 난다.
  // 화면의 「Paste code」 주소와는 redirect_uri 만 다르니(state · challenge 같음) 수동 코드 콜백으로 바꿔 준다
  const u = new URL(raw);
  if (/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(u.searchParams.get('redirect_uri') ?? '')) u.searchParams.set('redirect_uri', 'https://platform.claude.com/oauth/code/callback');
  const url = u.toString();
  return { url, previous: loginPrev };
}
export function loginCancel(): void { tmux(['kill-session', '-t', LOGIN]); try { fs.unlinkSync(urlFile()); } catch { /* 없음 */ } }

/** 돌아온 코드를 쳐 넣는다. 클로드 코드가 저장소에 쓰면 그 계정이 바로 이 맥의 계정이고, 사본을 남긴다 */
export async function loginCode(code: string): Promise<{ name: string; email: string | null; previous: string | null }> {
  let c = code.trim();
  // 주소째 붙여도 받는다: …/callback?code=X&state=Y → X#Y (claude 의 「Paste code」 꼴)
  try { const u = new URL(c); const k = u.searchParams.get('code'), st = u.searchParams.get('state'); if (k) c = st ? `${k}#${st}` : k; } catch { /* 주소 아님 */ }
  if (!c || c.length > 400 || /\s/.test(c)) throw new Error('코드가 이상해요');
  // 주소 파일은 화면보다 먼저 생긴다. 「Paste code」 줄이 그려질 때까지 잠깐 기다린다
  let ready = false; for (let i = 0; i < 20 && !ready; i++) { ready = screen().includes('Paste code'); if (!ready) await sleep(500); }
  if (!ready) throw new Error('로그인 창이 닫혔어요(앞 코드가 거절됐거나 시간이 지났어요). 「계정 더하기」를 처음부터 다시 해 주세요');
  tmux(['send-keys', '-t', LOGIN, '-l', c]); await sleep(300); tmux(['send-keys', '-t', LOGIN, 'Enter']);
  let changed = false;
  for (let i = 0; i < 90 && !changed; i++) {
    await sleep(500);
    const t = readStore().creds?.accessToken; if (t && t !== loginBefore) changed = true;
    else if (/invalid|expired|failed|error/i.test(screen().replace(/Browser didn't open\?.*$/m, ''))) break;
  }
  if (!changed) {
    // 클로드가 화면에 적은 까닭을 그대로 돌려준다(코드 · 토큰은 화면에 안 나온다)
    const why = (screen().split('\n').find((l) => /OAuth error|invalid|expired|failed/i.test(l)) ?? '').trim().slice(0, 200);
    loginCancel();
    throw new Error('로그인이 안 됐어요. 「계정 더하기」를 처음부터 다시 해 주세요' + (why ? ` (${why})` : ''));
  }
  // 메일은 claude 가 프로필을 받아 ~/.claude.json 에 적는다. 조금 기다린다
  let email: string | null = null;
  for (let i = 0; i < 20; i++) { email = currentEmail(); if (email && email !== loginPrev) break; await sleep(500); }
  loginCancel();
  const saved = snapshotCurrent('login');
  const prev = loginPrev; loginPrev = null; loginBefore = undefined;
  const e = saved ?? email;
  return { name: e ? e.split('@')[0]! : 'account', email: e, previous: prev };
}
