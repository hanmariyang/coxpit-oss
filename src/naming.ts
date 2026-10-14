// 이 제품의 이름 한 벌. 접두어는 여기서 한 번만 정한다.
//
// `coxpit` 을 바꾸면 worktree 폴더·브랜치·tmux 세션·상태 폴더 이름이 전부 따라 바뀐다 —
// 이미 돌고 있는 run 들은 옛 이름으로 만들어져 있으므로 바꾸지 않는다.
import { makeNaming } from './core';

export const names = makeNaming('coxpit');
