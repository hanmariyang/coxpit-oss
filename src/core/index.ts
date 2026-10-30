// 커널 공개면. 제품은 여기서만 들여온다.
//
// 규칙: src/core/ 안의 어떤 파일도 src/core/ 바깥을 import 하지 않는다.
// 깨지면 test/unit/core-boundary.test.ts 가 즉시 빨개진다. 왜 중요한지는 README.md.

export { type MachineTarget, isLocalMachine } from './types';
export { shq, samePath } from './shell';
export { TMUX_HISTORY_LIMIT, tmuxNewSession, tmuxInstanceEnv, tmuxKillOwned } from './tmux';
export { makeNaming, type Naming } from './naming';
export { spawnPty, openTerm, type TermOptions } from './term';
export {
  SETTLED_STATUSES, isSettled, settleStatus, type Guard,
  canSteer, canOpenPr, canMerge, checkBaseRepo,
  MERGE_FAIL_MARK, classifyMergeResult,
} from './runstate';
