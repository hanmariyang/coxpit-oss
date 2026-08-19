import { randomBytes } from 'node:crypto';
import { posix as ppath } from 'node:path';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { ChildProcess } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { config } from './config';
import { db } from './db';
import { agentRuns, agentEvents, tasks, repos, machines, designCaptures, docSnapshots, taskGroups } from './db/schema';
import { runShellOn, spawnShellOn, shq, type MachineTarget } from './exec';
import { broadcast } from './hub';
import { getProvider, type Provider } from './providers';

/** 에이전트 실행 커맨드. 드라이런=모의 stream-json + 실제 파일 1건 변경. */
function agentCommand(provider: Provider, prompt: string, real: boolean, model = ''): string {
  if (real) return provider.launchCmd(prompt, model || undefined);
  // 모의: init → assistant → (파일 변경) → result. claude stream-json 라인 형태
  // (드라이런은 프로바이더 불문 배관 리허설 — claude 파서가 처리한다).
  return [
    `printf '%s\\n' '{"type":"system","subtype":"init","session":"dryrun"}'`,
    `printf '%s\\n' '{"type":"assistant","text":"planning: '"$(printf %s ${shq(prompt)} | cut -c1-40)"'"}'`,
    `printf '%s\\n' 'coxpit dry-run' > COXPIT_DRYRUN.txt`,
    `printf '%s\\n' '{"type":"assistant","text":"edited COXPIT_DRYRUN.txt"}'`,
    `printf '%s\\n' '{"type":"result","subtype":"success","num_turns":1}'`,
  ].join('; ');
}

async function recordEvent(runId: number, kind: string, payload: string): Promise<void> {
  await db.insert(agentEvents).values({ runId, kind, payload });
  broadcast({ type: 'event', runId, kind, payload });
}

async function setRun(runId: number, patch: Partial<typeof agentRuns.$inferInsert>): Promise<void> {
  await db.update(agentRuns).set(patch).where(eq(agentRuns.id, runId));
  broadcast({ type: 'run', runId, ...patch });
}

// 실행 중 run 의 자식 프로세스(stop 용). stoppedRuns = 사용자가 멈춘 run 표식.
const liveChildren = new Map<number, ChildProcess>();
const stoppedRuns = new Set<number>();

// ── 에이전트 셀프 오케스트레이션 ──────────────────────────────
// run 마다 1회용 토큰을 발급해 에이전트 env 로 준다. 에이전트는 그 토큰으로
// /api/agent/subtasks 를 호출해 같은 repo 에 독립 서브런을 발사할 수 있다.
// 인메모리 = 데몬 재시작 시 무효(고아 정산과 같은 수명 철학).
const agentTokens = new Map<string, number>(); // token -> runId

function issueAgentToken(runId: number): string {
  for (const [t, r] of agentTokens) if (r === runId) return t; // steer 재사용
  const tok = randomBytes(16).toString('hex');
  agentTokens.set(tok, runId);
  return tok;
}

/** Bearer 토큰 → runId (없으면 null). server 의 /api/agent/* 가 사용. */
export function resolveAgentToken(token: string): number | null {
  return agentTokens.get(token) ?? null;
}

/** 에이전트 프롬프트에 붙는 능력 고지 — 독립 하위작업을 병렬 서브런으로 뺄 수 있다.
 * 파일 기반: 기본 권한(claude acceptEdits · codex workspace-write)이 네트워크를 막아도
 * 파일 쓰기는 되므로, spawn 요청을 워크트리의 .coxpit/spawn.json 으로 받는다. */
function orchestrationNote(): string {
  return '\n\n--- COXPIT ORCHESTRATION (optional) ---\n' +
    'You can parallelize genuinely independent subwork by spawning sub-agents. To spawn, write the file ' +
    '`.coxpit/spawn.json` in your working directory:\n' +
    '  {"title": "short title", "prompt": "full agent prompt", "count": 1}\n' +
    '(or an array of such objects, max 4). The daemon consumes it within ~2s and launches each subtask ' +
    'as an isolated sub-run of this repository. It keeps `.coxpit/subtasks.json` updated with their live ' +
    'status — read it to check progress. Prefer doing work yourself; spawn only clearly separable, ' +
    'file-disjoint tasks. Do not busy-wait on sub-agents.\n' +
    '--- END COXPIT ORCHESTRATION ---';
}

/**
 * 파일 기반 오케스트레이션 워처 — run 이 사는 동안 worktree 의 .coxpit/spawn.json 을
 * 소비해 서브태스크를 발사하고, .coxpit/subtasks.json 에 현황을 유지한다.
 * 로컬 run 전용(원격은 데몬이 파일에 못 닿음). 반환된 타이머는 run 종료 시 정리.
 */
export function startOrchWatch(runId: number, wtPath: string, real: boolean): NodeJS.Timeout {
  const dir = ppath.join(wtPath, '.coxpit');
  let last = '';
  let busy = false;
  return setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        const spawnPath = ppath.join(dir, 'spawn.json');
        const txt = await readFile(spawnPath, 'utf8').catch(() => null);
        if (txt !== null) {
          await rm(spawnPath).catch(() => { /* consumed */ });
          try {
            const req = JSON.parse(txt) as unknown;
            const items = (Array.isArray(req) ? req : [req]) as Array<{ title?: string; prompt?: string; count?: number }>;
            for (const it of items.slice(0, 4)) {
              if (typeof it?.title === 'string' && typeof it?.prompt === 'string' && it.title && it.prompt) {
                await spawnSubtasks(runId, it.title, it.prompt, Number(it.count) || 1, real);
              }
            }
          } catch {
            await recordEvent(runId, 'error', 'spawn.json was not valid JSON — nothing spawned');
          }
        }
        // 현황 파일 — 내용이 바뀔 때만 다시 쓴다
        const subs = await listSubtasks(runId);
        if (subs.length) {
          const j = JSON.stringify(subs, null, 2);
          if (j !== last) {
            last = j;
            await mkdir(dir, { recursive: true });
            await writeFile(ppath.join(dir, 'subtasks.json'), j);
          }
        }
      } catch { /* 워처 오류는 조용히 — 다음 틱에 재시도 */ }
      busy = false;
    })();
  }, 1500);
}

/**
 * 에이전트가 요청한 서브태스크 생성+발사. 부모 run 의 repo/머신/프로바이더 상속, real 고정
 * (토큰은 real run 에만 발급되므로). 결과는 부모 타임라인에 meta 이벤트로 남는다.
 */
