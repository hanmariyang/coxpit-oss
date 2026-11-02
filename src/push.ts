// 폰 푸시(APNs) — 세션이 끝나거나 허락을 물으면 앱이 꺼져 있어도 폰에 알린다.
//
// 중간 서버 없이 데몬이 애플로 바로 보낸다. 필요한 것은 둘:
//   1. APNs 키: 데이터 폴더(<COXPIT_DB 폴더>/apns/AuthKey_<키 ID>.p8). 개발자 웹(Certificates, IDs & Profiles → Keys)에서만 만든다.
//      팀 ID 는 apns/config.json {"teamId": "..."} 또는 COXPIT_APNS_TEAM.
//   2. 기기 토큰: 앱이 POST /api/push/register 로 보낸다(정식 번들 · 푸시 자격이 있을 때만 생긴다).
// 키가 없으면 아무것도 안 한다(앱이 켜져 있을 때는 앱이 직접 알림을 띄운다).
import crypto from 'node:crypto';
import fs from 'node:fs';
import http2 from 'node:http2';
import os from 'node:os';
import path from 'node:path';

const dataDir = (): string => path.dirname(path.resolve(process.env.COXPIT_DB || path.join(os.homedir(), '.coxpit', 'coxpit.db')));
const apnsDir = (): string => path.join(dataDir(), 'apns');
const tokensPath = (): string => path.join(dataDir(), 'push-tokens.json');

export type Policy = 'all' | 'ask' | 'off';
export interface Device { token: string; env: 'sandbox' | 'production'; topic: string; name?: string; device?: string; at: number; /** 이 기기가 받을 알림: 전부 · 물어봄(멈춤 · 한도 포함)만 · 끄기 */ policy?: Policy }
/** 알림 설정(맥마다 하나): 조용 시간엔 끝남을 모아 한 통, 쓰는 기기가 있어 건넌 알림은 5분 뒤 다시 본다 */
export interface PushSettings { quiet: { on: boolean; from: number; to: number }; defer: boolean }
const settingsPath = (): string => path.join(dataDir(), 'push-settings.json');
export function pushSettings(): PushSettings {
  const d: PushSettings = { quiet: { on: true, from: 0, to: 7 }, defer: true };
  try { const j = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); return { quiet: { ...d.quiet, ...(j.quiet ?? {}) }, defer: typeof j.defer === 'boolean' ? j.defer : d.defer }; } catch { return d; }
}
export function savePushSettings(p: Partial<PushSettings>): PushSettings {
  const cur = pushSettings();
  const next: PushSettings = { quiet: { ...cur.quiet, ...(p.quiet ?? {}) }, defer: typeof p.defer === 'boolean' ? p.defer : cur.defer };
  next.quiet.from = Math.max(0, Math.min(23, Math.round(Number(next.quiet.from) || 0)));
  next.quiet.to = Math.max(0, Math.min(23, Math.round(Number(next.quiet.to) || 0)));
  next.quiet.on = next.quiet.on === true;
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  return next;
}
function inQuiet(s = pushSettings(), d = new Date()): boolean {
  if (!s.quiet.on || s.quiet.from === s.quiet.to) return false;
  const h = d.getHours();
  return s.quiet.from < s.quiet.to ? h >= s.quiet.from && h < s.quiet.to : h >= s.quiet.from || h < s.quiet.to;
}
export function listDevices(): Array<{ device: string; name: string; env: string; at: number; policy: Policy }> {
  return loadDevices().map((d) => ({ device: d.device ?? d.token.slice(0, 12), name: d.name ?? '', env: d.env, at: d.at, policy: d.policy ?? 'all' }));
}
export function setDevicePolicy(device: string, policy: Policy): boolean {
  const all = loadDevices(); let hit = false;
  for (const d of all) if ((d.device ?? d.token.slice(0, 12)) === device) { d.policy = policy; hit = true; }
  if (hit) saveDevices(all);
  return hit;
}

