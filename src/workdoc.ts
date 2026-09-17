// v6.0 Part W — WORK.md, 한 작업(work)의 공유 컨텍스트.
//
// 격리된 run 은 **과거에서 갈라져 나온다** — 형제가 방금 정한 것을 모른 채 base 에서 시작하고,
// 그 run 의 세션은 내가 옆 터미널에 말한 내용을 들은 적이 없다. 파일 컨텍스트는 Part P(in-place)
// 의 몫이고, **결정 컨텍스트는 이 파일의 몫**이다: 여기 적힌 것은 이 작업 아래 모든 세션에 따라붙는다.
//
// 정본은 git 트리 **밖**(데몬 데이터 디렉터리 = DB 옆)에 둔다 — 어떤 worktree 의 diff 도
// 더럽히지 않고, 브랜치가 갈려도 내용이 갈라지지 않는다. 작업이 닫히면 같이 사라진다.
//
// ⚠️ 편집은 **다음 발사·steer** 부터 닿는다. 돌고 있는 턴에 끼어드는 마법은 없다.
// (W4 harvest — 살아있는 run 이 자기 worktree 에 적은 줄을 watcher 가 여기로 모으는 일 — 은
//  이번 단계에서 의도적으로 미룬다: 주입만으로도 사람이 큐레이션한 컨텍스트는 이미 전달된다.)
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { dirname as pdirname, join as pjoin, resolve as presolve } from 'node:path';
import { config } from './config';

/** 데몬 데이터 디렉터리(= DB 가 사는 곳, 기본 ~/.coxpit) 아래의 work 폴더. */
export function workDir(): string {
  return pjoin(pdirname(presolve(config.dbPath)), 'work');
}

/** 한 작업의 정본 경로. 파일은 첫 쓰기 때 생긴다(없는 것과 빈 것은 같은 뜻). */
export function workDocPath(taskId: number): string {
  return pjoin(workDir(), `${taskId}.md`);
}

/** 내용(없으면 ''). 읽기 실패는 '' 로 — 컨텍스트 하나 때문에 발사가 막히면 안 된다. */
export function readWorkDoc(taskId: number): string {
  try { return readFileSync(workDocPath(taskId), 'utf8'); } catch { return ''; }
}

export function workDocSize(taskId: number): number {
  try { return statSync(workDocPath(taskId)).size; } catch { return 0; }
}

/** 처음 열 때 빈 파일로 만들어 둔다 — 뷰어가 "없는 파일"에 걸려 넘어지지 않도록.
 *  빈 파일은 주입되지 않으므로(아래 workContextBlock) 보일러플레이트가 새어나가지 않는다. */
export function ensureWorkDoc(taskId: number): string {
  const p = workDocPath(taskId);
  mkdirSync(workDir(), { recursive: true });
  if (!existsSync(p)) writeFileSync(p, '', 'utf8');
  return p;
}

export function writeWorkDoc(taskId: number, content: string): { path: string; size: number } {
  const p = workDocPath(taskId);
  mkdirSync(workDir(), { recursive: true });
  writeFileSync(p, content, 'utf8');
  return { path: p, size: Buffer.byteLength(content, 'utf8') };
}

/** 작업이 닫히거나 지워질 때 함께 사라진다(정리 경로에서 호출). */
export function removeWorkDoc(taskId: number): void {
  try { rmSync(workDocPath(taskId), { force: true }); } catch { /* 없으면 그만 */ }
}

/**
 * 프롬프트에 붙일 블록. **비어 있으면 아무것도 붙이지 않는다** — 없음은 깔끔해야지,
 * 빈 블록으로 에이전트를 헷갈리게 하면 안 된다.
 */
export function workContextBlock(taskId: number): string {
  const text = readWorkDoc(taskId).trim();
  if (!text) return '';
  return `\n\n## WORK CONTEXT (shared across this work's sessions — decisions recorded here bind you)\n${text}`;
}
