import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as presolve, dirname as pdirname, join as pjoin, sep as psep } from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { eq, inArray, and, like, desc } from 'drizzle-orm';
import { authGate } from './auth';
import { config } from './config';
import { db } from './db';
import { machines, repos, tasks, agentRuns, agentEvents, designCaptures, shareLinks, taskGroups } from './db/schema';
import { BOOKMARKLET_JS } from './design';
import { runShellOn, shq } from './exec';
import { launchRun, cleanupRun, stopRun, getRunDiff, loadRunDocs, mergeRun, getRunTermInfo, steerRun, exportRun, prRun, integrateRuns, planFanout, reviewTask, syncRun, openWorkbench, spawnSubtasks, listSubtasks, resolveAgentToken, taskCloseRisk, launchGroupTask, isRunLive, askGroupCoordinator, computeRunOutputs, normalizeOutputs } from './orchestrator';
import { openTerm } from './term';
import { addSink, removeSink, broadcast } from './hub';
import { getProvider, listProviders } from './providers';
import { remoteState, setServe, setFunnel } from './remote';
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

/** 경량 마크다운 → HTML (보드 mdLite 의 서버측 판, 동일 문법). 입력은 먼저 escH. */
function mdLiteHTML(src: string): string {
  let s = escH(src);
  s = s.replace(/```[a-z]*\n([\s\S]*?)```/g, (_m, c: string) =>
    '<pre style="background:#0e1118;border:1px solid #222835;border-radius:7px;padding:8px 10px;overflow-x:auto">' + c + '</pre>');
  s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  s = s.replace(/^# (.+)$/gm, '<h2>$1</h2>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
  s = s.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>');
  s = s.split(/\n{2,}/).map((b) => /^<(h2|h3|ul|pre)/.test(b.trim()) ? b : (b.trim() ? '<p>' + b.replace(/\n/g, '<br>') + '</p>' : '')).join('');
  return s;
}

/** 확장자 → content-type 추론(파일 미리보기용). 미지 = octet-stream. */
function contentTypeFor(path: string): string {
  const ext = (path.split('.').pop() ?? '').toLowerCase();
  const map: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
    avif: 'image/avif', pdf: 'application/pdf', txt: 'text/plain; charset=utf-8',
    md: 'text/plain; charset=utf-8', json: 'application/json', csv: 'text/csv; charset=utf-8',
    html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  };
  return map[ext] ?? 'application/octet-stream';
}

