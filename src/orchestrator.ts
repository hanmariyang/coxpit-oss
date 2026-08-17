import { posix as ppath } from 'node:path';
import { createInterface } from 'node:readline';
import type { ChildProcess } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { config } from './config';
import { db } from './db';
import { agentRuns, agentEvents, tasks, repos, machines, designCaptures } from './db/schema';
import { runShellOn, spawnShellOn, shq, type MachineTarget } from './exec';
import { broadcast } from './hub';

/** 에이전트 실행 커맨드. 드라이런=모의 stream-json + 실제 파일 1건 변경. */
function agentCommand(prompt: string, real: boolean): string {
  if (real) {
    // claude-code headless. stream-json 라인이 stdout 으로 흐른다.
    return `${config.agent.bin} -p ${shq(prompt)} --output-format stream-json --verbose` +
      ` --permission-mode ${config.agent.perm}`;
  }
  // 모의: init → assistant → (파일 변경) → result. 진짜 stream-json 라인 형태.
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

interface RunContext {
  runId: number;
  machine: MachineTarget;
  repoPath: string;
  baseBranch: string;
  prompt: string;
  real: boolean;
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
    repoPath: repo.path,
    baseBranch: repo.defaultBranch,
    prompt,
    real: run.agent === 'claude-code' ? config.agent.real : config.agent.real,
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

    // 2) tmux 창(사람이 attach 해 개입할 수 있게) — best-effort
    await runShellOn(ctx.machine, `tmux new-session -d -s ${shq(session)} -c ${shq(wtPath)} 2>/dev/null || true`, 8000);

    await setRun(runId, { status: 'running' });
    await recordEvent(runId, 'meta', JSON.stringify({ branch, worktree: wtPath, real: useReal }));

    // 3) 에이전트 spawn(스트리밍)
    // 원격은 ssh 채널이 죽어도 프로세스가 남을 수 있어 pid 파일을 남긴다(stop 시 원격 kill).
    const isRemote = ctx.machine.kind !== 'local' && ctx.machine.address !== '';
    const pidPrefix = isRemote ? `printf '%s' "$$" > .coxpit-agent.pid && ` : '';
    const cmd = `cd ${shq(wtPath)} && ${pidPrefix}{ ${agentCommand(ctx.prompt, useReal)}; }`;
    const child = spawnShellOn(ctx.machine, cmd);
    liveChildren.set(runId, child);

    let lastResult = '';
    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on('line', (line: string) => {
        const s = line.trim();
        if (!s) return;
        let kind = 'log';
        try {
          const obj = JSON.parse(s) as { type?: string; result?: string };
          if (obj.type) kind = obj.type;
          // result 이벤트의 사람이 읽는 요약만 뽑아 둔다(없으면 원본 라인).
          if (obj.type === 'result') lastResult = typeof obj.result === 'string' ? obj.result : s;
        } catch { /* 비-JSON 로그 라인 */ }
        void recordEvent(runId, kind, s.slice(0, 2000));
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

    // 4) 변경 파일 수 집계
    const stat = await runShellOn(ctx.machine, `git -C ${shq(wtPath)} status --porcelain | wc -l`, 10000);
    const filesChanged = stat.ok ? parseInt(stat.stdout.trim(), 10) || 0 : 0;

    const wasStopped = stoppedRuns.delete(runId);
    await setRun(runId, {
      status: wasStopped ? 'stopped' : code === 0 ? 'done' : 'failed',
      endedAt: new Date(),
      filesChanged,
      exitSummary: wasStopped ? 'stopped by user' : lastResult ? lastResult.slice(0, 500) : `exit ${code}`,
    });
  } catch (e) {
    await recordEvent(runId, 'error', String(e).slice(0, 500));
    await setRun(runId, { status: 'error', endedAt: new Date(), exitSummary: 'orchestrator error' });
  }
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
  if (!child) return { ok: false, detail: 'not running' };
  stoppedRuns.add(runId);

  // 원격이면 먼저 원격 프로세스를 pid 파일로 죽인다(ssh 채널만 끊으면 잔존 가능).
  const ctx = await loadContext(runId);
  const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  const run = rr[0];
  if (ctx && run && ctx.machine.kind !== 'local' && ctx.machine.address !== '' && run.worktreePath) {
    const pidFile = shq(`${run.worktreePath}/.coxpit-agent.pid`);
    // 그룹 kill(-P, sshd 는 커맨드 셸을 세션리더로 띄워 성립) → 실패 시 자식(pkill -P)+본체 순.
    await runShellOn(
      ctx.machine,
      `P=$(cat ${pidFile} 2>/dev/null) && { kill -TERM -"$P" 2>/dev/null || { pkill -TERM -P "$P" 2>/dev/null; kill -TERM "$P" 2>/dev/null; }; } || true`,
      8000,
    );
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
 * 승자 run 머지 — worktree 미커밋 변경을 자동 커밋 후 run 브랜치를
 * repo 기본 브랜치에 merge. 본 repo 가 기본 브랜치+클린일 때만, 충돌 시 abort.
 */
export async function mergeRun(runId: number): Promise<{ ok: boolean; detail: string }> {
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
    return { ok: false, detail: 'merge conflict — aborted: ' + mg.stdout.replace('COXPIT_MERGE_FAILED', '').trim().slice(0, 300) };
  }
  await setRun(runId, { status: 'merged' });
  return { ok: true, detail: mg.stdout.trim().slice(0, 300) };
}

/**
 * worktree/브랜치/tmux 정리(태스크 종료·run 폐기 시).
 */
export async function cleanupRun(runId: number): Promise<{ ok: boolean; detail: string }> {
  const ctx = await loadContext(runId);
  const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  const run = rr[0];
  if (!ctx || !run || !run.worktreePath) return { ok: false, detail: 'no worktree' };
  await runShellOn(ctx.machine, `tmux kill-session -t ${shq(`coxpit-r${runId}`)} 2>/dev/null || true`, 8000);
  const rm = await runShellOn(
    ctx.machine,
    `git -C ${shq(ctx.repoPath)} worktree remove --force ${shq(run.worktreePath)} 2>&1` +
    ` ; git -C ${shq(ctx.repoPath)} branch -D ${shq(run.branch)} 2>&1 || true`,
    20000,
  );
  return { ok: true, detail: rm.stdout.trim().slice(0, 300) };
}
