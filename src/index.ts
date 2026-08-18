import { config } from './config';
import { db, ensureSchema } from './db';
import { machines } from './db/schema';
import { reconcileOrphanRuns } from './orchestrator';
import { buildServer } from './server';

await ensureSchema();

// 첫 실행 시 로컬 머신 시드(데몬이 도는 이 기계).
if ((await db.select().from(machines)).length === 0) {
  await db.insert(machines).values({ slug: 'local', name: 'This machine', kind: 'local', online: true });
}

// 재시작으로 고아가 된 running run 정산(카드가 영원히 '진행 중'으로 남는 것 방지).
const orphans = await reconcileOrphanRuns();
if (orphans > 0) console.log(`[coxpit] settled ${orphans} orphaned run(s) from a previous daemon instance`);

const app = await buildServer();
await app.listen({ host: config.host, port: config.port });
