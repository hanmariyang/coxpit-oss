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
function allowed(full: string): boolean {
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
const kCache = new Map<string, { at: number; v: { id: string; title: string; kind: 'md' | 'html'; body: string } }>();

export async function keepingItem(id: string): Promise<{ id: string; title: string; kind: 'md' | 'html'; body: string }> {
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) throw new Error('bad id');
  const hit = kCache.get(id); if (hit && Date.now() - hit.at < 120_000) return hit.v;
  let cfg: { url?: string; tokenFile?: string };
  try { cfg = JSON.parse(fs.readFileSync(path.join(dataDir(), 'keeping.json'), 'utf8')); } catch { throw new Error('keeping 설정 없음'); }
  if (!cfg.url) throw new Error('keeping 설정 없음');
  const tf = (cfg.tokenFile || '').replace(/^~(?=\/)/, HOME);
  let token = '';
  try { token = fs.readFileSync(tf, 'utf8').trim(); } catch { throw new Error('keeping 토큰 없음'); }
  // 토큰은 파일로만 curl 에 넘긴다(프로세스 인자에 안 싣는다)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coxpit-keep-'));
  const cf = path.join(tmp, 'c'), bf = path.join(tmp, 'b');
  try {
    fs.writeFileSync(cf, `header = "Authorization: Bearer ${token}"\n`, { mode: 0o600 });
    fs.writeFileSync(bf, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'keeping_get', arguments: { itemId: id } } }), { mode: 0o600 });
    const raw = await new Promise<string>((resolve, reject) => execFile('curl', ['-sS', '-m', '30', '-K', cf, '-X', 'POST', cfg.url!.replace(/\/$/, '') + '/mcp',
      '-H', 'content-type: application/json', '-H', 'accept: application/json, text/event-stream', '--data-binary', '@' + bf],
      { maxBuffer: 32 * 1024 * 1024 }, (e, so) => (e ? reject(new Error('keeping 연결 실패')) : resolve(so))));
    const line = raw.trimStart().startsWith('{') ? raw : (raw.split('\n').filter((l) => l.startsWith('data:')).pop() ?? '').slice(5);
    const d = JSON.parse(line);
    const res = d.result ?? {};
    if (d.error || res.isError) throw new Error('keeping 에 없는 항목');
    const text: string = (res.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
    // 머리 세 줄(# 제목 · keepKey · 판)과 빈 줄을 떼고 본문만
    const lines = text.split('\n');
    const title = (lines[0] ?? '').replace(/^#\s*/, '').trim();
    let i = 1; while (i < lines.length && i < 4 && (/^(keepKey|판):/.test(lines[i]!) || !lines[i]!.trim())) i++;
    const body = lines.slice(i).join('\n');
    const kind: 'md' | 'html' = /^\s*(<!doctype|<html|<head|<body|<div|<style|<meta)/i.test(body) ? 'html' : 'md';
    const v = { id, title, kind, body };
    kCache.set(id, { at: Date.now(), v });
    return v;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
