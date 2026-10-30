/**
 * claude 터미널 화면에서 「입력을 기다리는 질문」을 가려내고, 앱이 고른 답을 키 순서로 바꾼다.
 *
 * 질문 모양은 셋이다.
 *  - choice: AskUserQuestion(객관식 · 체크리스트 · 여러 질문). 화면에 떠 있는 질문 하나를 읽는다.
 *    대본은 믿지 않는다: 질문 셋짜리가 답을 받기 전까지 대본에 안 적힌 적이 있다(10/30).
 *  - menu: 번호 줄이 있고 커서(❯)가 그 위에 있는 화면. 계획 승인(「Would you like to proceed?」) · 답 확인 화면 등.
 *  - keys: 막혀 있는데 위 둘이 아닌 것. 화면 끝을 그대로 보여 주고 앱이 키를 누른다(비상구).
 *
 * 키 순서는 claude 2.1.314 에서 직접 눌러 맞췄다(10/30).
 *  - 하나 고르기: 숫자 하나 → 고르고 다음 질문으로(질문이 하나뿐이면 바로 제출).
 *  - 여럿 고르기: 숫자 = 체크 켜고 끄기(커서는 안 움직인다). 커서는 1번에서 시작,
 *    ↓ n번 = 「Type something」, ↓ n+1번 = 「Next / Submit」, 거기서 엔터.
 *  - 직접 입력: 하나 고르기는 숫자 n+1 로 그 줄에 간 뒤 글 · 엔터. 여럿 고르기는 ↓ n번 뒤 글(치면 체크된다).
 *  - 질문이 둘 이상이거나 여럿 고르기면 끝에 「Review your answers · Ready to submit」 화면 → 1.
 *  - 다른 질문으로: ← → (탭 줄).
 */

export interface QOption { label: string; description?: string }
export interface MenuOption { n: number; label: string }

export type ScreenAsk =
  | ({ kind: 'choice' } & ChoiceScreen)
  | { kind: 'menu'; title: string; body: string; options: MenuOption[] }
  | { kind: 'keys'; screen: string };

const OPT = /^\s*(?:❯\s*)?(\d{1,2})\.\s+(.+?)\s*$/;
const RULE = /^\s*[─━▔▁╌]{8,}\s*$/;

/** 화면이 AskUserQuestion 을 띄우고 있나(답 확인 화면은 menu 로 따로 잡힌다) */
export function isChoiceScreen(tail: string): boolean {
  return /Chat about this/.test(tail) && /Type something|\n\s*\d+\.\s/.test(tail) && /Enter to select/i.test(tail);
}

export interface ChoiceScreen {
  /** 질문이 여럿이거나 여럿 고르기면 탭 줄이 있다. done = 답을 고른 것(☒) */
  tabs: Array<{ label: string; done: boolean }>;
  question: string;
  multiSelect: boolean;
  options: Array<QOption & { checked?: boolean }>;
  /** 「Type something」 줄에 이미 친 글 */
  typed?: string;
  /** 커서 줄(1부터): 선택지 1..n, 직접 입력 n+1, Next/Submit n+2. 숫자 키는 커서를 안 옮긴다 */
  cursor: number;
}

/**
 * 지금 화면에 떠 있는 질문 하나를 읽는다. 내용은 대본이 아니라 화면에서 읽는다
 * — 대본에는 답을 받은 뒤에야 적히는 때가 있다(질문 셋짜리가 50초 넘게 안 적혔다, 10/30).
 */
