import fs from 'node:fs';
import { config } from './config';

// 소유자 UI 상태 — 데이터 폴더(~/.coxpit)의 ui-state.json 한 장.
// 왜 데몬이 기억하나: 열어둔 탭을 브라우저(localStorage)에만 두면 캐시를 비우거나, 기기를 바꾸거나,
// 오래된 페이지가 떠 있기만 해도 통째로 사라진다 — tmux 세션은 멀쩡히 살아 있는데도.
// 스키마를 늘리지 않는다: settings.json·auth.json 과 같은 자리의 작은 JSON 파일(선례 그대로).
// 소유자 1인 도구라 사용자 구분은 없다.

/** 탭 바에 열려 있던 run 탭 집합 + 마지막으로 보던 탭. */
export interface OpenTabs {
  ids: number[];
  active: number | null;
}
export interface UiState {
  openTabs?: OpenTabs;
}

/** 폰 DOM·복원 시간 보호 상한. 넘치면 **최근 것**을 남긴다. */
export const MAX_OPEN_TABS = 24;

function readUiState(): UiState {
  try {
    const raw = JSON.parse(fs.readFileSync(config.uiStatePath, 'utf8'));
    return raw && typeof raw === 'object' ? (raw as UiState) : {};
  } catch {
    return {};   // 파일 없음·깨짐 = 빈 상태(기억해둔 게 없다)
  }
}

/** 신뢰할 수 없는 입력(클라이언트 PUT·디스크 파일)을 정수 id 목록으로 정리한다. */
export function sanitizeOpenTabs(raw: unknown): OpenTabs {
  const o = (raw ?? {}) as { ids?: unknown; active?: unknown };
  const ids: number[] = [];
  if (Array.isArray(o.ids)) {
    for (const v of o.ids) {
      const n = Number(v);
      if (Number.isInteger(n) && n > 0 && !ids.includes(n)) ids.push(n);
    }
  }
  const a = Number(o.active);
  return {
    ids: ids.slice(-MAX_OPEN_TABS),
    active: Number.isInteger(a) && a > 0 ? a : null,
  };
}

/**
 * `stored` = 데몬이 **한 번이라도** 탭 집합을 받아 적었는가.
 * 빈 집합("전부 닫았다")과 미기록("아직 아무 말도 못 들었다")은 다르다 — 클라이언트는 후자일 때만
 * 브라우저 사본을 씨앗으로 쓴다(1회 이관). 이 구분이 없으면 owner 가 닫은 탭이 되살아난다.
 */
export function readOpenTabs(): OpenTabs & { stored: boolean } {
  const st = readUiState();
  if (!st.openTabs) return { ids: [], active: null, stored: false };
  return { ...sanitizeOpenTabs(st.openTabs), stored: true };
}

/** 부분 병합 저장 — 다른 UI 상태가 생겨도 이 쓰기가 덮지 않는다. */
export function writeOpenTabs(next: OpenTabs): OpenTabs {
  const clean = sanitizeOpenTabs(next);
  const cur = readUiState();
  fs.writeFileSync(config.uiStatePath, JSON.stringify({ ...cur, openTabs: clean }, null, 2) + '\n');
  return clean;
}
