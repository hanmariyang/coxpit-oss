// 앱에서 데몬 업데이트: 이 데몬이 도는 코드 폴더(git)를 원격 가지 끝까지 당기고, 스스로 내려간다.
// LaunchAgent 의 KeepAlive 가 새 코드로 다시 띄운다(bin/coxpit.js 는 자식이 끝나면 같이 끝난다).
// 손으로 고친 게 남아 있으면(작업 중인 체크아웃) 건드리지 않는다.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd: string, args: string[], timeout = 60_000): Promise<string> {
  return new Promise((resolve, reject) => execFile(cmd, args, { cwd: ROOT, timeout, maxBuffer: 8 * 1024 * 1024 },
    (e, so, se) => (e ? reject(new Error((se || so || e.message).toString().trim().slice(0, 400))) : resolve(so.toString().trim()))));
}
const git = (...a: string[]): Promise<string> => run('git', a);

export interface Version {
  commit: string; branch: string; date: string; subject: string;
  behind: number | null; latest: string | null; dirty: number; updatable: boolean; checkedAt: number | null;
}

let remote: { at: number; behind: number; latest: string } | null = null;
let busy = false;

export async function versionInfo(check = false): Promise<Version> {
  const [commit, branch, date, subject, st] = await Promise.all([
    git('rev-parse', '--short', 'HEAD'), git('rev-parse', '--abbrev-ref', 'HEAD'),
    git('log', '-1', '--format=%cI'), git('log', '-1', '--format=%s'),
    git('status', '--porcelain', '--untracked-files=no'),
  ]);
  const dirty = st ? st.split('\n').length : 0;
  // 원격은 가끔만 본다(30분) — 앱이 「새로 확인」을 누르면 바로
  if (check || !remote || Date.now() - remote.at > 30 * 60_000) {
    try {
      await git('fetch', '-q', 'origin', branch);
      const behind = Number(await git('rev-list', '--count', `HEAD..origin/${branch}`)) || 0;
      const latest = behind ? await git('log', '-1', '--format=%h %s', `origin/${branch}`) : '';
      remote = { at: Date.now(), behind, latest };
    } catch { /* 망이 없으면 모른다 */ }
  }
  return {
    commit, branch, date, subject: subject.slice(0, 120), dirty,
    behind: remote ? remote.behind : null, latest: remote?.latest || null,
    updatable: dirty === 0 && branch !== 'HEAD', checkedAt: remote?.at ?? null,
  };
}

/** 당기고(빨리 감기만), 패키지가 바뀌었으면 npm ci, 그다음 1.5초 뒤 스스로 내려간다 */
export async function selfUpdate(): Promise<{ ok: boolean; from: string; to: string; detail: string }> {
  if (busy) return { ok: false, from: '', to: '', detail: '이미 업데이트 중이에요' };
  busy = true;
  try {
    const v = await versionInfo(true);
    if (!v.updatable) return { ok: false, from: v.commit, to: v.commit, detail: v.dirty ? `손으로 고친 파일 ${v.dirty}개가 있어 건드리지 않았어요` : '가지에 있지 않아요' };
    if (!v.behind) return { ok: true, from: v.commit, to: v.commit, detail: '이미 최신이에요' };
    const before = await git('rev-parse', 'HEAD');
    await git('merge', '--ff-only', `origin/${v.branch}`);
    const changed = await git('diff', '--name-only', before, 'HEAD');
    if (/(^|\n)package(-lock)?\.json(\n|$)/.test(changed)) await run('npm', ['ci', '--no-audit', '--no-fund'], 5 * 60_000);
    const to = await git('rev-parse', '--short', 'HEAD');
    remote = null;
    setTimeout(() => process.exit(0), 1500);   // KeepAlive 가 새 코드로 다시 띄운다
    return { ok: true, from: v.commit, to, detail: `${v.behind}개 받았어요. 다시 켜는 중` };
  } catch (e) {
    return { ok: false, from: '', to: '', detail: (e as Error).message };
  } finally { busy = false; }
}
