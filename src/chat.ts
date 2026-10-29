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
import { getRunTermInfo, getSessionChat, openSessionAt } from './orchestrator';

export type ChatState = 'idle' | 'run' | 'ask' | 'error';
export type PermMode = 'default' | 'acceptEdits' | 'auto' | 'plan';
const MODES: PermMode[] = ['default', 'acceptEdits', 'auto', 'plan'];

export interface ChatMeta {
  id: string; title: string; cwd: string; sid: string; model: string; mode: PermMode;
  created: number; updated: number; last: string;
  /** tmux 모드: coxpit 세션(run) 안의 바로 그 claude 에 붙는다. 맥 화면과 폰이 같은 대화를 본다 */
  runId?: number;
}
export interface Turn { role: 'user' | 'assistant'; text: string; tools?: ToolUse[]; ts?: number }
export interface ToolUse { name: string; summary: string }
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
}

const IDLE_MS = 30 * 60 * 1000;
const storePath = (): string => path.join(path.dirname(path.resolve(process.env.COXPIT_DB || path.join(os.homedir(), '.coxpit', 'coxpit.db'))), 'chats.json');

let metas: ChatMeta[] = load();
const lives = new Map<string, Live>();

function load(): ChatMeta[] {
  try { const j = JSON.parse(fs.readFileSync(storePath(), 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; }
}
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
  return { ...m, state: l?.state ?? 'idle', current: l?.current ?? '', asks: l ? [...l.asks.values()] : [] };
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
  l.state = s; emit(id, { t: 'state', state: s, current: l.current }); announce(id);
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

export function updateChat(id: string, patch: { title?: string; mode?: string; model?: string }): ChatMeta {
  const m = getChat(id); if (!m) throw new Error('not found');
  if (patch.title != null) m.title = patch.title.trim() || m.title;
  if (patch.model != null) m.model = patch.model.trim();
  if (patch.mode != null && MODES.includes(patch.mode as PermMode)) {
    m.mode = patch.mode as PermMode;
    const l = lives.get(id);
    if (l?.proc) control(id, { subtype: 'set_permission_mode', mode: m.mode });
  }
  save(); announce(id);
  return m;
}

/** 대화 기록 — claude 의 jsonl 이 정본. 세션이 아직 없으면 빈 목록. */
export function readTurns(m: ChatMeta, max = 300, hint?: string[]): Turn[] {
  if (!m.sid) return [];
  const f = findTranscript(m.sid); if (!f) return [];
  let raw = '';
  try {
    const st = fs.statSync(f); const fd = fs.openSync(f, 'r');
    const len = Math.min(st.size, 4_000_000); const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd); raw = buf.toString('utf8');
  } catch { return []; }
  // 대본은 가지를 칠 수 있다(같은 대화를 두 곳에서 이어 쓰면). 마지막 줄에서 parentUuid 를 거슬러
  // 지금 이어지는 갈래만 남긴다 — 맥 화면의 claude 가 보는 것과 같게.
  type Row = { type?: string; uuid?: string; parentUuid?: string | null; timestamp?: string; isMeta?: boolean; isSidechain?: boolean; message?: { content?: unknown } };
  const rows: Row[] = [];
  for (const line of raw.split('\n')) { if (!line.trim()) continue; try { rows.push(JSON.parse(line)); } catch { /* 잘린 첫 줄 */ } }
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
    if (j.type === 'user' && !j.isMeta) {
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n') : '';
      if (text.trim() && !text.startsWith('<')) turns.push({ role: 'user', text, ts });
    } else if (j.type === 'assistant' && Array.isArray(c)) {
      const text = c.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
      const tools = c.filter((b) => b?.type === 'tool_use').map((b) => ({ name: b.name, summary: summarize(b.name, b.input) }));
      const prev = turns[turns.length - 1];
      // 한 답이 여러 줄(도구 → 글 → 도구)로 나뉘어 적히므로, 사람이 말하기 전까지는 하나로 묶는다
      if (prev && prev.role === 'assistant') {
        if (text.trim()) prev.text = prev.text ? prev.text + '\n\n' + text : text;
        if (tools.length) prev.tools = [...(prev.tools ?? []), ...tools];
        if (ts) prev.ts = ts;
      } else if (text.trim() || tools.length) turns.push({ role: 'assistant', text, tools, ts });
    }
  }
  return turns.slice(-max);
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

function findTranscript(sid: string): string | null {
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
  const l = lives.get(id);
  return { chat: summary(m), turns: readTurns(m, 300, m.runId ? tmuxHint.get(id) : undefined), partial: l?.partial ?? '', tools: l?.tools ?? [] };
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
const tmuxState = new Map<string, { screen: string; mtime: number; ask?: Ask; polling?: boolean }>();
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
    const cur = [...lines.slice(-12)].reverse().find((l) => /^[\s]*[⏺●✻✶✳✢·*]\s/.test(l)) ?? '';
    return { state: 'run', current: cur.replace(/^[\s⏺●✻✶✳✢·*]+/, '').slice(0, 160) };
  }
  return { state: 'idle', current: '' };
}