export async function spawnSubtasks(parentRunId: number, title: string, prompt: string, count: number, real = true): Promise<{
  ok: boolean; detail: string; taskId?: number; runIds?: number[];
}> {
  const pr = (await db.select().from(agentRuns).where(eq(agentRuns.id, parentRunId)).limit(1))[0];
  if (!pr) return { ok: false, detail: 'parent run not found' };
  const pt = (await db.select().from(tasks).where(eq(tasks.id, pr.taskId)).limit(1))[0];
  if (!pt) return { ok: false, detail: 'parent task not found' };
  // 폭주 가드 — 한 부모가 만들 수 있는 하위 태스크 상한
  const siblings = await db.select().from(tasks).where(eq(tasks.parentRunId, parentRunId));
  if (siblings.length >= 8) return { ok: false, detail: 'subtask limit reached (8 per run)' };
  // 그룹 — 부모가 이미 그룹에 속하면 그 그룹, 아니면 swarm 그룹 생성 후 부모까지 백필.
  let groupId = pt.groupId ?? null;
  if (groupId == null) {
    const gIns = await db.insert(taskGroups).values({ kind: 'swarm', title: pt.title.slice(0, 140) }).returning();
    groupId = gIns[0]!.id;
    await db.update(tasks).set({ groupId }).where(eq(tasks.id, pt.id));
    broadcast({ type: 'task', taskId: pt.id, groupId });
  }
  const n = Math.max(1, Math.min(4, count || 1));
  const tIns = await db.insert(tasks).values({
    repoId: pt.repoId, title: title.slice(0, 140), prompt, parentRunId, groupId,
  }).returning();
  const task = tIns[0]!;
  const runIds: number[] = [];
  for (let i = 0; i < n; i++) {
    const rIns = await db.insert(agentRuns).values({
      taskId: task.id, machineId: pr.machineId, agent: pr.agent, model: pr.model, status: 'pending',
    }).returning();
    const run = rIns[0]!;
    broadcast({ type: 'run', runId: run.id, taskId: task.id, status: 'pending', agent: run.agent, branch: '', filesChanged: 0 });
    void launchRun(run.id, real);
    runIds.push(run.id);
  }
  await recordEvent(parentRunId, 'meta', JSON.stringify({ subtask: task.id, title: task.title, runs: runIds }));
  return { ok: true, detail: `spawned task #${task.id} (${runIds.length} run(s))`, taskId: task.id, runIds };
}

/** 부모 run 이 발사한 서브태스크 현황 — 에이전트 폴링용. */
export async function listSubtasks(parentRunId: number): Promise<Array<{
  id: number; title: string; runs: Array<{ id: number; status: string; filesChanged: number; exitSummary: string }>;
}>> {
  const ts = await db.select().from(tasks).where(eq(tasks.parentRunId, parentRunId));
  const out = [];
  for (const t of ts) {
    const rs = await db.select().from(agentRuns).where(eq(agentRuns.taskId, t.id));
    out.push({
      id: t.id, title: t.title,
      runs: rs.map((r) => ({ id: r.id, status: r.status, filesChanged: r.filesChanged, exitSummary: r.exitSummary.slice(0, 200) })),
    });
  }
  return out;
}

/**
 * 원격 에이전트 kill 스크립트 — pid 파일 기준.
 * $$ 가 그룹 리더가 아닐 수 있어 ps 로 실제 pgid 를 조회해 그룹째 죽인다
 * (pkill -P 폴백은 직계 자식만 잡아 에이전트가 띄운 손자 프로세스가 잔존했음).
 * TERM 후에도 살아 있으면 KILL 로 에스컬레이션, 끝나면 pid 파일 제거.
 */
function remoteKillScript(worktreePath: string): string {
  const pidFile = shq(`${worktreePath}/.coxpit-agent.pid`);
  return (
    `P=$(cat ${pidFile} 2>/dev/null); [ -n "$P" ] && {` +
    ` PG=$(ps -o pgid= -p "$P" 2>/dev/null | tr -d ' ');` +
    ` kill -TERM -"\${PG:-$P}" 2>/dev/null || { pkill -TERM -P "$P" 2>/dev/null; kill -TERM "$P" 2>/dev/null; };` +
    ` sleep 2;` +
    ` kill -0 "$P" 2>/dev/null && { kill -KILL -"\${PG:-$P}" 2>/dev/null || { pkill -KILL -P "$P" 2>/dev/null; kill -KILL "$P" 2>/dev/null; }; };` +
    ` rm -f ${pidFile};` +
    ` } ; true`
  );
}

interface RunContext {
  runId: number;
  machine: MachineTarget;
  machineId: number;
  repoId: number;
  repoPath: string;
  baseBranch: string;
  prompt: string;
  real: boolean;
  agent: string;
  model: string;
}

async function loadContext(runId: number): Promise<RunContext | null> {
  const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  const run = rr[0];
  if (!run) return null;
  const tr = await db.select().from(tasks).where(eq(tasks.id, run.taskId)).limit(1);
  const task = tr[0];
  if (!task) return null;
  const rp = await db.select().from(repos).where(eq(repos.id, task.repoId)).limit(1);
  const repo = rp[0];
  if (!repo) return null;
  const mr = await db.select().from(machines).where(eq(machines.id, repo.machineId)).limit(1);
  const m = mr[0];
  if (!m) return null;

  // Design Mode — 태스크에 캡처가 연결돼 있으면 프롬프트에 컨텍스트 블록 주입
  let prompt = task.prompt;
  if (task.designCaptureId) {
    const dc = (await db.select().from(designCaptures).where(eq(designCaptures.id, task.designCaptureId)).limit(1))[0];
    if (dc) {
      prompt += `\n\n--- DESIGN CONTEXT (captured from the running app) ---\n` +
        `Page: ${dc.url}\nSelector: ${dc.selector}\n` +
        `Element HTML:\n${dc.html}\n` +
        `Computed styles:\n${dc.css}\n` +
        `--- END DESIGN CONTEXT ---`;
    }
  }

  return {
    runId,
    machine: { slug: m.slug, kind: m.kind, address: m.address, sshUser: m.sshUser },
    machineId: m.id,
    repoId: repo.id,
    repoPath: repo.path,
    baseBranch: repo.defaultBranch,
    prompt,
    real: config.agent.real,
    agent: run.agent,
    model: run.model,
  };
}

/**
 * 한 AgentRun 실행: worktree 생성 → tmux 창(best-effort) → 에이전트 spawn →
 * stdout 라인 파싱하며 이벤트 적재 → 종료 시 files_changed 집계 + status 전이.
 * fire-and-forget. 실패는 status='error' 로 봉인.
 */
