import { createRequire } from 'node:module';
import { chmodSync, closeSync, fstatSync, readdirSync } from 'node:fs';
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
    const candidates = [
      join(base, 'build', 'Release', 'spawn-helper'), // 소스빌드(node-gyp) 경로
      join(base, 'build', 'Debug', 'spawn-helper'),
    ];
    for (const dir of [`darwin-${process.arch}`, `linux-${process.arch}`]) {
      candidates.push(join(base, 'prebuilds', dir, 'spawn-helper'));
    }
    for (const p of candidates) {
      try { chmodSync(p, 0o755); } catch { /* absent or read-only bundle */ }
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

// node-pty 1.1.0 의 macOS(posix_spawn) 경로는 spawn 마다 pty master 를 하나 더 열고 안 닫는다
// (src/unix/pty.cc pty_posix_spawn: low_fds 정리 루프가 count==0 이면 아무것도 닫지 않음).
// 터미널을 열 때마다 /dev/ptmx 가 하나씩 새어 kern.tty.ptmx_max(맥 기본 511) 가 마르면
// 그 뒤로는 모든 spawn 이 "posix_spawnp failed." 로 죽는다 (2026-09-10 맥미니 데몬 256개 누수).
// spawn 전후의 fd 를 비교해, 새로 생긴 pty master(term.fd 와 같은 major 의 문자 디바이스) 중
// term.fd 가 아닌 것만 닫는다. 슬레이브·kqueue·/dev/null 은 major 가 달라 건드리지 않고,
// 스레드풀이 동시에 여는 일반 파일도 문자 디바이스가 아니라 안전하다. Linux 는 forkpty 경로라 해당 없음.
function liveFds(): Set<number> {
  const s = new Set<number>();
  for (const n of readdirSync('/dev/fd')) {
    const fd = Number(n);
    try { fstatSync(fd); s.add(fd); } catch { /* readdir 자신의 fd 등 이미 닫힌 것 */ }
  }
  return s;
}
function spawnPty(file: string, args: string[], opts: Parameters<PtyModule['spawn']>[2]): IPty {
  if (process.platform !== 'darwin') return pty().spawn(file, args, opts);
  const before = liveFds();
  const term = pty().spawn(file, args, opts);
  const fd = (term as unknown as { fd?: number }).fd;
  if (typeof fd !== 'number') return term;
  let masterMajor: number;
  try { masterMajor = (fstatSync(fd).rdev >> 24) & 0xff; } catch { return term; }
  for (const n of liveFds()) {
    if (n === fd || before.has(n)) continue;
    try {
      const st = fstatSync(n);
      if (st.isCharacterDevice() && ((st.rdev >> 24) & 0xff) === masterMajor) closeSync(n);
    } catch { /* 그 사이 닫힘 */ }
  }
  return term;
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
    return spawnPty('tmux', ['attach-session', '-t', '=' + session], opts);
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
  return spawnPty('ssh', args, opts);
}