function loadDevices(): Device[] {
  try { return JSON.parse(fs.readFileSync(tokensPath(), 'utf8')) as Device[]; } catch { return []; }
}
function saveDevices(d: Device[]): void {
  fs.writeFileSync(tokensPath(), JSON.stringify(d, null, 2), { mode: 0o600 });
}

export function registerDevice(input: { token?: string; env?: string; topic?: string; name?: string; device?: string; policy?: string }): Device {
  const token = String(input.token ?? '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (token.length < 32 || token.length > 200) throw new Error('token required');
  const topic = String(input.topic ?? '').trim();
  if (!/^[\w.-]+$/.test(topic)) throw new Error('topic required');
  const d: Device = { token, env: input.env === 'production' ? 'production' : 'sandbox', topic, name: input.name ? String(input.name).slice(0, 60) : undefined, device: input.device ? String(input.device).slice(0, 64) : undefined, at: Date.now() };
  const pol = input.policy === 'all' || input.policy === 'ask' || input.policy === 'off' ? input.policy : undefined;
  // 같은 기기(이름 · 앱)가 다시 등록하면 옛 토큰은 뺀다 — 설치 페이지 판 → TestFlight 판으로 바꾸면 토큰이 둘이 돼 같은 알림이 두 번 갔다
  // 기기 id 가 오면 그것으로만 가린다(iOS 이름은 「iPad」 같은 모델 이름이라 두 대를 못 가른다). 옛 앱은 이름으로
  const same = (x: Device) => x.topic === topic && (d.device ? x.device === d.device || (!x.device && x.name === d.name) : !!d.name && x.name === d.name);
  const prev = loadDevices().find((x) => x.token === token || same(x));
  d.policy = pol ?? prev?.policy;   // 정책은 다시 등록해도 남는다
  const all = loadDevices().filter((x) => x.token !== token && !same(x));
  all.push(d); saveDevices(all.slice(-20));
  return d;
}

interface Key { keyId: string; teamId: string; pem: string }
function loadKey(): Key | null {
  try {
    const dir = apnsDir();
    const f = fs.readdirSync(dir).find((x) => /^AuthKey_[A-Z0-9]+\.p8$/.test(x));
    if (!f) return null;
    let teamId = process.env.COXPIT_APNS_TEAM || '';
    try { teamId = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).teamId || teamId; } catch { /* 없음 */ }
    if (!teamId) return null;
    return { keyId: f.slice(8, -3), teamId, pem: fs.readFileSync(path.join(dir, f), 'utf8') };
  } catch { return null; }
}

export function pushStatus() {
  const k = loadKey();
  return { configured: !!k, keyId: k?.keyId ?? null, devices: loadDevices().map((d) => ({ name: d.name ?? '', env: d.env, topic: d.topic, at: d.at })) };
}

// 애플은 같은 토큰을 20분 넘게 쓰라고 하고 1시간 넘으면 거절한다 → 40분마다 새로
let jwtCache: { at: number; keyId: string; jwt: string } | null = null;
function bearer(k: Key): string {
  if (jwtCache && jwtCache.keyId === k.keyId && Date.now() - jwtCache.at < 40 * 60 * 1000) return jwtCache.jwt;
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = `${b64({ alg: 'ES256', kid: k.keyId })}.${b64({ iss: k.teamId, iat: Math.floor(Date.now() / 1000) })}`;
  const sig = crypto.sign('sha256', Buffer.from(head), { key: k.pem, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  jwtCache = { at: Date.now(), keyId: k.keyId, jwt: `${head}.${sig}` };
  return jwtCache.jwt;
}

function send(k: Key, d: Device, payload: object, collapse?: string): Promise<{ status: number; reason?: string }> {
  const host = d.env === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: { status: number; reason?: string }) => { if (!done) { done = true; resolve(v); try { c.close(); } catch { /* 닫힘 */ } } };
    const c = http2.connect(host);
    c.on('error', (e) => finish({ status: 0, reason: String(e.message) }));
    const body = JSON.stringify(payload);
    const headers: http2.OutgoingHttpHeaders = {
      ':method': 'POST', ':path': `/3/device/${d.token}`,
      authorization: `bearer ${bearer(k)}`, 'apns-topic': d.topic, 'apns-push-type': 'alert', 'apns-priority': '10',
      'content-type': 'application/json',
    };
    if (collapse) headers['apns-collapse-id'] = collapse.slice(0, 64);
    const r = c.request(headers);
    let status = 0, text = '';
    r.on('response', (h) => { status = Number(h[':status'] ?? 0); });
    r.on('data', (x) => { text += x; });
    r.on('end', () => { let reason: string | undefined; try { reason = JSON.parse(text).reason; } catch { /* 빈 몸 */ } finish({ status, reason }); });
    r.on('error', (e) => finish({ status: 0, reason: String(e.message) }));
    r.setTimeout(10000, () => { r.close(); finish({ status: 0, reason: 'timeout' }); });
    r.end(body);
  });
}

