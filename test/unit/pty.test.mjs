// pty 수명주기 + fd 회계 — issue #9 회귀 가드.
//
// node-pty 1.1.0 의 macOS(posix_spawn) 경로는 spawn 마다 pty master 를 하나 흘린다.
// src/term.ts 의 spawnPty 래퍼가 그 여분을 닫는데, 그 래퍼가 사라지면 터미널을 열 때마다
// /dev/ptmx 가 하나씩 새고 kern.tty.ptmx_max(맥 기본 511)가 마르는 순간 **모든** spawn 이
// "posix_spawnp failed." 로 죽는다 — 데몬이 조용히 쓸모없어진다(2026-09-10 맥미니 256개 누수).
//
// test/pty-fd.mjs 가 20회로 같은 것을 보지만 이건 npm test 안에서 8회로 빠르게 돈다.
// node-pty 가 안 실려 있으면(리눅스 CI 의 일부 러너 등) 실패가 아니라 이유를 밝히고 skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 하네스 위생 — term.ts → config.ts 가 import 시점에 데이터 폴더를 만든다.
// 물려받은 COXPIT_* 를 지우고 임시 폴더로 못박아 소유자의 ~/.coxpit 를 건드리지 않는다.
for (const k of Object.keys(process.env)) if (k.startsWith('COXPIT_')) delete process.env[k];
process.env.COXPIT_DB = join(mkdtempSync(join(tmpdir(), 'coxpit-unit-pty-')), 'unit.db');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let spawnPty = null;
let loadError = '';
try {
  ({ spawnPty } = await import('../../src/term.ts'));
  // 네이티브 바인딩은 첫 spawn 에서야 로드된다 — 여기서 한 번 태워 본다.
  const probe = spawnPty('sh', ['-c', 'exit 0'], { name: 'xterm', cols: 80, rows: 24, env: process.env });
  probe.onData(() => {});
  await sleep(120);
  try { probe.kill(); } catch { /* 이미 끝남 */ }
} catch (e) {
  spawnPty = null;
  loadError = String(e && e.message ? e.message : e).slice(0, 200);
}
const skip = spawnPty ? false : `node-pty not loadable here: ${loadError}`;

/** 이 프로세스가 붙들고 있는 pty master 수(darwin 전용 계측). */
const ptmx = () =>
  Number(execSync(`lsof -n -p ${process.pid} | grep -c /dev/ptmx || true`).toString().trim()) || 0;

const open = () =>
  spawnPty('sh', ['-c', 'sleep 30'], { name: 'xterm', cols: 80, rows: 24, env: process.env });

test('spawn -> attach -> close leaves the fd count at baseline (issue #9)', { skip }, async () => {
  if (process.platform !== 'darwin') {
    // 리눅스는 forkpty 경로라 해당 누수가 없다 — 그래도 열고 닫히는지는 본다.
    const t = open();
    t.onData(() => {});
    await sleep(120);
    t.kill();
    return;
  }
  const N = 8;
  const baseline = ptmx();
  for (let i = 0; i < N; i++) {
    const t = open();
    t.onData(() => {});
    await sleep(60);
    try { t.kill(); } catch { /* 이미 끝남 */ }
    await sleep(60);
  }
  await sleep(1200); // 자식 종료 + master 회수 여유
  const grew = ptmx() - baseline;
  // 0 이 이상적. 스케줄링 지연으로 1~2 개가 아직 회수 중일 수 있어 소폭만 허용한다.
  assert.ok(grew <= 2, `leaked ~${grew} pty master(s) over ${N} spawns — spawnPty wrapper regressed?`);
});

test('a pty reports its exit, and closing it twice is harmless', { skip }, async () => {
  const t = open();
  t.onData(() => {});
  const exited = new Promise((resolve) => t.onExit((e) => resolve(e)));
  await sleep(80);
  t.kill();
  const e = await Promise.race([exited, sleep(3000).then(() => null)]);
  assert.ok(e, 'pty never reported onExit after kill');

  // 데몬은 WS 핸들러에서 pty 를 닫고 또 쓴다 — 여기서 throw 하면 요청 하나가 통째로 죽는다.
  assert.doesNotThrow(() => { try { t.kill(); } catch (err) { throw err; } });
});

test('writing to a closed pty does not take the daemon down', { skip }, async () => {
  const t = open();
  t.onData(() => {});
  await sleep(80);
  t.kill();
  await sleep(300);
  // 사람이 탭을 닫은 직후 도착한 키 입력 — 조용히 버려져야지 예외가 되면 안 된다.
  assert.doesNotThrow(() => t.write('ls\r'));
});