export async function launchRun(runId: number, real?: boolean): Promise<void> {
  const ctx = await loadContext(runId);
  if (!ctx) return;
  const useReal = real ?? ctx.real;

  const branch = `coxpit/r${runId}`;
  const wtParent = ppath.join(ppath.dirname(ctx.repoPath), '.coxpit-worktrees');
  const wtPath = ppath.join(wtParent, `r${runId}`);
  const session = `coxpit-r${runId}`;

  try {
    await setRun(runId, { status: 'preparing', branch, worktreePath: wtPath, tmuxWindow: session, startedAt: new Date() });

    // 1) worktree 생성(격리 브랜치)
    const prep = await runShellOn(
      ctx.machine,
      `mkdir -p ${shq(wtParent)} && git -C ${shq(ctx.repoPath)} worktree add -b ${shq(branch)} ${shq(wtPath)} ${shq(ctx.baseBranch)}`,
      20000,
    );
    if (!prep.ok) {
      await recordEvent(runId, 'error', (prep.stderr || prep.stdout).trim().slice(0, 500));
      await setRun(runId, { status: 'error', endedAt: new Date(), exitSummary: 'worktree add failed' });
      return;
    }

    // 2) tmux 창(사람이 attach 해 개입할 수 있게) — best-effort. 동명 잔재는 선제 정리('=' 정확 일치).
    // export LANG: 이 명령이 tmux 서버를 처음 띄우는 경우(특히 원격) C 로케일로 뜨면 CJK 가 깨진다.
    await runShellOn(ctx.machine,
      `export LANG=${shq(config.lang)}; tmux kill-session -t ${shq('=' + session)} 2>/dev/null; tmux new-session -d -s ${shq(session)} -c ${shq(wtPath)} 2>/dev/null || true`, 8000);

    await setRun(runId, { status: 'running' });
    await recordEvent(runId, 'meta', JSON.stringify({ branch, worktree: wtPath, real: useReal }));

    // 3) 에이전트 spawn(스트리밍)
    // 원격은 ssh 채널이 죽어도 프로세스가 남을 수 있어 pid 파일을 남긴다(stop 시 원격 kill).
    const isRemote = ctx.machine.kind !== 'local' && ctx.machine.address !== '';
    const pidPrefix = isRemote ? `printf '%s' "$$" > .coxpit-agent.pid && ` : '';
    // 드라이런 모의 스트림은 claude 형태 — 파서도 claude 로 (배관 리허설은 프로바이더 불문)
    const provider = useReal ? getProvider(ctx.agent) : getProvider('claude-code');
    // 셀프 오케스트레이션 — real+로컬 run 에만 토큰/API env 와 능력 고지를 준다
    // (원격은 127.0.0.1 이 데몬에 닿지 않음). COXPIT_AGENT_ORCH=0 으로 끌 수 있음.
    let prompt = ctx.prompt;
    let envPrefix = '';
    if (useReal && !isRemote && config.agentOrch) {
      const tok = issueAgentToken(runId);
      envPrefix = `export COXPIT_API=${shq(`http://127.0.0.1:${config.port}`)} COXPIT_TOKEN=${shq(tok)}; `;
      prompt += orchestrationNote();
    }
    const cmd = `cd ${shq(wtPath)} && ${envPrefix}${pidPrefix}{ ${agentCommand(provider, prompt, useReal, ctx.model)}; }`;
    // 파일 오케스트레이션 — 로컬 run 이 사는 동안 .coxpit/spawn.json 감시.
    // .coxpit/ 는 repo exclude 에 넣어 diff/머지를 오염시키지 않는다(멱등).
    let orchTimer: NodeJS.Timeout | null = null;
    if (!isRemote && config.agentOrch) {
      await runShellOn(ctx.machine,
        `EX=$(git -C ${shq(wtPath)} rev-parse --git-path info/exclude) && { grep -qxF '.coxpit/' "$EX" 2>/dev/null || echo '.coxpit/' >> "$EX"; }`, 8000);
      orchTimer = startOrchWatch(runId, wtPath, useReal);
    }
    try {
      await runAgentChild(runId, ctx.machine, wtPath, cmd, provider);
    } finally {
      if (orchTimer) clearInterval(orchTimer);
    }
  } catch (e) {
    await recordEvent(runId, 'error', String(e).slice(0, 500));
    await setRun(runId, { status: 'error', endedAt: new Date(), exitSummary: 'orchestrator error' });
  }
}

/**
 * 에이전트 자식 프로세스 배선(공용) — 프로바이더가 stdout 라인을 정규화 이벤트로
 * 파싱, session 캡처, 종료 시 files_changed 집계 + 상태 전이. launchRun/steerRun 공유.
 */
async function runAgentChild(runId: number, machine: MachineTarget, wtPath: string, cmd: string, provider: Provider): Promise<void> {
  const child = spawnShellOn(machine, cmd);
  liveChildren.set(runId, child);

  let lastResult = '';
  if (child.stdout) {
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line: string) => {
      const p = provider.parseLine(line);
      if (!p) return;
      if (p.sessionId) void setRun(runId, { sessionId: p.sessionId }); // steer(resume)용 세션 키
      if (p.resultText != null) lastResult = p.resultText;
      void recordEvent(runId, p.kind, p.stored.slice(0, 2000));
    });
  }
  if (child.stderr) {
    const rle = createInterface({ input: child.stderr });
    rle.on('line', (line: string) => {
      const s = line.trim();
      if (s) void recordEvent(runId, 'stderr', s.slice(0, 2000));
    });
  }

  const code: number = await new Promise((resolve) => {
    child.on('close', (c) => resolve(c ?? 0));
    child.on('error', () => resolve(-1));
  });
  liveChildren.delete(runId);

  const stat = await runShellOn(machine, `git -C ${shq(wtPath)} status --porcelain | wc -l`, 10000);
  const filesChanged = stat.ok ? parseInt(stat.stdout.trim(), 10) || 0 : 0;

  const wasStopped = stoppedRuns.delete(runId);
  const status = wasStopped ? 'stopped' : code === 0 ? 'done' : 'failed';
  const exitSummary = wasStopped ? 'stopped by user' : lastResult ? lastResult.slice(0, 500) : `exit ${code}`;
  await setRun(runId, { status, endedAt: new Date(), filesChanged, exitSummary });
  // 문서 산출물을 정착 시점에 스냅샷 — worktree 소멸(머지·Close) 후에도 렌더 뷰 유지. best-effort.
  if (filesChanged > 0) void snapshotRunDocs(runId);
  void notifySettle(runId, status, filesChanged, exitSummary);
}

/**
 * 변경 문서(md/html)를 DB 에 스냅샷. 최신 우선(기존 행 삭제 후 재삽입).
 * 빈 읽기(worktree 이미 소멸 등)는 기존 스냅샷을 지우지 않는다.
 */
export async function snapshotRunDocs(runId: number): Promise<void> {
  const d = await getRunDocs(runId).catch(() => null);
  if (!d?.ok || d.docs.length === 0) return;
  await db.delete(docSnapshots).where(eq(docSnapshots.runId, runId));
  for (const doc of d.docs) await db.insert(docSnapshots).values({ runId, path: doc.path, kind: doc.kind, content: doc.content });
}

/** worktree(라이브) → 스냅샷 폴백 공용 로더. server 의 /api/runs/:id/docs·/share 가 사용. */
export async function loadRunDocs(runId: number): Promise<{
  docs: Array<{ path: string; kind: string; content: string }>; source: 'worktree' | 'snapshot';
}> {
  const live = await getRunDocs(runId).catch(() => null);
  if (live?.ok && live.docs.length > 0) return { docs: live.docs, source: 'worktree' };
  const snap = await db.select().from(docSnapshots).where(eq(docSnapshots.runId, runId));
  if (snap.length > 0) return { docs: snap.map((s) => ({ path: s.path, kind: s.kind, content: s.content })), source: 'snapshot' };
  return { docs: [], source: 'worktree' };
}

