// 에이전트 상태 감지 — 터미널 출력 스트림만 읽어 run 하나의 거친 상태를 판별한다.
//   working(바이트가 흐르는 중) · waiting(멎었고 프롬프트 패턴 적중) · idle(멎었고 적중 없음) · exited.
//
// 정직성 규칙(spec v5.28 A6) — 이 모듈의 존재 이유다:
//   · waiting 은 **양성 패턴 적중**이 있어야만 붙는다. 못 맞히면 idle 이다. 추측한 waiting 은 없다.
//   · 모든 전이 뒤에는 실제 스트림 바이트 또는 onExit 가 있다(지어낸 상태 경로 없음).
//   · tail 버퍼는 메모리에만 있고 detach 하면 사라진다 — 보존도, 학습도 하지 않는다.
//
// run 하나에 tracker 하나. /ws/term 은 연결마다 PTY 를 열고 tmux 는 같은 pane 을 붙은 모든
// 클라이언트에 미러링하므로 두 클라이언트가 붙으면 같은 바이트가 두 번 들어온다 →
// attach 레퍼런스 카운트로 tracker 를 공유하고, 타이머도 tracker 당 하나만 둔다.

import { broadcast } from './hub';
import { config } from './config';

export type AgentState = 'unknown' | 'working' | 'waiting' | 'idle' | 'exited';

const ACTIVE_MS = 600;      // 이만큼 새 바이트가 없으면 "멎었다"고 보고 분류한다
const FLAP_MS = 1_500;      // working↔idle 플랩 억제 — idle 은 이만큼 조용해야 확정한다
const TAIL_MAX = 8 * 1024;  // 굴러가는 raw tail (ANSI 제거는 분류 시점에)
const HOOK_COOLDOWN_MS = 60_000;  // run 하나가 웹훅을 때릴 수 있는 최소 간격

interface Pattern { id: string; re: RegExp }

// [!] 휴리스틱이고 provider TUI 화면에 종속적이다. "에이전트의 의도"를 안다고 주장하지 않는다 —
// 말하는 것은 "화면에 입력/승인 프롬프트가 떠 있다" 하나뿐이다. CLI 가 화면을 바꾸면 이 표만
// 고치고, provider 를 늘리는 일은 행을 늘리는 일이다. 확신이 없으면 넣지 않는다:
// 빗나간 idle 은 받아들일 수 있고, 지어낸 waiting 은 받아들일 수 없다.
const PROMPT_PATTERNS: Pattern[] = [
  // claude-code 승인 프롬프트 ("Do you want to proceed?" / "Do you want to make this edit?")
  { id: 'claude/permission', re: /Do you want to [^\n?]{0,80}\?/i },
  // 번호 선택 블록 — claude 승인, codex 승인이 함께 쓰는 모양 ("❯ 1. Yes" / "1. Yes")
  { id: 'agent/numbered-yes', re: /(^|\n)[^\S\n]*[^\w\s]?[^\S\n]*1\.[^\S\n]+Yes\b/ },
  // claude 입력 박스 하단 힌트 — 작업이 끝나고 사람 입력을 기다리는 화면
  { id: 'claude/input-box', re: /\?[^\S\n]+for[^\S\n]+shortcuts/i },
  // codex 승인 질문 ("Allow Codex to run …?")
  { id: 'codex/approval', re: /\b(Allow|Approve) [^\n?]{0,80}\?/i },
];

// 같은 성격의 표 — 이게 (프롬프트보다 나중에) 보이면 에이전트는 아직 일하는 중이다.
const WORKING_PATTERNS: Pattern[] = [
  { id: 'esc-to-interrupt', re: /esc to interrupt/i },
  { id: 'spinner', re: /[⠀-⣿✳✻✽✶✢]/ },  // braille 스피너 + claude 별표 프레임
];

/** ANSI 소독 — CSI(색·커서 이동·지우기)·OSC·2바이트 이스케이프 제거 + CR 정규화(줄 앵커용). */
function stripAnsi(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r\n?/g, '\n');
}

