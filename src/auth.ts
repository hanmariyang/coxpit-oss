import type { FastifyRequest, FastifyReply } from 'fastify';
import {
  authMode, verifyKey, verifySession, readCookie, SESSION_COOKIE, isLoopback, isExposedBind,
} from './authkey';
import { loginPageHTML } from './login';

/**
 * 이 요청이 "진짜 로컬"인가 — 소켓 peer 가 loopback 이고 포워딩 헤더가 없어야 한다.
 * 리버스 프록시/터널을 탄 요청은 소켓이 127.0.0.1 이라도 x-forwarded-for·cf-connecting-ip 를
 * 실어 오므로 로컬로 신뢰하지 않는다(issue #11 — 바인드가 아니라 요청별로 신뢰 판단).
 */
function isTrustedLocalReq(req: FastifyRequest): boolean {
  const ip = req.socket?.remoteAddress ?? '';
  const hasFwd = req.headers['x-forwarded-for'] != null || req.headers['cf-connecting-ip'] != null;
  return isLoopback(ip) && !hasFwd;
}

// /api/design/capture · /design/bookmarklet.js 는 외부 앱(북마클릿)에서 오므로
// 헤더/쿠키를 못 싣는다 — 라우트 자체가 캡처 키(?k=)를 검증한다.
// /api/agent/subtasks 는 에이전트 Bearer 토큰(라우트 자체 검증), /share/* 는 토큰 URL 이 곧 능력.
// /api/auth/* 는 언락/셋업 자체라 게이트 앞이어야 한다(체험 전 인증 불가).
const EXEMPT = new Set([
  '/api/health', '/api/design/capture', '/design/bookmarklet.js', '/api/agent/subtasks',
  '/api/auth/setup', '/api/auth/unlock', '/api/auth/logout',
  '/favicon.ico',
]);
// /brand/* — 공개 브랜드 에셋(로고·마스코트·워드마크 폰트·favicon). 미인증 로그인 페이지가
// 이걸 불러와야 하므로 게이트 앞. 시크릿 아님(패키지 동봉 정적물).
const EXEMPT_PREFIX = ['/share/', '/brand/'];

/** 이 요청이 HTML 문서를 원하는 GET 인가(→ 팝업 대신 login/setup 페이지 서빙). */
function wantsHtml(req: FastifyRequest): boolean {
  if (req.method !== 'GET') return false;
  const accept = String(req.headers['accept'] ?? '');
  return accept.includes('text/html');
}

/**
 * 인증 게이트 — 접근키(access-key) 기반.
 * 순서: DISABLED → pass · EXEMPT → pass · 유효한 세션 쿠키 → pass ·
 *       유효한 Basic 헤더(자동화 back-compat, 키만) → pass · else 거부.
 * 거부 시 HTML GET 은 login/setup 페이지(200), 그 외는 401(WWW-Authenticate 없음 → 팝업 없음).
 */
export async function authGate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const m = authMode();
  if (m.mode === 'disabled') return;

  const path = req.url.split('?')[0] ?? '';
  if (EXEMPT.has(path)) return;
  if (EXEMPT_PREFIX.some((p) => path.startsWith(p))) return;

  // 키 미구성(setup)이고 loopback 바인드일 때만, 진짜 로컬 요청을 무마찰 통과(npx coxpit 랩탑 경로).
  // ‑ 프록시/원격 요청(포워딩 헤더)은 loopback 바인드라도 통과시키지 않는다 → 프록시 뒤 무인증 노출 차단.
  // ‑ 노출 바인드(0.0.0.0)에 키가 없으면 로컬 포함 전원에게 setup 페이지를 강제한다(먼저 키를 걸게).
  // env/stored(키 구성됨)는 어떤 경우에도 우회 없음(issue #11).
  if (m.mode === 'setup' && !isExposedBind() && isTrustedLocalReq(req)) return;

  // 세션 쿠키(언락 완료 기기) — 무상태 서명 검증.
  const sess = readCookie(req.headers.cookie, SESSION_COOKIE);
  if (sess && verifySession(sess, m)) return;

  // Basic 헤더 back-compat(자동화 전용) — 유저명은 무시, 비밀번호 자리를 키로 검증.
  const h = req.headers.authorization ?? '';
  if (h.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      const p = idx >= 0 ? decoded.slice(idx + 1) : decoded;
      if (verifyKey(p, m)) return;
    } catch { /* malformed header → 아래에서 거부 */ }
  }

  // 거부 — HTML GET 은 페이지, 나머지는 401(팝업 없음).
  if (wantsHtml(req)) {
    await reply.type('text/html').code(200).send(loginPageHTML(m.mode === 'setup'));
    return;
  }
  await reply.code(401).send({ error: 'unauthorized' });
}