export function parseChoice(screen: string): ChoiceScreen | null {
  const lines = screen.split('\n').map((l) => l.replace(/\s+$/, ''));
  // 아래에서 「Chat about this」 위의 구분선을 찾고, 그 위가 질문 몸통
  let chat = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^\s*\d+\.\s+Chat about this/.test(lines[i]!)) { chat = i; break; }
  if (chat < 0) return null;
  let end = chat - 1;
  while (end >= 0 && !RULE.test(lines[end]!)) end--;
  // 위로: 탭 줄(← … →) 또는 머리 줄( ☐ 머리) 까지
  let head = -1;
  for (let i = end - 1; i >= 0 && i > end - 80; i--) {
    if (/^\s*←\s.*→\s*$/.test(lines[i]!) || /^\s*[☐☒✔]\s+\S/.test(lines[i]!)) { head = i; break; }
    if (RULE.test(lines[i]!)) break;
  }
  if (head < 0) return null;
  const tabs: ChoiceScreen['tabs'] = [];
  const hl = lines[head]!;
  if (/←/.test(hl)) {
    for (const m of hl.replace(/^\s*←|→\s*$/g, '').matchAll(/([☐☒])\s+(.+?)(?=\s{2,}|$)/g)) tabs.push({ label: m[2]!.trim(), done: m[1] === '☒' });
  } else {
    const m = /^\s*([☐☒✔])\s+(.+)$/.exec(hl); if (m) tabs.push({ label: m[2]!.trim(), done: m[1] === '☒' });
  }
  const body = lines.slice(head + 1, end).filter((l) => l.trim());
  const qLines: string[] = [];
  let i = 0;
  while (i < body.length && !OPT.test(body[i]!)) qLines.push(body[i++]!.trim());
  const opts: Array<QOption & { checked?: boolean }> = [];
  let multi = false, cursor = 1;
  for (; i < body.length; i++) {
    const m = OPT.exec(body[i]!);
    if (/^\s*❯\s*(Next|Submit)\s*$/.test(body[i]!)) cursor = opts.length + 1;
    if (m) {
      if (/^\s*❯/.test(body[i]!)) cursor = opts.length + 1;
      const box = /^\[( |✔)\]\s+(.*)$/.exec(m[2]!);
      if (box) multi = true;
      opts.push({ label: (box ? box[2]! : m[2]!).trim(), checked: box ? box[1] === '✔' : undefined });
    } else if (opts.length && /^\s{4,}\S/.test(body[i]!) && !/^\s*(Next|Submit)\s*$/.test(body[i]!)) {
      const o = opts[opts.length - 1]!; o.description = ((o.description ? o.description + ' ' : '') + body[i]!.trim());
    }
  }
  if (opts.length < 2) return null;
  // 마지막 번호 줄은 「Type something」(직접 입력) 줄이다
  const other = opts.pop()!;
  const typed = /^Type something\.?$/.test(other.label) ? undefined : other.label;
  return { tabs, question: qLines.join(' '), multiSelect: multi, options: opts, typed, cursor };
}