// 지금 앱을 쓰고 있는 기기: 그 기기가 알림을 직접 띄우니 다른 기기로는 푸시하지 않는다(10/31 오너 「무분별한 알림으로 피로도」).
// 앱이 /ws 로 {type:'presence', active} 를 보낸다: 앞으로 올 때 · 대화를 열 때 · 보낼 때 true, 뒤로 갈 때 false.
// 맥 앱은 앞에 띄워 둔 채 자리를 비울 수 있어서, 마지막 손길 10분 뒤에는 쓰는 중으로 치지 않는다.
const ACTIVE_MS = 10 * 60 * 1000;
const presence = new Map<object, { name: string; at: number; active: boolean }>();
export function setPresence(socket: object, p: { name?: string; active?: boolean } | null): void {
  if (!p) { presence.delete(socket); return; }
  presence.set(socket, { name: String(p.name ?? '').slice(0, 60) || '앱', at: Date.now(), active: p.active === true });
}
/** 쓰는 중인 기기 이름(없으면 null) */
export function activeDevice(): string | null {
  for (const p of presence.values()) if (p.active && Date.now() - p.at < ACTIVE_MS) return p.name;
  return null;
}

export type PushKind = 'done' | 'ask' | 'stop' | 'usage' | 'digest' | 'test';
export interface Notice { chatId: string; kind: PushKind; title: string; body: string }
/** 건넌 알림을 5분 뒤 다시 볼 때 「그 사이 그 대화를 열었나」를 묻는다(chat.ts 가 seen 을 안다) */
let openedSince: (chatId: string, at: number) => boolean = () => false;
export function setOpenedLookup(f: typeof openedSince): void { openedSince = f; }

const DEFER_MS = 5 * 60 * 1000;
const deferred: Array<{ n: Notice; at: number }> = [];
const digest: Array<{ n: Notice; at: number }> = [];
let digestAsks = 0;

