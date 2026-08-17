// 라이브 이벤트 팬아웃 — /ws 소켓과 오케스트레이터를 잇는 초경량 허브.
export interface Sink {
  send: (data: string) => void;
}

const sinks = new Set<Sink>();

export function addSink(s: Sink): void {
  sinks.add(s);
}
export function removeSink(s: Sink): void {
  sinks.delete(s);
}

/** 모든 구독 소켓에 JSON 이벤트 push. 개별 send 실패는 무시(끊긴 소켓). */
export function broadcast(obj: unknown): void {
  const data = JSON.stringify(obj);
  for (const s of sinks) {
    try { s.send(data); } catch { /* dead socket */ }
  }
}
