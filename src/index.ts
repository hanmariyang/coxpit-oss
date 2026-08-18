import { config } from './config';
import { db, ensureSchema } from './db';
import { machines } from './db/schema';
import { acquireDaemonLock } from './lock';
import { reconcileOrphanRuns } from './orchestrator';
import { buildServer } from './server';

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
