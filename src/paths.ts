import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// GUI/launchd 로 뜬 macOS 데몬은 PATH 가 `/usr/bin:/bin:/usr/sbin:/sbin` 뿐이라
// Homebrew(`/opt/homebrew/bin`·`/usr/local/bin`) 가 빠진다. tmux 는 macOS 기본 제공이
// 아니라 로컬 터미널이 `spawn tmux ENOENT` 로 죽는다(remote 는 ssh 가 /usr/bin 에 있어 동작).
// → issue #10. 시작 시 한 번 PATH 를 보강하면 로컬 `pty().spawn('tmux')` 와
// runShellOn 의 `sh -c` 프로브(둘 다 process.env.PATH 상속)가 함께 해결된다.
// 시스템 경로 우선순위는 건드리지 않고 없는 디렉터리만 뒤에 덧붙인다(시스템 툴 그림자 방지).
export function augmentPathForGuiLaunch(): void {
  if (process.platform !== 'darwin') return;
  const have = new Set((process.env.PATH ?? '').split(':').filter(Boolean));
  const add: string[] = [];
  const push = (d: string): void => {
    const dir = d.trim();
    if (dir && !have.has(dir) && existsSync(dir)) { have.add(dir); add.push(dir); }
  };

  // 1) 로그인 셸의 PATH — 사용자 환경(asdf·nvm·커스텀 tmux 위치)까지 포괄. best-effort.
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(shell, ['-lc', 'printf %s "$PATH"'], { timeout: 4000, encoding: 'utf8' });
    for (const d of out.split(':')) push(d);
  } catch { /* 로그인 셸 실패 → 아래 알려진 경로로 보강 */ }

  // 2) 알려진 Homebrew/local 경로 — 로그인 셸이 안 되는 환경 대비.
  for (const d of ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin']) push(d);

  if (add.length) {
    process.env.PATH = `${process.env.PATH}:${add.join(':')}`;
    console.log(`[coxpit] PATH augmented for GUI/launchd launch (+${add.length}: ${add.join(', ')})`);
  }
}
