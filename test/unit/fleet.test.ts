// run 상태 기계 + 머지 가드 — src/runstate.ts 의 순수 판정만 찌른다.
// git 도 DB 도 데몬도 띄우지 않는다: 머지 셸의 **출력**을 흉내 내 판정 경로를 직접 태운다.
// e2e.sh 는 같은 가드를 실제 저장소로 확인하지만(409 두 건), 그건 왜 막혔는지를 말해주지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  isSettled, SETTLED_STATUSES, settleStatus, canSteer, canOpenPr,
  canMerge, checkBaseRepo, classifyMergeResult, MERGE_FAIL_MARK,
} = await import('../../src/runstate.ts');

// ── 정착 판정 ──────────────────────────────────────────────────
test('settled = the agent is no longer running', () => {
  for (const s of ['done', 'failed', 'stopped', 'merged']) assert.equal(isSettled(s), true, s);
  for (const s of ['pending', 'preparing', 'running', 'open', '']) assert.equal(isSettled(s), false, s);
  assert.equal(SETTLED_STATUSES.length, 4);
});

test('settleStatus: a user stop outranks the exit code', () => {
  assert.equal(settleStatus(false, 0), 'done');
  assert.equal(settleStatus(false, 1), 'failed');
  assert.equal(settleStatus(false, -1), 'failed');
  // 우리가 죽인 프로세스의 비정상 코드를 실패로 적으면 보드가 빨간 run 으로 덮인다.
  assert.equal(settleStatus(true, 0), 'stopped');
  assert.equal(settleStatus(true, 143), 'stopped');
});

// ── 전이 가드 ──────────────────────────────────────────────────
test('steer: only a settled run can be woken; a live one goes to the terminal', () => {
  for (const s of ['done', 'failed', 'stopped']) {
    assert.equal(canSteer(s, false).ok, true, s);
  }
  // 살아있는 run 은 상태와 무관하게 거부 — 스트림에 말을 끼워 넣을 수 없다.
  const live = canSteer('done', true);
  assert.equal(live.ok, false);
  assert.match(live.detail, /attach the terminal/);
  for (const s of ['pending', 'preparing', 'running', 'merged', 'open']) {
    const g = canSteer(s, false);
    assert.equal(g.ok, false, s);
    assert.equal(g.detail, `cannot steer a '${s}' run`);
  }
});

test('PR: settled runs plus the interactive workbench (open)', () => {
  for (const s of ['done', 'failed', 'stopped', 'open']) assert.equal(canOpenPr(s, false).ok, true, s);
  for (const s of ['pending', 'preparing', 'running', 'merged']) {
    assert.equal(canOpenPr(s, false).ok, false, s);
  }
  assert.equal(canOpenPr('done', true).ok, false);
});

// ── 머지 가드 ──────────────────────────────────────────────────
test('merge entry: needs an isolated worktree+branch, and the run must be still', () => {
  assert.equal(canMerge({ live: false, worktreePath: '/tmp/wt', branch: 'coxpit/r7' }).ok, true);

  // 루트 세션·자유 세션 — branch 가 없다(이미 base). 머지할 것이 없다.
  for (const s of [
    { live: false, worktreePath: '/tmp/wt', branch: '' },
    { live: false, worktreePath: '/tmp/wt', branch: null },
    { live: false, worktreePath: '', branch: 'coxpit/r7' },
    { live: false, worktreePath: null, branch: null },
  ]) {
    const g = canMerge(s);
    assert.equal(g.ok, false);
    assert.equal(g.detail, 'no worktree/branch');
  }

  // 살아있는 run 의 worktree 를 커밋해 base 에 얹으면 반쪽이 올라간다.
  const live = canMerge({ live: true, worktreePath: '/tmp/wt', branch: 'coxpit/r7' });
  assert.equal(live.ok, false);
  assert.match(live.detail, /still running/);
});

test('base repo guard: right branch AND clean tree, both non-negotiable', () => {
  assert.equal(checkBaseRepo('main\n', '', 'main').ok, true);
  assert.equal(checkBaseRepo(' main \n', '\n', 'main').ok, true);

  const wrongBranch = checkBaseRepo('feature/x\n', '', 'main');
  assert.equal(wrongBranch.ok, false);
  assert.equal(wrongBranch.detail, "repo is on 'feature/x', expected 'main'");

  // detached HEAD 는 'HEAD' 로 나온다 — 기본 브랜치가 아니므로 거부.
  assert.equal(checkBaseRepo('HEAD\n', '', 'main').ok, false);

  // 사람이 손대던 변경이 머지 커밋에 섞이면 되돌릴 수 없다.
  const dirty = checkBaseRepo('main\n', ' M src/a.ts\n?? junk\n', 'main');
  assert.equal(dirty.ok, false);
  assert.equal(dirty.detail, 'repo working tree not clean');
});

test('merge result: the abort marker is the only conflict signal', () => {
  const clean = classifyMergeResult('Merge made by the ort strategy.\n a.txt | 1 +\n');
  assert.equal(clean.ok, true);
  assert.equal(clean.conflict, false);
  assert.equal(clean.detail, 'Merge made by the ort strategy.\n a.txt | 1 +');

  const conflict = classifyMergeResult(
    `Auto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt\n${MERGE_FAIL_MARK}\n`,
  );
  assert.equal(conflict.ok, false);
  assert.equal(conflict.conflict, true);
  assert.match(conflict.detail, /^merge conflict — aborted: /);
  // 판정 표식 자체는 사용자에게 새지 않는다.
  assert.equal(conflict.detail.includes(MERGE_FAIL_MARK), false);
  assert.match(conflict.detail, /CONFLICT \(content\)/);

  // "conflict" 라는 낱말이 성공 출력에 섞여도 표식이 없으면 성공이다
  // (git 종료코드는 셸 || 에 먹히므로 표식 말고는 볼 것이 없다).
  assert.equal(classifyMergeResult('resolved a merge conflict earlier\n').conflict, false);

  // detail 은 양쪽 모두 300자 상한.
  const long = classifyMergeResult('x'.repeat(1000));
  assert.equal(long.detail.length, 300);
  assert.equal(classifyMergeResult('y'.repeat(1000) + MERGE_FAIL_MARK).detail.length, 'merge conflict — aborted: '.length + 300);
});
