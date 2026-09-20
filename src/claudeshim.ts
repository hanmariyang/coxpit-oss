import { accessSync, chmodSync, constants, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { shq } from './exec';

/**
 * 한 coxpit 세션 = 한 claude 대화.
 *
 * claude 는 대본을 `~/.claude/projects/<cwd 를 [^a-zA-Z0-9]→'-' 로 인코딩>/<세션 id>.jsonl` 에 쌓는다.
 * 파일명이 세션 id 인데, 그 id 를 사후에 알아낼 길이 없다 — 첫 줄에 timestamp·cwd 가 없고,
 * lsof 에 열린 fd 도 안 보이고, `claude` 의 argv/env 에도 안 실린다. 그래서 한 폴더(워크스페이스 루트)에
 * 세션 여럿이 살면 "가장 최근 .jsonl" 은 거의 항상 남의 대화였다 — 뷰어의 대화 탭이 틀린 세션을 보여준 원인.
 *
 * 해법은 사후 추적이 아니라 **미리 이름을 정하는 것**이다: 세션을 열 때 id 를 만들어 두고,
 * 사람이 그 세션에서 그냥 `claude` 를 쳐도 `claude --session-id <그 id>` 가 되게 얇은 심을 PATH 맨 앞에 끼운다.
 * 심은 부팅 때 한 번, 진짜 claude 의 **절대경로**를 박아 쓴다(자기를 다시 부르는 PATH 루프가 원천적으로 불가능).
 */

/** 대본 파일명으로 쓸 수 있는 꼴(claude 는 UUID). 남이 심어둔 이름을 셸에 그냥 태우지 않기 위한 문지기. */
export const CLAUDE_SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/;

// 부팅 때 해결한 진짜 claude 경로. 빈 문자열 = 심이 없다(= 태깅 env 를 넣지 않는다).
let shimReal = '';

/**
 * 심 스크립트 본문. 규칙 셋뿐이다:
 *  - 사람이 이미 대화를 골랐으면(--resume/--session-id/-c 등) 아무것도 더하지 않고 그대로 넘긴다.
 *  - COXPIT_CLAUDE_SID 가 없으면(헤드리스·원격·평소 셸) 순수 통과 — 이 심은 보이지 않는다.
 *  - 있으면 --session-id 로 그 이름을 쓴다. 단 **그 이름의 대본이 이미 있으면 --resume 으로 이어붙인다**:
 *    한 세션에서 claude 를 두 번째로 띄우는 것이 흔하고, 쓰이고 있는 id 를 --session-id 로 다시 주면
 *    사람이 친 명령이 에러로 죽을 수 있다. 이어붙이는 쪽이 이 기능의 한 줄("한 세션 = 한 대화")과도 맞고,
 *    두 번째 대화가 태그 없이 새로 생겨 뷰어가 **옛 대본**을 보여주는 사고도 같이 막는다.
 *  (!) 이 심은 `claude` 하나만 가로챈다 — `claude attach <id>` 같은 서브커맨드에 --session-id 가 붙는
 *    드문 조합은 사람이 --resume/--session-id 를 직접 쓰면 위 첫 규칙으로 빠져나간다.
 */
export function claudeShimScript(real: string): string {
  const r = shq(real);
  return [
    '#!/bin/sh',
    '# coxpit: tag this session\'s claude so the viewer can find its transcript.',
    '# pass through untouched if the user already selected a session.',
    'for a in "$@"; do',
    '  case "$a" in',
    `    --session-id|--resume|-r|-c|--continue|--from-pr) exec ${r} "$@" ;;`,
    '  esac',
    'done',
    'if [ -n "${COXPIT_CLAUDE_SID:-}" ]; then',
    '  # claude keeps each conversation at ~/.claude/projects/<cwd with [^a-zA-Z0-9] as ->/<id>.jsonl',
    // pwd 를 그대로 파이프하면 끝의 개행이 '-' 로 바뀌어 폴더 이름이 한 칸 길어진다 — printf 로 벗긴다.
    "  enc=$(printf '%s' \"$(pwd)\" | tr -c 'a-zA-Z0-9' '-')",
    '  if [ -f "$HOME/.claude/projects/$enc/$COXPIT_CLAUDE_SID.jsonl" ]; then',
    `    exec ${r} --resume "$COXPIT_CLAUDE_SID" "$@"`,
    '  fi',
    `  exec ${r} --session-id "$COXPIT_CLAUDE_SID" "$@"`,
    'fi',
    `exec ${r} "$@"`,
    '',
  ].join('\n');
}

/**
 * 진짜 claude 의 절대경로. `command -v` 대신 PATH 를 직접 훑는다(셸 없이 결정적이고,
 * 심 폴더를 건너뛰는 규칙을 명시적으로 쓸 수 있다 — 심이 자기를 가리키는 일이 없다).
 * bin 이 claude 계열 **절대경로**면 그것을 존중하고, 그 밖에는 PATH 에서 `claude` 를 찾는다
 * (이름이 claude 가 아닌 bin 을 claude 자리에 앉히지 않는다 — 심의 이름은 사람이 치는 그 단어다).
 */
export function resolveClaudeReal(shimDir: string, bin = 'claude'): string {
  if (bin.startsWith('/')) {
    return existsSync(bin) && /claude/.test(path.basename(bin)) ? bin : '';
  }
  const skip = path.resolve(shimDir);
  for (const d of (process.env.PATH ?? '').split(':')) {
    if (!d || path.resolve(d) === skip) continue;
    const p = path.join(d, 'claude');
    try { accessSync(p, constants.X_OK); return p; } catch { /* 다음 후보 */ }
  }
  return '';
}

/**
 * 부팅 1회 — 심 폴더에 실행 가능한 `claude` 한 장을 쓴다.
 * claude 가 안 깔린 기계(CI 등)면 아무것도 쓰지 않고 빈 문자열을 돌려준다 —
 * 심이 없으면 태깅 env 도 안 들어가고, 세션은 지금까지와 똑같이 동작한다.
 */
export function ensureClaudeShim(): { dir: string; real: string; path: string } {
  const dir = config.shimDir;
  const real = resolveClaudeReal(dir, config.agent.bin || 'claude');
  const p = path.join(dir, 'claude');
  if (!real) { shimReal = ''; return { dir, real: '', path: p }; }
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(p, claudeShimScript(real));
    chmodSync(p, 0o755);   // 덮어쓰기는 mode 를 다시 세우지 않는다 — chmod 를 따로 한다
    shimReal = real;
  } catch { shimReal = ''; }
  return { dir, real: shimReal, path: p };
}

/**
 * 세션 tmux 에 얹을 태깅 env — `new-session -e KEY=VAL` 인자 조각(선행 공백 포함, 없으면 빈 문자열).
 * PATH 는 Node 에서 완성해 넘긴다(tmux -e 의 값은 리터럴이라 `$PATH` 가 안 풀린다).
 * 원격 머신은 제외한다 — 심 파일은 데몬이 사는 이 기계에만 있다.
 */
export function claudeTagEnvArgs(sid: string, local: boolean): string {
  if (!sid || !local || !shimReal) return '';
  // 빈 PATH 를 그대로 이어붙이면 끝에 ':' 가 남아 **현재 폴더**가 PATH 에 들어간다 — 붙이지 않는다.
  const cur = process.env.PATH ?? '';
  const p = cur ? `${config.shimDir}:${cur}` : config.shimDir;
  return ` -e ${shq(`PATH=${p}`)} -e ${shq(`COXPIT_CLAUDE_SID=${sid}`)}`;
}
