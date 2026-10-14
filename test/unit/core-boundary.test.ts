// 커널의 유일한 규칙을 지키는 테스트 — src/core/ 는 바깥을 import 하지 않는다.
//
// 이 규칙이 깨지는 순간 커널은 이 제품의 일부가 되고, 다른 제품으로 가져갈 수 없어진다.
// 규칙을 문서에만 적어 두면 어기는 줄도 모르고 어기므로 여기서 기계로 막는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const coreDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/core');

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** import/export ... from '<여기>' 의 '<여기>' 만 뽑는다. */
function specifiers(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+'([^']+)'/g)) out.push(m[1]);
  for (const m of src.matchAll(/import\s*\(\s*'([^']+)'\s*\)/g)) out.push(m[1]);
  return out;
}

test('core imports nothing above itself', () => {
  const files = filesUnder(coreDir);
  assert.ok(files.length >= 6, `expected the kernel files, found ${files.length}`);
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const spec of specifiers(src)) {
      if (spec.startsWith('node:')) continue;        // 표준 모듈
      if (!spec.startsWith('.')) continue;           // 패키지 (node-pty)
      const target = resolve(dirname(file), spec);
      const rel = relative(coreDir, target);
      assert.ok(
        !rel.startsWith('..'),
        `${relative(coreDir, file)} reaches outside the kernel: '${spec}'. ` +
        'Settings and services arrive as parameters, never as imports.',
      );
    }
  }
});

test('the kernel does not reach for the product config', () => {
  for (const file of filesUnder(coreDir)) {
    const src = readFileSync(file, 'utf8');
    assert.ok(!/from '\.\.\/config'/.test(src), `${file} imports the product config`);
    assert.ok(!/from '\.\.\/db/.test(src), `${file} imports the product database`);
  }
});
