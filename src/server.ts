import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { eq } from 'drizzle-orm';
import { authGate } from './auth';
import { db } from './db';
import { machines, repos } from './db/schema';
import { runShellOn, shq } from './exec';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  await app.register(websocket);
  app.addHook('onRequest', authGate);

  // 무인증 헬스(외부 감시용)
  app.get('/api/health', async () => ({ ok: true, name: 'coxpit', version: '2.0.0-p1' }));

  // ─── 머신 레지스트리 ────────────────────────────────────────────
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

  // 머신 상세 + 소속 repo
  app.get('/api/machines/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const rows = await db.select().from(machines).where(eq(machines.slug, slug)).limit(1);
    const m = rows[0];
    if (!m) return reply.code(404).send({ error: 'not found' });
    const mrepos = await db.select().from(repos).where(eq(repos.machineId, m.id));
    return { machine: m, repos: mrepos };
  });

  // 도달성 프로브 — SSH(또는 로컬)로 git/tmux/os 확인, online/lastSeen 갱신.
  app.post('/api/machines/:slug/probe', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const rows = await db.select().from(machines).where(eq(machines.slug, slug)).limit(1);
    const m = rows[0];
    if (!m) return reply.code(404).send({ error: 'not found' });

    const cmd = [
      'echo GIT:$(git --version 2>&1)',
      'echo TMUX:$(tmux -V 2>&1)',
      'echo OS:$(uname -sr 2>&1)',
    ].join('; ');
    const r = await runShellOn(m, cmd);

    const pick = (key: string): string => {
      const line = r.stdout.split('\n').find((l) => l.startsWith(`${key}:`));
      return line ? line.slice(key.length + 1).trim() : '';
    };
    const gitStr = pick('GIT');
    const tmuxStr = pick('TMUX');
    const reachable = r.ok;
    const git = { ok: /git version/i.test(gitStr), version: gitStr };
    const tmux = { ok: /tmux \d/i.test(tmuxStr), version: tmuxStr };

    await db.update(machines)
      .set({ online: reachable, lastSeen: new Date() })
      .where(eq(machines.id, m.id));

    return {
      slug, reachable,
      git, tmux, os: pick('OS'),
      ready: reachable && git.ok && tmux.ok,
      error: reachable ? undefined : (r.stderr.trim() || `ssh exit ${r.code}`),
    };
  });

  // ─── Repo 레지스트리 ────────────────────────────────────────────
  app.get('/api/repos', async (req) => {
    const q = (req.query ?? {}) as { machine?: string };
    if (q.machine) {
      const mr = await db.select().from(machines).where(eq(machines.slug, q.machine)).limit(1);
      if (!mr[0]) return { repos: [] };
      return { repos: await db.select().from(repos).where(eq(repos.machineId, mr[0].id)) };
    }
    return { repos: await db.select().from(repos) };
  });

  // repo 등록 — 경로가 실제 git work-tree 인지 원격/로컬 검증 후 insert.
  app.post('/api/repos', async (req, reply) => {
    const b = (req.body ?? {}) as { machineSlug?: string; path?: string; name?: string };
    const machineSlug = (b.machineSlug ?? '').trim();
    const path = (b.path ?? '').trim();
    if (!machineSlug || !path) return reply.code(400).send({ error: 'machineSlug and path required' });

    const mr = await db.select().from(machines).where(eq(machines.slug, machineSlug)).limit(1);
    const m = mr[0];
    if (!m) return reply.code(404).send({ error: 'machine not found' });

    const cmd =
      `git -C ${shq(path)} rev-parse --is-inside-work-tree 2>&1` +
      ` && echo '---B---'` +
      ` && git -C ${shq(path)} rev-parse --abbrev-ref HEAD 2>&1`;
    const r = await runShellOn(m, cmd);
    const isRepo = r.ok && /(^|\n)true(\n|$)/.test(r.stdout);
    if (!isRepo) {
      return reply.code(400).send({
        error: 'not a git work-tree',
        detail: (r.stdout || r.stderr).trim().slice(0, 400),
      });
    }
    const branch = (r.stdout.split('---B---')[1] ?? '').trim() || 'main';
    const name = (b.name ?? '').trim() || path.split('/').filter(Boolean).pop() || path;

    const ins = await db.insert(repos).values({
      machineId: m.id, path, name, defaultBranch: branch,
    }).returning();

    return reply.code(201).send({ ok: true, repo: ins[0] });
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
