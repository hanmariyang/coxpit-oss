import { config } from './config';
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
