import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// GUI 앱(Finder/데스크톱)에서 뜨면 PATH 가 최소(/usr/bin:/bin...)라 brew 로 설치한
// 도구(claude·tmux·git)를 못 찾는다 — 표준 설치 경로를 부팅 시 1회 보강한다.
{
  const extra = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    `${process.env.HOME ?? ''}/.local/bin`,
    `${process.env.HOME ?? ''}/.npm-global/bin`,
  ];
  const cur = (process.env.PATH ?? '').split(':').filter(Boolean);
  for (const p of extra) if (p && !p.startsWith('/.') && !cur.includes(p)) cur.push(p);
  process.env.PATH = cur.join(':');
}

// launchd/systemd 데몬은 LANG 미설정(C 로케일)로 뜬다 — 그 상태로 tmux 에 attach 하면
// tmux 가 클라이언트를 UTF-8 불가로 판단해 CJK(한글 등)를 '_'/8진수로 뭉갠다.
// UTF-8 로케일을 부팅 시 1회 보장한다 (COXPIT_LANG 으로 재정의 가능).
{
  const want = process.env.COXPIT_LANG
    ?? (/utf-?8/i.test(process.env.LANG ?? '') ? process.env.LANG! : 'en_US.UTF-8');
  process.env.LANG = want;
  if (process.env.LC_ALL && !/utf-?8/i.test(process.env.LC_ALL)) delete process.env.LC_ALL;
}

// 기본 DB 경로 — npm/dmg 어느 설치든 같은 상태를 보도록 ~/.coxpit 로 통일한다.
// 구버전(cwd 상대 ./coxpit.db)로 쌓아온 사용자는 그 파일이 존재하는 한 그대로 존중.
function defaultDbPath(): string {
  const legacy = path.resolve('./coxpit.db');
  if (fs.existsSync(legacy)) {
    console.log(`[coxpit] using legacy database at ${legacy} (move it to ~/.coxpit/coxpit.db to adopt the shared default)`);
    return legacy;
  }
  const dir = path.join(os.homedir(), '.coxpit');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'coxpit.db');
}

const dbPath = process.env.COXPIT_DB || defaultDbPath();
const settingsPath = path.join(path.dirname(path.resolve(dbPath)), 'settings.json');

// 영속 설정(settings.json)을 인라인으로 읽는다(순환 import 회피 — settings.ts 는 config 를 import).
// 병합 우선순위: 명시 env > settings.json > 기본값.
interface StoredSettings {
  port?: number; portStrict?: boolean; host?: string; webhookUrl?: string; publicUrl?: string;
  agent?: { provider?: string; model?: string; count?: number; real?: boolean };
}
const stored: StoredSettings = (() => {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
})();
const env = process.env;
const num = (v: unknown): number | undefined => {
  const n = Number(v); return Number.isFinite(n) ? n : undefined;
};

// 버전 SSOT = package.json (하드코딩 문자열 이중화 방지)
const pkgVersion: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/** 런타임 설정. 시크릿은 전부 env 주입(번들 0). */
export const config = {
  version: pkgVersion,
  // UTF-8 보장된 로케일 — PTY/원격 셸에 명시 전달용
  lang: process.env.LANG!,
  host: env.COXPIT_HOST ?? stored.host ?? '127.0.0.1',
  // 선호 포트(env > settings > 8210). 점유 시 index.ts 가 자동 이동(portStrict 면 실패).
  port: num(env.COXPIT_PORT) ?? stored.port ?? 8210,
  // 포트 점유 시 자동 이동 대신 실패(리버스 프록시 등 고정 포트가 필수인 경우).
  portStrict: env.COXPIT_PORT_STRICT === '1' || (env.COXPIT_PORT_STRICT == null && stored.portStrict === true),
  dbPath,
  settingsPath,
  // 단일 데몬 락 파일 — DB 와 같은 폴더(그 DB 를 지키는 락이므로)
  lockPath: path.join(path.dirname(path.resolve(dbPath)), 'daemon.lock.json'),
  // 원격 머신 SSH 개인키 경로(선택). 없으면 ssh 기본 키/에이전트 사용.
  sshKey: process.env.COXPIT_SSH_KEY ?? '',
  // run 정착 시 POST 할 웹훅(선택) — 텔레그램 브릿지 등 사용자 연결용.
  webhookUrl: env.COXPIT_WEBHOOK_URL ?? stored.webhookUrl ?? '',
  // 웹훅 payload 의 딥링크 base(선택) — 설정 시 url: <base>/?run=<id> 포함 (폰에서 탭 → 그 run)
  publicUrl: (env.COXPIT_PUBLIC_URL ?? stored.publicUrl ?? '').replace(/\/+$/, ''),
  agent: {
    // 기본 드라이런(모의 에이전트). 실제 CLI 실행은 켤 때만(크레딧 소모).
    real: env.COXPIT_AGENT_REAL != null ? env.COXPIT_AGENT_REAL === '1' : (stored.agent?.real ?? false),
    bin: process.env.COXPIT_AGENT_BIN ?? 'claude',
    // 격리 worktree에서 헤드리스 실행 권한: acceptEdits(파일편집 자동허용) 기본.
    // 완전 자율은 bypassPermissions.
    perm: process.env.COXPIT_AGENT_PERM ?? 'acceptEdits',
    // 보드 기본값(런처 초기 상태) — settings 로만, run 발사 시 클라이언트가 실제 값 전달.
    provider: stored.agent?.provider ?? 'claude-code',
    model: stored.agent?.model ?? '',
    count: stored.agent?.count ?? 1,
  },
  // 어떤 값이 env 로 고정됐는가 — Settings UI 가 잠금 표시(파일로 못 바꿈).
  envLocked: {
    port: env.COXPIT_PORT != null,
    host: env.COXPIT_HOST != null,
    webhookUrl: env.COXPIT_WEBHOOK_URL != null,
    publicUrl: env.COXPIT_PUBLIC_URL != null,
    real: env.COXPIT_AGENT_REAL != null,
    authDisabled: env.COXPIT_AUTH_DISABLED === '1',
    authPass: env.COXPIT_AUTH_PASS != null && env.COXPIT_AUTH_PASS !== '',
  },
  // 에이전트 셀프 오케스트레이션 — real+로컬 run 에 COXPIT_API/COXPIT_TOKEN env 와
  // 능력 고지를 준다(에이전트가 /api/agent/subtasks 로 서브런 발사). '0' 으로 끔.
  agentOrch: process.env.COXPIT_AGENT_ORCH !== '0',
  codex: {
    // 두 번째 프로바이더 — OpenAI Codex CLI (선택 설치). providers.ts 의 시임.
    bin: process.env.COXPIT_CODEX_BIN ?? 'codex',
    // workspace-write = acceptEdits 상응(워크스페이스 안 편집 자동허용).
    // 완전 자율은 danger-full-access.
    sandbox: process.env.COXPIT_CODEX_SANDBOX ?? 'workspace-write',
  },
  auth: {
    disabled: process.env.COXPIT_AUTH_DISABLED === '1',
    user: process.env.COXPIT_AUTH_USER ?? 'admin',
    pass: process.env.COXPIT_AUTH_PASS ?? '',
  },
} as const;
