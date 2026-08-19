#!/usr/bin/env node
// coxpit CLI — boots the daemon. Ships TS sources and runs them via tsx
// (no build step, no ESM extension rewrites).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

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
  coxpit --version, -v   print version
  coxpit --help, -h      show this help

Configuration is env-only (a .env file in the cwd is loaded):
  COXPIT_HOST            bind host (default 127.0.0.1)
  COXPIT_PORT            bind port (default 8210)
  COXPIT_DB              SQLite (libSQL) file (default ~/.coxpit/coxpit.db)
  COXPIT_AUTH_USER       basic auth user (default admin)
  COXPIT_AUTH_PASS       basic auth password (empty = all requests rejected;
                         set it, or COXPIT_AUTH_DISABLED=1 for local dev)
  COXPIT_AUTH_DISABLED   1 disables auth (local dev only)
  COXPIT_SSH_KEY         private key for remote machines (else ssh defaults/agent)
  COXPIT_AGENT_REAL      1 = real agent CLI by default (credits!)
  COXPIT_AGENT_BIN       agent command (default claude)
  COXPIT_AGENT_PERM      headless permission mode (default acceptEdits)`);
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
