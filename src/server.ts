import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as presolve, dirname as pdirname, join as pjoin } from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { eq } from 'drizzle-orm';
import { authGate } from './auth';
import { config } from './config';
import { db } from './db';
import { machines, repos, tasks, agentRuns, agentEvents, designCaptures, shareLinks } from './db/schema';
import { BOOKMARKLET_JS } from './design';
import { runShellOn, shq } from './exec';
import { launchRun, cleanupRun, stopRun, getRunDiff, getRunDocs, mergeRun, getRunTermInfo, steerRun, exportRun, prRun, integrateRuns, planFanout, reviewTask, syncRun, openWorkbench, spawnSubtasks, listSubtasks, resolveAgentToken } from './orchestrator';
import { openTerm } from './term';
import { addSink, removeSink, broadcast } from './hub';
import { getProvider, listProviders } from './providers';
import { BOARD_HTML } from './board';

const require_ = createRequire(import.meta.url);

// 자가완결 서빙 — CDN 없이 node_modules 의 xterm 배포본을 그대로 낸다.
const VENDOR: Record<string, { pkg: string; rel: string; type: string }> = {
  'xterm.js': { pkg: '@xterm/xterm/package.json', rel: 'lib/xterm.js', type: 'text/javascript' },
  'xterm.css': { pkg: '@xterm/xterm/package.json', rel: 'css/xterm.css', type: 'text/css' },
  'addon-fit.js': { pkg: '@xterm/addon-fit/package.json', rel: 'lib/addon-fit.js', type: 'text/javascript' },
  'addon-unicode11.js': { pkg: '@xterm/addon-unicode11/package.json', rel: 'lib/addon-unicode11.js', type: 'text/javascript' },
};

// ─── 읽기 전용 공유 페이지 (서버 렌더 스냅샷 — 스크립트 0, 액션 0) ───────────
const escH = (x: unknown): string =>
  String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** 보드 humanize 의 서버측 축약판 — 이벤트 한 줄을 {k, t} 로. null = 잡음. */
function shareLine(kind: string, payload: string): { k: string; t: string } | null {
  if (kind === 'steer') return { k: 'steer', t: '→ ' + payload };
  if (kind === 'ask') return { k: 'ask', t: '? ' + payload };
  if (kind === 'sync' || kind === 'pr' || kind === 'export') return { k: kind, t: payload };
  if (kind === 'stderr' || kind === 'error') return { k: kind, t: payload };
  try {
    const o = JSON.parse(payload) as {
      type?: string; subtype?: string; text?: string; result?: string; worktree?: string;
      message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: Record<string, string> }> };
    };
    if (o.type === 'system') return o.subtype === 'init' || !o.subtype ? { k: 'session', t: 'started' } : null;
    if (o.type === 'user') return null;
    if (o.type === 'assistant' && o.message) {
      const parts: string[] = [];
      for (const c of o.message.content ?? []) {
        if (c.type === 'text' && c.text) parts.push(c.text);
        else if (c.type === 'tool_use') {
          const i = c.input ?? {};
          const arg = i.file_path || i.command || i.path || i.pattern || '';
          parts.push('▸ ' + (c.name ?? 'tool') + (arg ? ' — ' + String(arg).split('/').slice(-2).join('/').slice(0, 60) : ''));
        }
      }
      return parts.length ? { k: 'agent', t: parts.join(' · ') } : null;
    }
    if (o.type === 'assistant' && o.text) return { k: 'said', t: o.text };
    if (o.type === 'result') return { k: 'done', t: o.result || 'finished' };
    if (kind === 'meta' && o.worktree) return { k: 'start', t: 'worktree ' + String(o.worktree).split('/').slice(-2).join('/') };
    return null;
  } catch { return payload.trim().startsWith('{') ? null : { k: kind, t: payload.slice(0, 160) }; }
}

