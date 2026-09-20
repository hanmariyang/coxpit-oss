// HUD bridge — `/hud` 는 브라우저에서 단독으로 도는 한 장이고, 데스크톱 창에 실릴 때만 이 통로가 생긴다.
// 통로는 **한 방향**이고 두 마디뿐이다: "이 배치에는 이만한 크기가 필요하다" 와 "치워 달라".
// 창을 실제로 줄이고 늘리고 내리는 것은 언제나 메인 프로세스다(preload-auth.cjs 와 같은 contextIsolated 형태).
// 페이지 쪽은 이 다리가 **없을 수도 있다는 전제로** 부른다(window.coxpitHud 가 undefined 면 아무 일도 없다).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('coxpitHud', {
  size: (want) => ipcRenderer.send('hud:size', {
    state: String((want && want.state) || 'pill'),
    w: Number(want && want.w) || 0,
    h: Number(want && want.h) || 0,
    // 이 높이가 **내용을 재서 나온 것**인가. 그렇다면 창은 기본 높이 대신 이 값으로 연다
    // (사람이 손으로 끈 크기가 저장돼 있으면 그쪽이 이긴다 — 그 판단도 메인 프로세스 몫이다).
    fit: !!(want && want.fit),
  }),
  // 치우기 — 값도 답도 없다. 모드를 hidden 으로 못 박고 창을 내리는 일은 저쪽 몫이고,
  // 되살리는 문은 전역 단축키 하나다(새 창도, 두 번째 채널도 만들지 않는다).
  hide: () => ipcRenderer.send('hud:hide'),
});
