// 대화 세션(하네스) — 터미널 없이 claude 를 stream-json 으로 직접 몬다. 폰 앱의 대화 화면이 이것을 쓴다.
//
// 한 대화 = claude 프로세스 하나(필요할 때 띄우고, 오래 쉬면 내린다). 대화의 정본은 claude 자신의
// `~/.claude/projects/<폴더>/<세션>.jsonl` 이다 — 데몬은 메타(제목·폴더·세션 id)만 chats.json 에 둔다.
// 그래서 데몬이 재시작해도 대화는 그대로이고, 같은 세션을 맥에서 `claude --resume <id>` 로 이어 받을 수 있다
// (하네스가 그 세션을 쥐고 있는 동안은 안 된다 → close 로 먼저 내린다).
//
// CLI 제어 메시지(SDK 가 쓰는 것과 같은 stdio 규약, 새 의존성 없음):
//   시작 control_request{subtype:'initialize'} · 권한 control_request{subtype:'can_use_tool'} → control_response
//   중단 control_request{subtype:'interrupt'} · 권한 모드 control_request{subtype:'set_permission_mode'}
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { config } from './config';
import { broadcast } from './hub';
import { db } from './db';
import { agentRuns } from './db/schema';
import { eq } from 'drizzle-orm';
import { runShellOn, shq } from './exec';
import { cleanupRun, getRunTermInfo, getSessionChat, openSessionAt } from './orchestrator';
import { pushNotify } from './push';

export type ChatState = 'idle' | 'run' | 'ask' | 'error' | 'gone';
export type PermMode = 'default' | 'acceptEdits' | 'auto' | 'plan';
const MODES: PermMode[] = ['default', 'acceptEdits', 'auto', 'plan'];

export interface ChatMeta {
  id: string; title: string; cwd: string; sid: string; model: string; mode: PermMode;
  created: number; updated: number; last: string;
  /** tmux 모드: coxpit 세션(run) 안의 바로 그 claude 에 붙는다. 맥 화면과 폰이 같은 대화를 본다 */
  runId?: number;
  /** 목록 맨 위에 고정(앱의 즐겨찾기) */
  pinned?: boolean;
  /** 목록에서 숨김(지우지 않는다. 앱 「숨긴 세션」에 모인다) */
  hidden?: boolean;
  /** 할 일 체크: 할 일 글(정규화) → 체크한 때(ms). 폰 · 맥 앱이 같이 본다 */
  todos?: Record<string, number>;
}
export interface Turn { role: 'user' | 'assistant'; text: string; tools?: ToolUse[]; ts?: number; /** 마지막 도구 뒤에 쓴 글(= 끝 보고). 알림 · 목록 한 줄에 쓴다 */ final?: string }
export interface ToolUse { name: string; summary: string }
export interface SubAgent { id: string; desc: string; started: number; updated: number; current: string; running: boolean }
interface Ask { id: string; tool: string; input: unknown; summary: string; ts: number }

interface Live {
  proc: ChildProcess | null;
  state: ChatState;
  partial: string;           // 지금 차오르는 답 글
  tools: ToolUse[];          // 이번 턴에 쓴 도구
  current: string;           // 지금 실행 중인 도구 한 줄
  asks: Map<string, Ask>;    // 사용자에게 물어본 권한(control request id 기준)
  started: number;
  idleTimer?: NodeJS.Timeout;
  subs: Set<(e: unknown) => void>;
  reqSeq: number;
  agents?: SubAgent[];       // 이 대화의 claude 가 띄운 서브에이전트(돌고 있는 것 · 막 끝난 것)
}

const IDLE_MS = 30 * 60 * 1000;
const storePath = (): string => path.join(path.dirname(path.resolve(process.env.COXPIT_DB || path.join(os.homedir(), '.coxpit', 'coxpit.db'))), 'chats.json');

let metas: ChatMeta[] = load();
const lives = new Map<string, Live>();

