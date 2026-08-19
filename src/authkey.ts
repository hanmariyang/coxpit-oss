// 접근키(access-key) 인증의 저장·해시·쿠키 서명·레이트리밋 — 전부 node 내장 crypto(신규 deps 0).
// 브라우저 basic-auth 팝업 대신 브랜디드 언락/셋업 페이지 + 서명된 세션 쿠키를 뒷받침한다.
import fs from 'node:fs';
import path from 'node:path';
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { config } from './config';

// 저장 위치 = DB 와 같은 데이터 폴더(~/.coxpit). auth.json 은 해시만 담는다(평문 키 없음).
const AUTH_PATH = path.join(path.dirname(path.resolve(config.dbPath)), 'auth.json');

export interface StoredAuth {
  algo: 'scrypt';
  salt: string;      // hex
  hash: string;      // hex (scrypt(key, salt))
  cookieSecret: string; // hex — 세션 쿠키 HMAC 서명용
}

const SCRYPT_N = 16384;
const SCRYPT_KEYLEN = 32;

function scryptHex(key: string, saltHex: string): string {
  return scryptSync(key, Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN, { N: SCRYPT_N, r: 8, p: 1 }).toString('hex');
}

/** 두 hex 문자열을 상수시간 비교(길이 방어 포함). */
export function constantEqHex(aHex: string, bHex: string): boolean {
  try {
    const a = Buffer.from(aHex, 'hex');
    const b = Buffer.from(bHex, 'hex');
    if (a.length === 0 || a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

let cache: StoredAuth | null | undefined; // undefined = 미로드, null = 파일 없음

/** 저장된 인증(있으면). env-mode 여도 파일이 있을 수 있으나 precedence 는 authMode 가 결정. */
export function loadStored(): StoredAuth | null {
  if (cache !== undefined) return cache;
  try {
    const raw = fs.readFileSync(AUTH_PATH, 'utf8');
    const j = JSON.parse(raw) as Partial<StoredAuth>;
    if (j && j.algo === 'scrypt' && typeof j.salt === 'string' && typeof j.hash === 'string' && typeof j.cookieSecret === 'string') {
      cache = { algo: 'scrypt', salt: j.salt, hash: j.hash, cookieSecret: j.cookieSecret };
      return cache;
    }
    cache = null;
    return null;
  } catch {
    cache = null;
    return null;
  }
}

/** 키를 해시해서 저장(첫 실행 셋업). 새 cookieSecret 을 발급. 평문 키/시크릿은 로그 금지. */
export function storeKey(key: string): StoredAuth {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptHex(key, salt);
  const cookieSecret = randomBytes(32).toString('hex');
  const rec: StoredAuth = { algo: 'scrypt', salt, hash, cookieSecret };
  fs.mkdirSync(path.dirname(AUTH_PATH), { recursive: true });
  fs.writeFileSync(AUTH_PATH, JSON.stringify(rec), { mode: 0o600 });
  try { fs.chmodSync(AUTH_PATH, 0o600); } catch { /* best effort */ }
  cache = rec;
  return rec;
}

/** 저장된 키 파일 삭제(reset-key). 다음 부팅은 다시 첫 실행 셋업. */
export function clearStored(): boolean {
  cache = undefined;
  try {
    if (fs.existsSync(AUTH_PATH)) { fs.rmSync(AUTH_PATH); return true; }
    return false;
  } catch {
    return false;
  }
}

export function authFilePath(): string { return AUTH_PATH; }

// ── precedence 결정 ────────────────────────────────────────────────
// 1) COXPIT_AUTH_DISABLED=1 → off  2) env COXPIT_AUTH_PASS → env-mode
// 3) auth.json 존재 → stored  4) 아무것도 없음 → 첫 실행 셋업
export type AuthMode =
  | { mode: 'disabled' }
  | { mode: 'env'; key: string }
  | { mode: 'stored'; rec: StoredAuth }
  | { mode: 'setup' };

/**
 * 데몬이 외부에 노출된 바인드인가 — loopback-only(127.0.0.1/::1/localhost)면 로컬 신뢰(false),
 * 0.0.0.0 이나 라우팅 가능한 IP 면 노출(true). 노출일 때만 접근키 인증을 적용한다.
 * (npx coxpit 로컬 = 무마찰; 레지던트 COXPIT_HOST=0.0.0.0 = 키 필요.)
 */
export function isExposedBind(): boolean {
  const host = (config.host ?? '').trim().toLowerCase();
  if (host === '' || host === '127.0.0.1' || host === '::1' || host === 'localhost' || host === '::ffff:127.0.0.1') {
    return false;
  }
  return true;
}

export function authMode(): AuthMode {
  if (config.auth.disabled) return { mode: 'disabled' };
  // loopback-only 바인드 = 로컬 신뢰 → 인증 없음(login/setup 페이지도 없음).
  if (!isExposedBind()) return { mode: 'disabled' };
  if (config.auth.pass !== '') return { mode: 'env', key: config.auth.pass };
  const rec = loadStored();
  if (rec) return { mode: 'stored', rec };
  return { mode: 'setup' };
}

/** 인증이 실질적으로 열려있나(비번 없음) — Funnel 가드·authOpen 배지용. */
export function authIsOpen(): boolean {
  const m = authMode();
  return m.mode === 'disabled' || m.mode === 'setup';
}

/** 주어진 키가 현재 구성된 키와 일치하나(상수시간). env/stored 양쪽. */
export function verifyKey(key: string, m: AuthMode = authMode()): boolean {
  if (m.mode === 'env') {
    // env 는 평문 비교지만 상수시간으로 — 같은 salt 로 양쪽 해시 후 비교.
    const salt = 'coxpit-env-mode-fixed-salt';
    return constantEqHex(scryptHex(key, Buffer.from(salt).toString('hex')), scryptHex(m.key, Buffer.from(salt).toString('hex')));
  }
  if (m.mode === 'stored') {
    return constantEqHex(scryptHex(key, m.rec.salt), m.rec.hash);
  }
  return false;
}

/** 쿠키 서명 시크릿 — stored 면 cookieSecret, env 면 그 키에서 파생(무상태). */
function cookieSecretFor(m: AuthMode = authMode()): string {
  if (m.mode === 'stored') return m.rec.cookieSecret;
  if (m.mode === 'env') return scryptHex(m.key, Buffer.from('coxpit-cookie-derive').toString('hex'));
  return '';
}

export const SESSION_COOKIE = 'coxpit_sess';

// 쿠키 값 = "<expiryMs>.<hmac>" — 서버 세션 스토어 없이 stateless 검증.
// expiry=0 → 세션 쿠키(무만료 스탬프, 브라우저 종료 시 소멸)지만 서명은 항상 검증.
export function signSession(expiryMs: number, m: AuthMode = authMode()): string {
  const secret = cookieSecretFor(m);
  const stamp = String(expiryMs);
  const mac = createHmac('sha256', secret).update(stamp).digest('hex');
  return stamp + '.' + mac;
}

export function verifySession(value: string, m: AuthMode = authMode()): boolean {
  const secret = cookieSecretFor(m);
  if (!secret) return false;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return false;
  const stamp = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  const expiry = Number(stamp);
  if (!Number.isFinite(expiry)) return false;
  const want = createHmac('sha256', secret).update(stamp).digest('hex');
  if (!constantEqHex(mac, want)) return false;
  if (expiry !== 0 && Date.now() > expiry) return false; // 만료
  return true;
}

/** 요청 헤더에서 쿠키 하나 파싱(라이브러리 없이 최소 수동). */
export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// ── 레이트리밋(per-client, in-memory, 백오프) ───────────────────────
interface Bucket { fails: number; blockedUntil: number }
const buckets = new Map<string, Bucket>();
const FREE_ATTEMPTS = 5;
// 5회 초과부터 창이 커진다: 5s → 30s → 2m → 5m(상한)
const BACKOFF_MS = [5_000, 30_000, 120_000, 300_000];

export function clientKey(headers: Record<string, unknown>, socketIp: string): string {
  const h = (k: string): string => {
    const v = headers[k];
    if (Array.isArray(v)) return String(v[0] ?? '');
    return typeof v === 'string' ? v : '';
  };
  const fwd = h('x-forwarded-for').split(',')[0]!.trim();
  return h('cf-connecting-ip') || fwd || socketIp || 'unknown';
}

/** 지금 시도해도 되나. 막혀있으면 { blocked:true, retryMs }. */
export function rateCheck(id: string): { blocked: boolean; retryMs: number; attemptsLeft: number } {
  const b = buckets.get(id);
  const now = Date.now();
  if (b && b.blockedUntil > now) {
    return { blocked: true, retryMs: b.blockedUntil - now, attemptsLeft: 0 };
  }
  const fails = b ? b.fails : 0;
  return { blocked: false, retryMs: 0, attemptsLeft: Math.max(0, FREE_ATTEMPTS - fails) };
}

/** 실패 1건 기록 → 필요 시 블록 창 설정. 반환은 이후 상태(다음 시도 안내용). */
export function rateFail(id: string): { retryMs: number; attemptsLeft: number } {
  const now = Date.now();
  const b = buckets.get(id) ?? { fails: 0, blockedUntil: 0 };
  b.fails += 1;
  if (b.fails > FREE_ATTEMPTS) {
    const over = b.fails - FREE_ATTEMPTS - 1;
    const win = BACKOFF_MS[Math.min(over, BACKOFF_MS.length - 1)]!;
    b.blockedUntil = now + win;
  }
  buckets.set(id, b);
  const blockedFor = b.blockedUntil > now ? b.blockedUntil - now : 0;
  return { retryMs: blockedFor, attemptsLeft: Math.max(0, FREE_ATTEMPTS - b.fails) };
}

/** 성공 시 리셋. */
export function rateReset(id: string): void { buckets.delete(id); }

// ── 첫 실행 셋업 토큰(Jupyter 스타일) ──────────────────────────────
// 부팅 시 키가 없으면 1회용 토큰을 stdout(=로그)에 찍는다. 로그 접근 = 머신 소유.
let setupToken: string | null = null;

export function ensureSetupToken(): string {
  if (!setupToken) setupToken = randomBytes(24).toString('hex');
  return setupToken;
}

export function getSetupToken(): string | null { return setupToken; }

export function verifySetupToken(token: string): boolean {
  if (!setupToken || !token) return false;
  return constantEqHex(Buffer.from(token).toString('hex'), Buffer.from(setupToken).toString('hex'));
}

/**
 * 셋업 anti-claim — 이 요청이 증명 가능한 소유자인가.
 * (A) 셋업 토큰 일치(로그 접근자), 또는
 * (B) 진짜 로컬: 소켓 remote 가 loopback AND forwarding 헤더 부재.
 * 터널을 탄 요청(127.0.0.1 이지만 cf/x-forwarded 헤더 보유)은 (A) 토큰 필수.
 */
export function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
}

export function setupAllowed(
  headers: Record<string, unknown>,
  remoteIp: string,
  token: string,
): { ok: boolean; via: 'token' | 'local' | null } {
  if (verifySetupToken(token)) return { ok: true, via: 'token' };
  const hasFwd = headers['x-forwarded-for'] != null || headers['cf-connecting-ip'] != null;
  if (isLoopback(remoteIp) && !hasFwd) return { ok: true, via: 'local' };
  return { ok: false, via: null };
}
