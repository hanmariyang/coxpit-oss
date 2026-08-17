import { config } from './config';
import { db, ensureSchema } from './db';
import { machines } from './db/schema';
import { buildServer } from './server';

await ensureSchema();

// 첫 실행 시 로컬 머신 시드(데몬이 도는 이 기계).
if ((await db.select().from(machines)).length === 0) {
  await db.insert(machines).values({ slug: 'local', name: 'This machine', kind: 'local', online: true });
}

const app = await buildServer();
await app.listen({ host: config.host, port: config.port });