function load(): ChatMeta[] {
  try { const j = JSON.parse(fs.readFileSync(storePath(), 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; }
}
// 앱에서 지운 coxpit 세션(run). 맞추기(syncSessions)가 다시 데려오지 않게 기억한다
const dismissPath = (): string => path.join(path.dirname(storePath()), 'chats-dismissed.json');
const dismissed = new Set<number>((() => { try { return JSON.parse(fs.readFileSync(dismissPath(), 'utf8')) as number[]; } catch { return []; } })());
function saveDismissed(): void { try { fs.writeFileSync(dismissPath(), JSON.stringify([...dismissed].slice(-2000))); } catch { /* 다음에 */ } }

function save(): void {
  try { fs.writeFileSync(storePath(), JSON.stringify(metas, null, 1)); } catch (e) { console.warn('[coxpit] chats.json write failed', e); }
}
function live(id: string): Live {
  let l = lives.get(id);
  if (!l) { l = { proc: null, state: 'idle', partial: '', tools: [], current: '', asks: new Map(), started: 0, subs: new Set(), reqSeq: 0 }; lives.set(id, l); }
  return l;
}

/** 도구 입력을 한 줄로(앱의 「명령 n개 실행 · 펼치기」와 권한 카드). 비밀이 섞일 수 있는 긴 값은 자른다. */
function summarize(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const s = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? '';
  return String(s).replace(/\s+/g, ' ').slice(0, 300) || name;
}

export function summary(m: ChatMeta) {
  const l = lives.get(m.id);
  return { ...m, state: l?.state ?? 'idle', current: l?.current ?? '', asks: l ? [...l.asks.values()] : [], agents: l?.agents ?? [] };
}
export function listChats() {
  return metas.slice().sort((a, b) => b.updated - a.updated).map(summary);
}
export function getChat(id: string): ChatMeta | undefined { return metas.find((m) => m.id === id); }

function emit(id: string, e: Record<string, unknown>): void {
  const l = lives.get(id);
  if (l) for (const f of l.subs) { try { f(e); } catch { /* 끊긴 구독 */ } }
}
function announce(id: string): void {
  const m = getChat(id); if (m) broadcast({ type: 'chat', chat: summary(m) });
}
function setState(id: string, s: ChatState): void {
  const l = live(id); if (l.state === s) return;
  const prev = l.state;
  l.state = s; emit(id, { t: 'state', state: s, current: l.current }); announce(id);
  onStateChange(id, prev, s);
}
function touch(id: string, last?: string): void {
  const m = getChat(id); if (!m) return;
  m.updated = Date.now(); if (last != null) m.last = last.replace(/\s+/g, ' ').slice(0, 200);
  save();
}

export function subscribe(id: string, f: (e: unknown) => void): () => void {
  const l = live(id); l.subs.add(f);
  if (getChat(id)?.runId) ensurePolling(id);
  return () => l.subs.delete(f);
}

export function createChat(input: { cwd: string; title?: string; model?: string; mode?: string; resume?: string; create?: boolean }): ChatMeta {
  const cwd = path.resolve(input.cwd.replace(/^~(?=$|\/)/, os.homedir()));
  // 새 프로젝트: 없는 폴더면 만들고 git 저장소로(홈 아래만). 있는 폴더는 건드리지 않는다
  if (input.create && !fs.existsSync(cwd)) {
    if (!cwd.startsWith(os.homedir() + path.sep)) throw new Error('new folders go under your home folder');
    fs.mkdirSync(cwd, { recursive: true });
    try { execFileSync('git', ['init', '-q', '-b', 'main'], { cwd, timeout: 10000 }); } catch { /* git 없음: 빈 폴더로 시작 */ }
  }
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`folder not found: ${cwd}`);
  let sid = (input.resume ?? '').trim();
  if (sid && !/^[0-9a-f-]{36}$/i.test(sid)) throw new Error('bad session id');
  // coxpit 이 붙여 둔 번호가 실제로 안 쓰였으면(셸이 PATH 를 덮어 shim 을 건너뜀) 그 폴더의 가장 최근 대화로
  if (sid && !findTranscript(sid)) sid = latestInFolder(cwd) ?? '';
  const m: ChatMeta = {
    id: randomUUID().slice(0, 8), title: (input.title ?? '').trim() || path.basename(cwd),
    cwd, sid, model: (input.model ?? '').trim(), mode: MODES.includes(input.mode as PermMode) ? input.mode as PermMode : 'auto',
    created: Date.now(), updated: Date.now(), last: '',
  };
  metas.push(m); save(); announce(m.id);
  return m;
}

export function updateChat(id: string, patch: { title?: string; mode?: string; model?: string; pinned?: unknown; hidden?: unknown }): ChatMeta {
  const m = getChat(id); if (!m) throw new Error('not found');
  if (patch.title != null) m.title = String(patch.title).trim().slice(0, 80) || m.title;
  if (patch.pinned != null) { if (patch.pinned === true || patch.pinned === 'true') m.pinned = true; else delete m.pinned; }
  if (patch.hidden != null) { if (patch.hidden === true || patch.hidden === 'true') m.hidden = true; else delete m.hidden; }
  if (patch.model != null) m.model = patch.model.trim();
  if (patch.mode != null && MODES.includes(patch.mode as PermMode)) {
    m.mode = patch.mode as PermMode;
    const l = lives.get(id);
    if (l?.proc) control(id, { subtype: 'set_permission_mode', mode: m.mode });
  }
  save(); announce(id);
  return m;
}

/** 할 일 체크 하나. 글이 같으면 같은 할 일로 본다(답이 다시 그려져도 체크가 남게) */
export function todoKey(text: string): string { return text.replace(/\s+/g, ' ').trim().slice(0, 200); }
export function setTodo(id: string, text: string, done: boolean): ChatMeta {
  const m = getChat(id); if (!m) throw new Error('not found');
  const k = todoKey(text); if (!k) throw new Error('text required');
  const t = { ...(m.todos ?? {}) };
  if (done) t[k] = Date.now(); else delete t[k];
  const keys = Object.keys(t);
  if (keys.length > 300) for (const x of keys.sort((a, b) => t[a]! - t[b]!).slice(0, keys.length - 300)) delete t[x];
  m.todos = t; save(); emit(id, { t: 'todos', todos: t }); announce(id);
  return m;
}

/** 대화 기록 — claude 의 jsonl 이 정본. 세션이 아직 없으면 빈 목록. */
type Row = { type?: string; uuid?: string; parentUuid?: string | null; timestamp?: string; isMeta?: boolean; isCompactSummary?: boolean; isSidechain?: boolean; message?: { content?: unknown } };

/** 대본 줄 캐시: 파일이 자란 만큼만 읽어 붙인다(긴 대화를 매번 4MB 씩 다시 읽어 데몬 전체가 느려졌다) */
const rowCache = new Map<string, { size: number; rows: unknown[]; rest: string }>();
function transcriptRows(f: string): unknown[] {
  let size = 0;
  try { size = fs.statSync(f).size; } catch { return []; }
  let c = rowCache.get(f);
  if (!c || size < c.size) {
    // 처음(또는 줄어듦): 꼬리 4MB 만
    const start = Math.max(0, size - 4_000_000);
    c = { size: start, rows: [], rest: '' };
    rowCache.set(f, c);
    if (start > 0) c.rest = '\u0000';   // 첫 줄은 잘렸을 수 있다 → 버린다
  }
  if (size > c.size) {
    const fd = fs.openSync(f, 'r');
    try {
      const buf = Buffer.alloc(size - c.size);
      fs.readSync(fd, buf, 0, buf.length, c.size);
      const text = (c.rest === '\u0000' ? '' : c.rest) + buf.toString('utf8');
      const parts = text.split('\n');
      const dropFirst = c.rest === '\u0000';
      c.rest = parts.pop() ?? '';
      for (const [i, line] of parts.entries()) {
        if (dropFirst && i === 0) continue;
        if (!line.trim()) continue;
        try { c.rows.push(JSON.parse(line)); } catch { /* 깨진 줄 */ }
      }
      if (c.rows.length > 20000) c.rows = c.rows.slice(-15000);
      c.size = size;
    } finally { fs.closeSync(fd); }
  }
  return c.rows;
}

export function readTurns(m: ChatMeta, max = 300, hint?: string[]): Turn[] {
  if (!m.sid) return [];
  const f = findTranscript(m.sid); if (!f) return [];
  const rows = transcriptRows(f) as Row[];
  // 대본은 가지를 칠 수 있다(같은 대화를 두 곳에서 이어 쓰면). 마지막 줄에서 parentUuid 를 거슬러
  // 지금 이어지는 갈래만 남긴다 — 맥 화면의 claude 가 보는 것과 같게.
  const byId = new Map(rows.filter((r) => r.uuid).map((r) => [r.uuid!, r]));
  const flat = (r: Row): string => { const c = r.message?.content; return (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b as { text?: string })?.text ?? '').join(' ') : '').replace(/\s+/g, ' '); };
  // 맥 화면에 떠 있는 답 글귀가 있으면 그 줄이 지금 갈래의 끝이다(같은 파일에 다른 갈래가 더 나중에 쓰였어도)
  let last: Row | undefined;
  for (const h of hint ?? []) {
    last = [...rows].reverse().find((r) => r.type === 'assistant' && r.uuid && flat(r).includes(h));
    if (last) break;   // 화면의 마지막 답이 끝. 그 뒤에 남이 덧붙인 줄은 이 claude 가 모른다
  }
  last ??= [...rows].reverse().find((r) => (r.type === 'user' || r.type === 'assistant') && r.uuid && !r.isSidechain);
  let chain: Row[] = rows;
  if (last) {
    const keep: Row[] = []; let cur: Row | undefined = last; const seen = new Set<string>();
    while (cur && cur.uuid && !seen.has(cur.uuid)) { seen.add(cur.uuid); keep.push(cur); cur = cur.parentUuid ? byId.get(cur.parentUuid) : undefined; }
    // 읽은 꼬리(4MB) 밖으로 이어지면 갈래 앞부분은 잘린다 — 그래도 지금 갈래가 맞다
    if (keep.length > 1) chain = keep.reverse();
  }
  const turns: Turn[] = [];
  for (const j of chain) {
    const ts = j.timestamp ? Date.parse(j.timestamp) : undefined;
    const c = j.message?.content;
    // 맥락이 차서 claude 가 스스로 쓴 요약은 사람의 말이 아니다 — 보이지 않는다
    if (j.type === 'user' && !j.isMeta && !j.isCompactSummary) {
      const raw = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n') : '';
      // 여러 줄 붙여넣기는 claude 가 <pasted_content id="…"> 로 감싸 적는다 — 껍데기를 벗겨 보낸 말 그대로
      const text = raw.replace(/<pasted_content id="[^"]*">\n?([\s\S]*?)\n?<\/pasted_content id="[^"]*">/g, '$1').trim();
      if (text && !text.startsWith('<')) turns.push({ role: 'user', text, ts });
    } else if (j.type === 'assistant' && Array.isArray(c)) {
      const text = c.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
      const tools = c.filter((b) => b?.type === 'tool_use').map((b) => ({ name: b.name, summary: summarize(b.name, b.input) }));
      const prev = turns[turns.length - 1];
      // 한 답이 여러 줄(도구 → 글 → 도구)로 나뉘어 적히므로, 사람이 말하기 전까지는 하나로 묶는다
      if (prev && prev.role === 'assistant') {
        if (text.trim()) {
          prev.text = prev.text ? prev.text + '\n\n' + text : text;
          prev.final = prev.final ? prev.final + '\n\n' + text : text;
        }
        if (tools.length) { prev.tools = [...(prev.tools ?? []), ...tools]; prev.final = ''; }   // 도구를 또 쓰면 앞 글은 중간 안내였다
        if (ts) prev.ts = ts;
      } else if (text.trim() || tools.length) turns.push({ role: 'assistant', text, tools, ts, final: tools.length ? '' : text });
    }
  }
  return turns.slice(-max);
}

