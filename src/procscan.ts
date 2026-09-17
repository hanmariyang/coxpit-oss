// 무엇이 지금 듣고 있고, 언제 시작했나 (spec v5.28 B) — 리스너 조사기.
//
// 하루의 고리는 이렇다: 에이전트가 코드를 고치고, 터미널에서 서버를 다시 띄우고, 확인한다.
// 덫은 **옛 프로세스가 포트를 그대로 물고 있는 것**이다(재시작이 실패했거나, 다른 페인에서
// 돌고 있거나, 새 것이 뜨다 죽고 옛 것만 살아남았거나). 그러면 새 코드를 옛 프로세스에 대고
// 디버깅하며 한 시간을 버린다.
//
// 자세(spec B4) — **증거를 보이고, 판정하지 않는다.** coxpit 은 "네가 의도한 빌드"를 알 수 없다.
// 알 수 있는 것은 싸고 정직한 사실뿐이다: 어떤 pid 가 어느 포트를 LISTEN 하고 있고(lsof),
// 얼마나 오래 떠 있었고(ps etime), 그 프로세스의 cwd/exec 가 이 페인 폴더 아래인가(underPane).
// **stale 이라는 판정은 이 파일 어디에도 없다.** 사람이 "3시간 전 시작"과 "2분 전 수정"을 나란히
// 보고 스스로 결론 내린다.
//
// 읽기 전용이고 싸다 — lsof 한 번 + ps 두 번(포맷 분리) + cwd lsof 한 번을, 원격이면 ssh 왕복
// **한 번**에 몰아 넣는다. du 도, 재귀도 없다. lsof 가 없는 머신은 **깨끗한 빈 결과 + note** 다
// (던지지 않는다 — 조사기가 터지면 조사할 수 없다).

import { runShellOn, shq, type MachineTarget } from './exec';

export interface Listener {
  pid: number;
  command: string;     // ps comm (실행 파일 이름)
  args: string;        // exec + 첫 인자까지만, 시크릿 소독(clipArgs)
  port: number;
  etime: string;       // ps etime — 시계 동기 가정 없는 정직한 "언제부터"
  underPane: boolean;  // cwd(또는 exec)가 이 페인 폴더 아래인가. 못 읽으면 false(행을 버리지 않는다)
  machineId: string;   // 머신 slug — 종료는 언제나 이 머신 하나에만 간다
}

export interface ScanResult {
  listeners: Listener[];
  note: string;        // 빈 결과의 이유(예: lsof 없음). 정상이면 ''
}

const CACHE_MS = 5_000;  // 같은 (머신, 범위) 를 연달아 열어도 다시 포크하지 않는다

interface CacheEntry { at: number; res: ScanResult }
const cache = new Map<string, CacheEntry>();

/** 시크릿이 실릴 만한 토큰은 값을 지운다 — 인자에 토큰을 그대로 붙여 띄우는 습관이 흔하다. */
const SECRETISH = /^(-{0,2}[\w.-]*(?:key|token|secret|password|passwd|pass|pwd|auth|cred)[\w.-]*)=.*/i;

/**
 * argv 를 **exec + 첫 인자**까지만 남긴다(rail detail 소독기와 같은 규율).
 * 전체 argv 는 절대 표면에 내지 않는다 — 거기에 토큰이 실려 있을 수 있고, 이 패널은
 * "무엇이 듣고 있나"를 답하는 자리이지 명령줄을 읽는 자리가 아니다.
 */
export function clipArgs(raw: string): string {
  const parts = raw.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  const safe = parts.map((p) => p.replace(SECRETISH, '$1=***'));
  let out = safe.join(' ');
  if (out.length > 120) out = out.slice(0, 117) + '...';
  return out;
}

/** `#L`/`#S`/`#A`/`#C` 마커로 구간을 나눈 한 방 스크립트. selector 로 포트를 좁힐 수 있다. */
function scanScript(selector: string): string {
  return [
    `command -v lsof >/dev/null 2>&1 || { echo '#NOLSOF'; exit 0; }`,
    `L=$(lsof -nP -i${selector} -sTCP:LISTEN -Fpcn 2>/dev/null)`,
    `echo '#L'`,
    `printf '%s\\n' "$L"`,
    `P=$(printf '%s\\n' "$L" | sed -n 's/^p//p' | sort -u | tr '\\n' ',' | sed 's/,$//')`,
    `echo '#S'`,
    `[ -n "$P" ] && ps -o pid=,etime=,comm= -p "$P" 2>/dev/null`,
    `echo '#A'`,
    `[ -n "$P" ] && ps -o pid=,args= -p "$P" 2>/dev/null`,
    `echo '#C'`,
    `[ -n "$P" ] && lsof -a -p "$P" -d cwd -Fpn 2>/dev/null`,
    `echo '#E'`,
    `exit 0`,
  ].join('\n');
}

