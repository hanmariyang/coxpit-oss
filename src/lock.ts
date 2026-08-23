import fs from 'node:fs';
import { config } from './config';

// 단일 데몬 락 — DB 폴더의 daemon.lock.json.
// 두 데몬이 같은 DB 를 잡으면 부팅 시 reconcileOrphanRuns() 가 상대 데몬의
// 살아있는 run 을 고아로 정산해버린다. 락 + 헬스 프로브로 원천 차단한다.

interface LockInfo {
  pid: number;
  host: string;
  port: number;
}

/** 해당 주소에 살아있는 coxpit 데몬이 있는지 확인 (/api/health 는 인증 면제). */
export async function probeCoxpit(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(`http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/api/health`, { signal: ac.signal });
    clearTimeout(t);
    if (!res.ok) return false;
    const body = (await res.json()) as { name?: string };
    return body?.name === 'coxpit';
  } catch {
    return false;
  }
}

export function readLock(lockPath: string): LockInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockInfo;
    return Number.isInteger(raw?.pid) && Number.isInteger(raw?.port) ? raw : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 실제 바인드 포트를 락에 반영(자동 포트 이동 후 — 데스크톱/외부가 실제 포트를 읽게). */
export function updateLockPort(port: number): void {
  try {
    const cur = readLock(config.lockPath);
    if (cur?.pid === process.pid && cur.port !== port) {
      fs.writeFileSync(config.lockPath, JSON.stringify({ ...cur, port } satisfies LockInfo));
    }
  } catch { /* best effort */ }
}

/**
 * 락 획득. 이미 살아있는 데몬이 같은 DB 를 잡고 있으면 안내 후 종료.
 * 죽은 프로세스가 남긴 stale 락은 치우고 진행한다.
 */
export async function acquireDaemonLock(): Promise<void> {
  const existing = readLock(config.lockPath);
  if (existing && existing.pid !== process.pid) {
    // pid 재사용 오탐을 피하려고 헬스 프로브를 진실로 삼는다.
    const alive = pidAlive(existing.pid) && (await probeCoxpit(existing.host ?? '127.0.0.1', existing.port));
    if (alive) {
      const url = `http://${(existing.host ?? '127.0.0.1') === '0.0.0.0' ? '127.0.0.1' : existing.host}:${existing.port}/`;
      console.error(
        `[coxpit] another daemon already owns this database (pid ${existing.pid}, ${url}).\n` +
        `[coxpit] open that URL instead, or stop it first — running two daemons on one DB corrupts live runs.`,
      );
      process.exit(1);
    }
    try { fs.unlinkSync(config.lockPath); } catch { /* gone */ }
  }

  fs.writeFileSync(config.lockPath, JSON.stringify({ pid: process.pid, host: config.host, port: config.port } satisfies LockInfo));

  const release = () => {
    try {
      const cur = readLock(config.lockPath);
      if (cur?.pid === process.pid) fs.unlinkSync(config.lockPath);
    } catch { /* best effort */ }
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => { release(); process.exit(0); });
  }
}