/** 대화 속 찾기: 대화마다 최근 300턴(대본 꼬리)에서 글귀를 찾는다. 대화당 앞 3개, 전체 60개까지 */
export function searchChats(q: string): Array<{ id: string; title: string; hits: Array<{ ts?: number; role: string; snippet: string }> }> {
  const needle = q.trim().toLowerCase(); if (needle.length < 2) return [];
  const out: Array<{ id: string; title: string; hits: Array<{ ts?: number; role: string; snippet: string }> }> = [];
  let total = 0;
  const order = [...metas].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  for (const m of order) {
    if (total >= 60) break;
    let turns: Turn[] = [];
    try { turns = readTurns(m, 300, m.runId ? tmuxHint.get(m.id) : undefined); } catch { continue; }
    const hits: Array<{ ts?: number; role: string; snippet: string }> = [];
    for (let i = turns.length - 1; i >= 0 && hits.length < 3; i--) {
      const t = turns[i]!; const flat = t.text.replace(/\s+/g, ' ');
      const at = flat.toLowerCase().indexOf(needle); if (at < 0) continue;
      const from = Math.max(0, at - 40);
      hits.push({ ts: t.ts, role: t.role, snippet: (from > 0 ? '…' : '') + flat.slice(from, at + needle.length + 80) });
    }
    if (hits.length) { out.push({ id: m.id, title: m.title, hits }); total += hits.length; }
  }
  return out;
}

/** 이 맥의 최근 claude 대화(앱 밖 터미널에서 쓴 것 포함). 앱에서 골라 coxpit 터미널로 잇는다(--resume) */
export function recentClaude(limit = 30): Array<{ sid: string; cwd: string; title: string; updated: number; live: boolean }> {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const known = new Set(metas.map((m) => m.sid));
  const files: Array<{ f: string; sid: string; t: number }> = [];
  try {
    for (const d of fs.readdirSync(root)) {
      let names: string[] = [];
      try { names = fs.readdirSync(path.join(root, d)); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith('.jsonl')) continue;
        const f = path.join(root, d, n);
        try { files.push({ f, sid: n.slice(0, -6), t: fs.statSync(f).mtimeMs }); } catch { /* 사라짐 */ }
      }
    }
  } catch { return []; }
  const out: Array<{ sid: string; cwd: string; title: string; updated: number; live: boolean }> = [];
  for (const x of files.sort((a, b) => b.t - a.t)) {
    if (out.length >= limit) break;
    if (known.has(x.sid)) continue;
    // 머리 64KB 에서 폴더와 첫 말을 읽는다
    let cwd = '', title = '', headless = false;
    try {
      const fd = fs.openSync(x.f, 'r'); const buf = Buffer.alloc(65536);
      const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
      for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
        let r: Row & { cwd?: string; summary?: string; entrypoint?: string };
        try { r = JSON.parse(line); } catch { continue; }
        if (r.entrypoint === 'sdk-cli' || r.entrypoint === 'sdk-ts' || r.entrypoint === 'sdk-py') { headless = true; break; }   // claude -p 같은 자동 작업
        if (!cwd && r.cwd) cwd = r.cwd;
        if (r.type === 'summary' && r.summary && !title) title = r.summary;
        if (!title && r.type === 'user' && !r.isMeta) {
          const c = r.message?.content;
          const t = (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join(' ') : '').trim();
          if (t && !t.startsWith('<')) title = t.replace(/\s+/g, ' ').slice(0, 80);
        }
        if (cwd && title) break;
      }
    } catch { continue; }
    if (!cwd || headless) continue;
    out.push({ sid: x.sid, cwd, title: title || path.basename(cwd), updated: x.t, live: Date.now() - x.t < 120_000 });
  }
  return out;
}

