import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { config } from '../config';
import * as schema from './schema';

// libSQL(NAPI 프리빌드 = 노드버전 무관). 로컬 파일 모드.
const client = createClient({ url: `file:${config.dbPath}` });

export const db = drizzle(client, { schema });

/** 스키마 부트스트랩(멱등). 정식 마이그레이션은 drizzle-kit(추후). */
export async function ensureSchema(): Promise<void> {
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
  `);
  // 기존 DB 마이그레이션(멱등)
  try { await client.execute('ALTER TABLE tasks ADD COLUMN design_capture_id INTEGER'); } catch { /* exists */ }
  try { await client.execute("ALTER TABLE agent_runs ADD COLUMN session_id TEXT NOT NULL DEFAULT ''"); } catch { /* exists */ }
}
