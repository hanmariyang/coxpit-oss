// 클로드 계정 여럿(시안 v6): 계정마다 `claude setup-token` 으로 받은 긴 토큰을 ~/.config/claude/accounts/<이름>.env(600) 에 두고,
// 세션(tmux)마다 어느 계정인지를 데이터 폴더 accounts/by-session/<세션> 에 적는다. claude 심(claudeshim.ts)이 그 파일을 보고
// 그 세션의 claude 에만 CLAUDE_CODE_OAUTH_TOKEN 을 넣는다. 토큰 값은 API 응답 · 로그 · 화면 어디에도 싣지 않는다.
// 「계정 더하기」는 앱에서 단추 하나: 데몬이 숨은 tmux 창에 setup-token 을 띄워 로그인 주소를 읽어 주고, 돌아온 코드를 대신 쳐 넣는다.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tokenDir = (): string => path.join(os.homedir(), '.config', 'claude', 'accounts');
const dataDir = (): string => path.dirname(path.resolve(process.env.COXPIT_DB || path.join(os.homedir(), '.coxpit', 'coxpit.db')));
const metaPath = (): string => path.join(dataDir(), 'accounts.json');
export const bySessionDir = (): string => path.join(dataDir(), 'accounts', 'by-session');

export interface Account { name: string; email?: string; since: number }
interface Meta { default?: string; list: Account[] }

function readMeta(): Meta {
  try { const j = JSON.parse(fs.readFileSync(metaPath(), 'utf8')); return { default: j.default, list: Array.isArray(j.list) ? j.list : [] }; } catch { return { list: [] }; }
}
function writeMeta(m: Meta): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(metaPath(), JSON.stringify(m, null, 2), { mode: 0o600 });
}
const envPath = (name: string): string => path.join(tokenDir(), `${name}.env`);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
function okName(n: string): boolean { return NAME_RE.test(n); }

/** 토큰 파일이 있는 계정만(메타에 있어도 파일이 없으면 뺀다) */
export function listAccounts(): { default: string | null; accounts: Account[] } {
  const m = readMeta();
  const accounts = m.list.filter((a) => okName(a.name) && fs.existsSync(envPath(a.name)));
  const def = m.default && accounts.some((a) => a.name === m.default) ? m.default : (accounts[0]?.name ?? null);
  return { default: def, accounts };
}
export function setDefault(name: string): boolean {
  const m = readMeta(); if (!m.list.some((a) => a.name === name)) return false;
  m.default = name; writeMeta(m); return true;
}
export function renameAccount(from: string, to: string): boolean {
  if (!okName(to) || from === to) return false;
  const m = readMeta(); const a = m.list.find((x) => x.name === from); if (!a || m.list.some((x) => x.name === to)) return false;
  try { fs.renameSync(envPath(from), envPath(to)); } catch { return false; }
  a.name = to; if (m.default === from) m.default = to; writeMeta(m);
  // 세션 표시도 따라간다
  try { for (const f of fs.readdirSync(bySessionDir())) { const p = path.join(bySessionDir(), f); if (fs.readFileSync(p, 'utf8').trim() === from) fs.writeFileSync(p, to); } } catch { /* 없음 */ }
  return true;
}
export function deleteAccount(name: string): boolean {
  const m = readMeta(); const n = m.list.length; m.list = m.list.filter((a) => a.name !== name);
  if (m.list.length === n) return false;
  if (m.default === name) delete m.default;
  writeMeta(m); try { fs.unlinkSync(envPath(name)); } catch { /* 이미 없음 */ }
  return true;
}
/** 이 세션의 claude 가 쓸 계정을 적는다(심이 읽는다). null 이면 표시를 지운다 = 맥의 로그인 계정 그대로 */
export function useAccount(session: string, name: string | null): void {
  fs.mkdirSync(bySessionDir(), { recursive: true });
  const p = path.join(bySessionDir(), session.replace(/[^A-Za-z0-9._-]/g, '_'));
  if (name) fs.writeFileSync(p, name, { mode: 0o600 }); else { try { fs.unlinkSync(p); } catch { /* 없음 */ } }
}