/** claude 가 폴더별 대화를 두는 자리: 경로의 영숫자 아닌 글자를 '-' 로 */
function projectDir(cwd: string): string {
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}
function latestInFolder(cwd: string): string | null {
  try {
    const d = projectDir(cwd);
    const files = fs.readdirSync(d).filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, t: fs.statSync(path.join(d, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    return files[0] ? files[0].f.replace(/\.jsonl$/, '') : null;
  } catch { return null; }
}

const pathCache = new Map<string, string>();
function findTranscript(sid: string): string | null {
  const hit = pathCache.get(sid);
  if (hit && fs.existsSync(hit)) return hit;
  const f = findTranscriptSlow(sid);
  if (f) pathCache.set(sid, f);
  return f;
}
function findTranscriptSlow(sid: string): string | null {
  const root = path.join(os.homedir(), '.claude', 'projects');
  try {
    for (const d of fs.readdirSync(root)) {
      const f = path.join(root, d, `${sid}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch { /* 없음 */ }
  return null;
}

export function chatDetail(id: string) {
  const m = getChat(id); if (!m) return null;
  const tst = tmuxState.get(id);
  const l = lives.get(id);
  const turns = readTurns(m, 300, m.runId ? tmuxHint.get(id) : undefined);
  return { chat: summary(m), turns, partial: (m.runId ? tst?.live : l?.partial) ?? '', tools: l?.tools ?? [] };
}

function write(id: string, obj: unknown): boolean {
  const p = lives.get(id)?.proc;
  if (!p || !p.stdin || p.stdin.destroyed) return false;
  p.stdin.write(JSON.stringify(obj) + '\n'); return true;
}
function control(id: string, request: Record<string, unknown>): boolean {
  const l = live(id);
  return write(id, { type: 'control_request', request_id: `cx${++l.reqSeq}`, request });
}

function start(m: ChatMeta): Live {
  const l = live(m.id);
  if (l.proc) return l;
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--permission-mode', m.mode];
  if (m.model) args.push('--model', m.model);
  if (m.sid) args.push('--resume', m.sid);
  const bin = config.agent.bin || 'claude';
  const p = spawn(bin, args, { cwd: m.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, COXPIT_CHAT: m.id } });
  l.proc = p; l.started = Date.now();
  let err = '';
  p.stderr?.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-2000); });
  p.on('error', (e) => { emit(m.id, { t: 'error', message: String(e) }); setState(m.id, 'error'); });
  p.on('exit', (code) => {
    l.proc = null; l.asks.clear(); l.current = '';
    if (l.state === 'run' || l.state === 'ask') {
      emit(m.id, { t: 'error', message: `claude exited (${code})${err ? ': ' + err.trim().split('\n').pop() : ''}` });
      setState(m.id, 'error');
    }
  });
  control(m.id, { subtype: 'initialize', hooks: null });
  const rl = readline.createInterface({ input: p.stdout! });
  rl.on('line', (line) => { try { onMessage(m.id, JSON.parse(line)); } catch { /* 줄이 아님 */ } });
  return l;
}

function onMessage(id: string, msg: Record<string, any>): void {
  const m = getChat(id); if (!m) return;
  const l = live(id);
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init' && msg.session_id && m.sid !== msg.session_id) { m.sid = msg.session_id; save(); }
      break;
    case 'stream_event': {
      const ev = msg.event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        l.partial += ev.delta.text; emit(id, { t: 'delta', text: ev.delta.text });
      }
      break;
    }
    case 'assistant':
      for (const b of msg.message?.content ?? []) {
        if (b.type === 'tool_use') {
          const t = { name: b.name, summary: summarize(b.name, b.input) };
          l.tools.push(t); l.current = `${t.name} · ${t.summary}`;
          emit(id, { t: 'tool', tool: t });
        } else if (b.type === 'text' && b.text) {
          // 조각을 놓쳤어도 글 블록 하나가 끝나면 그것으로 맞춘다
          if (!l.partial.endsWith(b.text)) { l.partial = l.partial ? l.partial + '\n\n' + b.text : b.text; emit(id, { t: 'text', text: l.partial }); }
          else l.partial += '\n\n';
        }
      }
      break;
    case 'control_request':
      if (msg.request?.subtype === 'can_use_tool') {
        const r = msg.request;
        const a: Ask = { id: msg.request_id, tool: r.tool_name, input: r.input, summary: summarize(r.tool_name, r.input), ts: Date.now() };
        l.asks.set(a.id, a); emit(id, { t: 'ask', ask: a }); setState(id, 'ask');
      }
      break;
    case 'result': {
      const text = l.partial.trim();
      if (String(msg.subtype ?? '').startsWith('error') && !text && !l.tools.length) {
        const why = Array.isArray(msg.errors) && msg.errors.length ? msg.errors.join(' ') : '';
        emit(id, { t: 'error', message: why || (m.sid ? 'Could not continue this conversation. The session may be open in a terminal, or it no longer exists.' : 'claude stopped before answering.') });
      }
      l.partial = ''; l.tools = []; l.current = ''; l.asks.clear();
      touch(id, typeof msg.result === 'string' && msg.result.trim() ? msg.result : text);
      emit(id, { t: 'result', subtype: msg.subtype, ms: msg.duration_ms, cost: msg.total_cost_usd });
      setState(id, 'idle');
      clearTimeout(l.idleTimer);
      l.idleTimer = setTimeout(() => closeChat(id), IDLE_MS);
      break;
    }
  }
}

export function sendChat(id: string, text: string): void {
  const m = getChat(id); if (!m) throw new Error('not found');
  const t = text.trim(); if (!t) throw new Error('empty');
  const l = start(m);
  clearTimeout(l.idleTimer);
  if (l.state !== 'run' && l.state !== 'ask') { l.partial = ''; l.tools = []; }
  write(id, { type: 'user', message: { role: 'user', content: t }, parent_tool_use_id: null, session_id: '' });
  emit(id, { t: 'user', text: t, ts: Date.now() });
  touch(id, t);
  setState(id, 'run');
}

export function answerAsk(id: string, askId: string, allow: boolean, note?: string): boolean {
  const l = lives.get(id); const a = l?.asks.get(askId);
  if (!l || !a) return false;
  l.asks.delete(askId);
  const response = allow ? { behavior: 'allow', updatedInput: a.input } : { behavior: 'deny', message: note?.trim() || 'The user denied this from the coxpit app.' };
  write(id, { type: 'control_response', response: { subtype: 'success', request_id: askId, response } });
  emit(id, { t: 'answered', id: askId, allow });
  setState(id, l.asks.size ? 'ask' : 'run');
  return true;
}

export function interruptChat(id: string): boolean {
  const l = lives.get(id); if (!l?.proc) return false;
  return control(id, { subtype: 'interrupt' });
}

/** 하네스를 내린다(맥에서 `claude --resume` 으로 이어 받기 전에). 대화는 jsonl 에 그대로 남는다. */
export function closeChat(id: string): void {
  const l = lives.get(id); if (!l) return;
  clearTimeout(l.idleTimer);
  if (l.proc) { try { l.proc.stdin?.end(); l.proc.kill('SIGTERM'); } catch { /* 이미 끝 */ } }
  l.proc = null; l.asks.clear(); l.current = '';
  setState(id, 'idle');
}

/** 앱의 「세션 지우기」: 목록에서 빼고 다시 안 데려온다. 폴더에서 연 세션(가지 없음)은 그 터미널도 닫는다
 *  (claude 대화 기록은 맥에 남아 「최근 클로드 대화 이어 열기」로 다시 열 수 있다). 격리 작업 폴더(가지 있음)의 run 은
 *  목록에서만 뺀다 — 그 폴더를 지우는 건 맥 coxpit 화면의 몫이다 */
export async function deleteChat(id: string): Promise<boolean> {
  const m = getChat(id); if (!m) return false;
  if (m.runId) {
    dismissed.add(m.runId); saveDismissed();
    try {
      const r = (await db.select().from(agentRuns).where(eq(agentRuns.id, m.runId)).limit(1))[0];
      if (r && !r.branch) await cleanupRun(m.runId);
    } catch { /* 터미널 정리는 덤 */ }
  }
  return removeChat(id);
}

export function removeChat(id: string): boolean {
  closeChat(id); lives.delete(id);
  const n = metas.length; metas = metas.filter((m) => m.id !== id); save();
  if (metas.length !== n) broadcast({ type: 'chat-removed', id });
  return metas.length !== n;
}

export function shutdownChats(): void { for (const id of lives.keys()) closeChat(id); }


// ───────────────────────── tmux 모드 ─────────────────────────
// 폰에서 보낸 말을 coxpit 세션(tmux) 안의 claude 에 그대로 쳐 넣고, 그 claude 가 쓰는 대본을 읽어 앱에 보낸다.
// claude 는 하나뿐이라 맥 화면과 폰이 같은 대화를 실시간으로 본다. 상태(작업 중 · 물어봄)는 화면을 읽어 판단한다.

/** 화면에 보이는 claude 답 줄(⏺ …) 몇 개 — 대본에서 지금 갈래를 고르는 손잡이 */
function screenHints(screen: string): string[] {
  return screen.split('\n').filter((l) => /^\s*⏺\s+\S/.test(l)).map((l) => l.replace(/^\s*⏺\s+/, '').replace(/\s+/g, ' ').trim())
    .filter((l) => l.length >= 12 && !/^(Bash|Read|Edit|Write|Update|Search|Grep|Glob)\(/.test(l)).slice(-3).reverse().map((l) => l.slice(0, 40));
}
const tmuxHint = new Map<string, string[]>();
const tmuxState = new Map<string, { screen: string; mtime: number; ask?: Ask; polling?: boolean; fails?: number; cur?: string; live?: string; sent?: Turn[] }>();
const recentCids = new Map<string, string[]>();   // 같은 말이 두 번 쳐지지 않게(앱이 다시 보낼 때)
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', '-zsh', '-bash', 'login']);

async function paneInfo(runId: number) {
  const info = await getRunTermInfo(runId);
  if (!info) return null;
  const t = shq(info.session);
  const r = await runShellOn(info.machine,
    `tmux display -p -t ${t} '#{pane_current_command}' 2>/dev/null; echo ---; tmux capture-pane -p -J -t ${t} 2>/dev/null`, 8000);
  if (!r.ok) return null;
  const [cmd, ...rest] = r.stdout.split('\n---\n');
  return { info, cmd: (cmd ?? '').trim(), screen: rest.join('\n---\n') };
}

/** 화면으로 상태를 본다: 승인 질문 → ask, 「esc to interrupt」 → run, 그 밖 → idle */
function classify(screen: string): { state: ChatState; ask?: Ask; current: string } {
  const lines = screen.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  const tail = lines.slice(-25).join('\n');
  // 처음 여는 폴더: 「이 폴더를 믿을까요?」
  if (/trust this folder|Do you trust the files/i.test(tail) && /Enter to confirm/i.test(tail)) {
    return { state: 'ask', ask: { id: 'tmux-trust', tool: 'Trust', input: null, summary: 'Open Claude Code in this folder? It will be able to read, edit and run files here.', ts: Date.now() }, current: 'trust this folder?' };
  }
  const q = /Do you want to [^\n?]{0,80}\?/i.exec(tail);
  if (q && /(^|\n)[^\S\n]*[❯>]?[^\S\n]*1\.[^\S\n]+Yes\b/.test(tail)) {
    // 질문 위의 명령 상자(테두리 안 글)를 요약으로
    const before = tail.slice(0, q.index).split('\n').slice(-8)
      .map((l) => l.replace(/^[\s│╭╰─╮╯]+|[\s│╭╰─╮╯]+$/g, '')).filter((l) => l && !/^─+$/.test(l));
    const summary = (before.join('\n') + '\n' + q[0]).trim().slice(-600);
    const id = 'tmux-' + Buffer.from(summary).toString('base64').slice(0, 24);
    return { state: 'ask', ask: { id, tool: 'Terminal', input: null, summary, ts: Date.now() }, current: q[0] };
  }
  if (/esc to interrupt/i.test(tail)) {
    // 지금 실행 중인 도구(⏺ Bash(…)) 가 있으면 그것, 없으면 스피너 글귀(「Beaming…」)
    const recent = lines.slice(-30);
    const tool = [...recent].reverse().find((l) => /^\s*⏺\s+[A-Z][A-Za-z]+\(/.test(l));
    const spin = [...recent].reverse().find((l) => /^\s*[✻✶✳✢·*]\s/.test(l) && /…/.test(l));
    const cur = tool ? tool.replace(/^\s*⏺\s+/, '') : (spin ?? '').replace(/^\s*[✻✶✳✢·*]\s+/, '').replace(/\s*\(.*$/, '');
    return { state: 'run', current: cur.slice(0, 160) };
  }
  return { state: 'idle', current: '' };
}

/** claude 가 프로세스마다 남기는 ~/.claude/sessions/<pid>.json — tmux 세션 이름과 지금 대화 번호 · 상태가 들어 있다 */
let sessCache: { at: number; list: Array<{ pid?: string | number; sessionId?: string; tmux?: string; status?: string; updatedAt?: string | number }> } = { at: 0, list: [] };
function claudeSessions() {
  if (Date.now() - sessCache.at < 1500) return sessCache.list;
  const dir = path.join(os.homedir(), '.claude', 'sessions');
  const list: typeof sessCache.list = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try { list.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch { /* 쓰는 중 */ }
    }
  } catch { /* 폴더 없음 */ }
  sessCache = { at: Date.now(), list };
  return list;
}
function liveClaudeFor(session: string): { sid: string; status: string } | null {
  let best: { sid: string; status: string; at: number } | null = null;
  for (const j of claudeSessions()) {
    if (!j.sessionId || !String(j.tmux ?? '').startsWith(session + ':')) continue;
    try { process.kill(Number(j.pid), 0); } catch { continue; }   // 끝난 프로세스의 남은 파일
    const at = Number(j.updatedAt) || 0;
    if (!best || at > best.at) best = { sid: j.sessionId, status: String(j.status ?? ''), at };
  }
  return best;
}

async function tmuxSid(m: ChatMeta): Promise<string> {
  const info = await getRunTermInfo(m.runId!);
  const lc = info ? liveClaudeFor(info.session) : null;
  if (lc && findTranscript(lc.sid)) {
    if (lc.sid !== m.sid) { m.sid = lc.sid; m.last = ''; const st = tmuxState.get(m.id); if (st) st.mtime = 0; save(); }
    return lc.sid;
  }
  const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, m.runId!)).limit(1);
  let sid = rr[0]?.claudeSessionId ?? '';
  if (!sid || !findTranscript(sid)) {
    await getSessionChat(m.runId!, 1);   // 화면으로 실제 대본을 찾아 run 에 적어 둔다
    const r2 = await db.select().from(agentRuns).where(eq(agentRuns.id, m.runId!)).limit(1);
    sid = r2[0]?.claudeSessionId ?? '';
    if (!sid || !findTranscript(sid)) {
      // 폴더의 최신 대본은 그 폴더를 쓰는 세션이 하나뿐일 때만 믿는다(홈 폴더 세션들이 서로의 대화를 집었다)
      const dir = rr[0]?.worktreePath || m.cwd;
      const sharers = metas.filter((x) => x.runId && x.cwd === dir).length;
      sid = sharers <= 1 ? (latestInFolder(dir) ?? '') : '';
    }
  }
  if (sid !== m.sid) { m.sid = sid; m.last = ''; const st = tmuxState.get(m.id); if (st) st.mtime = 0; save(); }
  return sid;
}

// ── 알림: 끝남 · 물어봄 → 폰 푸시(push.ts). 앱이 켜져 있으면 앱이 직접 띄우고 이건 앱이 화면에 안 보인다 ──
const finishTimers = new Map<string, NodeJS.Timeout>();
function onStateChange(id: string, prev: ChatState, s: ChatState): void {
  const m = getChat(id); if (!m) return;
  if (s === 'ask' && prev !== 'ask') {
    const a = [...(lives.get(id)?.asks.values() ?? [])][0];
    void pushNotify({ chatId: id, kind: 'ask', title: `${m.title} · 물어봄`, body: a?.summary || '허락을 기다려요' });
  }
  if (prev === 'run' && s === 'idle') {
    // 잠깐 쉬었다 다시 도는 것(도구 사이 · 에이전트 사이)은 알리지 않는다
    clearTimeout(finishTimers.get(id));
    finishTimers.set(id, setTimeout(() => {
      finishTimers.delete(id);
      if (lives.get(id)?.state !== 'idle') return;
      const mm = getChat(id); if (!mm) return;
      void pushNotify({ chatId: id, kind: 'done', title: `${mm.title} · 끝남`, body: mm.last.replace(/\*\*|`/g, '').slice(0, 180) || '답이 왔어요' });
    }, 8000));
  }
  if (s === 'run') clearTimeout(finishTimers.get(id));
}

