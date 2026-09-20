import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { config } from '../config';
import * as schema from './schema';

// libSQL(NAPI 프리빌드 = 노드버전 무관). 로컬 파일 모드.
const client = createClient({ url: `file:${config.dbPath}` });

export const db = drizzle(client, { schema });

/**
 * 저널 모드 — 로컬 파일 DB 에서만 의미가 있다. WAL 이면 보드 하이드레이션(읽기)이
 * 이벤트 적재(쓰기)를 막지 않고, synchronous=NORMAL 이면 이벤트 INSERT 마다 fsync 를
 * 기다리지 않는다(크래시 시 최근 몇 이벤트 손실 가능 — 감사 로그라 감수한다).
 * 원격 libSQL URL 은 PRAGMA 를 받지 않을 수 있어 **최선노력**이다: 실패해도 부트는 계속된다.
 */
async function applyPragmas(): Promise<void> {
  try { await client.execute('PRAGMA journal_mode=WAL'); } catch { /* 원격/미지원 */ }
  try { await client.execute('PRAGMA synchronous=NORMAL'); } catch { /* 원격/미지원 */ }
}

/** 스키마 부트스트랩(멱등). 정식 마이그레이션은 drizzle-kit(추후). */
export async function ensureSchema(): Promise<void> {
  await applyPragmas();
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS machines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      address TEXT NOT NULL DEFAULT '',
      ssh_user TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'local',
      online INTEGER NOT NULL DEFAULT 0,
      last_seen INTEGER
    );
    CREATE TABLE IF NOT EXISTS repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id INTEGER NOT NULL,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main'
    );
    CREATE TABLE IF NOT EXISTS design_captures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL DEFAULT '',
      selector TEXT NOT NULL DEFAULT '',
      html TEXT NOT NULL DEFAULT '',
      css TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      design_capture_id INTEGER,
      outputs TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      machine_id INTEGER NOT NULL,
      agent TEXT NOT NULL DEFAULT 'claude-code',
      worktree_path TEXT NOT NULL DEFAULT '',
      branch TEXT NOT NULL DEFAULT '',
      tmux_window TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      session_id TEXT NOT NULL DEFAULT '',
      pr_url TEXT NOT NULL DEFAULT '',
      files_changed INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER,
      ended_at INTEGER,
      exit_summary TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS agent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '',
      ts INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS share_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS doc_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      path TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS task_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL DEFAULT 'goal',
      title TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS secrets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL DEFAULT '',
      created_at INTEGER DEFAULT (unixepoch())
    );
  `);
  // 기존 DB 마이그레이션(멱등)
  try { await client.execute('ALTER TABLE tasks ADD COLUMN design_capture_id INTEGER'); } catch { /* exists */ }
  try { await client.execute("ALTER TABLE agent_runs ADD COLUMN session_id TEXT NOT NULL DEFAULT ''"); } catch { /* exists */ }
  try { await client.execute("ALTER TABLE agent_runs ADD COLUMN pr_url TEXT NOT NULL DEFAULT ''"); } catch { /* exists */ }
  try { await client.execute('ALTER TABLE tasks ADD COLUMN parent_run_id INTEGER'); } catch { /* exists */ }
  try { await client.execute("ALTER TABLE agent_runs ADD COLUMN model TEXT NOT NULL DEFAULT ''"); } catch { /* exists */ }
  try { await client.execute('ALTER TABLE tasks ADD COLUMN group_id INTEGER'); } catch { /* exists */ }
  try { await client.execute('ALTER TABLE tasks ADD COLUMN closed_at INTEGER'); } catch { /* exists */ }
  try { await client.execute("ALTER TABLE task_groups ADD COLUMN coord_session_id TEXT NOT NULL DEFAULT ''"); } catch { /* exists */ }
  try { await client.execute("ALTER TABLE tasks ADD COLUMN outputs TEXT NOT NULL DEFAULT '[]'"); } catch { /* exists */ }
  try { await client.execute('ALTER TABLE agent_runs ADD COLUMN agent_pid INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }
  try { await client.execute('ALTER TABLE agent_runs ADD COLUMN log_offset INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }
  try { await client.execute("ALTER TABLE repos ADD COLUMN verify_cmd TEXT NOT NULL DEFAULT ''"); } catch { /* exists */ }
  try { await client.execute("ALTER TABLE agent_runs ADD COLUMN verify_status TEXT NOT NULL DEFAULT ''"); } catch { /* exists */ }
  try { await client.execute("ALTER TABLE agent_runs ADD COLUMN verify_output TEXT NOT NULL DEFAULT ''"); } catch { /* exists */ }
  try { await client.execute("ALTER TABLE repos ADD COLUMN kind TEXT NOT NULL DEFAULT 'git'"); } catch { /* exists */ }
  try { await client.execute("ALTER TABLE agent_runs ADD COLUMN title TEXT NOT NULL DEFAULT ''"); } catch { /* exists */ }
  try { await client.execute('ALTER TABLE agent_runs ADD COLUMN in_place INTEGER NOT NULL DEFAULT 0'); } catch { /* exists */ }
  try { await client.execute("ALTER TABLE agent_runs ADD COLUMN claude_session_id TEXT NOT NULL DEFAULT ''"); } catch { /* exists */ }
  // DEFAULT 1 = 기존 run 은 real 로 남는다. 모르는 과거를 dry 로 칠하지 않기 위한 기본값이다(v5.28 H1).
  try { await client.execute('ALTER TABLE agent_runs ADD COLUMN real INTEGER NOT NULL DEFAULT 1'); } catch { /* exists */ }
  // 조인 키 인덱스(멱등) — 없으면 이 여섯 조회가 매번 테이블 전체를 훑는다.
  // ALTER 뒤에 두는 건 의도다: tasks.parent_run_id 는 위에서 붙는 컬럼이다.
  try { await client.execute('CREATE INDEX IF NOT EXISTS idx_events_run ON agent_events(run_id)'); } catch { /* exists */ }
  try { await client.execute('CREATE INDEX IF NOT EXISTS idx_runs_task ON agent_runs(task_id)'); } catch { /* exists */ }
  try { await client.execute('CREATE INDEX IF NOT EXISTS idx_tasks_repo ON tasks(repo_id)'); } catch { /* exists */ }
  try { await client.execute('CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_run_id)'); } catch { /* exists */ }
  try { await client.execute('CREATE INDEX IF NOT EXISTS idx_docsnap_run ON doc_snapshots(run_id)'); } catch { /* exists */ }
  try { await client.execute('CREATE INDEX IF NOT EXISTS idx_sharelinks_run ON share_links(run_id)'); } catch { /* exists */ }
}
