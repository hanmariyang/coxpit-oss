import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { config } from './config';

export interface RunResult {
  ok: boolean;        // 프로세스가 exit 0 인가
  code: number;       // exit code (-1 = spawn/timeout 실패)
  stdout: string;
  stderr: string;
}

/** 단일 프로세스 실행(promise). shell 없음 — 인자는 그대로 전달. */
function run(file: string, args: string[], timeoutMs = 12000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true, code: 0, stdout: String(stdout), stderr: String(stderr) });
      const code = typeof (err as NodeJS.ErrnoException).code === 'number'
        ? (err as unknown as { code: number }).code
        : -1;
      resolve({ ok: false, code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** POSIX 싱글쿼트 이스케이프 — 사용자 경로를 셸 커맨드에 안전하게 삽입. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface MachineTarget {
  slug: string;
  kind: string;
  address: string;
  sshUser: string;
}

function isLocal(m: MachineTarget): boolean {
  return m.kind === 'local' || m.address === '';
}

/**
 * 머신에서 셸 커맨드 1줄 실행.
 * 로컬 → `sh -c`, 원격 → `ssh [-i key] user@addr <cmd>`.
 * BatchMode=yes 라 비밀번호 프롬프트로 매달리지 않음(키/에이전트 없으면 즉시 실패).
 */
export async function runShellOn(m: MachineTarget, shellCmd: string, timeoutMs = 12000): Promise<RunResult> {
  if (isLocal(m)) return run('sh', ['-c', shellCmd], timeoutMs);
  const args: string[] = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=6',
    '-o', 'StrictHostKeyChecking=accept-new',
  ];
  if (config.sshKey) args.push('-i', config.sshKey);
  const target = m.sshUser ? `${m.sshUser}@${m.address}` : m.address;
  args.push(target, shellCmd);
  return run('ssh', args, timeoutMs);
}

/**
 * 스트리밍 실행 — 자식 프로세스를 반환(stdout/stderr pipe).
 * 오케스트레이터가 stdout 라인을 실시간 파싱하는 용도.
 */
export function spawnShellOn(m: MachineTarget, shellCmd: string): ChildProcess {
  if (isLocal(m)) return spawn('sh', ['-c', shellCmd], { stdio: ['ignore', 'pipe', 'pipe'] });
  const args: string[] = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=6',
    '-o', 'StrictHostKeyChecking=accept-new',
  ];
  if (config.sshKey) args.push('-i', config.sshKey);
  const target = m.sshUser ? `${m.sshUser}@${m.address}` : m.address;
  args.push(target, shellCmd);
  return spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
}