/** 마커로 잘라 구간별 줄 묶음으로. 없는 구간은 빈 배열. */
function sections(out: string): Record<string, string[]> {
  const secs: Record<string, string[]> = { L: [], S: [], A: [], C: [] };
  let cur = '';
  for (const line of out.split('\n')) {
    if (line === '#L' || line === '#S' || line === '#A' || line === '#C') { cur = line.slice(1); continue; }
    if (line === '#E') { cur = ''; continue; }
    if (cur && line !== '') secs[cur]!.push(line);
  }
  return secs;
}

/** lsof 이름 필드(`127.0.0.1:8210` · `[::1]:8210` · `*:8210`) 끝의 포트. 숫자가 아니면 null. */
function portOf(name: string): number | null {
  const at = name.lastIndexOf(':');
  if (at < 0) return null;
  const n = Number(name.slice(at + 1).trim());
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

/** 경로 p 가 base 아래(또는 같은 곳)인가 — 문자열 비교. 심링크까지 풀지 않는 best-effort. */
function under(p: string, base: string): boolean {
  if (!p || !base) return false;
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  return p === b || p.startsWith(b + '/');
}

function parseScan(stdout: string, machineId: string, pwd: string): ScanResult {
  if (stdout.includes('#NOLSOF')) {
    // 최소 리눅스 이미지엔 lsof 가 없다. 거짓말 대신 이유를 한 줄로 말하고 빈손으로 돌아온다.
    return { listeners: [], note: 'lsof not found on this machine — install lsof to inspect listeners' };
  }
  const secs = sections(stdout);

  // ── lsof -Fpcn: p<pid> / c<command> 뒤에 그 프로세스의 n<이름> 들이 따른다
  const found: Array<{ pid: number; command: string; port: number }> = [];
  const seen = new Set<string>();
  let pid = 0;
  let comm = '';
  for (const line of secs.L!) {
    const tag = line[0];
    const val = line.slice(1);
    if (tag === 'p') { pid = Number(val) || 0; comm = ''; continue; }
    if (tag === 'c') { comm = val; continue; }
    if (tag === 'n' && pid) {
      const port = portOf(val);
      if (port == null) continue;
      const key = pid + ':' + port;
      if (seen.has(key)) continue;   // v4/v6 두 줄로 잡히는 같은 소켓은 한 행으로
      seen.add(key);
      found.push({ pid, command: comm, port });
    }
  }

  // ── ps -o pid=,etime=,comm= → etime 은 공백이 없고, comm 은 줄 끝까지(경로에 공백이 있어도 안전)
  const etime = new Map<number, string>();
  const commOf = new Map<number, string>();
  for (const line of secs.S!) {
    // comm 이 비는 드문 경우에도 etime 은 건진다 — 세 번째 칸은 선택이다
    const m = /^\s*(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    etime.set(Number(m[1]), m[2]!);
    commOf.set(Number(m[1]), (m[3] ?? '').trim());
  }
  // ── ps -o pid=,args= → args 도 줄 끝까지. 표면에 나가기 전에 반드시 clipArgs 를 거친다
  const argsOf = new Map<number, string>();
  for (const line of secs.A!) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    argsOf.set(Number(m[1]), (m[2] ?? '').trim());
  }
  // ── lsof -d cwd -Fpn → 프로세스의 현재 폴더. 권한이 없어 못 읽으면 그냥 없는 채로 간다
  const cwdOf = new Map<number, string>();
  let cp = 0;
  for (const line of secs.C!) {
    if (line[0] === 'p') { cp = Number(line.slice(1)) || 0; continue; }
    if (line[0] === 'n' && cp) cwdOf.set(cp, line.slice(1));
  }

  const listeners: Listener[] = found.map((f) => {
    const rawArgs = argsOf.get(f.pid) ?? '';
    const exec = rawArgs.split(/\s+/)[0] ?? '';
    const cwd = cwdOf.get(f.pid) ?? '';
    return {
      pid: f.pid,
      command: (commOf.get(f.pid) || f.command || '').split('/').pop() || f.command,
      args: clipArgs(rawArgs),
      port: f.port,
      etime: etime.get(f.pid) ?? '',
      // cwd 를 못 읽었으면 플래그 없이 **행은 그대로 낸다** — 떨어뜨리는 쪽이 더 나쁜 거짓말이다
      underPane: !!pwd && (under(cwd, pwd) || under(exec, pwd)),
      machineId,
    };
  });
  listeners.sort((a, b) => a.port - b.port || a.pid - b.pid);
  return { listeners, note: '' };
}

async function scan(m: MachineTarget, selector: string, scope: string, pwd: string): Promise<ScanResult> {
  // 캐시는 (머신, 범위) 별. underPane 은 pwd 에 딸린 값이라 pwd 도 키에 든다 —
  // 같은 머신이라도 페인이 다르면 답이 다르다.
  const key = `${m.slug}|${scope}|${pwd}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.res;
  const r = await runShellOn(m, scanScript(selector), 15000);
  // 셸이 실패해도(원격 도달 불가 등) 던지지 않는다 — 이유를 한 줄로 실어 빈손으로 돌아온다.
  const res = r.ok || r.stdout.includes('#L')
    ? parseScan(r.stdout, m.slug, pwd)
    : { listeners: [], note: (r.stderr || '').trim().slice(0, 200) || `could not run lsof on ${m.slug}` };
  cache.set(key, { at: Date.now(), res });
  return res;
}

/**
 * 이 머신에서 LISTEN 중인 것 전부. `pwd` 를 주면 그 폴더 아래인 것에 underPane 이 붙는다
 * (페인의 살아있는 pwd — §D-fix 의 getRunPwd).
 */
export function scanListeners(m: MachineTarget, opts?: { pwd?: string }): Promise<ScanResult> {
  return scan(m, 'TCP', 'all', (opts?.pwd ?? '').trim());
}

/** 포트 하나를 겨눈 조회 — "8210 은 누가 물고 있나". 같은 파서, 더 좁은 lsof. */
export function scanPort(m: MachineTarget, port: number): Promise<ScanResult> {
  const p = Math.floor(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    return Promise.resolve({ listeners: [], note: 'port must be 1..65535' });
  }
  return scan(m, `TCP:${p}`, `port:${p}`, '');
}

/** 종료 후에는 캐시가 거짓말이 된다 — 그 머신 것만 버린다(다시 훑어야 행이 사라진다). */
export function dropCache(slug: string): void {
  for (const k of [...cache.keys()]) if (k.startsWith(slug + '|')) cache.delete(k);
}

/**
 * 고른 pid 하나에 TERM → 유예 → KILL. **이 머신에서만.**
 * 목록 검증(pid 1 거부·데몬 자신 거부·다시 훑은 목록에 없으면 거부)은 서버 라우트가 한다 —
 * 이 함수는 사람이 이미 고른 pid 를 정확히 그것만 종료한다.
 */
export async function killPid(m: MachineTarget, pid: number): Promise<{ ok: boolean; gone: boolean; signal: string; detail: string }> {
  const p = Math.floor(pid);
  if (!Number.isInteger(p) || p <= 1) return { ok: false, gone: false, signal: '', detail: 'refused: pid must be > 1' };
  const q = shq(String(p));
  // 0.3 초를 못 재는 sleep 이면 1초로 — 유예는 짧아야 하지만 없으면 안 된다
  const nap = `sleep 0.3 2>/dev/null || sleep 1`;
  const cmd = [
    `kill -TERM ${q} 2>/dev/null || true`,
    `i=0; while [ $i -lt 6 ]; do kill -0 ${q} 2>/dev/null || { echo 'GONE TERM'; exit 0; }; ${nap}; i=$((i+1)); done`,
    `kill -KILL ${q} 2>/dev/null || true`,
    nap,
    `kill -0 ${q} 2>/dev/null && echo 'ALIVE KILL' || echo 'GONE KILL'`,
  ].join('\n');
  const r = await runShellOn(m, cmd, 15000);
  dropCache(m.slug);
  const out = (r.stdout || '').trim().split('\n').pop() ?? '';
  const gone = out.startsWith('GONE');
  const signal = out.endsWith('TERM') ? 'TERM' : out.endsWith('KILL') ? 'KILL' : '';
  return {
    ok: gone,
    gone,
    signal,
    detail: gone
      ? `pid ${p} gone (${signal})`
      : (out ? `pid ${p} survived SIGKILL` : `could not signal pid ${p} on ${m.slug}`),
  };
}
