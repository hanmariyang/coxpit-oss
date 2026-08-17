#!/usr/bin/env node
// coxpit CLI — boots the daemon. Ships TS sources and runs them via tsx
// (no build step, no ESM extension rewrites).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, 'src', 'index.ts');

// --import 의 bare 'tsx' 는 사용자 cwd 기준으로 해석돼 npx 실행에서 깨진다 —
// 패키지 루트 기준으로 절대경로 해석해 넘긴다.
const require_ = createRequire(join(root, 'package.json'));
const tsxEntry = pathToFileURL(require_.resolve('tsx')).href;

const child = spawn(process.execPath, ['--import', tsxEntry, entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});
child.on('exit', (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