/** 탭 줄 원문(색 코드 포함, capture-pane -e)에서 지금 질문 번호. 배경색이 칠해진 칸이 지금 것 */
export function currentTab(escLine: string): number {
  const parts = escLine.split(/(?=\x1b\[48;5;\d+m)/);
  if (parts.length < 2) return 0;
  const before = parts[0]!.replace(/\x1b\[[0-9;]*m/g, '');
  return (before.match(/[☐☒]/g) ?? []).length;
}

/** 번호 메뉴: 화면 끝 번호 줄 묶음(1부터 이어진 것) 가운데 하나에 커서가 있어야 한다 */
export function parseMenu(lines: string[]): { title: string; body: string; options: MenuOption[] } | null {
  // 아래에서 위로: 마지막 번호 줄부터 1번까지 거슬러 올라간다. 사이의 들여 쓴 줄(설명)은 건너뛴다
  let i = lines.length - 1;
  while (i >= 0 && !OPT.test(lines[i]!)) i--;
  if (i < 0) return null;
  const found: Array<{ i: number; n: number; label: string; cursor: boolean }> = [];
  let want = Number(OPT.exec(lines[i]!)![1]);
  for (; i >= 0; i--) {
    const m = OPT.exec(lines[i]!);
    if (m && Number(m[1]) === want) {
      found.unshift({ i, n: want, label: m[2]!, cursor: /^\s*❯/.test(lines[i]!) });
      if (want === 1) break;
      want--;
      continue;
    }
    if (m) return null;                                  // 번호가 끊겼다
    if (RULE.test(lines[i]!) || /^\s{3,}\S/.test(lines[i]!)) continue;   // 설명 · 구분선
    return null;                                         // 1번에 닿기 전에 다른 글
  }
  if (found.length < 2 || found[0]!.n !== 1 || !found.some((f) => f.cursor)) return null;
  // 제목: 1번 위의 첫 글 줄. 본문: 그 위로 실선(─ · ▔)이 나올 때까지
  let t = found[0]!.i - 1;
  while (t >= 0 && (RULE.test(lines[t]!) || !lines[t]!.trim())) t--;
  const title = t >= 0 ? clean(lines[t]!) : '';
  const body: string[] = [];
  let b0 = t - 1;
  while (b0 >= 0 && (RULE.test(lines[b0]!) || !lines[b0]!.trim())) b0--;   // 제목 바로 위 구분선(계획 상자 아래 테두리)은 넘는다
  for (let b = b0; b >= 0 && body.length < 40; b--) {
    const l = lines[b]!;
    if (/^\s*[─━▔]{8,}\s*$/.test(l)) break;
    if (/^\s*❯\s/.test(l)) break;                         // 내가 친 말 = 질문 화면 밖
    if (/^\s*[╌]{8,}\s*$/.test(l) || !l.trim()) continue;
    body.unshift(clean(l));
  }
  return { title, body: body.join('\n').slice(-2000), options: found.map((f) => ({ n: f.n, label: clean(f.label) })) };
}

function clean(l: string): string {
  return l.replace(/^[\s│╭╰╮╯]+|[\s│╭╰╮╯]+$/g, '');
}

/** classify 가 trust · 「Do you want to」 를 본 뒤에 부른다. 막힌 화면이 아니면 null */
export function screenAsk(screen: string, blocked: boolean): ScreenAsk | null {
  const lines = screen.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
  const tail = lines.slice(-40);
  const tailS = tail.join('\n');
  if (/esc to interrupt/i.test(tail.slice(-8).join('\n'))) return null;   // 일하는 중
  if (isChoiceScreen(tailS)) { const c = parseChoice(lines.slice(-60).join('\n')); if (c) return { kind: 'choice', ...c }; }
  const menu = parseMenu(tail.filter((l) => !/^\s*(Enter to|ctrl\+g|Esc to|shift\+tab to approve)/i.test(l)));
  if (menu) return { kind: 'menu', ...menu };
  if (blocked) return { kind: 'keys', screen: lines.slice(-20).join('\n') };
  return null;
}

export interface ChoiceAnswer { picks?: number[]; text?: string }
/** tmux 한 걸음: 키 하나(send-keys) 또는 글(send-keys -l) */
export type Step = { key: string } | { lit: string };

/**
 * 지금 질문 하나에 대한 답 → 키 순서. picks 는 0부터.
 * 여럿 고르기는 화면의 체크 상태(checked)에서 출발해 바뀌어야 할 것만 누른다.
 */
export function choiceSteps(q: { multiSelect: boolean; options: Array<{ checked?: boolean }>; cursor?: number }, a: ChoiceAnswer): Step[] {
  const s: Step[] = [];
  const n = q.options.length;
  const picks = [...new Set((a.picks ?? []).filter((p) => Number.isInteger(p) && p >= 0 && p < n))];
  const text = (a.text ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!q.multiSelect) {
    if (text) return [{ key: String(n + 1) }, { lit: text }, { key: 'Enter' }];
    if (picks.length) return [{ key: String(picks[0]! + 1) }];
    return [];
  }
  q.options.forEach((o, i) => { if (!!o.checked !== picks.includes(i)) s.push({ key: String(i + 1) }); });
  // 커서는 화면에서 읽은 줄에서 필요한 만큼만 옮긴다(↑ ↓ 는 끝에서 반대쪽으로 돌아간다 — 많이 누르면 「거절」에 닿는다)
  let at = q.cursor ?? 1;
  const go = (to: number) => { while (at < to) { s.push({ key: 'Down' }); at++; } while (at > to) { s.push({ key: 'Up' }); at--; } };
  if (text) { go(n + 1); s.push({ lit: text }); }
  go(n + 2);
  s.push({ key: 'Enter' });
  return s;
}

/** 키가 안 먹었을 때: 질문을 닫고(Esc) 글로 보낼 답 */
export function choiceText(q: { question: string; options: QOption[] }, a: ChoiceAnswer): string {
  const picked = (a.picks ?? []).map((p) => q.options[p]?.label).filter(Boolean) as string[];
  if (a.text?.trim()) picked.push(a.text.trim());
  return `- ${q.question} → ${picked.length ? picked.join(', ') : '(답 안 함)'}`;
}

/** 앱 키패드가 보낼 수 있는 키(그 밖은 받지 않는다) */
export const PAD_KEYS = new Set(['Escape', 'Enter', 'Tab', 'BTab', 'Up', 'Down', 'Left', 'Right', 'Space', 'BSpace',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
