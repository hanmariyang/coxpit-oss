import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from './config';

// /api/design/capture · /design/bookmarklet.js 는 외부 앱(북마클릿)에서 오므로
// basic 헤더를 못 싣는다 — 라우트 자체가 캡처 키(?k=)를 검증한다.
// /api/agent/subtasks 는 에이전트 Bearer 토큰(라우트 자체 검증), /share/* 는 토큰 URL 이 곧 능력.
const EXEMPT = new Set(['/api/health', '/api/design/capture', '/design/bookmarklet.js', '/api/agent/subtasks']);
const EXEMPT_PREFIX = ['/share/'];

/**
 * 인증 게이트 — 현재 basic. 플러그형 좌석: 배포 시 앞단에 Cloudflare Access / Tailscale 을
 * 두는 것을 권장(그 경우 COXPIT_AUTH_DISABLED=1 로 내부 인증을 끄고 게이트웨이에 위임).
 */
export async function authGate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (config.auth.disabled) return;
  const path = req.url.split('?')[0] ?? '';
  if (EXEMPT.has(path)) return;
  if (EXEMPT_PREFIX.some((p) => path.startsWith(p))) return;

  const h = req.headers.authorization ?? '';
  if (h.startsWith('Basic ') && config.auth.pass !== '') {
    const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const u = decoded.slice(0, idx);
    const p = decoded.slice(idx + 1);
    if (u === config.auth.user && p === config.auth.pass) return;
  }
  await reply.header('WWW-Authenticate', 'Basic realm="coxpit"').code(401).send({ error: 'unauthorized' });
}
