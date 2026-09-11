#!/usr/bin/env node
// coxpit CLI — boots the daemon. Ships TS sources and runs them via tsx
// (no build step, no ESM extension rewrites).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import http from 'node:http';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, 'src', 'index.ts');

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`coxpit — self-hosted cockpit for a fleet of AI coding agents

Usage:
  coxpit                 start the daemon (board at http://<host>:<port>)
  coxpit reset-key       forget the stored access key (next boot = first-run setup)
  coxpit --version, -v   print version
  coxpit --help, -h      show this help

Dispatch orchestration to a project (from your workspace terminal):
  coxpit ls                             list projects + active runs
  coxpit fan <project> "<goal>" [opts]  launch agent runs on <project>
       -n N          number of parallel runs (1-8, default 1)
       --real        run the real agent (spends credits; default is dry rehearsal)
       --agent X     claude-code | codex     --model M   model override
  coxpit ps                             list active runs
  coxpit steer <run> "<message>"        send follow-up to a running agent
  coxpit add <path>                     register a git repo as a project
  The target is always named per command (no sticky default). Talks to the local
  daemon via its lock file; set COXPIT_KEY (or COXPIT_AUTH_PASS) if auth is on.

Access-key auth:
  On first boot with no key, open the board to set an access key (a one-time
  setup token is printed to the log — needed unless you visit http://127.0.0.1
  directly). After that you unlock once per device via the branded page (no
  username). To change or clear the key, run "coxpit reset-key" and restart, or
  delete ~/.coxpit/auth.json. Precedence: COXPIT_AUTH_DISABLED > COXPIT_AUTH_PASS
  env (back-compat, key-only) > stored key > first-run setup.

Configuration is env-only (a .env file in the cwd is loaded):
  COXPIT_HOST            bind host (default 127.0.0.1)
  COXPIT_PORT            bind port (default 8210)
  COXPIT_DB              SQLite (libSQL) file (default ~/.coxpit/coxpit.db)
  COXPIT_AUTH_PASS       access key (empty = stored key / first-run setup;
                         env-mode is back-compat, entered on the branded page)
  COXPIT_AUTH_DISABLED   1 disables auth (delegate to a front gateway)
  COXPIT_SSH_KEY         private key for remote machines (else ssh defaults/agent)
  COXPIT_AGENT_REAL      1 = real agent CLI by default (credits!)
  COXPIT_AGENT_BIN       agent command (default claude)
  COXPIT_AGENT_PERM      headless permission mode (default acceptEdits)`);
  process.exit(0);
}

// reset-key — 저장된 접근키(auth.json)를 지운다. 다음 부팅은 다시 첫 실행 셋업.
// auth.json 은 DB 와 같은 폴더에 산다(COXPIT_DB 존중, 기본 ~/.coxpit).
if (args[0] === 'reset-key') {
  const dbEnv = process.env.COXPIT_DB;
  const dir = dbEnv ? dirname(resolve(dbEnv)) : join(homedir(), '.coxpit');
  const authPath = join(dir, 'auth.json');
  if (existsSync(authPath)) {
    rmSync(authPath);
    console.log(`[coxpit] removed ${authPath} — next boot is first-run setup (set a new access key).`);
  } else {
    console.log(`[coxpit] no stored key at ${authPath} (nothing to reset).`);
  }
  process.exit(0);
}

