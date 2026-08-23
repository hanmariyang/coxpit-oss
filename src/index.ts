import { config } from './config';
import { authMode, ensureSetupToken, isExposedBind } from './authkey';
import { db, ensureSchema } from './db';
import { machines } from './db/schema';
import { acquireDaemonLock, updateLockPort } from './lock';
import { reconcileOrphanRuns } from './orchestrator';
import { buildServer } from './server';
import type { AddressInfo } from 'node:net';

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

// 포트 바인드 — 선호 포트가 점유면 자동으로 다음 빈 포트로 이동(고정 포트가 필수면
// COXPIT_PORT_STRICT=1 로 실패 처리). 어떤 고정 포트에도 의존하지 않아 "포트 점유로 죽는" 케이스 소멸.
async function listenAuto(): Promise<number> {
  const pref = config.port;
  const tryBind = async (p: number) => { await app.listen({ host: config.host, port: p }); };
  try {
    await tryBind(pref);
    return pref;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') throw e;
    if (config.portStrict) {
      console.error(`[coxpit] port ${pref} is already in use and COXPIT_PORT_STRICT=1 — refusing to move. Free the port or unset strict.`);
      process.exit(1);
    }
  }
  // pref+1..+20 스캔 → 그래도 없으면 OS 배정(:0).
  for (let p = pref + 1; p <= pref + 20; p++) {
    try { await tryBind(p); console.warn(`[coxpit] port ${pref} was busy — moved to ${p}.`); return p; }
    catch (e) { if ((e as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') throw e; }
  }
  await app.listen({ host: config.host, port: 0 });
  const p = (app.server.address() as AddressInfo).port;
  console.warn(`[coxpit] ports ${pref}..${pref + 20} were busy — moved to OS-assigned ${p}.`);
  return p;
}
const boundPort = await listenAuto();
updateLockPort(boundPort);   // 락에 실제 포트 반영 — 데스크톱/외부가 이걸 읽어 붙는다.
console.log(`[coxpit] listening on http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${boundPort}/`);

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
      `[coxpit] one-time setup token (needed unless you visit http://127.0.0.1:${boundPort} directly): ${token}`,
    );
  } else if (m.mode === 'env') {
    console.log('[coxpit] access-key auth ON (COXPIT_AUTH_PASS) — the branded unlock page asks for that key.');
  } else {
    console.log('[coxpit] access-key auth ON (stored key) — the branded unlock page asks for your key.');
  }
}
