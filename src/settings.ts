import fs from 'node:fs';
import { config } from './config';

// 영속 설정 — 데이터 폴더(~/.coxpit)의 settings.json. 웹 Settings 페이지가 읽고/쓴다.
// 우선순위(config.ts 에서 병합): 명시 env > settings.json > 기본값. env 를 준 값은 파일이 못 이긴다.
// 시크릿(접근 키)은 여기 넣지 않는다 — authkey.ts(auth.json, 해시)가 소유.

export interface Settings {
  port?: number;
  portStrict?: boolean;
  host?: string;
  webhookUrl?: string;
  publicUrl?: string;
  agent?: {
    provider?: 'claude-code' | 'codex';
    model?: string;
    count?: number;
    real?: boolean;
  };
}

export function readSettings(): Settings {
  try {
    const raw = JSON.parse(fs.readFileSync(config.settingsPath, 'utf8'));
    return raw && typeof raw === 'object' ? (raw as Settings) : {};
  } catch {
    return {};
  }
}

/** 부분 병합 저장. env 로 고정된 값은 UI 에서 잠기므로 여기선 순수 저장만. */
export function writeSettings(patch: Settings): Settings {
  const cur = readSettings();
  const next: Settings = { ...cur, ...patch };
  if (patch.agent) next.agent = { ...(cur.agent ?? {}), ...patch.agent };
  fs.writeFileSync(config.settingsPath, JSON.stringify(next, null, 2) + '\n');
  return next;
}