/** 끝남 · 물어봄 · 멈춤 · 한도를 폰에 보낸다. 조용 시간이면 끝남은 모아 두고, 쓰는 기기가 있으면 5분 미뤘다 다시 본다 */
export async function pushNotify(n: Notice, opt: { force?: boolean } = {}): Promise<Array<{ name: string; status: number; reason?: string }>> {
  const k = loadKey(); if (!k) return [];
  const s = pushSettings();
  if (!opt.force && n.kind !== 'test') {
    if (n.kind === 'done' && inQuiet(s)) { digest.push({ n, at: Date.now() }); logPush(n, [{ name: '건넘(조용 시간 · 아침에 묶어서)', status: 0 }]); return []; }
    if (n.kind === 'ask' && inQuiet(s)) digestAsks++;
    const using = activeDevice();
    if (using) {
      if (s.defer && (n.kind === 'done' || n.kind === 'ask')) { deferred.push({ n, at: Date.now() }); logPush(n, [{ name: `건넘(${using} 쓰는 중 · 5분 뒤 다시)`, status: 0 }]); }
      else logPush(n, [{ name: `건넘(${using} 쓰는 중)`, status: 0 }]);
      return [];
    }
  }
  const devices = loadDevices().filter((d) => n.kind === 'test' || ((d.policy ?? 'all') === 'all' || ((d.policy ?? 'all') === 'ask' && n.kind !== 'done' && n.kind !== 'digest')));
  if (!devices.length) { logPush(n, [{ name: '건넘(받을 기기 없음)', status: 0 }]); return []; }
  const urgent = n.kind === 'ask' || n.kind === 'stop';
  const payload = {
    aps: {
      alert: { title: n.title.slice(0, 120), body: n.body.slice(0, 240) }, sound: 'default',
      'thread-id': n.kind === 'digest' ? 'night' : n.chatId, category: n.kind,
      ...(urgent ? { 'interruption-level': 'time-sensitive' } : {}),
    },
    chatId: n.chatId, kind: n.kind, host: os.hostname(),
  };
  const out: Array<{ name: string; status: number; reason?: string }> = [];
  const dead = new Set<string>();
  for (const d of devices) {
    const r = await send(k, d, payload, `${n.chatId}-${n.kind}`);
    out.push({ name: d.name ?? '', ...r });
    // 앱을 지웠거나 토큰이 바뀐 기기는 뺀다
    if (r.status === 410 || r.reason === 'BadDeviceToken' || r.reason === 'Unregistered') dead.add(d.token);
  }
  if (dead.size) saveDevices(loadDevices().filter((d) => !dead.has(d.token)));
  logPush(n, out);
  return out;
}

// 30초마다: 미룬 알림은 5분 지나고 그 대화를 안 열었으면 보낸다. 조용 시간이 끝나면 모은 끝남을 한 통으로
let tickStarted = false;
export function startPushTicker(): void {
  if (tickStarted) return; tickStarted = true;
  setInterval(() => {
    const now = Date.now();
    while (deferred.length && now - deferred[0]!.at >= DEFER_MS) {
      const { n, at } = deferred.shift()!;
      if (openedSince(n.chatId, at)) { logPush(n, [{ name: '건넘(그 사이 열어 봄)', status: 0 }]); continue; }
      void pushNotify(n, { force: true });
    }
    if (digest.length && !inQuiet()) {
      const items = digest.splice(0); const asks = digestAsks; digestAsks = 0;
      const titles = [...new Set(items.map((x) => x.n.title.replace(/ · 끝남$/, '')))];
      const body = (asks ? `물어봄 ${asks} · ` : '') + titles.slice(0, 8).join(', ') + (titles.length > 8 ? ` 외 ${titles.length - 8}` : '') + ' 끝남';
      void pushNotify({ chatId: 'night', kind: 'digest', title: `밤사이 끝남 ${items.length}${asks ? ` · 물어봄 ${asks}` : ''}`, body }, { force: true });
    }
  }, 30000);
}

/** 보낸 알림 기록(최근 n건) */
export function pushLog(limit = 200): unknown[] {
  try {
    const lines = fs.readFileSync(path.join(dataDir(), 'push-log.jsonl'), 'utf8').trim().split('\n');
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  } catch { return []; }
}

/** 보낸 알림 기록(최근 200건): 「알림이 이상하다」를 확인할 때 무엇을 언제 보냈는지 본다 */
function logPush(n: { chatId: string; kind: string; title: string; body: string }, out: Array<{ name: string; status: number; reason?: string }>): void {
  try {
    const f = path.join(dataDir(), 'push-log.jsonl');
    const line = JSON.stringify({ at: new Date().toISOString(), chatId: n.chatId, kind: n.kind, title: n.title, body: n.body, sent: out.map((o) => `${o.name}:${o.status}${o.reason ? ':' + o.reason : ''}`) });
    let lines: string[] = [];
    try { lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { /* 처음 */ }
    fs.writeFileSync(f, [...lines.slice(-199), line].join('\n') + '\n', { mode: 0o600 });
  } catch { /* 기록은 덤 */ }
}