/** run 정착 웹훅(선택) — COXPIT_WEBHOOK_URL 로 JSON POST. 실패는 무해. */
async function notifySettle(runId: number, status: string, filesChanged: number, exitSummary: string): Promise<void> {
  if (!config.webhookUrl) return;
  try {
    const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
    const tr = rr[0] ? await db.select().from(tasks).where(eq(tasks.id, rr[0].taskId)).limit(1) : [];
    await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event: 'run.settled',
        run: { id: runId, status, filesChanged, exitSummary: exitSummary.slice(0, 300), task: tr[0]?.title ?? '' },
        // COXPIT_PUBLIC_URL 설정 시 폰에서 탭 → 보드가 그 run 모달을 딥링크로 연다
        ...(config.publicUrl ? { url: `${config.publicUrl}/?run=${runId}` } : {}),
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* 웹훅 실패는 조용히 */ }
}

/**
 * 후속 지시(steer) — 정착한 run 의 세션을 --resume 으로 이어 같은 worktree 에서 계속.
 * fire-and-forget. 진행 중 run 은 거부(개입은 터미널로).
 */
export async function steerRun(runId: number, message: string, mode: 'work' | 'ask' = 'work'): Promise<{ ok: boolean; detail: string }> {
  const ctx = await loadContext(runId);
  const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  const run = rr[0];
  if (!ctx || !run) return { ok: false, detail: 'run not found' };
  if (liveChildren.has(runId)) return { ok: false, detail: 'still running — attach the terminal to intervene' };
  if (!['done', 'failed', 'stopped'].includes(run.status)) return { ok: false, detail: `cannot steer a '${run.status}' run` };
  if (!run.worktreePath) return { ok: false, detail: 'worktree gone (cleaned up)' };
  if (!run.sessionId) return { ok: false, detail: 'no agent session on this run (dry-run runs cannot be steered)' };

  const wt = run.worktreePath;
  const exists = await runShellOn(ctx.machine, `test -d ${shq(wt)} && echo yes`, 8000);
  if (!exists.stdout.includes('yes')) return { ok: false, detail: 'worktree missing on machine' };

  await setRun(runId, { status: 'running', endedAt: null });
  await recordEvent(runId, mode === 'ask' ? 'ask' : 'steer', message.slice(0, 2000));

  // Ask 모드 — 세션에 질문만: 파일 수정 없이 답변만 하도록 래핑
  const finalMessage = mode === 'ask'
    ? `Question about your work in this session (do NOT modify any files, do NOT run write commands — answer concisely):\n${message}`
    : message;

  const isRemote = ctx.machine.kind !== 'local' && ctx.machine.address !== '';
  const pidPrefix = isRemote ? `printf '%s' "$$" > .coxpit-agent.pid && ` : '';
  const provider = getProvider(ctx.agent);
  // steer 세션도 셀프 오케스트레이션 유지(데몬 재시작으로 무효화된 토큰 재발급)
  const envPrefix = (!isRemote && config.agentOrch)
    ? `export COXPIT_API=${shq(`http://127.0.0.1:${config.port}`)} COXPIT_TOKEN=${shq(issueAgentToken(runId))}; `
    : '';
  const resume = provider.resumeCmd(run.sessionId, finalMessage, run.model || undefined);
  const cmd = `cd ${shq(wt)} && ${envPrefix}${pidPrefix}{ ${resume}; }`;
  if (!isRemote && config.agentOrch) {
    const orchTimer = startOrchWatch(runId, wt, true);
    void runAgentChild(runId, ctx.machine, wt, cmd, provider).finally(() => clearInterval(orchTimer));
  } else {
    void runAgentChild(runId, ctx.machine, wt, cmd, provider);
  }
  return { ok: true, detail: 'steering' };
}

/** 터미널 attach 용 — run 의 머신 타깃 + tmux 세션명. */
export async function getRunTermInfo(runId: number): Promise<{ machine: MachineTarget; session: string } | null> {
  const ctx = await loadContext(runId);
  const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  const run = rr[0];
  if (!ctx || !run || !run.tmuxWindow) return null;
  return { machine: ctx.machine, session: run.tmuxWindow };
}

/**
 * 실행 중 run 중지 — 자식 프로세스 SIGTERM. close 핸들러가 status='stopped' 로 봉인.
 */
export async function stopRun(runId: number): Promise<{ ok: boolean; detail: string }> {
  const child = liveChildren.get(runId);
  if (!child) {
    // 데몬 재시작 등으로 고아가 된 좀비 run — 프로세스는 없는데 DB 만 running.
    // stop 요청을 정산으로 처리해 카드가 영원히 '진행 중'으로 남지 않게 한다.
    const zr = (await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1))[0];
    if (zr && (zr.status === 'running' || zr.status === 'starting')) {
      await setRun(runId, { status: 'stopped', endedAt: new Date(), exitSummary: 'orphaned (daemon restarted) — settled by stop' });
      await recordEvent(runId, 'meta', JSON.stringify({ orphanSettled: true }));
      return { ok: true, detail: 'no live process — settled as stopped' };
    }
    return { ok: false, detail: 'not running' };
  }
  stoppedRuns.add(runId);

  // 원격이면 먼저 원격 프로세스를 pid 파일로 죽인다(ssh 채널만 끊으면 잔존 가능).
  const ctx = await loadContext(runId);
  const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  const run = rr[0];
  if (ctx && run && ctx.machine.kind !== 'local' && ctx.machine.address !== '' && run.worktreePath) {
    // pgid 조회 그룹 kill + TERM→KILL 에스컬레이션(스크립트 내 sleep 2 포함 — 타임아웃 여유).
    await runShellOn(ctx.machine, remoteKillScript(run.worktreePath), 15000);
  }

  // 로컬(또는 ssh 채널) 프로세스 그룹 종료 — sh 손자(실제 에이전트) 포함.
  try {
    if (child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  return { ok: true, detail: 'SIGTERM sent' };
}

/**
 * run worktree 의 변경 diff — tracked 는 diff HEAD, untracked 는 /dev/null 대비.
 */
export async function getRunDiff(runId: number): Promise<{ ok: boolean; diff: string; stat: string }> {
  const ctx = await loadContext(runId);
  const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  const run = rr[0];
  if (!ctx || !run || !run.worktreePath) return { ok: false, diff: '', stat: 'no worktree' };
  const wt = shq(run.worktreePath);
  const cmd =
    `git -C ${wt} status --porcelain` +
    ` ; echo '---DIFF---'` +
    ` ; git -C ${wt} diff HEAD` +
    ` ; git -C ${wt} ls-files --others --exclude-standard | while IFS= read -r f; do` +
    ` git -C ${wt} diff --no-index -- /dev/null "$f"; done ; true`;
  const r = await runShellOn(ctx.machine, cmd, 20000);
  const [stat = '', diff = ''] = r.stdout.split('---DIFF---\n');
  return { ok: true, stat: stat.trim(), diff: diff.slice(0, 200_000) };
}

/**
 * Doc 모드 — run worktree 의 변경 파일 중 문서(md/html)만 내용째 회수.
 * 보드가 diff 대신 "렌더된 산출물"을 보여줄 때 사용 (읽기 전용).
 */
export async function getRunDocs(runId: number): Promise<{
  ok: boolean; docs: Array<{ path: string; kind: 'md' | 'html'; content: string }>; detail?: string;
}> {
  const ctx = await loadContext(runId);
  const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  const run = rr[0];
  if (!ctx || !run || !run.worktreePath) return { ok: false, docs: [], detail: 'no worktree' };
  const wt = run.worktreePath;
  // 변경 파일 목록 = tracked 수정 + untracked (status --porcelain 경로 필드)
  const ls = await runShellOn(ctx.machine, `git -C ${shq(wt)} status --porcelain`, 15000);
  if (!ls.ok) return { ok: false, docs: [], detail: 'status failed' };
  const kindOf = (p: string): 'md' | 'html' | null =>
    /\.(md|markdown)$/i.test(p) ? 'md' : /\.(html?|htm)$/i.test(p) ? 'html' : null;
  const paths = ls.stdout.split('\n')
    .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''))
    .filter((p) => p && kindOf(p) !== null)
    .slice(0, 6); // 문서 비교 용도 — 상한
  const docs: Array<{ path: string; kind: 'md' | 'html'; content: string }> = [];
  for (const p of paths) {
    const cat = await runShellOn(ctx.machine, `head -c 200000 ${shq(ppath.join(wt, p))}`, 15000);
    if (cat.ok) docs.push({ path: p, kind: kindOf(p)!, content: cat.stdout });
  }
  return { ok: true, docs };
}

