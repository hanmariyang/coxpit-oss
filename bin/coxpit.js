#!/usr/bin/env node
// coxpit CLI — boots the daemon. Ships TS sources and runs them via tsx
// (no build step, no ESM extension rewrites).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, existsSync, rmSync } from 'node:fs';

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

// --import 의 bare 'tsx' 는 사용자 cwd 기준으로 해석돼 npx 실행에서 깨진다 —
// 패키지 루트 기준으로 절대경로 해석해 넘긴다.
const require_ = createRequire(join(root, 'package.json'));
const tsxEntry = pathToFileURL(require_.resolve('tsx')).href;

const child = spawn(process.execPath, ['--import', tsxEntry, entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
