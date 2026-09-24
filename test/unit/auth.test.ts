// 인증 게이트 판정 — issue #11 회귀 가드.
//
// e2e.sh 가 같은 규칙을 HTTP 로 이미 확인하지만(데몬 4번 재기동, 수십 초), 그건 규칙이
// 깨졌을 때 **느리게** 빨개진다. 여기서는 데몬도 포트도 없이 판정 함수만 찔러 밀리초에 잡는다.
//
// 하네스 위생: 물려받은 COXPIT_* 를 전부 지우고 COXPIT_DB 를 임시 폴더로 못박은 뒤에 import 한다.
// src/auth.ts → authkey.ts → config.ts 사슬이 import 시점에 데이터 폴더를 만들기 때문에,
// 이걸 빠뜨리면 이 테스트가 소유자의 실제 ~/.coxpit 를 건드린다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = process.env as Record<string, string | undefined>;
for (const k of Object.keys(env)) if (k.startsWith('COXPIT_')) delete env[k];
const scratch = mkdtempSync(join(tmpdir(), 'coxpit-unit-auth-'));
process.env.COXPIT_DB = join(scratch, 'unit.db');

const { gatePrecheck, isTrustedLocal, hasForwardedHeader, isExemptPath } = await import('../../src/auth.ts');
const { isExposedHost, verifyKey } = await import('../../src/authkey.ts');

const LOCAL = '127.0.0.1';
const NONE: Record<string, unknown> = {};
const API = '/api/machines';

/** 기본값은 "가장 느슨한 상태" — 키 없음 + loopback 바인드 + 진짜 로컬 요청. */
function precheck(over: Partial<Parameters<typeof gatePrecheck>[0]> = {}) {
  return gatePrecheck({
    mode: 'setup', path: API, exposedBind: false, remoteIp: LOCAL, headers: NONE, ...over,
  });
}

test('loopback bind, no key, direct local request -> trusted (zero-friction npx path)', () => {
  assert.equal(precheck(), 'trusted-local');
});

test('issue #11: a forwarded header on a loopback daemon is never trusted-local', () => {
  // 리버스 프록시/터널이 앞에 있으면 소켓은 127.0.0.1 이지만 도달 범위는 인터넷 전체다.
  assert.equal(precheck({ headers: { 'x-forwarded-for': '203.0.113.9' } }), 'credentials');
  assert.equal(precheck({ headers: { 'cf-connecting-ip': '203.0.113.9' } }), 'credentials');
  // 헤더가 비어 있어도 "실려 있음"은 실려 있음이다(프록시가 값을 못 채운 경우).
  assert.equal(precheck({ headers: { 'x-forwarded-for': '' } }), 'credentials');
});

test('issue #11: a configured key wins over bind-trust, even on loopback', () => {
  for (const mode of ['env', 'stored'] as const) {
    assert.equal(precheck({ mode }), 'credentials', `${mode} mode must demand credentials`);
    // 진짜 로컬이어도 우회 없음 — 키를 걸었다는 것은 걸어달라는 뜻이다.
    assert.equal(precheck({ mode, remoteIp: LOCAL, headers: NONE }), 'credentials');
  }
});

test('exposed bind (0.0.0.0) requires auth even with no key configured', () => {
  assert.equal(precheck({ exposedBind: true }), 'credentials');
  assert.equal(precheck({ exposedBind: true, mode: 'env' }), 'credentials');
});

test('non-loopback peer is not trusted-local', () => {
  assert.equal(precheck({ remoteIp: '203.0.113.9' }), 'credentials');
  assert.equal(precheck({ remoteIp: '' }), 'credentials');
  assert.equal(precheck({ remoteIp: '10.0.0.4' }), 'credentials');
});

test('COXPIT_AUTH_DISABLED short-circuits everything', () => {
  assert.equal(precheck({ mode: 'disabled', exposedBind: true, remoteIp: '203.0.113.9' }), 'disabled');
});

test('exempt paths pass the gate even when credentials would otherwise be required', () => {
  const gated = { mode: 'env', exposedBind: true, remoteIp: '203.0.113.9' } as const;
  for (const path of ['/api/health', '/favicon.ico', '/api/auth/unlock', '/share/abc', '/brand/mark.png']) {
    assert.equal(precheck({ ...gated, path }), 'exempt', `${path} must stay in front of the gate`);
  }
  // 게이트 뒤여야 하는 것들 — 예외 목록이 접두로 새지 않는지.
  for (const path of ['/api/machines', '/cockpit', '/api/design/capture-key', '/sharex/abc']) {
    assert.equal(isExemptPath(path), false, `${path} must stay behind the gate`);
  }
});

test('which bind counts as exposed', () => {
  for (const h of ['', '127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1', ' 127.0.0.1 ', 'LOCALHOST']) {
    assert.equal(isExposedHost(h), false, `${JSON.stringify(h)} is loopback`);
  }
  for (const h of ['0.0.0.0', '::', '192.168.0.10', '100.67.239.104']) {
    assert.equal(isExposedHost(h), true, `${JSON.stringify(h)} is exposed`);
  }
});

test('trusted-local / forwarded-header predicates on their own', () => {
  assert.equal(hasForwardedHeader({}), false);
  assert.equal(hasForwardedHeader({ 'x-forwarded-for': '1.2.3.4' }), true);
  assert.equal(hasForwardedHeader({ 'cf-connecting-ip': '1.2.3.4' }), true);
  assert.equal(isTrustedLocal('::1', {}), true);
  assert.equal(isTrustedLocal('::1', { 'x-forwarded-for': '1.2.3.4' }), false);
});

test('the key itself: right key unlocks, wrong key never does, setup mode has no key', () => {
  const m = { mode: 'env', key: 'unit-key' } as const;
  assert.equal(verifyKey('unit-key', m), true);
  assert.equal(verifyKey('unit-keY', m), false);
  assert.equal(verifyKey('', m), false);
  assert.equal(verifyKey('unit-key', { mode: 'setup' }), false);
});