/** 공유 페이지 Documents 섹션 — md 는 mdLiteHTML, html 은 sandbox iframe. */
function shareDocsHTML(docs: Array<{ path: string; kind: string; content: string }>): string {
  if (!docs.length) return '';
  const body = docs.map((d) => d.kind === 'md'
    ? `<div class="doc"><div class="doc-h">${escH(d.path)}</div><div class="doc-b">${mdLiteHTML(d.content)}</div></div>`
    : `<div class="doc"><div class="doc-h">${escH(d.path)}</div><iframe sandbox="" class="doc-frame" srcdoc="${escH(d.content)}"></iframe></div>`).join('');
  return `<div class="sec">Documents</div>${body}`;
}

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
  docs: Array<{ path: string; kind: string; content: string }> = [],
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
  .doc{margin-bottom:18px}
  .doc-h{font-family:ui-monospace,monospace;font-size:10.5px;color:#4ec9b0;border-bottom:1px solid #222835;padding-bottom:5px;margin-bottom:8px;word-break:break-all}
  .doc-b{font-size:13.5px;line-height:1.65;color:#8792a2}
  .doc-b h1,.doc-b h2{font-size:15px;color:#dee4ec;margin:12px 0 6px}
  .doc-b h3{font-size:13px;color:#dee4ec;margin:10px 0 4px}
  .doc-b ul{margin:4px 0 8px;padding-left:18px}.doc-b li{margin-bottom:3px}
  .doc-b strong{color:#dee4ec}.doc-b p{margin:0 0 8px}
  .doc-b code{font-family:ui-monospace,monospace;font-size:.9em;background:#0e1118;padding:1px 5px;border-radius:4px;color:#4ec9b0}
  .doc-frame{width:100%;height:420px;border:1px solid #222835;border-radius:8px;background:#fff}
  .ft{margin-top:40px;color:#3d4657;font-size:12px;font-family:ui-monospace,monospace}
  .ft a{color:#4ec9b0;text-decoration:none}
</style></head><body><div class="wrap">
  <div class="hd"><span class="mark">coxpit</span><span class="rid">r${run.id}</span><span class="chip">${escH(run.status)}</span></div>
  <h1>${escH(taskTitle)}</h1>
  <div class="meta">branch ${escH(run.branch || '—')} · ${run.filesChanged} file(s) changed · agent ${escH(run.agent)}</div>
  ${run.exitSummary ? `<div class="sum">${escH(run.exitSummary)}</div>` : ''}
  ${shareDocsHTML(docs)}
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
  // 기본 view=active: 닫힌 태스크·그 run·이벤트 전량을 내리지 않는다(수백 run 시 페이로드 폭발 방지).
  // 이벤트는 활성 run 당 최근 40개만(카드는 8, 모달은 전량 refetch). view=all 은 구버전 전량.
  const EVENT_CAP = 40;
  app.get('/api/fleet', async (req) => {
    const view = ((req.query ?? {}) as { view?: string }).view === 'all' ? 'all' : 'active';
    const [ms, rs, allTasks, dcs, gs] = await Promise.all([
      db.select().from(machines),
      db.select().from(repos),
      db.select().from(tasks),
      db.select().from(designCaptures),
      db.select().from(taskGroups),
    ]);
    const activeTasks = allTasks.filter((t) => t.status !== 'closed');
    const closedCount = allTasks.length - activeTasks.length;
    const ts = view === 'all' ? allTasks : activeTasks;
    const taskIds = new Set(ts.map((t) => t.id));
    const allRuns = await db.select().from(agentRuns);
    const rns = view === 'all' ? allRuns : allRuns.filter((r) => taskIds.has(r.taskId));
    const runIds = rns.map((r) => r.id);
    // 이벤트는 대상 run 으로 스코프한 뒤 로드(전량 로드 후 슬라이스 = 고치려는 그 버그).
    const evs = runIds.length ? await db.select().from(agentEvents).where(inArray(agentEvents.runId, runIds)) : [];
    const byRun = new Map<number, Array<{ kind: string; payload: string }>>();
    for (const e of evs) {
      const arr = byRun.get(e.runId) ?? [];
      arr.push({ kind: e.kind, payload: e.payload });
      byRun.set(e.runId, arr);
    }
    return {
      machines: ms, repos: rs, tasks: ts, captures: dcs, groups: gs,
      runs: rns.map((r) => ({ ...r, events: (byRun.get(r.id) ?? []).slice(-EVENT_CAP) })),
      counts: { activeTasks: activeTasks.length, closedTasks: closedCount },
      // 보드 헤더 "어느 데몬에 붙어 있나" 표시용 (인증 뒤라 dbPath 노출 가능)
      // authOpen = 비밀번호 미설정 → Funnel(공개) 가드가 켜져야 함(원격접근 카드용)
      daemon: {
        version: config.version, pid: process.pid, port: config.port, dbPath: config.dbPath,
        authOpen: config.auth.disabled || config.auth.pass === '',
      },
      providers: listProviders(),
    };
  });

  // 아카이브 — 닫힌 태스크 목록(최신순, 페이지네이션·필터). 카드가 아니라 한 줄 행.
  app.get('/api/archive', async (req) => {
    const q = (req.query ?? {}) as { offset?: string; limit?: string; q?: string; repo?: string; status?: string };
    const offset = Math.max(0, Number(q.offset) || 0);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 50));
    const conds = [eq(tasks.status, 'closed')];
    if (q.q) conds.push(like(tasks.title, `%${q.q}%`));
    if (q.repo) conds.push(eq(tasks.repoId, Number(q.repo)));
    const where = conds.length === 1 ? conds[0] : and(...conds);
    let closed = await db.select().from(tasks).where(where).orderBy(desc(tasks.id));
    // status 필터 = 태스크의 run 중 그 상태를 가진 게 있어야 함(런 로드 후 필터)
    const repoName = new Map((await db.select().from(repos)).map((r) => [r.id, r.name]));
    const grpTitle = new Map((await db.select().from(taskGroups)).map((g) => [g.id, g.title]));
    const total0 = closed.length;
    const page = closed.slice(offset, offset + limit);
    const rows = [];
    for (const t of page) {
      const rs = await db.select().from(agentRuns).where(eq(agentRuns.taskId, t.id));
      if (q.status && !rs.some((r) => r.status === q.status)) continue;
      rows.push({
        taskId: t.id, title: t.title, repoName: repoName.get(t.repoId) ?? '?',
        groupTitle: t.groupId != null ? grpTitle.get(t.groupId) ?? null : null,
        closedAt: t.closedAt ? Math.floor(t.closedAt.getTime() / 1000) : (t.createdAt ? Math.floor(t.createdAt.getTime() / 1000) : 0),
        runs: rs.map((r) => ({ id: r.id, status: r.status, filesChanged: r.filesChanged, agent: r.agent, model: r.model })),
      });
    }
    // status 필터가 있으면 total 은 근사(페이지 내 필터) — UI 는 rows 로만 판단하니 total0 유지.
    return { total: total0, rows };
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
    // origin/HEAD → 로컬 main/master → 현재 HEAD(symbolic-ref, unborn 무에러) 순으로 감지.
    // 마지막 세그먼트는 커밋 존재 여부(--verify HEAD) — 커밋 0개 repo 는 등록 거절.
    const g = `git -C ${shq(path)}`;
    const cmd =
      `${g} rev-parse --is-inside-work-tree 2>&1` +
      ` && echo '---B---'` +
      ` && { ${g} symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true; }` +
      ` && echo '---C---'` +
      ` && { ${g} show-ref --verify -q refs/heads/main && echo main || { ${g} show-ref --verify -q refs/heads/master && echo master; } || true; }` +
      ` && echo '---D---'` +
      ` && { ${g} symbolic-ref --short HEAD 2>/dev/null || true; }` +   // unborn 에서도 무에러
      ` && echo '---E---'` +
      ` && { ${g} rev-parse --verify -q HEAD >/dev/null 2>&1 && echo yes || echo no; }`;
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
    const hasCommit = (r.stdout.split('---E---')[1] ?? '').trim() === 'yes';
    if (!hasCommit) {
      return reply.code(400).send({
        error: 'this repository has no commits yet',
        code: 'NO_COMMITS',
        hint: 'make an initial commit first — or use Start a new project to have coxpit do it',
      });
    }
    const originHead = seg('---B---', '---C---').replace(/^origin\//, '');
    const localMain = seg('---C---', '---D---');
    const headNow = seg('---D---', '---E---');
    const branch = originHead || localMain || headNow || 'main';
    const name = (b.name ?? '').trim() || path.split('/').filter(Boolean).pop() || path;

    const ins = await db.insert(repos).values({
      machineId: m.id, path, name, defaultBranch: branch,
    }).returning();

    return reply.code(201).send({ ok: true, repo: ins[0] });
  });

  // greenfield — "Start a new project": 빈/미존재/커밋없는 경로에만 git init + 빈 초기 커밋을
  // 심고 등록한다. coxpit 이 git init 을 하는 유일한 자리 — 파일 있는 폴더는 절대 건드리지 않는다.
  app.post('/api/repos/new', async (req, reply) => {
    const b = (req.body ?? {}) as { machineSlug?: string; path?: string; name?: string };
    const machineSlug = (b.machineSlug ?? '').trim();
    const path = (b.path ?? '').trim();
    if (!machineSlug || !path) return reply.code(400).send({ error: 'machineSlug and path required' });
    if (!path.startsWith('/')) return reply.code(400).send({ error: 'path must be absolute' });

    const mr = await db.select().from(machines).where(eq(machines.slug, machineSlug)).limit(1);
    const m = mr[0];
    if (!m) return reply.code(404).send({ error: 'machine not found' });

    const g = `git -C ${shq(path)}`;
    const probe =
      `if [ ! -e ${shq(path)} ]; then echo MISSING;` +
      ` elif [ ! -d ${shq(path)} ]; then echo NOTDIR;` +
      ` elif [ -d ${shq(path)}/.git ]; then { ${g} rev-parse --verify -q HEAD >/dev/null 2>&1 && echo REPO_HAS_COMMITS || echo REPO_EMPTY; };` +
      ` elif [ -z "$(ls -A ${shq(path)} 2>/dev/null)" ]; then echo EMPTYDIR;` +
      ` else echo NONEMPTY; fi`;
    const pr = await runShellOn(m, probe, 20000);
    if (!pr.ok) return reply.code(400).send({ error: 'could not inspect path', detail: (pr.stdout || pr.stderr).trim().slice(0, 400) });
    const kind = pr.stdout.trim().split('\n').pop()?.trim() ?? '';

    if (kind === 'NOTDIR') return reply.code(400).send({ error: 'path is not a directory' });
    if (kind === 'REPO_HAS_COMMITS') return reply.code(409).send({ error: 'already a repository with commits — use Register' });
    if (kind === 'NONEMPTY') return reply.code(409).send({ error: 'folder is not empty — greenfield never touches existing files' });
    if (kind !== 'MISSING' && kind !== 'EMPTYDIR' && kind !== 'REPO_EMPTY') {
      return reply.code(400).send({ error: 'could not classify path', detail: (pr.stdout || pr.stderr).trim().slice(0, 400) });
    }

    // init(필요 시) + 빈 초기 커밋 — 이 커밋이 worktree 가 브랜치할 base.
    // mergeRun 과 동일 관례: coxpit ident, gpgsign off.
    const seed =
      `mkdir -p ${shq(path)} && cd ${shq(path)}` +
      ` && { [ -d .git ] || git init -b main; }` +
      ` && git -c user.name='coxpit' -c user.email='coxpit@local' -c commit.gpgsign=false` +
      ` commit --allow-empty -m 'coxpit: initial commit'`;
    const sr = await runShellOn(m, seed, 20000);
    if (!sr.ok) return reply.code(422).send({ error: 'could not initialize the project', detail: (sr.stdout || sr.stderr).trim().slice(0, 400) });

    // REPO_EMPTY 는 기존 unborn 브랜치가 master 일 수 있음 — seed 후 실제 브랜치를 읽는다.
    // init 케이스는 항상 main.
    let branch = 'main';
    if (kind === 'REPO_EMPTY') {
      const br = await runShellOn(m, `git -C ${shq(path)} symbolic-ref --short HEAD 2>/dev/null || echo main`, 10000);
      branch = br.stdout.trim().split('\n').pop()?.trim() || 'main';
    }
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

  // 기본 브랜치 변경 — merge·Sync base·PR 이 향할 대상. develop-flow repo 대응.
  app.patch('/api/repos/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { defaultBranch?: string };
    const branch = (b.defaultBranch ?? '').trim();
    if (!/^[\w.\-/]{1,80}$/.test(branch)) return reply.code(400).send({ error: 'invalid branch name' });
    const rp = await db.select().from(repos).where(eq(repos.id, id)).limit(1);
    const repo = rp[0];
    if (!repo) return reply.code(404).send({ error: 'not found' });
    const mr = await db.select().from(machines).where(eq(machines.id, repo.machineId)).limit(1);
    const m = mr[0];
    if (!m) return reply.code(404).send({ error: 'machine not found' });
    // branch 는 charset 가드 통과(셸 메타문자 없음). 전체 ref 를 인용해 전달.
    const check = await runShellOn(m,
      `git -C ${shq(repo.path)} rev-parse --verify --quiet ${shq('refs/heads/' + branch)} >/dev/null && echo OK`, 10000);
    if (!check.stdout.includes('OK')) return reply.code(400).send({ error: `branch '${branch}' not found in the repository` });
    await db.update(repos).set({ defaultBranch: branch }).where(eq(repos.id, id));
    return { ok: true, defaultBranch: branch };
  });

  // 디렉토리 브라우저 — repo 등록용 파일 피커(로컬 머신 전용, 인증 게이트 뒤).
  app.get('/api/browse', async (req) => {
    const q = (req.query ?? {}) as { path?: string };
    const start = q.path && q.path.startsWith('/') ? q.path : homedir();
    const p = presolve(start);
    let dirs: Array<{ name: string; isRepo: boolean; isEmpty: boolean }> = [];
    let error: string | undefined;
    try {
      const entries = await readdir(p, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue;
        const full = pjoin(p, e.name);
        const isRepo = existsSync(pjoin(full, '.git'));
        // 빈 폴더면 greenfield "Start here" 대상 — 서버 EMPTYDIR 판정(ls -A)과 동일하게
        // 모든 엔트리(닷파일 포함) 0개일 때만. repo 폴더는 Register 로 다루므로 계산 생략.
        let isEmpty = false;
        if (!isRepo) { try { isEmpty = (await readdir(full)).length === 0; } catch { isEmpty = false; } }
        dirs.push({ name: e.name, isRepo, isEmpty });
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

  // ─── Remote access (v4.5) ──────────────────────────────────────
  // coxpit DETECTS the user's own Tailscale and DRIVES serve/funnel — it never
  // hosts a relay or issues a coxpit-branded URL. Truth is read live from the
  // CLI each call (no DB state). Owner-only (behind the normal authGate).
  app.get('/api/remote', async () => remoteState(config.port));

  // Serve = tailnet-only HTTPS (safe by default) — no auth guard needed.
  app.post('/api/remote/serve', async (req) => {
    const b = (req.body ?? {}) as { on?: boolean };
    return setServe(config.port, b.on === true);
  });

  // Funnel = PUBLIC internet. Refuse to expose shells without a password:
  // Funnel has no Tailscale-side auth, so coxpit's basic auth is the only gate.
  app.post('/api/remote/funnel', async (req, reply) => {
    const b = (req.body ?? {}) as { on?: boolean };
    if (b.on === true && (config.auth.disabled || config.auth.pass === '')) {
      return reply.code(409).send({ error: 'set a password first', code: 'NO_AUTH' });
    }
    return setFunnel(config.port, b.on === true);
  });

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
    const b = (req.body ?? {}) as { repoId?: number; title?: string; prompt?: string; designCaptureId?: number; outputs?: unknown };
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
    // 산출물 계약(선택) — {answer,code,doc,page,file} 만 허용, 중복 제거, JSON 문자열로 저장.
    const outputs = normalizeOutputs(b.outputs);
    const ins = await db.insert(tasks).values({ repoId, title, prompt: b.prompt ?? '', designCaptureId, outputs: JSON.stringify(outputs) }).returning();
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
    const b = (req.body ?? {}) as { agent?: string; count?: number; real?: boolean; model?: string };
    const tr = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    const task = tr[0];
    if (!task) return reply.code(404).send({ error: 'task not found' });
    const rp = await db.select().from(repos).where(eq(repos.id, task.repoId)).limit(1);
    if (!rp[0]) return reply.code(404).send({ error: 'repo missing' });

    const count = Math.max(1, Math.min(8, Number(b.count) || 1));
    // 미지의 값은 기본 프로바이더로 정규화(런처 조작·API 오타 방어)
    const agent = getProvider(b.agent).id;
    // 모델 지정(선택) — 셸 안전 문자만, 빈값 = CLI 기본
    const model = (b.model ?? '').trim();
    if (model && (model.length > 64 || !/^[\w.\-:/]*$/.test(model))) {
      return reply.code(400).send({ error: 'invalid model name' });
    }
    const created: Array<typeof agentRuns.$inferSelect> = [];
    for (let i = 0; i < count; i++) {
      const ins = await db.insert(agentRuns)
        .values({ taskId: id, machineId: rp[0].machineId, agent, model, status: 'pending' })
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
    const b = (req.body ?? {}) as { force?: boolean };
    const tr = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    if (!tr[0]) return reply.code(404).send({ error: 'task not found' });
    // Close 가드 — 아직 살릴 곳 없는 산출물(미머지·미export·무PR)이 있으면 확인 요구.
    if (!b.force) {
      const atRisk = await taskCloseRisk(id);
      if (atRisk.length) return reply.code(409).send({ error: 'unmerged output', atRisk });
    }
    const trs = await db.select().from(agentRuns).where(eq(agentRuns.taskId, id));

    let anyStopped = false;
    for (const r of trs) {
      if ((await stopRun(r.id)).ok) anyStopped = true;
    }
    // SIGTERM 직후 worktree 파일 잠금이 풀리도록 잠깐 양보
    if (anyStopped) await new Promise((res) => setTimeout(res, 400));

    const cleanups = [];
    for (const r of trs) cleanups.push({ runId: r.id, ...(await cleanupRun(r.id)) });

    await db.update(tasks).set({ status: 'closed', closedAt: new Date() }).where(eq(tasks.id, id));
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

  // ─── Goal workroom (v4.6 L1) — 한 그룹(goal/swarm)을 한 방에서 몰기 ────────
  // steerable = 정착(done/failed/stopped) + sessionId 보유 + worktree 살아있음.
  // (steerRun 전제 그대로 — 라이브 run 은 steer 불가, 드라이런은 세션 없음.)
  const groupRuns = async (groupId: number): Promise<{
    group: typeof taskGroups.$inferSelect;
    rows: Array<{ run: typeof agentRuns.$inferSelect; task: typeof tasks.$inferSelect }>;
  } | null> => {
    const gr = await db.select().from(taskGroups).where(eq(taskGroups.id, groupId)).limit(1);
    if (!gr[0]) return null;
    const gts = await db.select().from(tasks).where(eq(tasks.groupId, groupId));
    const rows: Array<{ run: typeof agentRuns.$inferSelect; task: typeof tasks.$inferSelect }> = [];
    for (const t of gts) {
      const trs = await db.select().from(agentRuns).where(eq(agentRuns.taskId, t.id));
      for (const run of trs) rows.push({ run, task: t });
    }
    rows.sort((a, b) => a.run.id - b.run.id);
    return { group: gr[0], rows };
  };
  const isSteerable = (r: typeof agentRuns.$inferSelect): boolean =>
    !isRunLive(r.id) && ['done', 'failed', 'stopped'].includes(r.status) && !!r.sessionId && !!r.worktreePath;

  // B1 — 애그리게이트 뷰(방의 chips + 최근 타임라인). 페이로드 다이어트: 최근 200 이벤트만.
  app.get('/api/groups/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const g = await groupRuns(id);
    if (!g) return reply.code(404).send({ error: 'group not found' });
    const runs = g.rows.map(({ run, task }) => ({
      runId: run.id, taskId: task.id, title: task.title, status: run.status,
      agent: run.agent, model: run.model, branch: run.branch, filesChanged: run.filesChanged,
      live: isRunLive(run.id), steerable: isSteerable(run),
      // 수렴 콕핏 결정 행용: 태스크 닫힘 여부 + worktree 생존(터미널 가드·머지 가능성 판단).
      taskStatus: task.status, hasWorktree: !!run.worktreePath,
    }));
    const runIds = g.rows.map((x) => x.run.id);
    // 이벤트: 그룹 run 전체에서 최근 200개(id 순, 오래된 것 먼저 — 방 피드는 append-only).
    const evs = runIds.length
      ? (await db.select().from(agentEvents).where(inArray(agentEvents.runId, runIds)))
          .sort((a, b) => a.id - b.id).slice(-200)
      : [];
    return {
      group: { id: g.group.id, kind: g.group.kind, title: g.group.title, coordSessionId: g.group.coordSessionId },
      runs,
      events: evs.map((e) => ({ runId: e.runId, kind: e.kind, payload: e.payload, ts: e.ts })),
    };
  });

  // B2 — "＋ New attempt": 그룹에 새 시도(들)를 발사. repo 는 그룹의 기존 태스크에서 상속.
  app.post('/api/groups/:id/spawn', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { title?: string; prompt?: string; count?: number; real?: boolean };
    const prompt = (b.prompt ?? '').trim();
    if (!prompt) return reply.code(400).send({ error: 'prompt required' });
    const g = await groupRuns(id);
    if (!g) return reply.code(404).send({ error: 'group not found' });
    if (!g.rows[0]) return reply.code(409).send({ error: 'group has no tasks to inherit a repo from' });
    const repoId = g.rows[0].task.repoId; // 형제는 같은 repo 를 공유
    const title = (b.title ?? '').trim() || prompt.slice(0, 40);
    const count = Math.max(1, Math.min(5, Number(b.count) || 1));
    const created: Array<{ id: number; title: string; runId: number }> = [];
    for (let i = 0; i < count; i++) {
      created.push(await launchGroupTask(id, repoId, title, prompt, b.real === true));
    }
    return reply.code(201).send({ ok: true, tasks: created });
  });

  // B3 — "→ Broadcast": 그룹의 정착·steerable run 전부에 후속 지시. 라이브/드라이는 정직하게 skip.
  app.post('/api/groups/:id/steer', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { message?: string; mode?: string };
    const message = (b.message ?? '').trim();
    if (!message) return reply.code(400).send({ error: 'message required' });
    const g = await groupRuns(id);
    if (!g) return reply.code(404).send({ error: 'group not found' });
    const mode = b.mode === 'ask' ? 'ask' : 'work';
    let steered = 0;
    const skipped: Array<{ runId: number; reason: string }> = [];
    let running = 0, noSession = 0;
    // 그룹 규모가 작아 순차 for 루프로 충분(폭주 fan-out 없음).
    for (const { run } of g.rows) {
      const res = await steerRun(run.id, message, mode);
      if (res.ok) { steered++; continue; }
      skipped.push({ runId: run.id, reason: res.detail });
      if (/still running/.test(res.detail)) running++;
      else if (/no agent session/.test(res.detail)) noSession++;
    }
    const parts = [`${steered} steered`];
    if (running) parts.push(`${running} still running (steer after they settle)`);
    if (noSession) parts.push(`${noSession} no session`);
    const otherSkips = skipped.length - running - noSession;
    if (otherSkips > 0) parts.push(`${otherSkips} skipped`);
    return { ok: true, steered, skipped, detail: parts.join(' · ') };
  });
  // NOTE(v4.6): queuing a broadcast to apply to running runs once they settle is
  // explicitly out of scope for L1 — running runs are reported as skipped, not queued.

  // B4 (L2) — "? Ask": 그룹 스코프 읽기 전용 코디네이터. run 발사·steer·파일 쓰기 절대 없음.
  // askGroupCoordinator 는 getRunDiff(읽기)와 텍스트 반환뿐 — launch/steer/write 경로를 부르지 않는다.
  app.post('/api/groups/:id/ask', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = (req.body ?? {}) as { message?: string; real?: boolean };
    const message = (b.message ?? '').trim();
    if (!message) return reply.code(400).send({ error: 'message required' });
    const g = await groupRuns(id);
    if (!g) return reply.code(404).send({ error: 'group not found' });
    const res = await askGroupCoordinator(id, message, b.real === true);
    if (!res.ok) return reply.code(422).send({ error: res.detail });
    return { ok: true, answer: res.answer };
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

  // Doc 모드 — 변경된 문서(md/html) 내용째 (렌더 뷰). worktree 라이브 → 스냅샷 폴백.
  app.get('/api/runs/:id/docs', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
    if (!rr[0]) return reply.code(404).send({ error: 'not found' });
    const { docs, source } = await loadRunDocs(id);
    return { ok: true, docs, source };
  });

  // ─── 산출물 계약(v4.7 P1) — 카드 목록 · 뷰어 콘텐츠 · 파일 바이트 ──
  // 카드 목록: computeRunOutputs 로 병합(매니페스트+git status+answer). 404 = run 없음.
  app.get('/api/runs/:id/outputs', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
    if (!rr[0]) return reply.code(404).send({ error: 'not found' });
    const outputs = await computeRunOutputs(id);
    return { outputs };
  });

  // 뷰어 콘텐츠: answer/doc → md, page → html(둘 다 loadRunDocs 폴백 재사용).
  // code 는 별도 콘텐츠 없음 — 클라이언트가 기존 /api/runs/:id/diff 를 재사용한다.
  app.get('/api/runs/:id/output', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const q = (req.query ?? {}) as { type?: string; path?: string };
    const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
    if (!rr[0]) return reply.code(404).send({ error: 'not found' });
    const type = (q.type ?? '').trim();
    if (type === 'answer') {
      const cards = await computeRunOutputs(id);
      const has = cards.some((c) => c.type === 'answer' && c.present);
      const content = has ? (rr[0].exitSummary || '') : '';
      // answer 본문은 result 이벤트가 원천 — exitSummary 는 그 클립(≤500자)이라 여기선 이벤트 우선.
      const evs = await db.select().from(agentEvents).where(eq(agentEvents.runId, id));
      let answer = content;
      for (let i = evs.length - 1; i >= 0; i--) {
        if (evs[i]!.kind !== 'result') continue;
        try { const o = JSON.parse(evs[i]!.payload) as { result?: string }; if (typeof o.result === 'string' && o.result.trim()) { answer = o.result.trim(); break; } } catch { /* skip */ }
      }
      return { kind: 'md', content: answer };
    }
    if (type === 'doc' || type === 'page') {
      const wantKind = type === 'doc' ? 'md' : 'html';
      const { docs } = await loadRunDocs(id); // worktree→snapshot 폴백 내장
      const path = (q.path ?? '').trim();
      const doc = path ? docs.find((d) => d.path === path) : docs.find((d) => d.kind === wantKind);
      if (!doc) return reply.code(404).send({ error: 'output not found' });
      return { kind: doc.kind === 'html' ? 'html' : 'md', content: doc.content };
    }
    if (type === 'code') {
      // code 는 콘텐츠 뷰어가 없다 — 컬러 diff 는 클라이언트가 /api/runs/:id/diff 로 재사용.
      return { kind: 'diff', diffUrl: `/api/runs/${id}/diff` };
    }
    return reply.code(400).send({ error: 'type must be one of answer|doc|page|code' });
  });

  // 파일 바이트(NEW · 보안 임계) — 이미지/바이너리 미리보기용 raw bytes.
  // 가드: worktree 루트 기준으로 path 를 해석하고, realpath 가 worktree 밖으로
  // 벗어나면(.. / 절대경로 / 심볼릭링크 탈출) 거부. 크기 상한 ~10MB. worktree 소멸 후 404.
  const FILE_MAX = 10 * 1024 * 1024;
  app.get('/api/runs/:id/file', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const q = (req.query ?? {}) as { path?: string };
    const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
    const run = rr[0];
    if (!run) return reply.code(404).send({ error: 'not found' });
    const rel = (q.path ?? '').trim();
    if (!rel) return reply.code(400).send({ error: 'path required' });
    // 절대경로 즉시 거부(worktree 밖 강제)
    if (rel.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(rel)) return reply.code(400).send({ error: 'path must be relative' });
    if (!run.worktreePath) return reply.code(404).send({ error: 'no worktree' });

    // 원격 머신 파일은 데몬 파일시스템에 없다 — export 와 동일하게 로컬 전용.
    const mr = await db.select().from(machines).where(eq(machines.id, run.machineId)).limit(1);
    const mach = mr[0];
    const isRemote = !!mach && mach.kind !== 'local' && (mach.address ?? '') !== '';
    if (isRemote) return reply.code(400).send({ error: 'remote file preview not supported' });

    // worktree 루트를 realpath 로 정규화(심링크 해소된 canonical base).
    let rootReal: string;
    try { rootReal = await realpath(run.worktreePath); }
    catch { return reply.code(404).send({ error: 'worktree gone' }); }
    // 요청 경로 = 루트에 join 후 realpath — 심링크 탈출까지 잡는다.
    const joined = presolve(rootReal, rel);
    let targetReal: string;
    try { targetReal = await realpath(joined); }
    catch { return reply.code(404).send({ error: 'file not found' }); }
    // realpath 결과가 worktree 루트 하위가 아니면 탈출 — 거부.
    const rootWithSep = rootReal.endsWith(psep) ? rootReal : rootReal + psep;
    if (targetReal !== rootReal && !targetReal.startsWith(rootWithSep)) {
      return reply.code(403).send({ error: 'path escapes the worktree' });
    }
    let st;
    try { st = await stat(targetReal); } catch { return reply.code(404).send({ error: 'file not found' }); }
    if (!st.isFile()) return reply.code(404).send({ error: 'not a file' });
    if (st.size > FILE_MAX) return reply.code(413).send({ error: 'file too large (>10MB)' });
    const buf = await readFile(targetReal);
    return reply.type(contentTypeFor(rel)).send(buf);
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
    const { docs } = await loadRunDocs(run.id);
    return reply.type('text/html').send(sharePageHTML(run, task?.title ?? `task ${run.taskId}`, evs, d.ok ? d.diff : '', docs));
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
      // tmuxWindow 가 없음 = 세션이 정리됐거나(닫힌 task·cleanup) run 미존재.
      // 죽은 세션에 attach 를 시도하지 말고 명확한 사유로 닫는다.
      const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
      const d = rr[0]
        ? 'terminal unavailable — worktree cleaned (run closed or cleaned up)'
        : 'run not found';
      socket.send(JSON.stringify({ t: 'err', d }));
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
