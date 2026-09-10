// pty master fd 누수 회귀 테스트 (issue #9).
//   node-pty 1.1.0 의 macOS posix_spawn 경로는 spawn 마다 pty master 를 하나 흘린다.
//   src/term.ts 의 spawnPty 래퍼가 그 여분 master 를 닫는다 — 여기서 그게 유지되는지 검증.
//   20회 spawn+kill 후 이 프로세스의 /dev/ptmx fd 수가 baseline 으로 돌아오면 통과.
//
// darwin 전용(리눅스는 forkpty 라 누수 없음) — 다른 OS 에선 skip(성공)한다.
// 실행: node --import tsx test/pty-fd.mjs
import { execSync } from 'node:child_process';

if (process.platform !== 'darwin') {
  console.log('pty-fd: skip (darwin-only; Linux uses forkpty, not affected)');
  process.exit(0);
}

const { spawnPty } = await import('../src/term.ts');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ptmx = () => Number(execSync(`lsof -n -p ${process.pid} | grep -c /dev/ptmx || true`).toString().trim()) || 0;

const N = 20;
const baseline = ptmx();
console.log(`pty-fd: baseline /dev/ptmx = ${baseline}`);

for (let i = 0; i < N; i++) {
  const t = spawnPty('sh', ['-c', 'sleep 30'], { name: 'xterm', cols: 80, rows: 24, env: process.env });
  t.onData(() => {});
  await sleep(60);
  try { t.kill(); } catch { /* already gone */ }
  await sleep(60);
}
await sleep(1500); // 자식 종료 + master 회수 여유

const after = ptmx();
const grew = after - baseline;
console.log(`pty-fd: after ${N}x spawn/kill /dev/ptmx = ${after} (grew ${grew})`);

// 완벽히 0 이 이상적. 스케줄링 지연으로 1~2 개가 아직 회수 중일 수 있어 소폭 허용.
if (grew > 2) {
  console.error(`pty-fd: FAIL — leaked ~${grew} pty master(s) over ${N} spawns (spawnPty wrapper regressed?)`);
  process.exit(1);
}
console.log('pty-fd: OK — no pty master leak');
process.exit(0);
