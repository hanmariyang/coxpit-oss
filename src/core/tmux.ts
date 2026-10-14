// tmux 셸 조각 빌더 — 순수 문자열만. 실행은 부르는 쪽이 한다.

export const TMUX_HISTORY_LIMIT = 100000;

/**
 * `tmux new-session <rest>` 대신 쓰는 셸 조각 — history-limit 을 올린 뒤 세션을 만든다. rest 는 호출부가 인용한다.
 *
 * 서브셸로 감싸 **$HOME 에서** tmux 를 부른다(coxpit#18). 이 호출이 그 기계의 tmux 서버를 처음 띄우는 경우,
 * 서버는 여기서의 cwd 를 평생 물고 산다. 데스크톱 앱이 자동 업데이트되면 옛 번들이 통째로 지워지므로,
 * 그 안에서 태어난 tmux 서버의 cwd 는 이름 없는 삭제된 폴더가 되고 getcwd() 가 ENOENT 를 낸다.
 * 그러면 tmux(>=3.4, spawn.c)는 새 페인의 `-c` 를 **조용히 건너뛴다** — 모든 새 터미널이 죽은 폴더에서 열리고
 * 프롬프트엔 `.` 만 남는다(#{pane_start_path} 는 요청한 경로를 그대로 보여줘서 멀쩡해 보인다).
 * tmux 쪽 수정은 업스트림에 맡기고, 여긴 서버가 사라질 수 없는 자리에서 태어나게 한다.
 * 페인 자신의 폴더는 그대로 호출부의 `-c <path>` 가 정한다 — 바뀌는 건 서버의 출생지뿐이다.
 */
export function tmuxNewSession(rest: string): string {
  return `( cd "$HOME" 2>/dev/null || cd / ; tmux start-server \\; set-option -g history-limit ${TMUX_HISTORY_LIMIT} \\; new-session ${rest} )`;
}
