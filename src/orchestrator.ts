import { posix as ppath } from 'node:path';
import { createInterface } from 'node:readline';
import { eq } from 'drizzle-orm';
import { config } from './config';
import { db } from './db';
import { agentRuns, agentEvents, tasks, repos, machines } from './db/schema';
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
  return {
    runId,
    machine: { slug: m.slug, kind: m.kind, address: m.address, sshUser: m.sshUser },
    repoPath: repo.path,
    baseBranch: repo.defaultBranch,
    prompt: task.prompt,
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
    const cmd = `cd ${shq(wtPath)} && ${agentCommand(ctx.prompt, useReal)}`;
    const child = spawnShellOn(ctx.machine, cmd);

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

    // 4) 변경 파일 수 집계
    const stat = await runShellOn(ctx.machine, `git -C ${shq(wtPath)} status --porcelain | wc -l`, 10000);
    const filesChanged = stat.ok ? parseInt(stat.stdout.trim(), 10) || 0 : 0;

    await setRun(runId, {
      status: code === 0 ? 'done' : 'failed',
      endedAt: new Date(),
      filesChanged,
      exitSummary: lastResult ? lastResult.slice(0, 500) : `exit ${code}`,
    });
  } catch (e) {
    await recordEvent(runId, 'error', String(e).slice(0, 500));
    await setRun(runId, { status: 'error', endedAt: new Date(), exitSummary: 'orchestrator error' });
  }
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
