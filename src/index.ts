import { config } from './config';
import { authMode, ensureSetupToken, isExposedBind } from './authkey';
import { db, ensureSchema } from './db';
import { machines } from './db/schema';
import { acquireDaemonLock } from './lock';
import { reconcileOrphanRuns } from './orchestrator';
import { buildServer } from './server';

// Windows 네이티브는 에이전트 실행 계층(sh·tmux·git worktree over sh)이 성립하지 않는다.
// 보드/원격 머신 관제는 되지만 로컬 run 은 불가 — WSL 데몬을 안내한다.
if (process.platform === 'win32') {
  console.warn(
    '[coxpit] Windows detected: local agent runs need a POSIX shell + tmux, which Windows lacks.\n' +
    '[coxpit] Run the daemon inside WSL2 (npm i -g coxpit) and connect from the browser or desktop app,\n' +
    '[coxpit] or register remote (ssh) machines only — the local machine will fail readiness checks.',
  );
}

// DB 를 열기 전에 단일 데몬 보장 — 이미 떠 있으면 그 URL 을 안내하고 종료.
await acquireDaemonLock();

await ensureSchema();

// 첫 실행 시 로컬 머신 시드(데몬이 도는 이 기계).
if ((await db.select().from(machines)).length === 0) {
  await db.insert(machines).values({ slug: 'local', name: 'This machine', kind: 'local', online: true });
}

// 재시작으로 고아가 된 running run 정산(카드가 영원히 '진행 중'으로 남는 것 방지).
const orphans = await reconcileOrphanRuns();
if (orphans > 0) console.log(`[coxpit] settled ${orphans} orphaned run(s) from a previous daemon instance`);

const app = await buildServer();
try {
  await app.listen({ host: config.host, port: config.port });
} catch (e) {
  if ((e as NodeJS.ErrnoException)?.code === 'EADDRINUSE') {
    console.error(`[coxpit] port ${config.port} is already in use — is another daemon (or app) running? Set COXPIT_PORT to change.`);
    process.exit(1);
  }
  throw e;
}

// 접근키 인증 상태 안내. 첫 실행(키 미설정)이면 브랜디드 셋업 페이지 + 1회용 셋업 토큰을 찍는다.
// (토큰 = Jupyter 스타일: 로그 접근자 = 머신 소유자. 터널/타넷/로컬 어디서 붙어도 이 토큰으로 셋업 가능.)
{
  const m = authMode();
  if (m.mode === 'disabled') {
    if (config.auth.disabled) {
      console.warn('[coxpit] auth is DISABLED (COXPIT_AUTH_DISABLED=1) — every request is allowed. Front it with your own gateway if exposed.');
    } else if (!isExposedBind()) {
      console.log(`[coxpit] loopback-only bind (${config.host}) — trusted local, no login required. Bind to 0.0.0.0 to require an access key.`);
    }
  } else if (m.mode === 'setup') {
    const token = ensureSetupToken();
    console.log(
      '[coxpit] no access key configured yet — open the board to set one (first-run setup).\n' +
      `[coxpit] one-time setup token (needed unless you visit http://127.0.0.1:${config.port} directly): ${token}`,
    );
  } else if (m.mode === 'env') {
    console.log('[coxpit] access-key auth ON (COXPIT_AUTH_PASS) — the branded unlock page asks for that key.');
  } else {
    console.log('[coxpit] access-key auth ON (stored key) — the branded unlock page asks for your key.');
  }
}
