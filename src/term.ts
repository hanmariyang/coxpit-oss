import { createRequire } from 'node:module';
import { chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { IPty } from 'node-pty';
import { config } from './config';
import type { MachineTarget } from './exec';

const require_ = createRequire(import.meta.url);

// node-pty prebuilt spawn-helper 는 npm 패키징에서 실행 비트가 빠져 오는 경우가 있어
// (posix_spawnp failed) 로드 전에 best-effort 로 보정한다.
function fixSpawnHelper(): void {
  try {
    const ptyPkg = require_.resolve('node-pty/package.json');
    const base = dirname(ptyPkg);
    for (const dir of [`darwin-${process.arch}`, `linux-${process.arch}`]) {
      try { chmodSync(join(base, 'prebuilds', dir, 'spawn-helper'), 0o755); } catch { /* absent */ }
    }
  } catch { /* node-pty missing — openTerm 에서 에러 */ }
}
fixSpawnHelper();

// eslint 없는 프로젝트 — 동적 require 로 native 로드 실패를 호출 시점 에러로 미룬다.
type PtyModule = typeof import('node-pty');
let ptyMod: PtyModule | null = null;
function pty(): PtyModule {
  if (!ptyMod) ptyMod = require_('node-pty') as PtyModule;
  return ptyMod;
}

function isLocal(m: MachineTarget): boolean {
  return m.kind === 'local' || m.address === '';
}

/**
 * 머신의 tmux 세션에 PTY 로 attach.
 * 로컬 → tmux attach 직접. 원격 → PTY 안에서 ssh -tt (리사이즈 SIGWINCH 전파됨).
 */
export function openTerm(m: MachineTarget, session: string, cols: number, rows: number): IPty {
  const opts = {
    name: 'xterm-256color',
    cols: Math.max(20, Math.min(500, cols || 80)),
    rows: Math.max(5, Math.min(200, rows || 24)),
    // LANG: C 로케일 클라이언트로 attach 하면 tmux 가 CJK 를 '_' 로 뭉갠다 (config 에서 UTF-8 보장)
    env: { ...process.env, TERM: 'xterm-256color', LANG: config.lang } as Record<string, string>,
  };
  if (isLocal(m)) {
    return pty().spawn('tmux', ['attach-session', '-t', '=' + session], opts);
  }
  const args: string[] = [
    '-tt',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=6',
    '-o', 'StrictHostKeyChecking=accept-new',
  ];
  if (config.sshKey) args.push('-i', config.sshKey);
  const target = m.sshUser ? `${m.sshUser}@${m.address}` : m.address;
  // 세션명은 우리가 만든 coxpit-rN 형식이라 셸 주입 여지 없음 — 그래도 인용.
  // 원격도 UTF-8 로케일 명시 (비대화 ssh 는 LANG 미설정이 보통)
  args.push(target, `export LANG='${config.lang.replace(/'/g, '')}'; tmux attach-session -t '=${session.replace(/'/g, "'\\''")}'`);
  return pty().spawn('ssh', args, opts);
}