// ── 서브에이전트 ──
// 메인 claude 가 에이전트를 뒤에 돌려 놓고 턴을 끝내면 화면은 쉬는데 일은 돈다(오너 「끝남으로 나온다」 10/30).
// claude 가 남기는 것만 읽는다: <대본 폴더>/<세션>/subagents/agent-<id>.{meta.json,jsonl}
// 끝남 = 메인 대본에 그 id 의 task-notification · task_status(끝) · (앞에서 돈 것은) tool_result 가 에이전트 마지막 기록 뒤에 있다.
const AGENT_STALE_MS = 3 * 60 * 60 * 1000;   // 이보다 오래 조용하면 죽은 것으로 본다(claude 가 꺼진 채 남은 것)
const AGENT_KEEP_MS = 15 * 60 * 1000;        // 끝난 것도 이만큼은 목록에 남긴다
// 뒤에서 돌린 셸(Bash run_in_background)도 같은 알림으로 끝난다 → 같이 센다
interface BgShell { id: string; cmd: string; ts: number }
const endIdx = new Map<string, { n: number; rows: unknown[]; ends: Map<string, number>; shells: Map<string, BgShell> }>();
function agentEnds(f: string): Map<string, number> { return agentIndex(f).ends; }
function agentIndex(f: string) {
  const rows = transcriptRows(f) as Array<Record<string, any>>;
  let c = endIdx.get(f);
  if (!c || c.rows !== rows || c.n > rows.length) { c = { n: 0, rows, ends: new Map(), shells: new Map() }; endIdx.set(f, c); }
  const put = (k: string, t: number) => { if (t > (c!.ends.get(k) ?? 0)) c!.ends.set(k, t); };
  for (; c.n < rows.length; c.n++) {
    const r = rows[c.n]!; const ts = Date.parse(r.timestamp ?? '') || 0;
    const txt = typeof r.content === 'string' ? r.content : typeof r.message?.content === 'string' ? r.message.content : '';
    if (txt.includes('<task-notification>')) {
      for (const m of txt.matchAll(/<task-id>([\w-]+)<\/task-id>/g)) put(m[1]!, ts);
      for (const m of txt.matchAll(/<tool-use-id>([\w-]+)<\/tool-use-id>/g)) put('n:' + m[1]!, ts);
    }
    if (r.type === 'assistant' && Array.isArray(r.message?.content)) for (const b of r.message.content) {
      if (b?.type === 'tool_use' && b.name === 'Bash' && b.input?.run_in_background === true) c.shells.set(b.id, { id: b.id, cmd: String(b.input.description || b.input.command || '').replace(/\s+/g, ' ').slice(0, 120), ts });
    }
    const a = r.attachment;
    if (a?.type === 'task_status' && a.taskId && a.status && a.status !== 'running') put(String(a.taskId), ts);
    if (Array.isArray(r.message?.content)) for (const b of r.message.content) if (b?.type === 'tool_result' && b.tool_use_id) put('tool:' + b.tool_use_id, ts);
  }
  return c;
}
const agentCur = new Map<string, { mt: number; current: string; started: number; finished: boolean }>();
/** 에이전트 대본 꼬리: 지금 쓰는 도구 · 시작 때 · 끝냈는지(마지막 답이 글로 끝났거나 SubagentHandback) */
function agentProgress(f: string, mt: number): { current: string; started: number; finished: boolean } {
  const hit = agentCur.get(f); if (hit && hit.mt === mt) return hit;
  let current = '', started = hit?.started ?? 0, finished = false;
  try {
    const size = fs.statSync(f).size, fd = fs.openSync(f, 'r');
    try {
      if (!started) { const b = Buffer.alloc(Math.min(4096, size)); fs.readSync(fd, b, 0, b.length, 0); started = Date.parse(JSON.parse(b.toString('utf8').split('\n')[0]!).timestamp) || 0; }
      const n = Math.min(65536, size), b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, size - n);
      const lines = b.toString('utf8').split('\n').reverse();
      for (const line of lines) {
        let j: Record<string, any>; try { j = JSON.parse(line); } catch { continue; }
        const content = j.type === 'assistant' && Array.isArray(j.message?.content) ? j.message.content : null;
        if (!content) continue;
        const tu = content.slice().reverse().find((x: any) => x?.type === 'tool_use');
        if (!tu) { if (j.message?.stop_reason === 'end_turn') { finished = true; break; } continue; }
        if (tu.name === 'SubagentHandback') { finished = true; break; }
        current = summarize(tu.name, tu.input); current = current === tu.name ? tu.name : `${tu.name} · ${current}`; break;
      }
    } finally { fs.closeSync(fd); }
  } catch { /* 읽다 실패 → 빈 줄 */ }
  const v = { mt, current: current.slice(0, 160), started, finished }; agentCur.set(f, v); return v;
}
function subAgents(transcript: string): SubAgent[] {
  const dir = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents');
  let names: string[] = []; try { names = fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl')); } catch { /* 에이전트 없음 · 셸만 볼 수 있다 */ }
  const now = Date.now(); let ends: Map<string, number> | null = null;
  const out: SubAgent[] = [];
  for (const n of names) {
    const jf = path.join(dir, n);
    let mt = 0; try { mt = fs.statSync(jf).mtimeMs; } catch { continue; }
    if (now - mt > AGENT_STALE_MS) continue;
    const id = n.replace(/^agent-/, '').replace(/\.jsonl$/, '');
    let meta: Record<string, any> = {}; try { meta = JSON.parse(fs.readFileSync(path.join(dir, `agent-${id}.meta.json`), 'utf8')); } catch { /* 없음 */ }
    ends ??= agentEnds(transcript);
    // 뒤에서 도는 것은 띄우자마자 「launched」 tool_result 가 오므로 알림만 끝으로 친다
    const fg = meta.requestShape && meta.requestShape !== 'background';
    const end = Math.max(ends.get(id) ?? 0, fg && meta.toolUseId ? (ends.get('tool:' + meta.toolUseId) ?? 0) : 0);
    // 끝 알림이 대본 창(꼬리 4MB) 밖으로 밀려나도 에이전트 자기 대본으로 끝을 안다
    const pr = agentProgress(jf, mt);
    const running = end < mt - 1000 && !pr.finished;
    if (!running && now - mt > AGENT_KEEP_MS) continue;
    out.push({ id, desc: String(meta.description ?? meta.agentType ?? '에이전트').slice(0, 120), started: pr.started || mt, updated: mt, current: running ? pr.current : '', running });
  }
  // 뒤에서 도는 셸: 끝 알림(같은 tool-use-id)이 아직 없으면 도는 중
  const ix = agentIndex(transcript);
  for (const sh of ix.shells.values()) {
    if (now - sh.ts > AGENT_STALE_MS) continue;
    const end = ix.ends.get('n:' + sh.id) ?? 0;
    const running = end < sh.ts;
    if (!running && now - end > AGENT_KEEP_MS) continue;
    out.push({ id: sh.id, desc: '셸 · ' + (sh.cmd || '명령'), started: sh.ts, updated: running ? sh.ts : end, current: '', running });
  }
  return out.sort((a, b) => Number(b.running) - Number(a.running) || b.updated - a.updated).slice(0, 12);
}

async function pollTmux(id: string): Promise<void> {
  const m = getChat(id); if (!m?.runId) return;
  const st = tmuxState.get(id) ?? { screen: '', mtime: 0 }; tmuxState.set(id, st);
  const p = await paneInfo(m.runId);
  if (!p) {
    // 한 번 못 읽었다고 오류로 보이지 않는다. 세 번 이어지면 터미널이 없는 것
    st.fails = (st.fails ?? 0) + 1;
    if (st.fails >= 3) {
      const info = await getRunTermInfo(m.runId);
      const has = info ? (await runShellOn(info.machine, `tmux has-session -t ${shq('=' + info.session)} 2>/dev/null && echo yes`, 6000)).stdout.includes('yes') : false;
      setState(id, has ? 'error' : 'gone');
    }
    return;
  }
  st.fails = 0;
  const c = classify(p.screen);
  const lc = liveClaudeFor(p.info.session);
  if (c.state === 'idle' && lc?.status === 'busy') c.state = 'run';
  // 메인이 쉬어도 서브에이전트가 돌면 작업 중이다(claude 가 꺼져 있으면 남은 기록은 안 센다)
  const sid = await tmuxSid(m);
  const f = sid ? findTranscript(sid) : null;
  const agents = f && lc ? subAgents(f) : [];
  const nRun = agents.filter((a) => a.running).length;
  if (c.state === 'idle' && nRun) { c.state = 'run'; c.current = `뒤에서 ${nRun}개 작업 중`; }
  const hints = screenHints(p.screen); if (hints.length) tmuxHint.set(id, hints);
  const l = live(id);
  l.current = c.current;
  const agKey = JSON.stringify(agents);
  if (agKey !== JSON.stringify(l.agents ?? [])) { l.agents = agents; emit(id, { t: 'agents', agents }); announce(id); }
  const prevAsk = st.ask?.id;
  st.ask = c.ask;
  l.asks = new Map(c.ask ? [[c.ask.id, c.ask]] : []);
  if (c.ask && c.ask.id !== prevAsk) emit(id, { t: 'ask', ask: c.ask });
  if (!c.ask && prevAsk) emit(id, { t: 'answered', id: prevAsk, allow: true });
  setState(id, c.state);
  if (c.state === 'run' && st.cur !== l.current) { st.cur = l.current; emit(id, { t: 'state', state: 'run', current: l.current }); }
  // 작업 중에는 화면에 차오르는 답을 그대로(대본은 문단이 끝나야 적힌다)
  const lv = c.state === 'run' ? liveText(p.screen) : '';
  if (lv !== (st.live ?? '')) { st.live = lv; emit(id, { t: 'live', text: lv }); }
  const mt = f ? fs.statSync(f).mtimeMs : 0;
  const hintKey = (tmuxHint.get(id) ?? []).join('|');
  if (mt && (mt !== st.mtime || hintKey !== (st as { hk?: string }).hk)) {
    (st as { hk?: string }).hk = hintKey;
    st.mtime = mt;
    const turns = readTurns(m, 300, tmuxHint.get(id));
    const lastA = [...turns].reverse().find((t) => t.role === 'assistant' && t.text.trim());
    // 한 답 안의 중간 안내(「확인하는 중이에요」)가 아니라 끝 보고를 남긴다. 끝 보고가 아직 없으면(도구 중) 지금까지 글의 끝부분
    if (lastA) { m.last = (lastA.final?.trim() ? lastA.final : lastA.text.split('\n\n').slice(-1)[0] ?? lastA.text).replace(/\s+/g, ' ').slice(0, 200); }
    m.updated = Math.max(m.updated, mt); save();
    // 바뀐 데부터만 보낸다(중계 길에서 가볍게). 앞이 달라졌으면 from 0
    const prev = st.sent ?? [];
    let from = 0;
    while (from < prev.length && from < turns.length && prev[from]!.role === turns[from]!.role && prev[from]!.text === turns[from]!.text
      && (prev[from]!.tools?.length ?? 0) === (turns[from]!.tools?.length ?? 0)) from++;
    if (from === prev.length && from === turns.length) { announce(id); return; }
    st.sent = turns;
    emit(id, { t: 'patch', from, turns: turns.slice(from), total: turns.length });
    announce(id);
  }
}

/** 화면에서 마지막 입력(❯ …) 아래, 아래쪽 상자 위의 글 — 작업 중에 차오르는 답 */
function liveText(screen: string): string {
  const lines = screen.split('\n');
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^\s*❯\s+\S/.test(lines[i]!) ) { start = i + 1; break; }
  if (start < 0) return '';
  let end = lines.length;
  for (let i = lines.length - 1; i >= start; i--) if (/^─{10,}/.test(lines[i]!.trim())) end = i;
  return lines.slice(start, end).map((x) => x.replace(/\s+$/, ''))
    .filter((x) => !/esc to interrupt|\/effort|shift\+tab|^\s*[✻✶✳✢·*◐◑◒◓⏵]\s/.test(x)).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim().slice(-4000);
}

