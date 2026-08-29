// Cockpit — 터미널 우선 셸 (병행 개발용, /cockpit). board.ts 처럼 자가완결 단일 HTML(빌드 0).
// 백엔드(server 라우트·term.ts·orchestrator)는 보드와 전부 공유. Phase 5에서 데스크톱 기본을 여기로 플립.
// Phase 0 = 스캐폴드(레이아웃 골격 + Board 토글 + 모바일 보드 리다이렉트). 트리·페인 그리드·요청바는 Phase 2~3.
export const COCKPIT_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>coxpit · cockpit</title>
<link rel="icon" href="/brand/favicon.ico" sizes="any" />
<link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png" />
<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png" />
<style>
  @font-face{font-family:'Pixelify';src:url('/brand/pixelify.woff2') format('woff2');font-weight:400 700;font-display:swap}
  :root{
    --bg:#0b0d12; --surface:#12151c; --surface2:#171b24; --panel:#0e1118;
    --line:#222835; --line-hi:#2f3648;
    --ink:#dee4ec; --muted:#8792a2; --faint:#5c6675;
    --brand:#4ec9b0; --brand-ink:#062822; --brand-dim:rgba(78,201,176,.13);
    --running:#55a7e0; --done:#58b368; --blocked:#d6a249; --failed:#e25b67;
    --mono:ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,monospace;
    --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,Roboto,sans-serif;
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.5;
    -webkit-font-smoothing:antialiased;overflow:hidden}

  /* ── topbar ── */
  header{display:flex;align-items:center;gap:13px;height:46px;padding:0 14px;
    border-bottom:1px solid var(--line);background:rgba(18,21,28,.92);font-family:var(--mono)}
  .brand{display:inline-flex;align-items:center;gap:8px;text-decoration:none}
  .brand img{height:22px;width:auto;display:block}
  .brand .wm{font-family:'Pixelify';font-weight:600;font-size:19px;color:var(--ink);letter-spacing:.01em;margin-left:-2px}
  .mach{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:7px;padding:4px 10px}
  .mach .dot{width:6px;height:6px;border-radius:50%;background:var(--done)}
  .vtabs{display:flex;gap:4px;margin-left:4px}
  .vtab{font-size:12px;color:var(--muted);padding:6px 11px;border-radius:7px;display:inline-flex;align-items:center;gap:7px;cursor:pointer;background:none;border:none;font-family:var(--mono)}
  .vtab.on{background:var(--brand-dim);color:var(--ink);box-shadow:inset 0 0 0 1px rgba(78,201,176,.28)}
  .vtab .g{color:var(--brand)}
  .right{margin-left:auto;display:flex;align-items:center;gap:9px}
  .wip{font-size:10.5px;color:var(--blocked);border:1px solid rgba(214,162,73,.4);border-radius:999px;padding:2px 9px}
  .toggle{font-size:12px;color:var(--muted);text-decoration:none;border:1px solid var(--line);border-radius:7px;padding:5px 11px}
  .toggle:hover{color:var(--ink);border-color:var(--line-hi)}

  /* ── body: tree | main ── */
  .layout{display:grid;grid-template-columns:264px 1fr;height:calc(100vh - 46px)}
  .rail{border-right:1px solid var(--line);overflow:auto;padding:12px 10px}
  .lbl{font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);padding:5px 8px 10px}
  .skel{height:11px;border-radius:5px;background:linear-gradient(90deg,var(--surface) 0%,var(--surface2) 50%,var(--surface) 100%);
    background-size:200% 100%;animation:sh 1.4s linear infinite;margin:9px 8px}
  @keyframes sh{to{background-position:-200% 0}}
  @media (prefers-reduced-motion:reduce){.skel{animation:none}}

  .main{display:flex;flex-direction:column;min-width:0;background:var(--bg)}
  .stage{flex:1;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px}
  .stage .card{max-width:460px}
  .stage .glyph{font-family:var(--mono);font-size:26px;color:#2c3444;letter-spacing:5px;margin-bottom:14px}
  .stage h1{font-family:var(--mono);font-size:17px;margin:0 0 8px;color:var(--ink);font-weight:700}
  .stage p{color:var(--muted);font-size:13.5px;margin:0 0 6px;line-height:1.6}
  .stage .steps{font-family:var(--mono);font-size:12px;color:var(--faint);margin-top:16px;text-align:left;
    border:1px solid var(--line);border-radius:10px;background:var(--surface);padding:14px 16px;line-height:1.9}
  .stage .steps b{color:var(--brand)}
  .reqbar{display:flex;align-items:center;gap:10px;border-top:1px solid var(--line);background:var(--surface);padding:11px 14px;font-family:var(--mono)}
  .reqbar .ctx{font-size:11px;color:var(--brand-ink);background:var(--brand);border-radius:6px;padding:3px 9px;font-weight:600}
  .reqbar .caret{color:var(--brand)}
  .reqbar .ph{color:var(--faint);font-size:13px;flex:1}
  .reqbar .kbd{border:1px solid var(--line-hi);border-radius:5px;padding:1px 6px;color:var(--faint);font-size:11px}
</style>
</head>
<body>
<header>
  <a class="brand" href="/"><img src="/brand/mark.png" alt="" /><span class="wm">coxpit</span></a>
  <span class="mach"><span class="dot"></span><span id="mach">local</span></span>
  <div class="vtabs">
    <button type="button" class="vtab on"><span class="g">⌗</span>Terminal</button>
    <button type="button" class="vtab"><span class="g">⧉</span>Review</button>
    <button type="button" class="vtab"><span class="g">▤</span>Docs</button>
  </div>
  <div class="right">
    <span class="wip">preview · Phase 0</span>
    <a class="toggle" href="/">← Board</a>
  </div>
</header>

<div class="layout">
  <aside class="rail">
    <div class="lbl">Workspace</div>
    <div class="skel" style="width:70%"></div>
    <div class="skel" style="width:52%"></div>
    <div class="skel" style="width:60%"></div>
    <div class="skel" style="width:44%"></div>
  </aside>

  <main class="main">
    <div class="stage">
      <div class="card">
        <div class="glyph">⌗ ⌗ ⌗</div>
        <h1>Cockpit — 터미널 우선 셸</h1>
        <p>이 화면은 새 셸의 골격입니다. 백엔드는 보드와 공유하고, 여기에 트리·페인 그리드 터미널·요청바를 단계로 얹습니다.</p>
        <div class="steps">
          <div><b>Phase 1</b> · tmux 재-adopt (재시작 내성 토대)</div>
          <div><b>Phase 2</b> · 워크스페이스 트리 + 페인 그리드 터미널</div>
          <div><b>Phase 3</b> · 요청바 · 팬아웃 타일 · Review · 브로드캐스트</div>
          <div><b>Phase 4</b> · verify in-loop</div>
        </div>
      </div>
    </div>
    <div class="reqbar">
      <span class="ctx">cockpit</span><span class="caret">›</span>
      <span class="ph">요청바 — Phase 3</span>
      <span class="kbd">⏎</span>
    </div>
  </main>
</div>

<script>
  // 모바일은 터미널 우선 대신 보드(모니터)로 — Cockpit 은 데스크톱 우선.
  // (뷰포트 폭 + 터치 힌트로 판정 — screen.width 는 헤드리스/멀티모니터서 부정확)
  if (window.innerWidth <= 860 && matchMedia('(pointer:coarse)').matches) location.replace('/');
  // health 로 머신명 정도만 채운다(스캐폴드).
  fetch('/api/health').then(function(r){return r.json()}).then(function(){}).catch(function(){});
</script>
</body>
</html>`;