/** 마지막 매치 위치(없으면 -1). 스트림은 그려진 순서라 "더 뒤"가 더 최근이다. */
function lastIndexOfMatch(text: string, re: RegExp): number {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let at = -1;
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) !== null) {
    at = m.index;
    if (m.index === g.lastIndex) g.lastIndex++;  // 빈 매치 무한루프 방지
  }
  return at;
}

/**
 * 멎은 tail 을 보고 상태를 고른다. raw tail 을 받아 **분류 시점에** ANSI 를 벗긴다 —
 * TUI 는 커서 이동·지우기로 다시 그려서 raw 바이트로 매칭하면 프롬프트 문구가 쪼개지고,
 * 청크 경계에서 잘린 이스케이프도 버퍼에 모인 뒤에는 온전하다.
 * 표식이 둘 다 보이면 **뒤에 나온 쪽이 이긴다** — 앞쪽에 남은 'esc to interrupt' 잔해가
 * 지금 막 뜬 프롬프트를 덮어버리지 않도록.
 */
export function classifyIdle(rawTail: string): 'working' | 'waiting' | 'idle' {
  const tail = stripAnsi(rawTail);
  let prompt = -1;
  let working = -1;
  for (const p of PROMPT_PATTERNS) prompt = Math.max(prompt, lastIndexOfMatch(tail, p.re));
  for (const p of WORKING_PATTERNS) working = Math.max(working, lastIndexOfMatch(tail, p.re));
  if (working > prompt) return 'working';  // 스피너/인터럽트 힌트가 더 최근 — 아직 작업 중
  if (prompt >= 0) return 'waiting';
  return 'idle';                           // 적중 없음 = idle. waiting 을 추측하지 않는다.
}

interface Tracker {
  refs: number;                                // 붙어 있는 /ws/term 소켓 수
  state: AgentState;
  since: number;                               // 마지막 전이 시각
  tail: string;                                // raw(ANSI 포함) 꼬리 버퍼
  lastByteAt: number;
  timer: ReturnType<typeof setTimeout> | null;  // tracker 당 정확히 하나
  lastHookAt: number;                          // 웹훅 쿨다운 — tracker 와 함께 살고 함께 죽는다
  spotted: Set<number>;                        // B3 수동 포트 감지 — 출력에서 본 LISTEN 포트(감지만, 행동 없음)
}

// B3: 출력에서 "listening on :PORT" / "http(s)://host:PORT" 만 보수적으로 집는다.
// A2 와 같은 규율 — 못 맞히면 빈손이고, 포트를 지어내지 않는다. 1..65535 만 인정.
const PORT_PATTERNS: RegExp[] = [
  /\blisten(?:ing)?\b[^0-9]{0,20}:(\d{2,5})\b/gi,   // "Listening on :3000", "listening at port 8080" 근처의 :NNNN
  /\bhttps?:\/\/[a-z0-9.\-]+:(\d{2,5})\b/gi,          // http://localhost:3000
  /\b(?:0\.0\.0\.0|127\.0\.0\.1|localhost)\b[^0-9]{0,4}:(\d{2,5})\b/gi,
];

function spotPorts(t: Tracker, chunk: string): void {
  for (const re of PORT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(chunk))) {
      const p = Number(m[1]);
      if (p >= 1 && p <= 65535) t.spotted.add(p);
    }
  }
  // 무한정 쌓지 않는다 — 최근 것 위주로 상한
  if (t.spotted.size > 24) {
    const keep = [...t.spotted].slice(-24);
    t.spotted = new Set(keep);
  }
}

/**
 * 주의 환기의 서버 쪽 절반(spec v5.28 A5) — 코크핏이 아예 닫혀 있을 때 유일하게 남는 신호다.
 * orchestrator 의 notifySettle 과 같은 모양으로 POST 하고, 실패는 무해하게 삼킨다.
 *
 * [!] **상태만 보낸다.** detail 도, tail 조각도 절대 태우지 않는다 — 터미널 출력은 시크릿을
 * 그대로 뱉을 수 있고 웹훅 엔드포인트는 coxpit 의 신뢰 경계 **밖**이다(꼬리는 인증된 /ws 허브에만).
 */
