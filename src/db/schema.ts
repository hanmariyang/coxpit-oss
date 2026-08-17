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

/** 하나의 요청. 여러 AgentRun 으로 병렬 시도됨. */
export const tasks = sqliteTable('tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  repoId: integer('repo_id').notNull(),
  title: text('title').notNull(),
  prompt: text('prompt').notNull().default(''),
  status: text('status').notNull().default('open'), // open | done
  designCaptureId: integer('design_capture_id'), // 선택 — 프롬프트에 DESIGN CONTEXT 주입
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
