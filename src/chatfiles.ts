// 폰 앱이 대화의 결과물을 여는 창구.
// - chatFile: 답에 나온 경로(절대 · ~ · 대화 폴더 기준 상대)의 파일. 홈 안, 숨김 폴더 밖만(.ssh · .config 같은 데는 안 준다).
// - recentFiles: 대화 폴더에서 최근 바뀐 파일.
// - keepingItem: keeping(기획 · 시안 보관함) 항목. 토큰은 데몬만 들고 앱엔 내용만 준다.
//   설정은 데이터 폴더의 keeping.json {"url": "https://…", "tokenFile": "~/…"} — 없으면 꺼진다.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mimeFor } from './files';

const HOME = path.resolve(os.homedir());
const MAX_FILE = 60 * 1024 * 1024;
const SKIP = new Set(['node_modules', 'dist', 'build', 'DerivedData', 'Pods', 'target', 'coverage', '__pycache__', 'venv', 'Library', 'Applications', 'Music', 'Movies', 'Pictures']);

function expand(cwd: string, p: string): string {
  let s = p.trim().replace(/^file:\/\//, '');
  try { s = decodeURIComponent(s); } catch { /* 그대로 */ }
  s = s.replace(/:\d+(:\d+)?$/, '');            // src/x.ts:12 → src/x.ts
  if (s === '~' || s.startsWith('~/')) s = path.join(HOME, s.slice(1));
  return path.resolve(path.isAbsolute(s) ? s : path.join(cwd || HOME, s));
}
// 홈 밖 · 숨김 폴더라도 여는 곳: 클로드 세션 스크래치패드(/private/tmp/claude-<uid>/…), 앱이 올린 파일(데이터 폴더 uploads/)
const EXTRA_ROOTS = (() => {
  const out: string[] = [];
  try { out.push(fs.realpathSync(`/private/tmp/claude-${process.getuid?.() ?? 501}`)); } catch { /* 없음 */ }
  try { out.push(fs.realpathSync(path.join(path.dirname(path.resolve(process.env.COXPIT_DB || path.join(HOME, '.coxpit', 'coxpit.db'))), 'uploads'))); } catch { /* 없음 */ }
  return out;
})();
function allowed(full: string): boolean {
  if (EXTRA_ROOTS.some((r) => full === r || full.startsWith(r + path.sep))) return true;
  if (full !== HOME && !full.startsWith(HOME + path.sep)) return false;
  return !path.relative(HOME, full).split(path.sep).some((x) => x.startsWith('.'));
}

export async function chatFile(cwd: string, p: string): Promise<{ path: string; name: string; mime: string; buf: Buffer }> {
  if (!p) throw new Error('path required');
  const want = expand(cwd, p);
  let full: string;
  try { full = await realpath(want); } catch { throw new Error('파일이 없어요'); }
  if (!allowed(full)) throw new Error('홈 폴더 밖이나 숨김 폴더는 열 수 없어요');
  const st = await stat(full);
  if (st.isDirectory()) throw new Error('폴더예요');
  if (st.size > MAX_FILE) throw new Error('파일이 너무 커요(60MB 넘음)');
  const ext = path.extname(full).toLowerCase();
  const extra: Record<string, string> = { '.md': 'text/markdown; charset=utf-8', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.csv': 'text/csv; charset=utf-8' };
  return { path: full, name: path.basename(full), mime: extra[ext] ?? mimeFor(full), buf: await readFile(full) };
}

export async function recentFiles(cwd: string, limit = 30): Promise<Array<{ path: string; rel: string; size: number; mtime: number }>> {
  const root = path.resolve(cwd || HOME);
  if (!allowed(root)) return [];
  const out: Array<{ path: string; rel: string; size: number; mtime: number }> = [];
  const queue: Array<[string, number]> = [[root, 0]];
  let seen = 0;
  while (queue.length && seen < 6000) {
    const [dir, depth] = queue.shift()!;
    let items: fs.Dirent[];
    try { items = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      if (it.name.startsWith('.') || SKIP.has(it.name)) continue;
      seen++;
      const f = path.join(dir, it.name);
      if (it.isDirectory()) { if (depth < 4) queue.push([f, depth + 1]); continue; }
      if (!it.isFile()) continue;
      try { const st = await stat(f); out.push({ path: f, rel: path.relative(root, f), size: st.size, mtime: st.mtimeMs }); } catch { /* 사라짐 */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

// ── keeping ──
const dataDir = (): string => path.dirname(path.resolve(process.env.COXPIT_DB || path.join(HOME, '.coxpit', 'coxpit.db')));
export interface KeepingVersion { v: number; note: string; current: boolean }
export interface KeepingItem { id: string; title: string; kind: 'md' | 'html'; body: string; key?: string; versions?: KeepingVersion[]; version?: number }
export interface KeepingHit { id: string; title: string; kind: 'plan' | 'mockup'; key: string; project: string; version: number; size: string; note: string }
const kCache = new Map<string, { at: number; v: unknown }>();
function cached<T>(key: string, ttl: number, make: () => Promise<T>): Promise<T> {
  const hit = kCache.get(key); if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.v as T);
  return make().then((v) => { kCache.set(key, { at: Date.now(), v }); return v; });
}

/** keeping MCP 도구 하나를 부른다. 토큰은 데몬만 들고, 파일로만 curl 에 넘긴다(프로세스 인자에 안 싣는다) */
async function keepingCall(name: string, args: Record<string, unknown>): Promise<string> {
  let cfg: { url?: string; tokenFile?: string };
  try { cfg = JSON.parse(fs.readFileSync(path.join(dataDir(), 'keeping.json'), 'utf8')); } catch { throw new Error('keeping 설정 없음'); }
  if (!cfg.url) throw new Error('keeping 설정 없음');
  const tf = (cfg.tokenFile || '').replace(/^~(?=\/)/, HOME);
  let token = '';
  try { token = fs.readFileSync(tf, 'utf8').trim(); } catch { throw new Error('keeping 토큰 없음'); }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coxpit-keep-'));
  const cf = path.join(tmp, 'c'), bf = path.join(tmp, 'b');
  try {
    fs.writeFileSync(cf, `header = "Authorization: Bearer ${token}"\n`, { mode: 0o600 });
    fs.writeFileSync(bf, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), { mode: 0o600 });
    const raw = await new Promise<string>((resolve, reject) => execFile('curl', ['-sS', '-m', '30', '-K', cf, '-X', 'POST', cfg.url!.replace(/\/$/, '') + '/mcp',
      '-H', 'content-type: application/json', '-H', 'accept: application/json, text/event-stream', '--data-binary', '@' + bf],
      { maxBuffer: 32 * 1024 * 1024 }, (e, so) => (e ? reject(new Error('keeping 연결 실패')) : resolve(so))));
    const line = raw.trimStart().startsWith('{') ? raw : (raw.split('\n').filter((l) => l.startsWith('data:')).pop() ?? '').slice(5);
    const d = JSON.parse(line);
    const res = d.result ?? {};
    if (d.error || res.isError) throw new Error('keeping 에 없는 항목');
    return (res.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** 항목 원문 + 머리(제목 · 키 · 판 목록). version 을 주면 그 판 */
export async function keepingItem(id: string, version?: number): Promise<KeepingItem> {
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) throw new Error('bad id');
  return cached(`item:${id}:${version ?? ''}`, 120_000, async () => {
    const text = await keepingCall('keeping_get', version ? { itemId: id, version } : { itemId: id });
    const lines = text.split('\n');
    const title = (lines[0] ?? '').replace(/^#\s*/, '').replace(/\s*\(v\d+\s*·[^)]*\)\s*$/, '').trim();
    let key: string | undefined, versions: KeepingVersion[] | undefined;
    let i = 1;
    while (i < lines.length && i < 5 && (/^(keepKey|판):/.test(lines[i]!) || !lines[i]!.trim())) {
      const l = lines[i]!;
      if (l.startsWith('keepKey:')) key = l.slice(8).trim();
      if (l.startsWith('판:')) {
        versions = l.slice(2).split(/\s·\s(?=v\d+\s*\()/).map((part) => {
          const m = part.trim().match(/^v(\d+)\s*\((.*)\)\s*(←\s*지금)?\s*$/s);
          return m ? { v: Number(m[1]), note: m[2]!.trim(), current: !!m[3] } : { v: 0, note: part.trim(), current: false };
        }).filter((v) => v.v > 0);
      }
      i++;
    }
    const body = lines.slice(i).join('\n');
    const kind: 'md' | 'html' = /^\s*(<!doctype|<html|<head|<body|<div|<style|<meta)/i.test(body) ? 'html' : 'md';
    return { id, title, kind, body, key, versions, version: version ?? versions?.find((v) => v.current)?.v };
  });
}

/** 목록: 제목 · id · 키 · 프로젝트 · 판 · 크기 · 최신 판 메모. 썸네일은 없다(앱이 그린다) */
export async function keepingSearch(q: { project?: string; kind?: 'plan' | 'mockup'; query?: string; limit?: number }): Promise<KeepingHit[]> {
  const args: Record<string, unknown> = {};
  if (q.project) args.project = q.project; if (q.kind) args.kind = q.kind; if (q.query) args.query = q.query; args.limit = q.limit ?? 60;
  return cached('search:' + JSON.stringify(args), 20_000, async () => {
    const text = await keepingCall('keeping_search', args);
    const out: KeepingHit[] = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const h = lines[i]!.match(/^(기획|시안)\s*·\s*(.+)$/); if (!h) continue;
      const m = (lines[i + 1] ?? '').match(/id=(\S+)\s*·\s*keepKey=(\S+)\s*·\s*(.+?)\s*·\s*v(\d+)\s*·\s*(\S+)\s*$/); if (!m) continue;
      const noteLine = (lines[i + 2] ?? '').match(/^\s*최신 판:\s*(.*)$/);
      out.push({ id: m[1]!, title: h[2]!.trim(), kind: h[1] === '기획' ? 'plan' : 'mockup', key: m[2]!, project: m[3]!.trim(), version: Number(m[4]), size: m[5]!, note: noteLine ? noteLine[1]!.trim() : '' });
      i += noteLine ? 2 : 1;
    }
    return out;
  });
}

/** 프로젝트 이름과 수 */
export async function keepingProjects(): Promise<Array<{ name: string; count: number }>> {
  return cached('projects', 60_000, async () => {
    const text = await keepingCall('keeping_projects', {});
    return text.split('\n').map((l) => l.match(/^\s+(.+?)\s*·\s*(\d+)건\s*$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => ({ name: m[1]!, count: Number(m[2]) }));
  });
}