function ensurePolling(id: string): void {
  const st = tmuxState.get(id) ?? { screen: '', mtime: 0 }; tmuxState.set(id, st);
  if (st.polling) return;
  st.polling = true;
  const tick = async () => {
    const l = lives.get(id);
    const watching = (l?.subs.size ?? 0) > 0 || (l && l.state !== 'idle');
    try { await pollTmux(id); } catch { /* 다음 번에 */ }
    if (!getChat(id)) { st.polling = false; return; }
    setTimeout(tick, watching ? 1500 : 6000);
  };
  void tick();
}

/** 데몬이 뜰 때 tmux 대화들의 상태 보기를 시작한다(목록의 작업 중 · 물어봄) */
export function startTmuxWatch(): void {
  void syncSessions().then(() => { for (const m of metas) if (m.runId) ensurePolling(m.id); });
  setInterval(() => void syncSessions(), 20000);
}

export async function adoptRun(runId: number, title?: string): Promise<ChatMeta> {
  if (dismissed.delete(runId)) saveDismissed();   // 다시 넘겨 받으면 지운 표시를 푼다(맞추기는 지운 것을 안 넘긴다)
  const ex = metas.find((m) => m.runId === runId);
  if (ex) return ex;
  const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1);
  const r = rr[0]; if (!r || !r.tmuxWindow) throw new Error('that session has no terminal');
  const m: ChatMeta = {
    id: randomUUID().slice(0, 8), title: title || r.title || path.basename(r.worktreePath), cwd: r.worktreePath,
    sid: '', model: '', mode: 'auto', created: Date.now(), updated: Date.now(), last: '', runId,
  };
  metas.push(m); save(); announce(m.id); ensurePolling(m.id);
  return m;
}

