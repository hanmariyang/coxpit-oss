import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { authGate } from './auth';
import { db } from './db';
import { machines } from './db/schema';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  await app.register(websocket);
  app.addHook('onRequest', authGate);

  // 무인증 헬스(외부 감시용)
  app.get('/api/health', async () => ({ ok: true, name: 'coxpit', version: '2.0.0-p1' }));

  // 머신 레지스트리 (P1: 로컬/원격 등록)
  app.get('/api/machines', async () => ({ machines: await db.select().from(machines) }));

  app.post('/api/machines', async (req, reply) => {
    const b = (req.body ?? {}) as {
      slug?: string; name?: string; address?: string; sshUser?: string; kind?: string;
    };
    const slug = (b.slug ?? '').trim();
    if (!slug) return reply.code(400).send({ error: 'slug required' });
    try {
      await db.insert(machines).values({
        slug,
        name: b.name ?? slug,
        address: b.address ?? '',
        sshUser: b.sshUser ?? '',
        kind: b.kind ?? (b.address ? 'remote' : 'local'),
      });
    } catch {
      return reply.code(409).send({ error: 'slug exists' });
    }
    return reply.code(201).send({ ok: true, slug });
  });

  // 라이브 스트림 좌석 — P1 오케스트레이션에서 AgentRun 이벤트를 여기로 push.
  app.get('/ws', { websocket: true }, (socket) => {
    socket.send(JSON.stringify({ type: 'hello', name: 'coxpit-fleet', version: '2.0.0-p1' }));
    socket.on('message', (raw: Buffer) => {
      socket.send(JSON.stringify({ type: 'echo', data: raw.toString() }));
    });
  });

  return app;
}