async function postHook(runId: number, state: AgentState): Promise<void> {
  try {
    await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event: 'agentstate',
        runId,
        state,
        // COXPIT_PUBLIC_URL 설정 시 폰에서 탭 → 그 run 으로 바로 착지
        ...(config.publicUrl ? { url: `${config.publicUrl}/?run=${runId}` } : {}),
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* 웹훅 실패는 조용히 */ }
}

/** 사람을 부르는 전이(waiting·exited)에만, run 당 60초에 한 번. 플랩하는 세션이 엔드포인트를 도배하지 못하게. */
function maybeHook(runId: number, t: Tracker, state: AgentState): void {
  if (state !== 'waiting' && state !== 'exited') return;
  if (!config.webhookUrl) return;
  const now = Date.now();
  if (now - t.lastHookAt < HOOK_COOLDOWN_MS) return;
  t.lastHookAt = now;
  void postHook(runId, state);
}

const trackers = new Map<number, Tracker>();

function setState(runId: number, t: Tracker, next: AgentState): void {
  if (t.state === next) return;
  t.state = next;
  t.since = Date.now();
  // 안정된 전이만 허브로 나간다(같은 상태 재지정은 위에서 잘린다).
  // detail 은 이 단계에서 **항상 빈 문자열**이다 — 모양만 먼저 고정하고, tail 에서 뽑는 일은
  // 소독 규칙이 생기는 phase 3 의 몫이다. 터미널 출력은 시크릿을 그대로 뱉을 수 있어서,
  // 규칙 없이 꼬리 조각을 허브에 태우지 않는다.
  broadcast({ type: 'agentstate', runId, state: next, detail: '', ts: t.since });
  maybeHook(runId, t, next);   // 허브가 먼저, 웹훅은 그 다음 — 붙어 있는 화면이 항상 가장 빠르다
}

function clearTimer(t: Tracker): void {
  if (t.timer) { clearTimeout(t.timer); t.timer = null; }
}

function arm(runId: number, t: Tracker, ms: number): void {
  clearTimer(t);
  const h = setTimeout(() => { t.timer = null; onQuiet(runId); }, ms);
  // 데몬 종료를 이 타이머가 붙잡지 않도록 (node 핸들일 때만 — 타입은 런타임에 따라 다르다)
  (h as unknown as { unref?: () => void }).unref?.();
  t.timer = h;
}

/** ACTIVE_MS 동안 새 바이트가 없을 때 — 분류하거나, 아직 이르면 남은 만큼 다시 잰다. */
function onQuiet(runId: number): void {
  const t = trackers.get(runId);
  if (!t || t.state === 'exited') return;
  const quiet = Date.now() - t.lastByteAt;
  if (quiet < ACTIVE_MS) { arm(runId, t, ACTIVE_MS - quiet); return; }  // 사이에 바이트가 들어왔다

  const next = classifyIdle(t.tail);
  // 화면이 아직 작업 중이라고 말한다 — 상태는 working 그대로 두고 타이머를 놓는다.
  // (바이트가 더 안 오면 화면도 안 바뀌므로 다시 재봐야 달라질 것이 없다.)
  if (next === 'working') { setState(runId, t, 'working'); return; }
  // 플랩 억제: working↔idle 이 FLAP_MS 안에서 오가지 않도록 idle 은 충분히 조용해야 확정한다.
  // waiting 은 사람을 부르는 신호라 늦추지 않는다.
  if (next === 'idle' && quiet < FLAP_MS) { arm(runId, t, FLAP_MS - quiet); return; }
  setState(runId, t, next);
}

