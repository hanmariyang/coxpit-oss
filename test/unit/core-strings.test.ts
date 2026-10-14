// 커널이 **내보내는 셸 문자열**을 직접 본다.
//
// 이 테스트가 없어서 사고가 났다(2026-10-14): 커널 추출 중 tmuxNewSession 의 명령 구분자에서
// 백슬래시가 하나 줄어들어 출력에 맨 세미콜론이 들어갔고, tmux 의 명령 구분자가 셸 구분자로
// 바뀌어 set-option·new-session 이 셸 명령으로 실행됐다. 타입은 통과하고 세션만 안 열렸다.
// 문자열을 옮길 때 봐야 하는 것은 타입이 아니라 출력이다.
//
// 이 파일은 백슬래시를 소스에 쓰지 않는다 — 쓰는 순간 같은 함정에 테스트가 먼저 빠진다.
// 구분자는 문자 코드로 만들어 비교한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { tmuxNewSession, TMUX_HISTORY_LIMIT, shq, samePath } = await import('../../src/core/index.ts');

const BS = String.fromCharCode(92);   // 백슬래시 한 개
const SEP = BS + ';';                  // 셸이 tmux 에 리터럴 ';' 로 넘기는 구분자

test('tmux 명령 구분자가 셸 구분자로 바뀌지 않는다', () => {
  const out = tmuxNewSession("-d -s 'x' -c '/tmp'");
  assert.ok(out.includes('tmux start-server ' + SEP + ' set-option'),
    '구분자가 ' + JSON.stringify(SEP) + ' 가 아니다: ' + JSON.stringify(out));
  assert.ok(out.includes('history-limit 100000 ' + SEP + ' new-session'),
    '두 번째 구분자가 어긋났다: ' + JSON.stringify(out));
  assert.equal(out.split(SEP).length - 1, 2, '구분자는 정확히 두 개다');
  assert.ok(!out.includes(' ; set-option'), '맨 세미콜론이면 set-option 이 셸 명령이 된다');
  assert.ok(!out.includes(' ; new-session'), '맨 세미콜론이면 new-session 이 셸 명령이 된다');
});

test('tmux 조각은 서버를 $HOME 에서 띄운다', () => {
  // 번들 폴더에서 태어난 tmux 서버는 자동 업데이트로 그 폴더가 지워지면 -c 를 조용히 무시한다.
  assert.ok(tmuxNewSession('-d').startsWith('( cd "$HOME" 2>/dev/null || cd / ; tmux start-server'));
  assert.equal(TMUX_HISTORY_LIMIT, 100000);
});

test('shq 는 싱글쿼트를 닫고 다시 연다', () => {
  assert.equal(shq('/tmp/a b'), "'/tmp/a b'");
  assert.equal(shq("it's"), "'it'" + BS + "''s'");
  assert.equal(shq(''), "''");
});

test('samePath 는 /private 접두와 끝 슬래시를 흡수한다', () => {
  assert.equal(samePath('/private/var/x', '/var/x'), true);
  assert.equal(samePath('/tmp/a/', '/tmp/a'), true);
  assert.equal(samePath('/tmp/a', '/tmp/b'), false);
});