/**
 * base 동기화 — 오래 사는 세션의 worktree 에 base 브랜치 최신을 머지한다.
 * 충돌 시 자동 abort — 그땐 steer 로 에이전트에게 머지를 맡기라고 안내.
 */
export async function syncRun(runId: number): Promise<{ ok: boolean; detail: string; conflict?: boolean }> {
  const ctx = await loadContext(runId);
  const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  const run = rr[0];
  if (!ctx || !run || !run.worktreePath) return { ok: false, detail: 'no worktree' };
  if (liveChildren.has(runId)) return { ok: false, detail: 'still running — wait for it to settle' };
  const wt = shq(run.worktreePath);
  const ident = `-c user.name='coxpit' -c user.email='coxpit@local'`;
  // 미커밋 변경 먼저 커밋(머지 가능 상태로)
  const c1 = await runShellOn(ctx.machine,
    `cd ${wt} && git add -A && (git diff --cached --quiet || git ${ident} -c commit.gpgsign=false commit -m ${shq(`coxpit r${runId}: checkpoint before base sync`)})`, 20000);
  if (!c1.ok) return { ok: false, detail: 'checkpoint commit failed' };
  const mg = await runShellOn(ctx.machine,
    `cd ${wt} && git ${ident} -c commit.gpgsign=false merge --no-edit ${shq(ctx.baseBranch)} 2>&1 || (git merge --abort 2>/dev/null; echo COXPIT_SYNC_CONFLICT)`, 30000);
  if (mg.stdout.includes('COXPIT_SYNC_CONFLICT')) {
    return { ok: false, conflict: true, detail: `conflict with ${ctx.baseBranch} — steer the agent: "merge ${ctx.baseBranch} and resolve conflicts"` };
  }
  await recordEvent(runId, 'sync', `merged ${ctx.baseBranch} into session worktree`);
  return { ok: true, detail: mg.stdout.trim().split('\n').slice(-1)[0] ?? 'synced' };
}

/**
 * 승자 run 머지 — worktree 미커밋 변경을 자동 커밋 후 run 브랜치를
 * repo 기본 브랜치에 merge. 본 repo 가 기본 브랜치+클린일 때만, 충돌 시 abort.
 */
export async function mergeRun(runId: number): Promise<{ ok: boolean; detail: string; conflict?: boolean }> {
  const ctx = await loadContext(runId);
  const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  const run = rr[0];
  if (!ctx || !run || !run.worktreePath || !run.branch) return { ok: false, detail: 'no worktree/branch' };
  if (liveChildren.has(runId)) return { ok: false, detail: 'still running — stop it first' };
  const wt = shq(run.worktreePath);
  const repo = shq(ctx.repoPath);
  const ident = `-c user.name='coxpit' -c user.email='coxpit@local'`;

  // 1) worktree 미커밋 변경 자동 커밋(있을 때만)
  const c1 = await runShellOn(
    ctx.machine,
    `git -C ${wt} add -A && (git -C ${wt} diff --cached --quiet || git -C ${wt} ${ident} -c commit.gpgsign=false commit -m ${shq(`coxpit r${runId}: agent changes`)})`,
    20000,
  );
  if (!c1.ok) return { ok: false, detail: 'worktree commit failed: ' + (c1.stderr || c1.stdout).trim().slice(0, 300) };

  // 2) 본 repo 가드 — 기본 브랜치 위 + 클린
  const guard = await runShellOn(
    ctx.machine,
    `git -C ${repo} rev-parse --abbrev-ref HEAD && echo '---S---' && git -C ${repo} status --porcelain`,
    10000,
  );
  if (!guard.ok) return { ok: false, detail: 'repo check failed' };
  const [head = '', dirty = ''] = guard.stdout.split('---S---');
  if (head.trim() !== ctx.baseBranch) {
    return { ok: false, detail: `repo is on '${head.trim()}', expected '${ctx.baseBranch}'` };
  }
  if (dirty.trim() !== '') return { ok: false, detail: 'repo working tree not clean' };

  // 3) merge (충돌 시 abort)
  const mg = await runShellOn(
    ctx.machine,
    `git -C ${repo} ${ident} -c commit.gpgsign=false merge --no-ff -m ${shq(`coxpit: merge r${runId} (${run.branch})`)} ${shq(run.branch)} 2>&1 || (git -C ${repo} merge --abort 2>/dev/null; echo COXPIT_MERGE_FAILED)`,
    30000,
  );
  if (mg.stdout.includes('COXPIT_MERGE_FAILED')) {
    return { ok: false, conflict: true, detail: 'merge conflict — aborted: ' + mg.stdout.replace('COXPIT_MERGE_FAILED', '').trim().slice(0, 300) };
  }
  await setRun(runId, { status: 'merged' });
  return { ok: true, detail: mg.stdout.trim().slice(0, 300) };
}

/**
 * Workbench — 인터랙티브 작업방: 격리 worktree + tmux 만 만들고 에이전트는
 * 띄우지 않는다. 사람이 터미널로 들어가(원하면 claude TUI 로) 오래 작업하고,
 * coxpit 은 diff·merge·PR·export 레일만 제공한다. status='open'.
 */
