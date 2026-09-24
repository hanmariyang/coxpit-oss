// run 상태 기계와 머지 가드 — I/O 없는 순수 판정만 모아 둔다.
// orchestrator 는 여기를 그대로 부르고(판정을 두 번 적지 않는다), 테스트는 데몬도 git 도
// 띄우지 않고 이 함수들을 직접 찌른다. 자꾸 깨지는 자리라 밀리초에 빨개져야 한다(issue #15).
// 여기에는 db·exec·config 를 import 하지 않는다 — 들여오는 순간 순수성이 사라진다.

/** 정착(settled) 상태 — 에이전트가 더는 돌지 않는 run. */
export const SETTLED_STATUSES: readonly string[] = ['done', 'failed', 'stopped', 'merged'];

export function isSettled(status: string): boolean {
  return SETTLED_STATUSES.includes(status);
}

/**
 * 에이전트 종료 → 정착 상태.
 * 사용자 중지가 exit code 보다 앞선다 — 우리가 죽인 프로세스의 비정상 코드를 실패로 적으면
 * 보드에 빨간 run 이 쌓이고, "왜 실패했지"를 매번 다시 확인하게 된다.
 */
export function settleStatus(wasStopped: boolean, code: number): 'stopped' | 'done' | 'failed' {
  return wasStopped ? 'stopped' : code === 0 ? 'done' : 'failed';
}

/** 가드 판정 — ok=false 면 detail 이 그대로 사용자에게 나간다. */
export interface Guard { ok: boolean; detail: string }
const PASS: Guard = { ok: true, detail: '' };

/**
 * steer/ask — 살아있는 run 에 끼어드는 길은 터미널뿐이다(스트림에 말을 끼워 넣을 수 없다).
 * 정착한 run 만 다시 깨운다.
 */
export function canSteer(status: string, live: boolean): Guard {
  if (live) return { ok: false, detail: 'still running — attach the terminal to intervene' };
  if (!['done', 'failed', 'stopped'].includes(status)) {
    return { ok: false, detail: `cannot steer a '${status}' run` };
  }
  return PASS;
}

/** PR — 정착한 run + 사람이 쓰는 작업방(open)까지. */
export function canOpenPr(status: string, live: boolean): Guard {
  if (live) return { ok: false, detail: 'still running — stop it first' };
  if (!['done', 'failed', 'stopped', 'open'].includes(status)) {
    return { ok: false, detail: `cannot open a PR from a '${status}' run` };
  }
  return PASS;
}

/**
 * 머지 진입 가드.
 * branch 가 없는 run(루트 세션·자유 세션)은 애초에 머지할 것이 없다 — 이미 base 다.
 * 살아있는 run 은 거부: 에이전트가 쓰는 중인 worktree 를 커밋해 base 에 얹으면 반쪽이 올라간다.
 */
export function canMerge(s: { live: boolean; worktreePath?: string | null; branch?: string | null }): Guard {
  if (!s.worktreePath || !s.branch) return { ok: false, detail: 'no worktree/branch' };
  if (s.live) return { ok: false, detail: 'still running — stop it first' };
  return PASS;
}

/**
 * 본 repo 가드 — 기본 브랜치 위 + 클린.
 * 둘 다 협상 불가다: 다른 브랜치 위라면 엉뚱한 곳에 얹히고, 더러운 트리라면 사람이 손대던
 * 변경이 머지 커밋에 섞여 되돌릴 수 없다.
 * head·dirty 는 `git rev-parse --abbrev-ref HEAD` 와 `git status --porcelain` 의 원문.
 */
export function checkBaseRepo(head: string, dirty: string, baseBranch: string): Guard {
  if (head.trim() !== baseBranch) {
    return { ok: false, detail: `repo is on '${head.trim()}', expected '${baseBranch}'` };
  }
  if (dirty.trim() !== '') return { ok: false, detail: 'repo working tree not clean' };
  return PASS;
}

/**
 * 머지 셸이 실패했을 때 찍는 표식 — `git merge ... || (git merge --abort; echo <이것>)`.
 * git 의 종료코드는 셸 || 에 먹히므로, 충돌 여부는 이 표식으로만 판정한다.
 */
export const MERGE_FAIL_MARK = 'COXPIT_MERGE_FAILED';

/** 머지 셸 출력 → 판정. 표식이 있으면 충돌(이미 abort 됨), 없으면 성공. */
export function classifyMergeResult(stdout: string): { ok: boolean; conflict: boolean; detail: string } {
  if (stdout.includes(MERGE_FAIL_MARK)) {
    return {
      ok: false,
      conflict: true,
      detail: 'merge conflict — aborted: ' + stdout.replace(MERGE_FAIL_MARK, '').trim().slice(0, 300),
    };
  }
  return { ok: true, conflict: false, detail: stdout.trim().slice(0, 300) };
}
