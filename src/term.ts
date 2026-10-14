// 커널의 PTY 를 제품 설정으로 감싼다 — 호출부(server.ts)는 전과 같은 모양으로 쓴다.
import type { IPty } from 'node-pty';
import { config } from './config';
import { openTerm as coreOpenTerm, type MachineTarget } from './core';

export { spawnPty } from './core';

/** 머신의 tmux 세션에 PTY 로 attach. 로케일·ssh 키는 config 에서 주입한다. */
export function openTerm(m: MachineTarget, session: string, cols: number, rows: number): IPty {
  return coreOpenTerm(m, session, cols, rows, { lang: config.lang, sshKey: config.sshKey });
}