/** 터미널이 열렸다 — tracker 생성 또는 refcount+1(미러된 두 번째 클라이언트). */
export function attach(runId: number): void {
  const cur = trackers.get(runId);
  if (cur) { cur.refs++; return; }
  trackers.set(runId, { refs: 1, state: 'unknown', since: Date.now(), tail: '', lastByteAt: 0, timer: null, lastHookAt: 0, spotted: new Set() });
}

/** 출력 청크 — tail 에 붙이고 시각을 찍고 working. 미러 중복이 들어와도 해롭지 않다. */
export function feed(runId: number, chunk: string): void {
  const t = trackers.get(runId);
  if (!t || t.state === 'exited') return;
  t.tail += chunk;
  if (t.tail.length > TAIL_MAX) t.tail = t.tail.slice(t.tail.length - TAIL_MAX);
  t.lastByteAt = Date.now();
  spotPorts(t, chunk);   // B3 수동 포트 감지 — 감지만, 행동 없음
  setState(runId, t, 'working');
  arm(runId, t, ACTIVE_MS);
}

/** B3: 이 run 의 출력에서 감지한 LISTEN 포트 목록(감지만; 코크핏이 원클릭 대상으로 제안). */
export function spottedPorts(runId: number): number[] {
  const t = trackers.get(runId);
  return t ? [...t.spotted] : [];
}

/**
 * 사람이 터미널에 입력했다 — waiting 을 즉시 지운다.
 * TUI 는 다시 그리므로 이미 답한 프롬프트 문구가 tail 에 남는다. 입력 신호는 "사람이 응답했다"는
 * 유일한 확실한 근거이고, 핸들러에 이미 들어와 있어 공짜다.
 */
export function input(runId: number): void {
  const t = trackers.get(runId);
  if (!t || t.state === 'exited') return;
  setState(runId, t, 'working');
  arm(runId, t, ACTIVE_MS);  // 곧 재분류
}

/** PTY/tmux pane 프로세스 종료 — 더 분류할 스트림이 없다. */
export function onExit(runId: number): void {
  const t = trackers.get(runId);
  if (!t) return;
  clearTimer(t);
  setState(runId, t, 'exited');
}

/** 소켓 종료 — refcount−1. 0 이면 타이머를 멈추고 tail 을 버리고 tracker 를 지운다(누수 금지). */
export function detach(runId: number): void {
  const t = trackers.get(runId);
  if (!t) return;
  t.refs--;
  if (t.refs > 0) return;
  clearTimer(t);
  t.tail = '';
  trackers.delete(runId);
}

/** 현재 상태(붙어 있는 동안만 존재). phase 2 의 /api/fleet·허브가 여기서 읽는다. */
export function getAgentState(runId: number): { state: AgentState; since: number } | null {
  const t = trackers.get(runId);
  return t ? { state: t.state, since: t.since } : null;
}

/**
 * 지금 살아 있는 상태 전부 — `/api/fleet` 이 이걸로 `agentStates` 를 만든다.
 * 갓 뜬 코크핏·재연결이 다음 델타를 기다리지 않고 현재 상태를 칠할 수 있게 하는 용도다.
 * 맵에는 **터미널이 붙어 있는 run 만** 들어있다(detach 하면 사라진다) — 그게 계약 그대로다.
 * detail 은 허브 메시지와 같은 이유로 아직 빈 문자열이다(phase 3).
 */
export function allAgentStates(): Record<number, { state: AgentState; detail: string; ts: number }> {
  const out: Record<number, { state: AgentState; detail: string; ts: number }> = {};
  for (const [runId, t] of trackers) out[runId] = { state: t.state, detail: '', ts: t.since };
  return out;
}

/** 테스트용 — tracker/타이머가 정말 비었는지 확인하는 창구(타이머 누수는 DoD 항목). */
export function _stats(): { trackers: number; timers: number; refs: number } {
  let timers = 0;
  let refs = 0;
  for (const t of trackers.values()) { if (t.timer) timers++; refs += t.refs; }
  return { trackers: trackers.size, timers, refs };
}