// ── Orchestration from the terminal — dispatch to the local daemon ──────────
// The session is your workspace command post; you name the target project per
// command (no sticky default — the target is always visible in what you typed).
// Reuses the same API the board uses; loopback is still key-gated, so we auth
// with COXPIT_KEY / COXPIT_AUTH_PASS when the daemon requires it.
const SUBCMDS = new Set(['ls', 'projects', 'fan', 'run', 'ps', 'steer', 'add']);
if (SUBCMDS.has(args[0])) {
  const dbEnv = process.env.COXPIT_DB;
  const dir = dbEnv ? dirname(resolve(dbEnv)) : join(homedir(), '.coxpit');
  const lockPath = join(dir, 'daemon.lock.json');

  const die = (msg) => { console.error('coxpit: ' + msg); process.exit(1); };
  let port;
  try {
    const lk = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (!Number.isInteger(lk?.port)) throw new Error('no port');
    port = lk.port;
  } catch {
    die('no running daemon (lock not found at ' + lockPath + ') — start it with "coxpit".');
  }
  const key = process.env.COXPIT_KEY || process.env.COXPIT_AUTH_PASS || '';
  const authHeaders = key ? { authorization: 'Basic ' + Buffer.from('coxpit:' + key).toString('base64') } : {};

  const api = (method, path, body) => new Promise((res, rej) => {
    const data = body != null ? JSON.stringify(body) : null;
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...authHeaders, ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (r) => { let b = ''; r.on('data', (d) => b += d); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch { /* non-json */ } res({ status: r.statusCode, json: j, raw: b }); }); },
    );
    req.on('error', rej); if (data) req.write(data); req.end();
  });
  const guard = (r) => {
    if (r.status === 401) die('daemon requires an access key — set COXPIT_KEY (or COXPIT_AUTH_PASS) to your key.');
    if (r.status >= 400) die((r.json && r.json.error) || ('HTTP ' + r.status));
    return r;
  };
  const num = (flag, def) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] != null ? Number(args[i + 1]) : def; };
  const str = (flag, def) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] != null ? args[i + 1] : def; };
  const has = (flag) => args.includes(flag);
  // positional args = everything that isn't a flag or a flag's value
  const positionals = () => {
    const flagsWithVal = new Set(['-n', '--count', '--agent', '--model']);
    const out = []; for (let i = 1; i < args.length; i++) { const a = args[i]; if (a.startsWith('-')) { if (flagsWithVal.has(a)) i++; continue; } out.push(a); }
    return out;
  };
  const realRepos = async () => (guard(await api('GET', '/api/fleet?view=all')).json.repos || []).filter((r) => r.kind !== 'sessions');
  const matchRepo = (repos, name) => {
    const n = String(name || '').toLowerCase();
    let hit = repos.filter((r) => r.name.toLowerCase() === n);
    if (!hit.length) hit = repos.filter((r) => r.name.toLowerCase().startsWith(n));
    if (!hit.length) hit = repos.filter((r) => r.name.toLowerCase().includes(n));
    return hit;
  };

  (async () => {
    const cmd = args[0];
    if (cmd === 'ls' || cmd === 'projects') {
      const fleet = guard(await api('GET', '/api/fleet?view=all')).json;
      const repos = (fleet.repos || []).filter((r) => r.kind !== 'sessions');
      const runs = fleet.runs || [];
      if (!repos.length) { console.log('no projects registered — "coxpit add <path>" or register one in the board.'); process.exit(0); }
      const active = (repoId) => runs.filter((r) => { const t = (fleet.tasks || []).find((x) => x.id === r.taskId); return t && t.repoId === repoId && (r.status === 'running' || r.status === 'pending'); }).length;
      const w = Math.max(...repos.map((r) => r.name.length), 7);
      for (const r of repos) { const a = active(r.id); console.log('  ' + r.name.padEnd(w) + '  ' + (a ? a + ' running' : 'idle')); }
      process.exit(0);
    }
    if (cmd === 'ps') {
      const fleet = guard(await api('GET', '/api/fleet?view=all')).json;
      const repoName = Object.fromEntries((fleet.repos || []).map((r) => [r.id, r.name]));
      const taskById = Object.fromEntries((fleet.tasks || []).map((t) => [t.id, t]));
      const live = (fleet.runs || []).filter((r) => r.status === 'running' || r.status === 'pending');
      if (!live.length) { console.log('no active runs.'); process.exit(0); }
      for (const r of live) { const t = taskById[r.taskId]; const rn = t ? repoName[t.repoId] : '?'; console.log('  r' + r.id + '  ' + r.status.padEnd(8) + '  ' + (rn || '?') + '  ' + (t ? t.title : '').slice(0, 50)); }
      process.exit(0);
    }
    if (cmd === 'add') {
      const p = positionals()[0]; if (!p) die('usage: coxpit add <path>');
      const abs = resolve(p);
      const r = guard(await api('POST', '/api/repos', { machineSlug: 'local', path: abs }));
      console.log('registered ' + (r.json.repo ? r.json.repo.name : abs));
      process.exit(0);
    }
    if (cmd === 'steer') {
      const pos = positionals(); const rid = String(pos[0] || '').replace(/^r/, ''); const msg = pos.slice(1).join(' ');
      if (!rid || !msg) die('usage: coxpit steer <run> "<message>"');
      guard(await api('POST', '/api/runs/' + Number(rid) + '/steer', { message: msg }));
      console.log('steered r' + rid);
      process.exit(0);
    }
    if (cmd === 'fan' || cmd === 'run') {
      const pos = positionals();
      const project = pos[0]; const goal = pos.slice(1).join(' ');
      if (!project || !goal) die('usage: coxpit fan <project> "<goal>" [-n N] [--real] [--agent claude-code|codex] [--model M]');
      const repos = await realRepos();
      const hit = matchRepo(repos, project);
      if (!hit.length) die('no project matches "' + project + '" — try "coxpit ls".');
      if (hit.length > 1) die('"' + project + '" is ambiguous: ' + hit.map((r) => r.name).join(', '));
      const repo = hit[0];
      const count = Math.max(1, Math.min(8, num('-n', num('--count', 1)) || 1));
      const real = has('--real');
      const agent = str('--agent', undefined);
      const model = str('--model', undefined);
      const task = guard(await api('POST', '/api/tasks', { repoId: repo.id, title: goal.slice(0, 140), prompt: goal })).json.task;
      const body = { count, real }; if (agent) body.agent = agent; if (model) body.model = model;
      const runs = guard(await api('POST', '/api/tasks/' + task.id + '/run', body)).json.runs || [];
      console.log('▶ ' + repo.name + ' · ' + count + (count === 1 ? ' run' : ' runs') + (real ? ' (real)' : ' (dry)') + ' · ' + runs.map((r) => 'r' + r.id).join(' '));
      console.log('  watch: coxpit ps  ·  compare/merge in the board/cockpit Review');
      process.exit(0);
    }
  })().catch((e) => die(String(e && e.message || e)));
}

// 서브커맨드는 위 async IIFE 가 처리하고 스스로 exit 한다 — 데몬 기동으로 fall through 하면 안 됨
// (async 라 동기 흐름이 여기까지 내려오므로 명시 가드).
if (!SUBCMDS.has(args[0])) {
  // --import 의 bare 'tsx' 는 사용자 cwd 기준으로 해석돼 npx 실행에서 깨진다 —
  // 패키지 루트 기준으로 절대경로 해석해 넘긴다.
  const require_ = createRequire(join(root, 'package.json'));
  const tsxEntry = pathToFileURL(require_.resolve('tsx')).href;

  const child = spawn(process.execPath, ['--import', tsxEntry, entry, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
}