/** 새 대화 = 새 coxpit 세션(tmux)을 그 폴더에 열고 붙는다. 맥 coxpit 화면에도 세션으로 뜬다 */
export async function openTmuxChat(cwd: string, title?: string, create?: boolean, resumeSid?: string): Promise<ChatMeta> {
  const dir = path.resolve(cwd.replace(/^~(?=$|\/)/, os.homedir()));
  if (create && !fs.existsSync(dir)) {
    if (!dir.startsWith(os.homedir() + path.sep)) throw new Error('new folders go under your home folder');
    fs.mkdirSync(dir, { recursive: true });
    try { execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, timeout: 10000 }); } catch { /* git 없음 */ }
  }
  const open = (await db.select().from(agentRuns)).filter((x) => x.worktreePath === dir && x.tmuxWindow && x.status !== 'closed');
  const ex = open.sort((a, b) => b.id - a.id)[0];
  // 이전 대화를 잇는 거면 그 폴더에 열린 세션이 있어도 새로 연다(있는 세션은 다른 대화다)
  if (ex && !resumeSid && (await getRunTermInfo(ex.id))) return adoptRun(ex.id, title || path.basename(dir));
  const r = await openSessionAt('local', dir, title || path.basename(dir));
  if (!r.ok || !r.runId) throw new Error(r.detail || 'could not open a session');
  const m = await adoptRun(r.runId, title || path.basename(dir));
  if (resumeSid && findTranscript(resumeSid)) { m.sid = resumeSid; save(); }   // 이전 대화를 이 세션에서 잇는다
  return m;
}