async function tmuxSid(m: ChatMeta): Promise<string> {
  const rr = await db.select().from(agentRuns).where(eq(agentRuns.id, m.runId!)).limit(1);
  let sid = rr[0]?.claudeSessionId ?? '';
  if (!sid || !findTranscript(sid)) {
    await getSessionChat(m.runId!, 1);   // 화면으로 실제 대본을 찾아 run 에 적어 둔다
    const r2 = await db.select().from(agentRuns).where(eq(agentRuns.id, m.runId!)).limit(1);
    sid = r2[0]?.claudeSessionId ?? '';
    if (!sid || !findTranscript(sid)) sid = latestInFolder(rr[0]?.worktreePath || m.cwd) ?? '';
  }
  if (sid && sid !== m.sid) { m.sid = sid; save(); }
  return sid;
}

async function pollTmux(id: string): Promise<void> {
  const m = getChat(id); if (!m?.runId) return;
  const st = tmuxState.get(id) ?? { screen: '', mtime: 0 }; tmuxState.set(id, st);
  const p = await paneInfo(m.runId);
  if (!p) { setState(id, 'error'); return; }
  const c = classify(p.screen);
  const hints = screenHints(p.screen); if (hints.length) tmuxHint.set(id, hints);
  const l = live(id);
  l.current = c.current;
  const prevAsk = st.ask?.id;
  st.ask = c.ask;
  l.asks = new Map(c.ask ? [[c.ask.id, c.ask]] : []);
  if (c.ask && c.ask.id !== prevAsk) emit(id, { t: 'ask', ask: c.ask });
  if (!c.ask && prevAsk) emit(id, { t: 'answered', id: prevAsk, allow: true });
  setState(id, c.state);
  if (c.state === 'run') emit(id, { t: 'state', state: 'run', current: l.current });
  // 대본이 바뀌었으면 기록을 통째로 다시 보낸다(앱은 갈아 끼운다)
  const sid = await tmuxSid(m);
  const f = sid ? findTranscript(sid) : null;
  const mt = f ? fs.statSync(f).mtimeMs : 0;
  const hintKey = (tmuxHint.get(id) ?? []).join('|');
  if (mt && (mt !== st.mtime || hintKey !== (st as { hk?: string }).hk)) {
    (st as { hk?: string }).hk = hintKey;
    st.mtime = mt;
    const turns = readTurns(m, 300, tmuxHint.get(id));
    const lastA = [...turns].reverse().find((t) => t.role === 'assistant' && t.text.trim());
    if (lastA) { m.last = lastA.text.replace(/\s+/g, ' ').slice(0, 200); }
    m.updated = Math.max(m.updated, mt); save();
    emit(id, { t: 'turns', turns }); announce(id);
  }
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
export function startTmuxWatch(): void { for (const m of metas) if (m.runId) ensurePolling(m.id); }

export async function adoptRun(runId: number, title?: string): Promise<ChatMeta> {
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
  if (ex && (await getRunTermInfo(ex.id))) return adoptRun(ex.id, title || path.basename(dir));
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

export async function sendAny(id: string, text: string): Promise<void> {
  const m = getChat(id); if (!m) throw new Error('not found');
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