function shareDiffHTML(text: string): string {
  if (!text.trim()) return '<span style="color:#5c6675">no changes</span>';
  return text.slice(0, 120_000).split('\n').map((l) => {
    const e = escH(l);
    if (l.startsWith('diff --git') || l.startsWith('+++') || l.startsWith('---')) return `<span class="f">${e}</span>`;
    if (l.startsWith('@@')) return `<span class="h">${e}</span>`;
    if (l.startsWith('+')) return `<span class="a">${e}</span>`;
    if (l.startsWith('-')) return `<span class="d">${e}</span>`;
    return e;
  }).join('\n');
}

function sharePageHTML(
  run: { id: number; status: string; branch: string; agent: string; filesChanged: number; exitSummary: string },
  taskTitle: string,
  events: Array<{ kind: string; payload: string }>,
  diff: string,
): string {
  const lines = events.map((e) => shareLine(e.kind, e.payload)).filter((x): x is { k: string; t: string } => !!x);
  const sc: Record<string, string> = { done: '#3fb970', merged: '#4ec9b0', failed: '#e5534b', error: '#e5534b', stopped: '#a371f7', running: '#4184e4', open: '#4ec9b0' };
  const color = sc[run.status] ?? '#8792a2';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>coxpit · r${run.id} — ${escH(taskTitle)}</title>
<style>
  body{margin:0;background:#0b0d12;color:#dee4ec;font-family:-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.55}
  .wrap{max-width:960px;margin:0 auto;padding:28px 18px 60px}
  .hd{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:4px}
  .mark{color:#4ec9b0;font-family:ui-monospace,monospace;font-weight:700}
  .rid{color:#5c6675;font-family:ui-monospace,monospace}
  h1{font-size:17px;margin:6px 0 2px}
  .chip{display:inline-block;font-family:ui-monospace,monospace;font-size:11px;text-transform:uppercase;letter-spacing:.08em;
    padding:2px 10px;border:1px solid ${color};border-radius:999px;color:${color}}
  .meta{color:#5c6675;font-family:ui-monospace,monospace;font-size:11.5px;margin:8px 0 22px}
  .sec{font-family:ui-monospace,monospace;font-size:10px;text-transform:uppercase;letter-spacing:.14em;color:#5c6675;
    border-bottom:1px solid #222835;padding-bottom:6px;margin:26px 0 10px}
  .tl{font-family:ui-monospace,monospace;font-size:12px;display:flex;flex-direction:column;gap:6px}
  .tl .k{color:#4ec9b0;display:inline-block;min-width:64px}
  .tl .t{color:#8792a2;word-break:break-word}
  pre{background:#0e1118;border:1px solid #222835;border-radius:10px;padding:14px;overflow-x:auto;
    font-family:ui-monospace,monospace;font-size:11.5px;line-height:1.5;white-space:pre-wrap;word-break:break-all}
  .f{color:#4ec9b0;font-weight:600}.h{color:#4184e4}.a{color:#3fb970}.d{color:#e5534b}
  .sum{background:#12151c;border:1px solid #222835;border-radius:10px;padding:12px 14px;color:#8792a2;font-size:13px}
  .ft{margin-top:40px;color:#3d4657;font-size:12px;font-family:ui-monospace,monospace}
  .ft a{color:#4ec9b0;text-decoration:none}
</style></head><body><div class="wrap">
  <div class="hd"><span class="mark">coxpit</span><span class="rid">r${run.id}</span><span class="chip">${escH(run.status)}</span></div>
  <h1>${escH(taskTitle)}</h1>
  <div class="meta">branch ${escH(run.branch || '—')} · ${run.filesChanged} file(s) changed · agent ${escH(run.agent)}</div>
  ${run.exitSummary ? `<div class="sum">${escH(run.exitSummary)}</div>` : ''}
  <div class="sec">Timeline</div>
  <div class="tl">${lines.map((l) => `<div><span class="k">${escH(l.k)}</span><span class="t">${escH(l.t.slice(0, 220))}</span></div>`).join('') || '<span style="color:#5c6675">no events</span>'}</div>
  <div class="sec">Diff</div>
  <pre>${shareDiffHTML(diff)}</pre>
  <div class="ft">read-only snapshot shared via <a href="https://github.com/hanmariyang/coxpit-oss">coxpit</a></div>
</div></body></html>`;
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  await app.register(websocket);
  app.addHook('onRequest', authGate);

  // 무인증 헬스(외부 감시용)
  app.get('/api/health', async () => ({ ok: true, name: 'coxpit', version: config.version }));

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
      // 보드 헤더 "어느 데몬에 붙어 있나" 표시용 (인증 뒤라 dbPath 노출 가능)
      daemon: { version: config.version, pid: process.pid, port: config.port, dbPath: config.dbPath },
      providers: listProviders(),
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

    const agentBin = config.agent.bin;
    const codexBin = config.codex.bin;
    const cmd = [
      'echo GIT:$(git --version 2>&1)',
      'echo TMUX:$(tmux -V 2>&1)',
      `echo AGENT:$(command -v ${shq(agentBin)} >/dev/null 2>&1 && ${shq(agentBin)} --version 2>/dev/null | head -1 || echo missing)`,
      `echo CODEX:$(command -v ${shq(codexBin)} >/dev/null 2>&1 && ${shq(codexBin)} --version 2>/dev/null | head -1 || echo missing)`,
      'echo OS:$(uname -sr 2>&1)',
    ].join('; ');
    const r = await runShellOn(m, cmd, 20000);

    const pick = (key: string): string => {
      const line = r.stdout.split('\n').find((l) => l.startsWith(`${key}:`));
      return line ? line.slice(key.length + 1).trim() : '';
    };
    const gitStr = pick('GIT');
    const tmuxStr = pick('TMUX');
    const agentStr = pick('AGENT');
    const codexStr = pick('CODEX');
    const reachable = r.ok;
    const git = { ok: /git version/i.test(gitStr), version: gitStr };
    const tmux = { ok: /tmux \d/i.test(tmuxStr), version: tmuxStr };
    // 에이전트 CLI 존재 여부(인증까지는 여기서 알 수 없음 — 첫 real run 이 판정)
    const agent = { ok: agentStr !== '' && agentStr !== 'missing', version: agentStr, bin: agentBin };
    // 두 번째 프로바이더(선택) — 없어도 ready 판정엔 영향 없음
    const codex = { ok: codexStr !== '' && codexStr !== 'missing', version: codexStr, bin: codexBin };

    await db.update(machines)
      .set({ online: reachable, lastSeen: new Date() })
      .where(eq(machines.id, m.id));

    return {
      slug, reachable,
      git, tmux, agent, codex, os: pick('OS'),
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

    // 기본 브랜치는 "지금 체크아웃된 브랜치"가 아니라 repo 의 진짜 기본값:
    // origin/HEAD → 로컬 main/master → 현재 HEAD 순으로 감지.
    const g = `git -C ${shq(path)}`;
    const cmd =
      `${g} rev-parse --is-inside-work-tree 2>&1` +
      ` && echo '---B---'` +
      ` && { ${g} symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true; }` +
      ` && echo '---C---'` +
      ` && { ${g} show-ref --verify -q refs/heads/main && echo main || { ${g} show-ref --verify -q refs/heads/master && echo master; } || true; }` +
      ` && echo '---D---'` +
      ` && ${g} rev-parse --abbrev-ref HEAD 2>&1`;
    const r = await runShellOn(m, cmd);
    const isRepo = r.ok && /(^|\n)true(\n|$)/.test(r.stdout);
    if (!isRepo) {
      return reply.code(400).send({
        error: 'not a git work-tree',
        detail: (r.stdout || r.stderr).trim().slice(0, 400),
      });
    }
    const seg = (a: string, b: string): string =>
      ((r.stdout.split(a)[1] ?? '').split(b)[0] ?? '').trim();
    const originHead = seg('---B---', '---C---').replace(/^origin\//, '');
    const localMain = seg('---C---', '---D---');
    const headNow = (r.stdout.split('---D---')[1] ?? '').trim();
    const branch = originHead || localMain || headNow || 'main';
    const name = (b.name ?? '').trim() || path.split('/').filter(Boolean).pop() || path;

    const ins = await db.insert(repos).values({
      machineId: m.id, path, name, defaultBranch: branch,
    }).returning();

    return reply.code(201).send({ ok: true, repo: ins[0] });
  });

  // repo 삭제 — 열린 태스크가 있으면 거부(이력 보호).
  app.delete('/api/repos/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const rp = await db.select().from(repos).where(eq(repos.id, id)).limit(1);
    if (!rp[0]) return reply.code(404).send({ error: 'not found' });
    const open = (await db.select().from(tasks).where(eq(tasks.repoId, id))).filter((t) => t.status !== 'closed');
    if (open.length) return reply.code(409).send({ ok: false, detail: `close ${open.length} open task(s) on this repo first` });
    await db.delete(repos).where(eq(repos.id, id));
    return { ok: true };
  });

  // 디렉토리 브라우저 — repo 등록용 파일 피커(로컬 머신 전용, 인증 게이트 뒤).
  app.get('/api/browse', async (req) => {
    const q = (req.query ?? {}) as { path?: string };
    const start = q.path && q.path.startsWith('/') ? q.path : homedir();
    const p = presolve(start);
    let dirs: Array<{ name: string; isRepo: boolean }> = [];
    let error: string | undefined;
    try {
      const entries = await readdir(p, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        dirs.push({ name: e.name, isRepo: existsSync(pjoin(p, e.name, '.git')) });
        if (dirs.length >= 300) break;
      }
      dirs.sort((a, b) => (b.isRepo ? 1 : 0) - (a.isRepo ? 1 : 0) || a.name.localeCompare(b.name));
    } catch {
      error = 'cannot read directory';
      dirs = [];
    }
    return { path: p, parent: pdirname(p), home: homedir(), isRepo: existsSync(pjoin(p, '.git')), dirs, error };
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
    // 미지의 값은 기본 프로바이더로 정규화(런처 조작·API 오타 방어)
    const agent = getProvider(b.agent).id;
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

  // AI 리뷰 — 심판 에이전트가 run diff 들을 읽고 접근/장단점/추천을 요약.
  app.post('/api/tasks/:id/review', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { real?: boolean };
    const tr = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    if (!tr[0]) return reply.code(404).send({ error: 'task not found' });
    const res = await reviewTask(id, b.real === true);
    if (!res.ok) return reply.code(422).send(res);
    return res;
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

  // 후속 지시(steer) — 정착한 run 을 같은 세션(--resume)·같은 worktree 로 계속.
  app.post('/api/runs/:id/steer', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { message?: string; mode?: string };
    const message = (b.message ?? '').trim();
    if (!message) return reply.code(400).send({ error: 'message required' });
    const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
    if (!rr[0]) return reply.code(404).send({ error: 'not found' });
    const res = await steerRun(id, message, b.mode === 'ask' ? 'ask' : 'work');
    if (!res.ok) return reply.code(409).send(res);
    return reply.code(202).send(res);
  });

  // base 동기화 — 오래 사는 세션 worktree 에 base 최신 머지.
  app.post('/api/runs/:id/sync', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
    if (!rr[0]) return reply.code(404).send({ error: 'not found' });
    const res = await syncRun(id);
    if (!res.ok) return reply.code(409).send(res);
    return res;
  });

  // Workbench — 인터랙티브 작업방(worktree+tmux, 에이전트 없음).
  app.post('/api/workbench', async (req, reply) => {
    const b = (req.body ?? {}) as { repoId?: number; title?: string };
    const repoId = Number(b.repoId);
    if (!repoId) return reply.code(400).send({ error: 'repoId required' });
    const res = await openWorkbench(repoId, (b.title ?? '').trim());
    if (!res.ok) return reply.code(422).send(res);
    return reply.code(201).send(res);
  });

  // Plan fan-out — 목표 하나 → 플래너가 태스크 분해 → 전부 자동 발사.
  // (real 플래너는 repo 를 읽고 계획하느라 1~3분 걸릴 수 있음 — 클라이언트는 대기)
  app.post('/api/plan', async (req, reply) => {
    const b = (req.body ?? {}) as { repoId?: number; goal?: string; real?: boolean };
    const repoId = Number(b.repoId);
    const goal = (b.goal ?? '').trim();
    if (!repoId || !goal) return reply.code(400).send({ error: 'repoId and goal required' });
    if (goal.length > 4000) return reply.code(400).send({ error: 'goal too long' });
    const res = await planFanout(repoId, goal, b.real === true);
    if (!res.ok) return reply.code(422).send(res);
    return reply.code(202).send(res);
  });

  // 통합 — 여러 run(태스크 무관)을 base 에 순차 머지, 충돌은 통합 에이전트 자동 발사.
  app.post('/api/integrate', async (req, reply) => {
    const b = (req.body ?? {}) as { runIds?: number[]; real?: boolean };
    const ids = (b.runIds ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return reply.code(400).send({ error: 'runIds required' });
    if (ids.length > 20) return reply.code(400).send({ error: 'too many runs (max 20)' });
    const results = await integrateRuns(ids, b.real);
    return {
      ok: true,
      merged: results.filter((r) => r.status === 'merged').length,
      conflicts: results.filter((r) => r.status === 'conflict').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      results,
    };
  });

  // 결과 파일 회수 — 머지 없이 worktree 산출물만 지정 폴더로 복사(조회성 태스크).
  app.post('/api/runs/:id/export', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { dest?: string };
    const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
    if (!rr[0]) return reply.code(404).send({ error: 'not found' });
    const res = await exportRun(id, b.dest);
    if (!res.ok) return reply.code(409).send(res);
    return res;
  });

  // PR 모드 — run 브랜치 push + gh pr create.
  app.post('/api/runs/:id/pr', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
    if (!rr[0]) return reply.code(404).send({ error: 'not found' });
    const res = await prRun(id);
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

  // Doc 모드 — 변경된 문서(md/html)를 내용째 (렌더 비교용, 읽기 전용)
  app.get('/api/runs/:id/docs', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
    if (!rr[0]) return reply.code(404).send({ error: 'not found' });
    return getRunDocs(id);
  });

  // ─── 에이전트 셀프 오케스트레이션 (run 별 Bearer 토큰 — authGate 예외, 여기서 자체 검증) ──
  const agentAuth = (req: { headers: { authorization?: string } }): number | null => {
    const h = req.headers.authorization ?? '';
    if (!h.startsWith('Bearer ')) return null;
    return resolveAgentToken(h.slice(7).trim());
  };

  app.post('/api/agent/subtasks', async (req, reply) => {
    const rid = agentAuth(req);
    if (rid == null) return reply.code(401).send({ error: 'invalid agent token' });
    const b = (req.body ?? {}) as { title?: string; prompt?: string; count?: number };
    if (!b.title?.trim() || !b.prompt?.trim()) return reply.code(400).send({ error: 'title and prompt required' });
    const r = await spawnSubtasks(rid, b.title.trim(), b.prompt, Number(b.count) || 1);
    if (!r.ok) return reply.code(409).send({ error: r.detail });
    return reply.code(201).send(r);
  });

  app.get('/api/agent/subtasks', async (req, reply) => {
    const rid = agentAuth(req);
    if (rid == null) return reply.code(401).send({ error: 'invalid agent token' });
    return { subtasks: await listSubtasks(rid) };
  });

  // ─── GitHub 이슈/PR → 태스크 초안 (자동 발사 아님 — 사람이 검토 후 Run fleet) ──
  app.post('/api/tasks/from-github', async (req, reply) => {
    const b = (req.body ?? {}) as { url?: string };
    const m = (b.url ?? '').trim().match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d+)/);
    if (!m) return reply.code(400).send({ error: 'expected a github.com issue or pull request URL' });
    const [, owner, repo, kind, num] = m as unknown as [string, string, string, 'issues' | 'pull', string];
    const isPr = kind === 'pull';
    let title = '', body = '';
    // gh CLI 우선(사설 repo 는 gh 인증이 필요) — 없거나 실패하면 공개 API 폴백
    const local = { slug: 'local', kind: 'local', address: '', sshUser: '' };
    const ghCmd = `gh ${isPr ? 'pr' : 'issue'} view ${shq(b.url!.trim())} --json title,body`;
    const g = await runShellOn(local, `command -v gh >/dev/null 2>&1 && ${ghCmd}`, 20000);
    if (g.ok) {
      try { const j = JSON.parse(g.stdout) as { title?: string; body?: string }; title = j.title ?? ''; body = j.body ?? ''; } catch { /* fall through */ }
    }
    if (!title) {
      try {
        const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${num}`, {
          headers: { 'user-agent': 'coxpit', accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(10000),
        });
        if (r.ok) { const j = await r.json() as { title?: string; body?: string }; title = j.title ?? ''; body = j.body ?? ''; }
      } catch { /* unreachable/private */ }
    }
    if (!title) return reply.code(502).send({ error: 'could not fetch it — private repo needs the gh CLI signed in on the daemon machine' });
    return {
      ok: true,
      title: `${repo}#${num} · ${title}`.slice(0, 140),
      prompt: `GitHub ${isPr ? 'pull request' : 'issue'}: ${b.url!.trim()}\n\n# ${title}\n\n${(body || '(no description)').slice(0, 6000)}\n\n---\nWork in this repository to address the ${isPr ? 'pull request' : 'issue'} above. Keep the change minimal and verifiable, and say how to verify it in your final summary.`,
    };
  });

  // ─── 읽기 전용 공유 링크 — 토큰 URL 이 곧 능력(스냅샷 뷰, 액션 없음) ──
  app.post('/api/runs/:id/share', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
    if (!rr[0]) return reply.code(404).send({ error: 'not found' });
    const ex = await db.select().from(shareLinks).where(eq(shareLinks.runId, id));
    if (ex[0]) return { ok: true, url: `/share/${ex[0].token}`, existing: true };
    const token = randomBytes(12).toString('base64url');
    await db.insert(shareLinks).values({ runId: id, token });
    return reply.code(201).send({ ok: true, url: `/share/${token}` });
  });

  app.delete('/api/runs/:id/share', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    await db.delete(shareLinks).where(eq(shareLinks.runId, id));
    return { ok: true };
  });

  app.get('/share/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const sl = (await db.select().from(shareLinks).where(eq(shareLinks.token, token)).limit(1))[0];
    if (!sl) return reply.code(404).type('text/html').send('<!doctype html><meta charset="utf-8"><body style="background:#0b0d12;color:#8792a2;font-family:ui-monospace,monospace;padding:40px">share link not found or revoked</body>');
    const run = (await db.select().from(agentRuns).where(eq(agentRuns.id, sl.runId)).limit(1))[0];
    if (!run) return reply.code(404).send({ error: 'run gone' });
    const task = (await db.select().from(tasks).where(eq(tasks.id, run.taskId)).limit(1))[0];
    const evs = await db.select().from(agentEvents).where(eq(agentEvents.runId, run.id));
    const d = await getRunDiff(run.id).catch(() => ({ ok: false, diff: '', stat: '' }));
    return reply.type('text/html').send(sharePageHTML(run, task?.title ?? `task ${run.taskId}`, evs, d.ok ? d.diff : ''));
  });

  // 라이브 스트림 좌석 — 오케스트레이터가 run/event 를 여기로 broadcast.
  app.get('/ws', { websocket: true }, (socket) => {
    addSink(socket);
    socket.send(JSON.stringify({ type: 'hello', name: 'coxpit-fleet', version: config.version }));
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
  // 하드닝: ?cols&rows 초기 크기(80x24 경유 제거) · 세션 자동 소생 · keepalive · 백프레셔.
  app.get('/ws/term/:id', { websocket: true }, async (socket, req) => {
    const id = Number((req.params as { id: string }).id);
    const q = (req.query ?? {}) as { cols?: string; rows?: string };
    const cols = Math.max(20, Math.min(500, Number(q.cols) || 80));
    const rows = Math.max(5, Math.min(200, Number(q.rows) || 24));
    const info = await getRunTermInfo(id);
    if (!info) {
      socket.send(JSON.stringify({ t: 'err', d: 'run or tmux session not found' }));
      socket.close();
      return;
    }
    // 세션 자동 소생 — 셸 exit 등으로 죽었어도 worktree 가 살아있으면 그 자리에서 재생성
    const has = await runShellOn(info.machine, `tmux has-session -t ${shq('=' + info.session)} 2>&1`, 8000);
    if (!has.ok) {
      const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
      const wt = rr[0]?.worktreePath ?? '';
      const revive = wt
        ? await runShellOn(info.machine, `export LANG=${shq(config.lang)}; test -d ${shq(wt)} && tmux new-session -d -s ${shq(info.session)} -c ${shq(wt)}`, 10000)
        : { ok: false } as { ok: boolean };
      if (!revive.ok) {
        socket.send(JSON.stringify({ t: 'err', d: `tmux session '${info.session}' gone and could not be revived (worktree missing?)` }));
        socket.close();
        return;
      }
      socket.send(JSON.stringify({ t: 'o', d: '\r\n\x1b[90m[coxpit] session revived in the worktree\x1b[0m\r\n' }));
    }
    let term;
    try {
      term = openTerm(info.machine, info.session, cols, rows);
    } catch (e) {
      socket.send(JSON.stringify({ t: 'err', d: 'pty spawn failed: ' + String(e).slice(0, 200) }));
      socket.close();
      return;
    }
    // 백프레셔 — WS 송신 버퍼가 차면 pty 를 잠시 멈춰 폭주 방지
    let paused = false;
    term.onData((d) => {
      try {
        socket.send(JSON.stringify({ t: 'o', d }));
        if (!paused && socket.bufferedAmount > 800_000) { paused = true; try { term.pause(); } catch { /* n/a */ } }
      } catch { /* closed */ }
    });
    const drain = setInterval(() => {
      if (paused && socket.bufferedAmount < 100_000) { paused = false; try { term.resume(); } catch { /* n/a */ } }
    }, 200);
    const keepalive = setInterval(() => { try { socket.ping(); } catch { /* closed */ } }, 30_000);

    term.onExit(() => { try { socket.send(JSON.stringify({ t: 'exit' })); socket.close(); } catch { /* closed */ } });
    socket.on('message', (raw: Buffer) => {
      try {
        const m = JSON.parse(raw.toString()) as { t?: string; d?: string; cols?: number; rows?: number };
        if (m.t === 'i' && typeof m.d === 'string') term.write(m.d);
        else if (m.t === 'r' && m.cols && m.rows) term.resize(Math.max(20, Math.min(500, m.cols)), Math.max(5, Math.min(200, m.rows)));
      } catch { /* ignore */ }
    });
    socket.on('close', () => {
      clearInterval(drain); clearInterval(keepalive);
      try { term.kill(); } catch { /* gone */ }
    });
  });

  return app;
}
