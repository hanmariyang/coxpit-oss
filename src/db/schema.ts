import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

/** 접근 대상 머신. address 빈값 = 로컬(데몬이 도는 머신), 그 외 = 원격(ssh). */
export const machines = sqliteTable('machines', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  address: text('address').notNull().default(''), // tailscale/LAN host; '' = local
  sshUser: text('ssh_user').notNull().default(''),
  kind: text('kind').notNull().default('local'), // local | remote
  online: integer('online', { mode: 'boolean' }).notNull().default(false),
  lastSeen: integer('last_seen', { mode: 'timestamp' }),
});

/** 머신 위의 git 저장소. */
export const repos = sqliteTable('repos', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  machineId: integer('machine_id').notNull(),
  path: text('path').notNull(),
  name: text('name').notNull(),
  defaultBranch: text('default_branch').notNull().default('main'),
});

/** Design Mode 캡처 — 북마클릿 인스펙터가 보낸 UI 요소 컨텍스트. */
export const designCaptures = sqliteTable('design_captures', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  url: text('url').notNull().default(''),
  selector: text('selector').notNull().default(''),
  html: text('html').notNull().default(''),
  css: text('css').notNull().default(''),
  note: text('note').notNull().default(''),
  createdAt: integer('created_at', { mode: 'timestamp' }),
});

/** 태스크 그룹 — 한 goal(plan fan-out)·한 swarm(에이전트 서브태스크)에서 난 형제들. */
export const taskGroups = sqliteTable('task_groups', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind').notNull().default('goal'), // 'goal' | 'swarm'
  title: text('title').notNull(),
  coordSessionId: text('coord_session_id').notNull().default(''), // L2 — 읽기전용 Ask 코디네이터의 재개 세션(--resume 키)
  createdAt: integer('created_at', { mode: 'timestamp' }),
});

/** 하나의 요청. 여러 AgentRun 으로 병렬 시도됨. */
export const tasks = sqliteTable('tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  repoId: integer('repo_id').notNull(),
  title: text('title').notNull(),
  prompt: text('prompt').notNull().default(''),
  status: text('status').notNull().default('open'), // open | done
  designCaptureId: integer('design_capture_id'), // 선택 — 프롬프트에 DESIGN CONTEXT 주입
  parentRunId: integer('parent_run_id'), // 에이전트 셀프 오케스트레이션 — 이 태스크를 발사한 run
  groupId: integer('group_id'), // task_groups — goal/swarm 형제 묶음(수동 태스크는 NULL)
  closedAt: integer('closed_at', { mode: 'timestamp' }), // 닫힌 시각(아카이브 정렬·표시)
  createdAt: integer('created_at', { mode: 'timestamp' }),
});

/** 정착·정리 시점에 회수한 문서(md/html) 스냅샷 — worktree 소멸 후에도 렌더 뷰 유지. */
export const docSnapshots = sqliteTable('doc_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: integer('run_id').notNull(),
  path: text('path').notNull(),
  kind: text('kind').notNull(), // 'md' | 'html'
  content: text('content').notNull().default(''),
  createdAt: integer('created_at', { mode: 'timestamp' }),
});

/** 읽기 전용 공유 링크 — run 스냅샷을 무인증으로 보여준다(토큰 = capability). */
export const shareLinks = sqliteTable('share_links', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: integer('run_id').notNull(),
  token: text('token').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' }),
});

/** 에이전트 1 = worktree 1 = tmux 창 1 = 브랜치 1. 태스크의 한 병렬 시도. */
export const agentRuns = sqliteTable('agent_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  taskId: integer('task_id').notNull(),
  machineId: integer('machine_id').notNull(),
  agent: text('agent').notNull().default('claude-code'),
  worktreePath: text('worktree_path').notNull().default(''),
  branch: text('branch').notNull().default(''),
  tmuxWindow: text('tmux_window').notNull().default(''),
  status: text('status').notNull().default('pending'), // pending | running | waiting | done | error
  sessionId: text('session_id').notNull().default(''), // 에이전트 세션(steer 용 --resume 키)
  prUrl: text('pr_url').notNull().default(''), // PR 모드로 올린 pull request URL
  model: text('model').notNull().default(''), // 런치별 모델 지정(빈값 = CLI 기본)
  filesChanged: integer('files_changed').notNull().default(0),
  startedAt: integer('started_at', { mode: 'timestamp' }),
  endedAt: integer('ended_at', { mode: 'timestamp' }),
  exitSummary: text('exit_summary').notNull().default(''),
});

/** 감사·재생용 이벤트(라이브는 WebSocket). */
export const agentEvents = sqliteTable('agent_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: integer('run_id').notNull(),
  kind: text('kind').notNull(), // output | status | diff | prompt
  payload: text('payload').notNull().default(''),
  ts: integer('ts', { mode: 'timestamp' }),
});