export async function openWorkbench(repoId: number, title: string): Promise<{
  ok: boolean; detail: string; taskId?: number; runId?: number;
}> {
  const rp = await db.select().from(repos).where(eq(repos.id, repoId)).limit(1);
  const repo = rp[0];
  if (!repo) return { ok: false, detail: 'repo not found' };
  const mr = await db.select().from(machines).where(eq(machines.id, repo.machineId)).limit(1);
  const m = mr[0];
  if (!m) return { ok: false, detail: 'machine not found' };
  const machine: MachineTarget = { slug: m.slug, kind: m.kind, address: m.address, sshUser: m.sshUser };

  const tIns = await db.insert(tasks).values({ repoId, title: title || 'Workbench', prompt: '(interactive workbench)' }).returning();
  const task = tIns[0]!;
  const rIns = await db.insert(agentRuns).values({ taskId: task.id, machineId: m.id, agent: 'workbench', status: 'pending' }).returning();
  const run = rIns[0]!;
  const runId = run.id;
  broadcast({ type: 'run', runId, taskId: task.id, status: 'pending', agent: 'workbench', branch: '', filesChanged: 0 });

  const branch = `coxpit/r${runId}`;
  const wtParent = ppath.join(ppath.dirname(repo.path), '.coxpit-worktrees');
  const wtPath = ppath.join(wtParent, `r${runId}`);
  const session = `coxpit-r${runId}`;

  const prep = await runShellOn(
    machine,
    // 동명 세션 잔재(DB 리셋 등으로 run id 재사용) 선제 정리 — '=' 정확 일치만.
    // export LANG: tmux 서버 첫 기동이 C 로케일이면 세션 셸의 CJK 입력·표시가 깨진다.
    `export LANG=${shq(config.lang)}; mkdir -p ${shq(wtParent)} && git -C ${shq(repo.path)} worktree add -b ${shq(branch)} ${shq(wtPath)} ${shq(repo.defaultBranch)}` +
    ` && { tmux kill-session -t ${shq('=' + session)} 2>/dev/null || true; }` +
    ` && tmux new-session -d -s ${shq(session)} -c ${shq(wtPath)}`,
    20000,
  );
  if (!prep.ok) {
    await setRun(runId, { status: 'error', endedAt: new Date(), exitSummary: 'workbench prep failed' });
    return { ok: false, detail: (prep.stderr || prep.stdout).trim().slice(0, 300) };
  }
  await setRun(runId, { status: 'open', branch, worktreePath: wtPath, tmuxWindow: session, startedAt: new Date() });
  await recordEvent(runId, 'meta', JSON.stringify({ branch, worktree: wtPath, workbench: true }));
  return { ok: true, detail: 'workbench open', taskId: task.id, runId };
}

/**
 * Plan fan-out — 스웜의 입구. 목표 하나를 받아 플래너 에이전트가 repo 를 읽고
 * 독립 실행 가능한 하위 태스크들로 분해 → 각 태스크를 count 1 로 자동 발사한다.
 * (수렴은 Integrate 가 담당. real=false 는 배관 리허설용 모의 2분할.)
 */
export async function planFanout(repoId: number, goal: string, real: boolean): Promise<{
  ok: boolean; detail: string; tasks?: Array<{ id: number; title: string; runId: number }>;
}> {
  const rp = await db.select().from(repos).where(eq(repos.id, repoId)).limit(1);
  const repo = rp[0];
  if (!repo) return { ok: false, detail: 'repo not found' };
  const mr = await db.select().from(machines).where(eq(machines.id, repo.machineId)).limit(1);
  const m = mr[0];
  if (!m) return { ok: false, detail: 'machine not found' };
  const machine: MachineTarget = { slug: m.slug, kind: m.kind, address: m.address, sshUser: m.sshUser };

  let plan: Array<{ title: string; prompt: string }>;
  if (!real) {
    // 드라이런: 파이프라인 리허설용 고정 2분할
    plan = [
      { title: `[plan] ${goal.slice(0, 40)} — part 1`, prompt: `${goal}\n(rehearsal plan, part 1)` },
      { title: `[plan] ${goal.slice(0, 40)} — part 2`, prompt: `${goal}\n(rehearsal plan, part 2)` },
    ];
  } else {
    const plannerPrompt =
      `You are planning work for this repository. Goal:\n${goal}\n\n` +
      `Read the repository as needed, then respond with ONLY a JSON object (no prose, no code fences):\n` +
      `{"tasks":[{"title":"short imperative title","prompt":"full agent prompt"}]}\n` +
      `Rules: 2-6 tasks. Each must be independently executable in an isolated git worktree by a coding agent ` +
      `that knows nothing about the other tasks. Each prompt must name the target files, the constraints, and how to verify. ` +
      `Minimize file overlap between tasks to reduce merge conflicts. Do not include setup/integration tasks.`;
    // 플래너는 읽기만 하면 되므로 repo 본체에서 default 권한(편집 자동거부)으로 실행
    const cmd = `cd ${shq(repo.path)} && ${config.agent.bin} -p ${shq(plannerPrompt)} --output-format json`;
    const r = await runShellOn(machine, cmd, 300000);
    if (!r.ok) return { ok: false, detail: 'planner failed: ' + (r.stderr || r.stdout).trim().slice(0, 300) };
    try {
      const envelope = JSON.parse(r.stdout.trim()) as { result?: string };
      let body = (envelope.result ?? '').trim();
      const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fence?.[1] != null) body = fence[1].trim();
      const first = body.indexOf('{');
      const last = body.lastIndexOf('}');
      if (first === -1 || last === -1) throw new Error('no JSON in planner output');
      const parsed = JSON.parse(body.slice(first, last + 1)) as { tasks?: Array<{ title?: string; prompt?: string }> };
      plan = (parsed.tasks ?? [])
        .filter((t) => typeof t.title === 'string' && typeof t.prompt === 'string' && t.title && t.prompt)
        .slice(0, 8)
        .map((t) => ({ title: t.title as string, prompt: t.prompt as string }));
    } catch (e) {
      return { ok: false, detail: 'could not parse the plan: ' + String(e).slice(0, 200) };
    }
    if (plan.length < 1) return { ok: false, detail: 'planner returned no tasks' };
  }

  // 이 goal 의 형제들을 한 그룹으로 묶는다(보드 밴드). 드라이 리허설도 동일.
  const gIns = await db.insert(taskGroups).values({ kind: 'goal', title: goal.slice(0, 140) }).returning();
  const groupId = gIns[0]!.id;

  const created: Array<{ id: number; title: string; runId: number }> = [];
  for (const t of plan) {
    const tIns = await db.insert(tasks).values({ repoId, title: t.title, prompt: t.prompt, groupId }).returning();
    const task = tIns[0]!;
    const rIns = await db.insert(agentRuns).values({ taskId: task.id, machineId: m.id, agent: 'claude-code', status: 'pending' }).returning();
    const run = rIns[0]!;
    broadcast({ type: 'run', runId: run.id, taskId: task.id, status: 'pending', agent: run.agent, branch: '', filesChanged: 0 });
    void launchRun(run.id, real);
    created.push({ id: task.id, title: t.title, runId: run.id });
  }
  return { ok: true, detail: `${created.length} task(s) launched`, tasks: created };
}

/**
 * AI 리뷰(심판) — 태스크의 정착 run diff 들을 리뷰 에이전트가 읽고
 * 접근 방식·장단점·리스크·추천을 요약한다. 사람은 코드 전수가 아니라
 * 판단만 하면 되도록. (read-only, 워크트리 불필요)
 */
