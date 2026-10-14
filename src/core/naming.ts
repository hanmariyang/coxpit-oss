// 이름 규칙 — worktree 폴더·브랜치·tmux 세션·상태 폴더의 이름을 한 곳에서 만든다.
//
// 왜 커널에 있나: 이 이름들이 제품 이름을 품는다(`.coxpit-worktrees`, `coxpit/r22`, `coxpit-r22`).
// 같은 기계에서 두 제품이 돌면 tmux 세션과 worktree 폴더가 그대로 충돌한다 — 한쪽이 만든 세션에
// 다른 쪽이 attach 하거나, 회수 코드가 남의 폴더를 집는다. 접두어를 주입받게 해 그 사고를 구조로 막는다.
//
// 세션명 매칭은 언제나 tmux 의 '=' 정확 일치로 해야 한다. 접두 매칭이면 r5 가 r50 을 집는다.

import { posix as ppath } from 'node:path';

export interface Naming {
  /** 접두어 그대로 — 로그·진단용. */
  readonly prefix: string;
  /** worktree 들을 모아 두는 폴더. repo 체크아웃의 형제로 둔다. */
  worktreeParent(repoPath: string): string;
  /** 한 run 의 격리 worktree 경로. */
  worktreePath(repoPath: string, runId: number): string;
  /** 한 run 의 브랜치 이름. */
  branch(runId: number): string;
  /** 한 run 의 tmux 세션 이름. */
  session(runId: number): string;
  /**
   * 우리 세션만 집는 정규식 — 캡처 1번이 run id.
   * 고아 세션 정리가 쓴다. 만드는 쪽(session)과 찾는 쪽이 어긋나면 남의 세션을 죽이거나
   * 우리 것을 영원히 못 찾는다. 그래서 같은 자리에서 낸다.
   */
  sessionPattern(): RegExp;
  /** worktree 안에 두는 상태 폴더 이름(끝 슬래시 없음). git info/exclude 에도 이 이름을 넣는다. */
  readonly stateDir: string;
  /** 그 상태 폴더의 전체 경로. */
  statePath(worktreePath: string): string;
  /** 에이전트 pid 파일 경로. */
  agentPidFile(worktreePath: string): string;
}

const PREFIX_RE = /^[a-z][a-z0-9-]{0,30}$/;

/**
 * 접두어 하나로 이름 한 벌을 만든다.
 * 접두어는 경로·브랜치·tmux 세션명에 그대로 들어가므로 소문자·숫자·하이픈만 받는다.
 */
export function makeNaming(prefix: string): Naming {
  if (!PREFIX_RE.test(prefix)) {
    throw new Error(`naming prefix must match ${PREFIX_RE} — got ${JSON.stringify(prefix)}`);
  }
  const stateDir = `.${prefix}`;
  return {
    prefix,
    stateDir,
    worktreeParent: (repoPath) => ppath.join(ppath.dirname(repoPath), `.${prefix}-worktrees`),
    worktreePath(repoPath, runId) {
      return ppath.join(this.worktreeParent(repoPath), `r${runId}`);
    },
    branch: (runId) => `${prefix}/r${runId}`,
    session: (runId) => `${prefix}-r${runId}`,
    sessionPattern: () => new RegExp(`^${prefix}-r(\\d+)$`),
    statePath: (worktreePath) => ppath.join(worktreePath, stateDir),
    agentPidFile: (worktreePath) => `${worktreePath}/${stateDir}-agent.pid`,
  };
}
