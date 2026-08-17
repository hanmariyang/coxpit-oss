#!/usr/bin/env node
// coxpit CLI — boots the daemon. Ships TS sources and runs them via tsx
// (no build step, no ESM extension rewrites).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, 'src', 'index.ts');

const child = spawn(process.execPath, ['--import', 'tsx', entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
