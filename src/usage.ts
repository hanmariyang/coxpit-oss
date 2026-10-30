// 구독 한도(5시간 · 주간). claude 가 상태줄 명령에 넘기는 rate_limits 를 scripts/claude-statusline.py 가
// ~/.claude/coxpit-usage.json 에 남기고, 데몬은 그 파일만 읽는다(토큰을 만지지 않는다).
// 계정 이름은 ~/.claude.json 의 oauthAccount.emailAddress — 맥마다 계정이 다를 수 있다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface Window { used: number; resetsAt: number }
export interface Usage { account: string | null; at: number | null; fiveHour: Window | null; sevenDay: Window | null }

function win(w: unknown, now: number): Window | null {
  const o = w as { used_percentage?: number; resets_at?: number } | null;
  if (!o || typeof o.used_percentage !== 'number' || typeof o.resets_at !== 'number') return null;
  // 풀린 창은 0 으로(새 창이 시작됐지만 아직 claude 가 새 값을 못 받았다)
  if (o.resets_at * 1000 <= now) return { used: 0, resetsAt: 0 };
  return { used: Math.round(o.used_percentage), resetsAt: o.resets_at * 1000 };
}

export function usage(): Usage {
  const home = os.homedir(), now = Date.now();
  let account: string | null = null;
  try { account = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'))?.oauthAccount?.emailAddress ?? null; } catch { /* 없음 */ }
  try {
    const d = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'coxpit-usage.json'), 'utf8'));
    const rl = d.rate_limits ?? {};
    return { account, at: typeof d.at === 'number' ? d.at * 1000 : null, fiveHour: win(rl.five_hour, now), sevenDay: win(rl.seven_day, now) };
  } catch { return { account, at: null, fiveHour: null, sevenDay: null }; }
}
