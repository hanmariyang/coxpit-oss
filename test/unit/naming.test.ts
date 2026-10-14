// 이름 규칙 — 추출이 문자열을 한 글자도 바꾸지 않았는지 못박는다.
//
// 여기 적힌 값들은 디스크에 이미 존재하는 worktree 폴더·브랜치·tmux 세션의 이름이다.
// 하나라도 달라지면 돌고 있는 run 들이 고아가 되고, 고아 정리가 그것들을 집어 죽인다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { makeNaming } = await import('../../src/core/naming.ts');

const names = makeNaming('coxpit');
const REPO = '/Users/someone/code/eduops';

test('the product names are exactly what is already on disk', () => {
  assert.equal(names.worktreeParent(REPO), '/Users/someone/code/.coxpit-worktrees');
  assert.equal(names.worktreePath(REPO, 22), '/Users/someone/code/.coxpit-worktrees/r22');
  assert.equal(names.branch(22), 'coxpit/r22');
  assert.equal(names.session(22), 'coxpit-r22');
  assert.equal(names.stateDir, '.coxpit');
  assert.equal(names.statePath('/wt/r22'), '/wt/r22/.coxpit');
  assert.equal(names.agentPidFile('/wt/r22'), '/wt/r22/.coxpit-agent.pid');
});

test('the session pattern finds our sessions and only ours', () => {
  const re = names.sessionPattern();
  assert.equal(re.exec('coxpit-r22')?.[1], '22');
  assert.equal(re.exec('coxpit-r50')?.[1], '50');      // r5 가 r50 을 집던 사고의 반대편
  assert.equal(re.test('coxpit-r'), false);
  assert.equal(re.test('coxpit-r22x'), false);
  assert.equal(re.test('xcoxpit-r22'), false);
  assert.equal(re.test('isroom-cp-r22'), false);        // 남의 제품 세션
});

test('a second product gets names that cannot collide', () => {
  const other = makeNaming('isroom-cp');
  assert.notEqual(other.session(22), names.session(22));
  assert.notEqual(other.branch(22), names.branch(22));
  assert.notEqual(other.worktreeParent(REPO), names.worktreeParent(REPO));
  assert.notEqual(other.stateDir, names.stateDir);
  assert.equal(other.sessionPattern().test(names.session(22)), false);
  assert.equal(names.sessionPattern().test(other.session(22)), false);
});

test('a prefix that would break a path or a branch is refused', () => {
  for (const bad of ['', 'IsRoom', 'is room', 'is/room', '.hidden', '-lead', 'x'.repeat(40)]) {
    assert.throws(() => makeNaming(bad), /naming prefix/, `accepted ${JSON.stringify(bad)}`);
  }
  assert.doesNotThrow(() => makeNaming('isroom-cp'));
});