export async function reviewTask(taskId: number, real: boolean): Promise<{ ok: boolean; detail: string; review?: string }> {
  const tr = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  const task = tr[0];
  if (!task) return { ok: false, detail: 'task not found' };
  const rp = await db.select().from(repos).where(eq(repos.id, task.repoId)).limit(1);
  const repo = rp[0];
  if (!repo) return { ok: false, detail: 'repo not found' };
  const mr = await db.select().from(machines).where(eq(machines.id, repo.machineId)).limit(1);
  const m = mr[0];
  if (!m) return { ok: false, detail: 'machine not found' };
  const machine: MachineTarget = { slug: m.slug, kind: m.kind, address: m.address, sshUser: m.sshUser };

  const trs = (await db.select().from(agentRuns).where(eq(agentRuns.taskId, taskId)))
    .filter((r) => ['done', 'failed', 'stopped', 'merged'].includes(r.status));
  if (trs.length < 2) return { ok: false, detail: 'need at least 2 settled runs to review' };

  const sections: string[] = [];
  for (const r of trs) {
    const d = await getRunDiff(r.id);
    const diff = (d.ok ? d.diff : '(worktree gone — diff unavailable)').slice(0, 15000);
    sections.push(`### run r${r.id} (status: ${r.status})\nAgent's own summary: ${(r.exitSummary || '-').slice(0, 300)}\n\nDiff:\n\`\`\`diff\n${diff}\n\`\`\``);
  }

  if (!real) {
    return {
      ok: true, detail: 'rehearsal review',
      review: `## AI Review (rehearsal)\n\n${trs.map((r) => `**r${r.id}** — approach: (dry-run placeholder)\n- pros: n/a\n- cons: n/a`).join('\n\n')}\n\n**Recommendation**: run with Real agent for an actual review.`,
    };
  }

  const prompt =
    `You are reviewing ${trs.length} competing implementations of the same task.\n` +
    `Task: ${task.title}\nOriginal prompt: ${task.prompt.slice(0, 800)}\n\n` +
    sections.join('\n\n') +
    `\n\nWrite a review in markdown, in the language of the task prompt (Korean if the prompt is Korean):\n` +
    `1. For EACH run: one-line approach summary, then pros (max 3) and cons (max 3) as bullets.\n` +
    `2. '## 추천' section: which run to merge and WHY, in 2-3 sentences. If combining both is better, say exactly what to steer.\n` +
    `Judge correctness, simplicity, consistency with the existing codebase, and risk. Be decisive. Respond with ONLY the markdown.`;
  const cmd = `cd ${shq(repo.path)} && ${config.agent.bin} -p ${shq(prompt)} --output-format json`;
  const r = await runShellOn(machine, cmd, 300000);
  if (!r.ok) return { ok: false, detail: 'reviewer failed: ' + (r.stderr || r.stdout).trim().slice(0, 300) };
  try {
    const envelope = JSON.parse(r.stdout.trim()) as { result?: string };
    const review = (envelope.result ?? '').trim();
    if (!review) throw new Error('empty review');
    return { ok: true, detail: 'reviewed', review };
  } catch (e) {
    return { ok: false, detail: 'could not parse review: ' + String(e).slice(0, 200) };
  }
}

export interface IntegrateResult {
  runId: number;
  status: 'merged' | 'conflict' | 'skipped';
  detail?: string;
  integrationTaskId?: number;
  integrationRunId?: number;
}

/**
 * 통합(Integrate) — 여러 run(태스크 무관)을 base 에 순차 머지한다.
 * 충돌 나는 run 은 멈추지 않고 "통합 태스크"를 자동 발사 — 에이전트가
 * base 에서 분기한 새 worktree 에서 해당 브랜치를 머지·충돌 해소한다.
 * (스웜의 수렴 단계: 분업한 결과를 다시 하나로.)
 */
export async function integrateRuns(runIds: number[], real?: boolean): Promise<IntegrateResult[]> {
  const results: IntegrateResult[] = [];
  for (const id of runIds) {
    const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
    const run = rr[0];
    if (!run) { results.push({ runId: id, status: 'skipped', detail: 'not found' }); continue; }
    if (run.status === 'merged') { results.push({ runId: id, status: 'skipped', detail: 'already merged' }); continue; }

    const m = await mergeRun(id);
    if (m.ok) { results.push({ runId: id, status: 'merged' }); continue; }
    if (!m.conflict) { results.push({ runId: id, status: 'skipped', detail: m.detail }); continue; }

    // 충돌 → 통합 태스크 자동 발사 (에이전트가 머지를 대신 푼다)
    const ctx = await loadContext(id);
    if (!ctx) { results.push({ runId: id, status: 'skipped', detail: 'context missing for integration' }); continue; }
    const title = `Integrate r${id} into ${ctx.baseBranch}`;
    const prompt =
      `This worktree is branched from '${ctx.baseBranch}'. Merge the branch '${run.branch}' into it:\n` +
      `1. Run: git merge ${run.branch}\n` +
      `2. Resolve every conflict by preserving the intent of BOTH sides — do not simply pick one side.\n` +
      `3. Make sure the result is consistent (typecheck/tests if available), then commit the merge.\n` +
      `Do not modify files unrelated to the conflicts.`;
    const tIns = await db.insert(tasks).values({ repoId: ctx.repoId, title, prompt }).returning();
    const newTask = tIns[0]!;
    const rIns = await db.insert(agentRuns).values({ taskId: newTask.id, machineId: ctx.machineId, agent: 'claude-code', status: 'pending' }).returning();
    const newRun = rIns[0]!;
    broadcast({ type: 'run', runId: newRun.id, taskId: newTask.id, status: 'pending', agent: newRun.agent, branch: '', filesChanged: 0 });
    void launchRun(newRun.id, real ?? true);
    results.push({ runId: id, status: 'conflict', detail: m.detail, integrationTaskId: newTask.id, integrationRunId: newRun.id });
  }
  return results;
}

/**
 * 결과 파일 회수(export) — 조회성 태스크용: worktree 의 변경·신규 파일을
 * 지정 폴더로 복사한다. 머지 없이 산출물만 가져오는 길. (v1: 로컬 머신 전용)
 */
export async function exportRun(runId: number, destIn?: string): Promise<{ ok: boolean; detail: string; dest?: string; copied?: number; skipped?: number }> {
  const ctx = await loadContext(runId);
  const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  const run = rr[0];
  if (!ctx || !run || !run.worktreePath) return { ok: false, detail: 'no worktree' };
  if (liveChildren.has(runId)) return { ok: false, detail: 'still running — wait for it to settle' };
  if (ctx.machine.kind !== 'local' && ctx.machine.address !== '') {
    return { ok: false, detail: 'remote export not yet supported — files are on the remote machine' };
  }
  const wt = run.worktreePath;
  if (!existsSync(wt)) return { ok: false, detail: 'worktree missing (cleaned up)' };

  // 회수 대상 = 분기점 이후 커밋된 변경(머지 시도가 auto-commit 했을 수 있음) ∪ 미커밋·신규
  const list = await runShellOn(
    ctx.machine,
    `cd ${shq(wt)} && { git diff --name-only ${shq(ctx.baseBranch)}...HEAD -z 2>/dev/null; git ls-files -mo --exclude-standard -z; }`,
    15000,
  );
  if (!list.ok) return { ok: false, detail: 'could not list changed files' };
  const files = [...new Set(list.stdout.split('\0').filter(Boolean))];
  if (!files.length) return { ok: false, detail: 'no changed files in this run' };

  const dest = (destIn ?? '').trim() || ppath.join(homedir(), 'coxpit-exports', `r${runId}`);
  if (!dest.startsWith('/')) return { ok: false, detail: 'destination must be an absolute path' };

  let copied = 0, skipped = 0;
  for (const f of files) {
    const src = ppath.join(wt, f);
    if (!existsSync(src)) { skipped++; continue; } // 삭제된 파일 등
    const out = ppath.join(dest, f);
    await mkdir(ppath.dirname(out), { recursive: true });
    await copyFile(src, out);
    copied++;
  }
  await recordEvent(runId, 'export', JSON.stringify({ dest, copied, skipped }));
  return { ok: true, detail: `${copied} file(s) exported`, dest, copied, skipped };
}