// ── 로그인(계정 더하기): 숨은 tmux 창에서 setup-token ──
const LOGIN = 'coxpit-login';
function tmux(args: string[], timeout = 8000): string {
  const r = spawnSync('tmux', args, { encoding: 'utf8', timeout, env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}` } });
  return r.stdout ?? '';
}
function screen(): string { return tmux(['capture-pane', '-p', '-J', '-t', LOGIN]); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 로그인 시작: 주소를 돌려준다(앱이 브라우저를 연다). 이미 떠 있으면 새로 */
export async function loginStart(): Promise<{ url: string }> {
  tmux(['kill-session', '-t', LOGIN]);
  // 심을 피해서 진짜 claude 를 바로 부른다(심은 COXPIT_CLAUDE_SID 가 없으면 통과하지만, 계정 파일을 읽지 않게 by-session 도 없는 이름이다)
  tmux(['new-session', '-d', '-s', LOGIN, '-x', '160', '-y', '40', 'env -u CLAUDE_CODE_OAUTH_TOKEN -u COXPIT_ACCOUNT claude setup-token; sleep 600']);
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const s = screen().replace(/\n/g, '');
    const m = s.match(/https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\s]+/) ?? s.match(/https:\/\/claude\.ai\/oauth\/authorize\?[^\s]+/);
    if (m) return { url: m[0].replace(/[^A-Za-z0-9%._~:/?#&=+-]+$/, '') };
  }
  tmux(['kill-session', '-t', LOGIN]);
  throw new Error('로그인 주소를 못 받았어요(claude setup-token 이 안 떴어요)');
}
export function loginCancel(): void { tmux(['kill-session', '-t', LOGIN]); }

/** 돌아온 코드를 쳐 넣고 토큰을 받아 저장한다. 토큰은 파일에만 */
export async function loginCode(code: string): Promise<{ name: string; email: string | null }> {
  const c = code.trim(); if (!c || c.length > 400 || /\s/.test(c)) throw new Error('코드가 이상해요');
  if (!screen().includes('Paste code')) throw new Error('로그인 창이 없어요. 처음부터 다시 해 주세요');
  tmux(['send-keys', '-t', LOGIN, '-l', c]); tmux(['send-keys', '-t', LOGIN, 'Enter']);
  let token = '';
  for (let i = 0; i < 60 && !token; i++) {
    await sleep(500);
    const m = screen().replace(/\n/g, '').match(/sk-ant-oat01-[A-Za-z0-9_-]{20,}/);
    if (m) token = m[0];
    else if (/invalid|error|failed/i.test(screen())) break;
  }
  tmux(['kill-session', '-t', LOGIN]);
  if (!token) throw new Error('토큰을 못 받았어요. 코드가 틀렸거나 시간이 지났어요');
  // 누구 계정인지: 그 토큰으로 auth status
  let email: string | null = null;
  try {
    const out = execFileSync('claude', ['auth', 'status'], { encoding: 'utf8', timeout: 20000, env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}` } });
    const j = JSON.parse(out.slice(out.indexOf('{'))); if (typeof j.email === 'string') email = j.email;
  } catch { /* 모르면 이름만 */ }
  const m = readMeta();
  let name = (email ? email.split('@')[0]! : 'account').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) || 'account';
  if (m.list.some((a) => a.name === name)) { let k = 2; while (m.list.some((a) => a.name === `${name}${k}`)) k++; name = `${name}${k}`; }
  fs.mkdirSync(tokenDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(envPath(name), `CLAUDE_CODE_OAUTH_TOKEN=${token}\n`, { mode: 0o600 });
  m.list.push({ name, email: email ?? undefined, since: Date.now() });
  if (!m.default) m.default = name;
  writeMeta(m);
  return { name, email };
}
