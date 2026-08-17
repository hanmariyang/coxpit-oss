import 'dotenv/config';

/** 런타임 설정. 시크릿은 전부 env 주입(번들 0). */
export const config = {
  host: process.env.COXPIT_HOST ?? '127.0.0.1',
  port: Number(process.env.COXPIT_PORT ?? 8210),
  dbPath: process.env.COXPIT_DB ?? './coxpit.db',
  // 원격 머신 SSH 개인키 경로(선택). 없으면 ssh 기본 키/에이전트 사용.
  sshKey: process.env.COXPIT_SSH_KEY ?? '',
  agent: {
    // 기본 드라이런(모의 에이전트). 실제 CLI 실행은 켤 때만(크레딧 소모).
    real: process.env.COXPIT_AGENT_REAL === '1',
    bin: process.env.COXPIT_AGENT_BIN ?? 'claude',
    // 격리 worktree에서 헤드리스 실행 권한: acceptEdits(파일편집 자동허용) 기본.
    // 완전 자율은 bypassPermissions.
    perm: process.env.COXPIT_AGENT_PERM ?? 'acceptEdits',
  },
  auth: {
    disabled: process.env.COXPIT_AUTH_DISABLED === '1',
    user: process.env.COXPIT_AUTH_USER ?? 'admin',
    pass: process.env.COXPIT_AUTH_PASS ?? '',
  },
} as const;
