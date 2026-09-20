// HUD bridge — `/hud` 는 브라우저에서 단독으로 도는 한 장이고, 데스크톱 창에 실릴 때만 이 통로가 생긴다.
// 통로는 **한 방향 한 가지**다: 페이지가 "지금 이 배치에는 이만한 크기가 필요하다"고 말한다.
// 창을 실제로 줄이고 늘리는 것은 언제나 메인 프로세스다(preload-auth.cjs 와 같은 contextIsolated 형태).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('coxpitHud', {
  size: (want) => ipcRenderer.send('hud:size', {
    state: String((want && want.state) || 'pill'),
    w: Number(want && want.w) || 0,
    h: Number(want && want.h) || 0,
  }),
});