async function tmuxSend(m: ChatMeta, text: string): Promise<void> {
  const p = await paneInfo(m.runId!);
  if (!p) throw new Error('the terminal session is gone');
  const t = shq(p.info.session);
  // claude 가 안 떠 있으면(셸 프롬프트) 먼저 띄운다. coxpit 심이 이 세션의 대화로 잇는다
  if (SHELLS.has(p.cmd)) {
    let flags = m.mode && m.mode !== 'default' ? ` --permission-mode ${m.mode}` : '';
    if (m.sid && findTranscript(m.sid)) flags += ` --resume ${m.sid}`;
    await runShellOn(p.info.machine, `tmux send-keys -t ${t} ${shq('claude' + flags)} Enter`, 8000);
    let up = false;
    for (let i = 0; i < 180; i++) {   // 폴더 믿기 질문에 답할 시간까지 90초
      await new Promise((r) => setTimeout(r, 500));
      const q = await paneInfo(m.runId!);
      if (!q) break;
      const last = q.screen.split('\n').filter((x) => x.trim()).slice(-6).join('\n');
      if (SHELLS.has(q.cmd) && i > 6 && /command not found: claude|\$ $|% $/.test(last)) break;   // 안 떴거나 꺼졌다
      if (/trust this folder|Do you trust the files/i.test(last + q.screen.slice(-1500))) { if (i % 4 === 0) void pollTmux(m.id); continue; }
      if (!SHELLS.has(q.cmd) && /for shortcuts|mode on|shift\+tab/i.test(last)) { up = true; break; }
    }
    if (!up) { setState(m.id, 'error'); throw new Error('claude did not start in the terminal session. Open it on the Mac to check.'); }
  }
  // 여러 줄도 한 번에: 괄호 붙여넣기(bracketed paste)로 넣고 Enter
  const r = await runShellOn(p.info.machine,
    `printf %s ${shq(text)} | tmux load-buffer -b cxchat - && tmux paste-buffer -p -d -b cxchat -t ${t} && sleep 0.15 && tmux send-keys -t ${t} Enter`, 10000);
  if (!r.ok) throw new Error((r.stderr || r.stdout).trim().slice(0, 200) || 'send failed');
}

/** 키를 하나씩, 사이를 띄워 보낸다(한 번에 몰아 보내면 claude 화면이 못 알아듣는다) */
async function tmuxKeys(m: ChatMeta, keys: string): Promise<boolean> {
  const info = await getRunTermInfo(m.runId!); if (!info) return false;
  const t = shq(info.session);
  const cmd = keys.split(' ').map((k) => `tmux send-keys -t ${t} ${k}`).join(' && sleep 0.25 && ');
  const r = await runShellOn(info.machine, cmd, 8000);
  return r.ok;
}

export async function sendAny(id: string, text: string, cid?: string): Promise<void> {
  const m = getChat(id); if (!m) throw new Error('not found');
  if (cid) {
    const seen = recentCids.get(id) ?? [];
    if (seen.includes(cid)) return;   // 앱이 응답을 못 받고 다시 보낸 것 — 이미 쳤다
    recentCids.set(id, [...seen, cid].slice(-50));
  }
  if (!m.runId) return sendChat(id, text);
  const t = text.trim(); if (!t) throw new Error('empty');
  emit(id, { t: 'user', text: t, ts: Date.now() });
  touch(id, t); setState(id, 'run'); ensurePolling(id);
  await tmuxSend(m, t);
}
export async function answerAny(id: string, askId: string, allow: boolean, note?: string): Promise<boolean> {
  const m = getChat(id); if (!m) return false;
  if (!m.runId) return answerAsk(id, askId, allow, note);
  // claude 승인 화면: 1 = 예, Esc = 아니오. 폴더 믿기 화면은 두 번째 줄이 「예」
  const keys = askId === 'tmux-trust' ? (allow ? 'Down Enter' : 'Escape') : (allow ? '1' : 'Escape');
  const ok = await tmuxKeys(m, keys);
  if (ok) {
    const st = tmuxState.get(id); if (st) st.ask = undefined;   // 같은 질문이 다시 뜨면 새로 알린다
    emit(id, { t: 'answered', id: askId, allow }); setTimeout(() => void pollTmux(id), 600);
  }
  return ok;
}
export async function interruptAny(id: string): Promise<boolean> {
  const m = getChat(id); if (!m) return false;
  return m.runId ? tmuxKeys(m, 'Escape') : interruptChat(id);
}


/**
 * 맥 coxpit 의 열린 세션을 모두 대화 목록에 올린다(넘겨 받기 단계 없이 폰에서 다 보이게).
 * 닫히거나 지워진 세션의 대화는 목록에서 내린다. tmux 를 건드리지 않는다.
 */
let syncing: Promise<void> | null = null;
export function syncSessions(): Promise<void> {
  syncing ??= (async () => {
    try {
      const { tasks } = await import('./db/schema');
      const rows = await db.select().from(agentRuns);
      const ts = await db.select().from(tasks);
      const title = new Map(ts.map((t) => [t.id, t.title]));
      const openTasks = new Set(ts.filter((t) => t.status === 'open').map((t) => t.id));
      const open = rows.filter((r) => r.tmuxWindow && openTasks.has(r.taskId) && !dismissed.has(r.id));
      const openIds = new Set(open.map((r) => r.id));
      for (const r of open) if (!metas.some((m) => m.runId === r.id)) {
        try { await adoptRun(r.id, r.title || title.get(r.taskId) || undefined); } catch { /* 터미널 없음 */ }
      }
      for (const m of [...metas]) if (m.runId && !openIds.has(m.runId)) removeChat(m.id);
    } finally { syncing = null; }
  })();
  return syncing;
}