/**
 * PR 모드 — run 브랜치를 origin 에 push 하고 gh 로 pull request 를 연다.
 * 팀 repo·리뷰 흐름용: 로컬 merge 대신 PR 로 결과를 보낸다.
 */
export async function prRun(runId: number): Promise<{ ok: boolean; detail: string; url?: string }> {
  const ctx = await loadContext(runId);
  const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  const run = rr[0];
  if (!ctx || !run || !run.worktreePath || !run.branch) return { ok: false, detail: 'no worktree/branch' };
  if (liveChildren.has(runId)) return { ok: false, detail: 'still running — stop it first' };
  if (!['done', 'failed', 'stopped', 'open'].includes(run.status)) return { ok: false, detail: `cannot open a PR from a '${run.status}' run` };
  const wt = shq(run.worktreePath);

  // 0) 사전 조건: origin 리모트 + gh CLI
  const pre = await runShellOn(ctx.machine,
    `cd ${wt} && { git remote get-url origin >/dev/null 2>&1 && echo R1 || echo R0; } && { command -v gh >/dev/null 2>&1 && echo G1 || echo G0; }`, 10000);
  if (!pre.stdout.includes('R1')) return { ok: false, detail: 'no origin remote on this repo' };
  if (!pre.stdout.includes('G1')) return { ok: false, detail: 'GitHub CLI (gh) not found on the machine' };

  // 1) worktree 미커밋 변경 자동 커밋
  const ident = `-c user.name='coxpit' -c user.email='coxpit@local'`;
  const c1 = await runShellOn(ctx.machine,
    `cd ${wt} && git add -A && (git diff --cached --quiet || git ${ident} -c commit.gpgsign=false commit -m ${shq(`coxpit r${runId}: agent changes`)})`, 20000);
  if (!c1.ok) return { ok: false, detail: 'worktree commit failed: ' + (c1.stderr || c1.stdout).trim().slice(0, 300) };

  // 2) push
  const push = await runShellOn(ctx.machine, `cd ${wt} && git push -u origin ${shq(run.branch)} 2>&1`, 60000);
  if (!push.ok) return { ok: false, detail: 'push failed: ' + (push.stderr || push.stdout).trim().slice(0, 300) };

  // 3) PR 생성 (동일 브랜치 PR 이 이미 있으면 그 URL 재사용)
  const tr = await db.select().from(tasks).where(eq(tasks.id, run.taskId)).limit(1);
  const title = `${tr[0]?.title ?? 'coxpit run'} (r${runId})`;
  const body = (run.exitSummary ? run.exitSummary + '\n\n' : '') + '🤖 Opened from a coxpit agent run';
  const pr = await runShellOn(ctx.machine,
    `cd ${wt} && gh pr create -B ${shq(ctx.baseBranch)} -H ${shq(run.branch)} -t ${shq(title)} -b ${shq(body)} 2>&1 || true`, 60000);
  const m = (pr.stdout + pr.stderr).match(/https:\/\/github\.com\/\S+\/pull\/\d+/);
  if (!m) return { ok: false, detail: 'gh pr create failed: ' + (pr.stdout || pr.stderr).trim().slice(0, 300) };

  await setRun(runId, { prUrl: m[0] });
  await recordEvent(runId, 'pr', m[0]);
  return { ok: true, detail: 'pull request opened', url: m[0] };
}

/**
 * worktree/브랜치/tmux 정리(태스크 종료·run 폐기 시).
 */
/**
 * 부팅 정산 — 데몬 재시작 후 살아있는 자식이 있을 수 없는데 DB 가 running/starting 인
 * run(고아)을 failed 로 정리한다. workbench('open')는 에이전트가 없으므로 대상 아님.
 */
export async function reconcileOrphanRuns(): Promise<number> {
  const stale = (await db.select().from(agentRuns)).filter(
    (r) => r.status === 'running' || r.status === 'starting',
  );
  for (const r of stale) {
    await setRun(r.id, { status: 'failed', endedAt: new Date(), exitSummary: 'orphaned by daemon restart' });
    await recordEvent(r.id, 'error', 'daemon restarted while this run was live — settled as failed (worktree/branch preserved; diff still reviewable)');
  }
  return stale.length;
}

/**
 * Close 가드 — 태스크 닫으면 worktree 가 삭제되므로, 아직 살릴 곳 없는 산출물을 경고.
 * 위험 = 정착(done/failed/stopped) ∧ 변경있음 ∧ 미머지 ∧ export·PR 이벤트 없음.
 */
export async function taskCloseRisk(taskId: number): Promise<Array<{ runId: number; filesChanged: number }>> {
  const trs = await db.select().from(agentRuns).where(eq(agentRuns.taskId, taskId));
  const atRisk: Array<{ runId: number; filesChanged: number }> = [];
  for (const r of trs) {
    if (!['done', 'failed', 'stopped'].includes(r.status)) continue;
    if (r.filesChanged <= 0) continue;
    const evs = await db.select().from(agentEvents).where(eq(agentEvents.runId, r.id));
    if (evs.some((e) => e.kind === 'export' || e.kind === 'pr')) continue; // 산출물이 이미 탈출함
    atRisk.push({ runId: r.id, filesChanged: r.filesChanged });
  }
  return atRisk;
}

export async function cleanupRun(runId: number): Promise<{ ok: boolean; detail: string }> {
  const ctx = await loadContext(runId);
  const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  const run = rr[0];
  if (!ctx || !run || !run.worktreePath) return { ok: false, detail: 'no worktree' };
  // worktree 를 지우기 전에 문서 스냅샷(정착 안 하는 워크벤치·수정편집도 포착). best-effort.
  await snapshotRunDocs(runId).catch(() => { /* 스냅샷 실패는 정리를 막지 않음 */ });
  // 원격에 잔존 에이전트가 있으면 worktree 제거 전에 죽인다(파일 잠금·좀비 방지).
  if (ctx.machine.kind !== 'local' && ctx.machine.address !== '') {
    await runShellOn(ctx.machine, remoteKillScript(run.worktreePath), 15000);
  }
  await runShellOn(ctx.machine, `tmux kill-session -t ${shq(`=coxpit-r${runId}`)} 2>/dev/null || true`, 8000);
  const rm = await runShellOn(
    ctx.machine,
    `git -C ${shq(ctx.repoPath)} worktree remove --force ${shq(run.worktreePath)} 2>&1` +
    ` ; git -C ${shq(ctx.repoPath)} branch -D ${shq(run.branch)} 2>&1 || true`,
    20000,
  );
  return { ok: true, detail: rm.stdout.trim().slice(0, 300) };
}
