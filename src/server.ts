import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { eq } from 'drizzle-orm';
import { authGate } from './auth';
import { config } from './config';
import { db } from './db';
import { machines, repos, tasks, agentRuns, agentEvents, designCaptures } from './db/schema';
import { BOOKMARKLET_JS } from './design';
import { runShellOn, shq } from './exec';
import { launchRun, cleanupRun, stopRun, getRunDiff, mergeRun, getRunTermInfo } from './orchestrator';
import { openTerm } from './term';
import { addSink, removeSink, broadcast } from './hub';
import { BOARD_HTML } from './board';

const require_ = createRequire(import.meta.url);

// 자가완결 서빙 — CDN 없이 node_modules 의 xterm 배포본을 그대로 낸다.
const VENDOR: Record<string, { pkg: string; rel: string; type: string }> = {
  'xterm.js': { pkg: '@xterm/xterm/package.json', rel: 'lib/xterm.js', type: 'text/javascript' },
  'xterm.css': { pkg: '@xterm/xterm/package.json', rel: 'css/xterm.css', type: 'text/css' },
  'addon-fit.js': { pkg: '@xterm/addon-fit/package.json', rel: 'lib/addon-fit.js', type: 'text/javascript' },
};

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  await app.register(websocket);
  app.addHook('onRequest', authGate);

  // 무인증 헬스(외부 감시용)
  app.get('/api/health', async () => ({ ok: true, name: 'coxpit', version: '2.0.0-p1' }));

  // 플릿 보드(단일 페이지). 인증 게이트 적용됨.
  app.get('/', async (_req, reply) => reply.type('text/html').send(BOARD_HTML));

  // 보드 하이드레이션 — machines/repos/tasks/runs(+events)/captures 한 방에.
  app.get('/api/fleet', async () => {
    const [ms, rs, ts, rns, evs, dcs] = await Promise.all([
      db.select().from(machines),
      db.select().from(repos),
      db.select().from(tasks),
      db.select().from(agentRuns),
      db.select().from(agentEvents),
      db.select().from(designCaptures),
    ]);
    const byRun = new Map<number, Array<{ kind: string; payload: string }>>();
    for (const e of evs) {
      const arr = byRun.get(e.runId) ?? [];
      arr.push({ kind: e.kind, payload: e.payload });
      byRun.set(e.runId, arr);
    }
    return {
      machines: ms, repos: rs, tasks: ts, captures: dcs,
      runs: rns.map((r) => ({ ...r, events: byRun.get(r.id) ?? [] })),
    };
  });

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

  // ─── Design Mode ───────────────────────────────────────────────
  // 캡처 키: 인증 off 면 자유, on 이면 ?k=<COXPIT_AUTH_PASS> (북마클릿은 basic 헤더 불가)
  const captureKeyOk = (req: { query?: unknown }): boolean => {
    if (config.auth.disabled || config.auth.pass === '') return config.auth.disabled;
    return ((req.query ?? {}) as { k?: string }).k === config.auth.pass;
  };
  const cors = (reply: { header: (k: string, v: string) => unknown }) => {
    reply.header('access-control-allow-origin', '*');
    reply.header('access-control-allow-methods', 'POST, OPTIONS');
    reply.header('access-control-allow-headers', 'content-type');
  };

  app.options('/api/design/capture', async (_req, reply) => { cors(reply); return reply.code(204).send(); });

  app.post('/api/design/capture', async (req, reply) => {
    cors(reply);
    if (!captureKeyOk(req)) return reply.code(401).send({ error: 'bad capture key' });
    const b = (req.body ?? {}) as { url?: string; selector?: string; html?: string; css?: string; note?: string };
    const ins = await db.insert(designCaptures).values({
      url: (b.url ?? '').slice(0, 500),
      selector: (b.selector ?? '').slice(0, 500),
      html: (b.html ?? '').slice(0, 8000),
      css: (b.css ?? '').slice(0, 4000),
      note: (b.note ?? '').slice(0, 200),
    }).returning();
    broadcast({ type: 'capture', capture: ins[0] });
    return reply.code(201).send({ ok: true, id: ins[0]!.id });
  });

  app.get('/api/design', async () => ({ captures: await db.select().from(designCaptures) }));

  app.delete('/api/design/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    await db.delete(designCaptures).where(eq(designCaptures.id, id));
    return reply.code(200).send({ ok: true });
  });

  // 북마클릿 본체 — 외부 앱 <script> 로 로드됨(인증 예외, 키는 src 쿼리로 전달)
  app.get('/design/bookmarklet.js', async (_req, reply) =>
    reply.type('text/javascript').header('cache-control', 'no-store').send(BOOKMARKLET_JS));

  // ─── Task ──────────────────────────────────────────────────────
  app.get('/api/tasks', async (req) => {
    const q = (req.query ?? {}) as { repo?: string };
    if (q.repo) {
      const id = Number(q.repo);
      return { tasks: await db.select().from(tasks).where(eq(tasks.repoId, id)) };
    }
    return { tasks: await db.select().from(tasks) };
  });

  app.post('/api/tasks', async (req, reply) => {
    const b = (req.body ?? {}) as { repoId?: number; title?: string; prompt?: string; designCaptureId?: number };
    const repoId = Number(b.repoId);
    const title = (b.title ?? '').trim();
    if (!repoId || !title) return reply.code(400).send({ error: 'repoId and title required' });
    const rp = await db.select().from(repos).where(eq(repos.id, repoId)).limit(1);
    if (!rp[0]) return reply.code(404).send({ error: 'repo not found' });
    let designCaptureId: number | null = null;
    if (b.designCaptureId) {
      const dc = await db.select().from(designCaptures).where(eq(designCaptures.id, Number(b.designCaptureId))).limit(1);
      if (!dc[0]) return reply.code(404).send({ error: 'design capture not found' });
      designCaptureId = dc[0].id;
    }
    const ins = await db.insert(tasks).values({ repoId, title, prompt: b.prompt ?? '', designCaptureId }).returning();
    return reply.code(201).send({ ok: true, task: ins[0] });
  });

  app.get('/api/tasks/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const tr = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    if (!tr[0]) return reply.code(404).send({ error: 'not found' });
    const runs = await db.select().from(agentRuns).where(eq(agentRuns.taskId, id));
    return { task: tr[0], runs };
  });

  // N개의 에이전트 run 을 만들고 각자 오케스트레이션 시작(fire-and-forget).
  app.post('/api/tasks/:id/run', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { agent?: string; count?: number; real?: boolean };
    const tr = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    const task = tr[0];
    if (!task) return reply.code(404).send({ error: 'task not found' });
    const rp = await db.select().from(repos).where(eq(repos.id, task.repoId)).limit(1);
    if (!rp[0]) return reply.code(404).send({ error: 'repo missing' });

    const count = Math.max(1, Math.min(8, Number(b.count) || 1));
    const agent = b.agent ?? 'claude-code';
    const created: Array<typeof agentRuns.$inferSelect> = [];
    for (let i = 0; i < count; i++) {
      const ins = await db.insert(agentRuns)
        .values({ taskId: id, machineId: rp[0].machineId, agent, status: 'pending' })
        .returning();
      created.push(ins[0]!);
    }
    // 보드가 taskId 를 알도록 생성 브로드캐스트 후 백그라운드 시작.
    for (const r of created) {
      broadcast({ type: 'run', runId: r.id, taskId: id, status: 'pending', agent, branch: '', filesChanged: 0 });
      void launchRun(r.id, b.real);
    }
    return reply.code(202).send({ ok: true, runs: created.map((r) => ({ id: r.id, status: r.status })) });
  });

  // 비교 뷰 — 태스크의 모든 run + 각 diff 를 한 방에 (승자 고르기용).
  app.get('/api/tasks/:id/compare', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const tr = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    if (!tr[0]) return reply.code(404).send({ error: 'task not found' });
    const trs = await db.select().from(agentRuns).where(eq(agentRuns.taskId, id));
    const runsOut = [];
    for (const r of trs) {
      const d = await getRunDiff(r.id);
      runsOut.push({ ...r, diff: d.ok ? d.diff : '', stat: d.ok ? d.stat : d.stat });
    }
    return { task: tr[0], runs: runsOut };
  });

  // 태스크 닫기 — 살아있는 run 중지 후 소속 run 전체 worktree/브랜치 정리.
  app.post('/api/tasks/:id/close', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const tr = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    if (!tr[0]) return reply.code(404).send({ error: 'task not found' });
    const trs = await db.select().from(agentRuns).where(eq(agentRuns.taskId, id));

    let anyStopped = false;
    for (const r of trs) {
      if ((await stopRun(r.id)).ok) anyStopped = true;
    }
    // SIGTERM 직후 worktree 파일 잠금이 풀리도록 잠깐 양보
    if (anyStopped) await new Promise((res) => setTimeout(res, 400));

    const cleanups = [];
    for (const r of trs) cleanups.push({ runId: r.id, ...(await cleanupRun(r.id)) });

    await db.update(tasks).set({ status: 'closed' }).where(eq(tasks.id, id));
    broadcast({ type: 'task', taskId: id, status: 'closed' });
    return { ok: true, taskId: id, cleanups };
  });

  // ─── Run ───────────────────────────────────────────────────────
  app.get('/api/runs/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
    if (!rr[0]) return reply.code(404).send({ error: 'not found' });
    const events = await db.select().from(agentEvents).where(eq(agentEvents.runId, id));
    return { run: rr[0], events };
  });

  app.post('/api/runs/:id/cleanup', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
    if (!rr[0]) return reply.code(404).send({ error: 'not found' });
    const res = await cleanupRun(id);
    return res;
  });

  // 승자 run 머지 — run 브랜치를 repo 기본 브랜치로.
  app.post('/api/runs/:id/merge', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
    if (!rr[0]) return reply.code(404).send({ error: 'not found' });
    const res = await mergeRun(id);
    if (!res.ok) return reply.code(409).send(res);
    return res;
  });

  // 실행 중 run 중지(SIGTERM) — close 핸들러가 stopped 로 봉인.
  app.post('/api/runs/:id/stop', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
    if (!rr[0]) return reply.code(404).send({ error: 'not found' });
    return stopRun(id);
  });

  // run worktree 의 변경 diff(tracked + untracked)
  app.get('/api/runs/:id/diff', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
    if (!rr[0]) return reply.code(404).send({ error: 'not found' });
    return getRunDiff(id);
  });

  // 라이브 스트림 좌석 — 오케스트레이터가 run/event 를 여기로 broadcast.
  app.get('/ws', { websocket: true }, (socket) => {
    addSink(socket);
    socket.send(JSON.stringify({ type: 'hello', name: 'coxpit-fleet', version: '2.0.0-p1' }));
    socket.on('close', () => removeSink(socket));
  });

  // xterm 배포본 서빙(브라우저 터미널용, CDN 없음)
  app.get('/vendor/:file', async (req, reply) => {
    const { file } = req.params as { file: string };
    const v = VENDOR[file];
    if (!v) return reply.code(404).send({ error: 'not found' });
    const path = require_.resolve(v.pkg).replace(/package\.json$/, v.rel);
    const body = await readFile(path);
    return reply.type(v.type).header('cache-control', 'public, max-age=86400').send(body);
  });

  // run 터미널 — tmux 세션에 PTY attach, WS 로 중계.
  // client → {t:'i',d:string} 입력 · {t:'r',cols,rows} 리사이즈 / server → {t:'o',d} 출력 · {t:'exit'}
  app.get('/ws/term/:id', { websocket: true }, async (socket, req) => {
    const id = Number((req.params as { id: string }).id);
    const info = await getRunTermInfo(id);
    if (!info) {
      socket.send(JSON.stringify({ t: 'err', d: 'run or tmux session not found' }));
      socket.close();
      return;
    }
    // 세션 생존 확인(정리됐거나 머신 재부팅이면 attach 가 바로 죽는다)
    const has = await runShellOn(info.machine, `tmux has-session -t ${shq(info.session)} 2>&1`, 8000);
    if (!has.ok) {
      socket.send(JSON.stringify({ t: 'err', d: `tmux session '${info.session}' not available` }));
      socket.close();
      return;
    }
    let term;
    try {
      term = openTerm(info.machine, info.session, 80, 24);
    } catch (e) {
      socket.send(JSON.stringify({ t: 'err', d: 'pty spawn failed: ' + String(e).slice(0, 200) }));
      socket.close();
      return;
    }
    term.onData((d) => { try { socket.send(JSON.stringify({ t: 'o', d })); } catch { /* closed */ } });
    term.onExit(() => { try { socket.send(JSON.stringify({ t: 'exit' })); socket.close(); } catch { /* closed */ } });
    socket.on('message', (raw: Buffer) => {
      try {
        const m = JSON.parse(raw.toString()) as { t?: string; d?: string; cols?: number; rows?: number };
        if (m.t === 'i' && typeof m.d === 'string') term.write(m.d);
        else if (m.t === 'r' && m.cols && m.rows) term.resize(Math.max(20, Math.min(500, m.cols)), Math.max(5, Math.min(200, m.rows)));
      } catch { /* ignore */ }
    });
    socket.on('close', () => { try { term.kill(); } catch { /* gone */ } });
  });

  return app;
}
