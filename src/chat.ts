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

export type ChatState = 'idle' | 'run' | 'ask' | 'error';
export type PermMode = 'default' | 'acceptEdits' | 'auto' | 'plan';
const MODES: PermMode[] = ['default', 'acceptEdits', 'auto', 'plan'];

export interface ChatMeta {
  id: string; title: string; cwd: string; sid: string; model: string; mode: PermMode;
  created: number; updated: number; last: string;
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
export function readTurns(m: ChatMeta, max = 300): Turn[] {
  if (!m.sid) return [];
  const f = findTranscript(m.sid); if (!f) return [];
  let raw = '';
  try {
    const st = fs.statSync(f); const fd = fs.openSync(f, 'r');
    const len = Math.min(st.size, 4_000_000); const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd); raw = buf.toString('utf8');
  } catch { return []; }
  const turns: Turn[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let j: { type?: string; timestamp?: string; isMeta?: boolean; message?: { content?: unknown } };
    try { j = JSON.parse(line); } catch { continue; }
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
  return { chat: summary(m), turns: readTurns(m), partial: l?.partial ?? '', tools: l?.tools ?? [] };
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
