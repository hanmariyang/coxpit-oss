// Cockpit — 터미널 우선 셸 (병행 개발, /cockpit). board.ts 처럼 자가완결 단일 HTML(빌드 0).
// 백엔드(server 라우트·term.ts·orchestrator)는 보드와 전부 공유. Phase 5에서 데스크톱 기본을 여기로 플립.
// Phase 2 = 워크스페이스 트리(/api/fleet 라이브) + 페인 그리드 터미널(오토타일=창분할, 각 페인 /ws/term attach).
export const COCKPIT_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>coxpit · cockpit</title>
<link rel="icon" href="/brand/favicon.ico" sizes="any" />
<link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png" />
<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png" />
<link rel="stylesheet" href="/vendor/xterm.css" />
<style>
  @font-face{font-family:'Pixelify';src:url('/brand/pixelify.woff2') format('woff2');font-weight:400 700;font-display:swap}
  :root{
    --bg:#0b0d12; --surface:#12151c; --surface2:#171b24; --panel:#0e1118;
    --line:#222835; --line-hi:#2f3648;
    --ink:#dee4ec; --muted:#8792a2; --faint:#5c6675;
    --brand:#4ec9b0; --brand-ink:#062822; --brand-dim:rgba(78,201,176,.13);
    --running:#55a7e0; --done:#58b368; --blocked:#d6a249; --failed:#e25b67; --merged:#4ec9b0; --open:#7f9cf5; --stopped:#b58be0;
    --mono:ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,monospace;
    --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,Roboto,sans-serif;
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.5;
    -webkit-font-smoothing:antialiased;overflow:hidden}
  button{font-family:var(--sans)}
  :focus-visible{outline:2px solid rgba(78,201,176,.5);outline-offset:1px;border-radius:4px}

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
  .vtab[disabled]{opacity:.5;cursor:default}
  .right{margin-left:auto;display:flex;align-items:center;gap:9px}
  .ws{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted)}
  .ws .dot{width:6px;height:6px;border-radius:50%;background:var(--faint)}
  .ws.on .dot{background:var(--done)}
  .wip{font-size:10.5px;color:var(--blocked);border:1px solid rgba(214,162,73,.4);border-radius:999px;padding:2px 9px}
  .toggle{font-size:12px;color:var(--muted);text-decoration:none;border:1px solid var(--line);border-radius:7px;padding:5px 11px}
  .toggle:hover{color:var(--ink);border-color:var(--line-hi)}

  .layout{display:grid;grid-template-columns:270px 1fr;height:calc(100vh - 46px)}
  .layout > *{min-height:0;min-width:0}

  /* ── workspace tree ── */
  .rail{border-right:1px solid var(--line);overflow:auto;padding:10px 8px;font-family:var(--mono);font-size:12.5px;display:flex;flex-direction:column}
  .lbl{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);padding:6px 8px 10px;display:flex;justify-content:space-between}
  .tnode{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:7px;color:var(--muted);white-space:nowrap;cursor:default}
  .tnode .car{color:var(--faint);width:9px;display:inline-block;text-align:center;cursor:pointer}
  .tnode .n{overflow:hidden;text-overflow:ellipsis;flex:1}
  .tnode .meta{color:var(--faint);font-size:11px}
  .tnode.repo{color:var(--ink)}
  .tnode.goal{padding-left:20px} .tnode.goal .gi{color:var(--brand)}
  .tnode.task{padding-left:30px}
  .tnode.run{padding-left:44px;font-size:12px;cursor:pointer}
  .tnode.run:hover{background:var(--surface)}
  .tnode.run.open{background:var(--brand-dim);color:var(--ink);box-shadow:inset 0 0 0 1px rgba(78,201,176,.22)}
  .tnode.empty{color:var(--faint);padding:8px}
  .st{width:6px;height:6px;border-radius:50%;flex:none}
  .st.running{background:var(--running);box-shadow:0 0 0 3px rgba(85,167,224,.16)}
  .st.done{background:var(--done)} .st.blocked{background:var(--blocked)} .st.failed,.st.error{background:var(--failed)}
  .st.merged{background:var(--merged)} .st.open{background:var(--open)} .st.stopped{background:var(--stopped)}
  .st.preparing,.st.pending,.st.starting{background:var(--blocked)}
  .tree-sep{height:1px;background:var(--line);margin:8px 4px}
  .railfoot{margin-top:auto;padding:8px;color:var(--faint);font-size:11px;border-top:1px solid var(--line)}

  /* ── 탭 바 + 분할 트리 페인 ── */
  .stage{display:flex;flex-direction:column;min-width:0;background:var(--bg);position:relative}
  .tabbar{display:flex;align-items:stretch;height:38px;border-bottom:1px solid var(--line);background:var(--panel);font-family:var(--mono)}
  .tabs{flex:1;display:flex;align-items:stretch;overflow-x:auto;overflow-y:hidden}
  .tab{display:inline-flex;align-items:center;gap:7px;padding:0 10px 0 12px;border-right:1px solid var(--line);font-size:12px;color:var(--muted);cursor:pointer;white-space:nowrap;max-width:220px;user-select:none;flex:none}
  .tab:hover{background:var(--surface)}
  .tab.shown{color:var(--ink);background:var(--bg);box-shadow:inset 0 -2px 0 var(--brand)}
  .tab.drag{opacity:.4}
  .tab .st{flex:none}
  .tab .nm{overflow:hidden;text-overflow:ellipsis}
  .tab .ren{font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--brand);border-radius:4px;padding:0 4px;width:120px;outline:none}
  .tab .x{color:var(--faint);font-size:13px;padding:0 2px;border:none;background:none;cursor:pointer;line-height:1}
  .tab .x:hover{color:var(--failed)}
  .tabctl{display:flex;align-items:center;gap:6px;padding:0 10px;border-left:1px solid var(--line)}
  .tc-btn{background:none;border:1px solid var(--line);border-radius:6px;color:var(--muted);font-size:11px;padding:3px 8px;cursor:pointer;font-family:var(--mono)}
  .tc-btn:hover:not([disabled]){color:var(--ink);border-color:var(--line-hi)}
  .tc-btn[disabled]{opacity:.4;cursor:default}
  .tc-btn.session{color:var(--brand);border-color:rgba(78,201,176,.35)}
  .tc-btn.session:hover:not([disabled]){background:var(--brand-dim);border-color:var(--brand)}

  .panes{flex:1;display:none;min-height:0;min-width:0}  /* 초기 숨김 — 탭 있을 때만 flex */
  .node{display:flex;min-width:0;min-height:0;flex:1 1 0}
  .node.row{flex-direction:row} .node.col{flex-direction:column}
  .gutter{flex:none;background:var(--line);z-index:2}
  .gutter.row{width:5px;cursor:col-resize} .gutter.col{height:5px;cursor:row-resize}
  .gutter:hover,.gutter.drag{background:var(--brand)}
  .leaf{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;flex:1 1 0;background:var(--bg)}
  .leaf.focus{box-shadow:inset 0 0 0 1px rgba(78,201,176,.45)}
  .leaf.drop{box-shadow:inset 0 0 0 2px var(--brand)}
  .leaf-h{display:flex;align-items:center;gap:8px;height:26px;padding:0 6px 0 10px;background:var(--surface);border-bottom:1px solid var(--line);font-family:var(--mono);font-size:11px;color:var(--muted);flex:none;cursor:pointer}
  .leaf.focus .leaf-h{background:var(--brand-dim)}
  .leaf-h .nm{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--ink)}
  .leaf-h .x{color:var(--faint);border:none;background:none;cursor:pointer;font-size:13px}
  .leaf-h .x:hover{color:var(--failed)}
  .chip{font-size:9px;text-transform:uppercase;letter-spacing:.04em;padding:1px 6px;border-radius:999px}
  .chip.running{color:var(--running);background:rgba(85,167,224,.14)}
  .chip.done,.chip.merged{color:var(--done);background:rgba(88,179,104,.14)}
  .chip.blocked,.chip.preparing,.chip.pending,.chip.starting{color:var(--blocked);background:rgba(214,162,73,.16)}
  .chip.failed,.chip.error{color:var(--failed);background:rgba(226,91,103,.14)}
  .chip.open{color:var(--open);background:rgba(127,156,245,.14)}
  .chip.stopped{color:var(--stopped);background:rgba(181,139,224,.14)}
  .vbadge{font-size:9px;font-weight:600;letter-spacing:.03em;padding:1px 6px;border-radius:999px;white-space:nowrap}
  .vbadge.pass{color:var(--done);background:rgba(88,179,104,.16)}
  .vbadge.fail{color:var(--failed);background:rgba(226,91,103,.16)}
  .vbadge.running{color:var(--blocked);background:rgba(214,162,73,.16)}
  .vbadge.error{color:var(--failed);background:rgba(226,91,103,.12)}
  .leaf-body{flex:1;min-height:0;min-width:0;display:flex}
  .leaf-body.drop{box-shadow:inset 0 0 0 2px var(--brand);background:var(--brand-dim)}
  .leaf-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--faint);font-family:var(--mono);font-size:11.5px;text-align:center;padding:12px}
  .term-host{flex:1;min-height:0;min-width:0;padding:4px 2px 2px 8px}
  .term-host .xterm{height:100%}

  .empty{flex:1;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px}
  .empty .card{max-width:440px}
  .empty .glyph{font-family:var(--mono);font-size:24px;color:#2c3444;letter-spacing:5px;margin-bottom:14px}
  .empty h1{font-family:var(--mono);font-size:16px;margin:0 0 8px;color:var(--ink)}
  .empty p{color:var(--muted);font-size:13px;margin:0 0 18px}
  .empty .cta{display:inline-flex;align-items:center;gap:8px;font-family:var(--mono);font-size:13px;font-weight:600;
    color:var(--brand-ink);background:var(--brand);border:none;border-radius:9px;padding:10px 16px;cursor:pointer}
  .empty .cta:hover{filter:brightness(1.06)}
  .empty .hint{color:var(--faint);font-size:11.5px;margin-top:12px}
  .pb-btn.session{color:var(--brand);border-color:rgba(78,201,176,.35)}
  .pb-btn.session:hover:not([disabled]){background:var(--brand-dim);border-color:var(--brand)}

  .reqbar{display:flex;align-items:center;gap:9px;border-top:1px solid var(--line);background:var(--surface);padding:9px 12px;font-family:var(--mono)}
  .modes{display:inline-flex;gap:2px;border:1px solid var(--line);border-radius:8px;padding:2px;background:var(--panel)}
  .mode{font-size:11px;color:var(--muted);padding:4px 9px;border-radius:6px;cursor:pointer;background:none;border:none;font-family:var(--mono);white-space:nowrap}
  .mode.on{background:var(--brand-dim);color:var(--ink);box-shadow:inset 0 0 0 1px rgba(78,201,176,.3)}
  .reqbar select{font-family:var(--mono);font-size:11.5px;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:7px;padding:5px 7px;max-width:150px}
  .reqbar select:disabled{opacity:.35}
  .reqbar .tgt{font-size:11px;color:var(--brand);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px}
  .rlbl{display:inline-flex;align-items:center;gap:5px}
  .rchk{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--muted);cursor:pointer;white-space:nowrap}
  .reqinput{flex:1;min-width:80px;font-family:var(--mono);font-size:13px;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 11px}
  .reqinput:focus{outline:none;border-color:var(--line-hi);box-shadow:0 0 0 2px rgba(78,201,176,.18)}
  .reqinput::placeholder{color:var(--faint)}
  .reqgo{font-family:var(--mono);font-size:12px;font-weight:600;color:var(--brand-ink);background:var(--brand);border:none;border-radius:8px;padding:8px 13px;cursor:pointer}
  .reqgo:disabled{opacity:.4;cursor:default}
  .reqgo.bcast{background:var(--open);color:#0b0d12}
  .reqgo.steer{background:var(--running);color:#04121e}
  /* ── folder picker (자유 세션 폴더 지정) ── */
  .modal{position:fixed;inset:0;background:rgba(4,6,10,.6);display:none;align-items:center;justify-content:center;z-index:60}
  .modal.on{display:flex}
  .pick{width:min(560px,92vw);max-height:76vh;display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--line-hi);border-radius:14px;overflow:hidden;font-family:var(--mono)}
  .pick-h{display:flex;align-items:center;gap:10px;padding:13px 15px;border-bottom:1px solid var(--line)}
  .pick-h .t{font-size:13px;color:var(--ink);font-weight:600}
  .pick-h .x{margin-left:auto;background:none;border:none;color:var(--faint);font-size:16px;cursor:pointer}
  .pick-h .x:hover{color:var(--ink)}
  .pick-path{padding:8px 15px;font-size:11.5px;color:var(--brand);border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}
  .pick-list{flex:1;overflow:auto;padding:6px}
  .pick-row{display:flex;align-items:center;gap:9px;padding:7px 10px;border-radius:7px;cursor:pointer;font-size:12.5px;color:var(--muted)}
  .pick-row:hover{background:var(--surface2);color:var(--ink)}
  .pick-row .ic{width:14px;text-align:center;color:var(--faint)}
  .pick-row.up .ic{color:var(--muted)}
  .pick-row .rp{margin-left:auto;font-size:9px;color:var(--brand);border:1px solid rgba(78,201,176,.3);border-radius:999px;padding:0 6px}
  .pick-f{display:flex;align-items:center;gap:10px;padding:12px 15px;border-top:1px solid var(--line)}
  .pick-f .go{margin-left:auto;font-family:var(--mono);font-size:12px;font-weight:600;color:var(--brand-ink);background:var(--brand);border:none;border-radius:8px;padding:9px 15px;cursor:pointer}
  .pick-f .home{font-family:var(--mono);font-size:11px;color:var(--muted);background:none;border:1px solid var(--line);border-radius:7px;padding:7px 11px;cursor:pointer}
  .pick-f .home:hover{color:var(--ink);border-color:var(--line-hi)}
  .pick-name{flex:1;font-family:var(--mono);font-size:12px;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:7px 10px}
  .pick-name:focus{outline:none;border-color:var(--brand)}
  .pick-name::placeholder{color:var(--faint)}

  .lbl .lnk{color:var(--brand);cursor:pointer;font-size:10px;letter-spacing:0;text-transform:none}
  .tnode.session{padding-left:20px;cursor:pointer} .tnode.session:hover{background:var(--surface)}
  .tnode.session.open{background:var(--brand-dim);color:var(--ink);box-shadow:inset 0 0 0 1px rgba(78,201,176,.22)}
  .tnode.session .p{color:var(--faint);font-size:10.5px;overflow:hidden;text-overflow:ellipsis}

  .toast{position:fixed;bottom:64px;left:50%;transform:translateX(-50%);background:var(--surface2);border:1px solid var(--line-hi);color:var(--ink);
    font-family:var(--mono);font-size:12px;padding:8px 14px;border-radius:9px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:40;max-width:80vw}
  .toast.show{opacity:1}

  /* ── Review (compare/merge) ── */
  .review{position:absolute;inset:46px 0 0 0;background:var(--bg);display:none;flex-direction:column;overflow:hidden;z-index:20}
  .review.on{display:flex}
  .rv-head{display:flex;align-items:center;gap:10px;height:40px;padding:0 14px;border-bottom:1px solid var(--line);background:var(--panel);font-family:var(--mono);font-size:12px;color:var(--muted)}
  .rv-head select{font-family:var(--mono);font-size:12px;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:7px;padding:5px 8px;max-width:340px}
  .rv-cols{flex:1;display:flex;gap:1px;background:var(--line);overflow-x:auto;min-height:0}
  .rv-col{flex:1 0 340px;min-width:300px;display:flex;flex-direction:column;background:var(--bg)}
  .rv-col-h{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--line);background:var(--surface);font-family:var(--mono);font-size:12px}
  .rv-col-h .rid{color:var(--ink);font-weight:600}
  .rv-col-h .stat{color:var(--faint);font-size:11px;margin-left:auto}
  .rv-merge{font-family:var(--mono);font-size:10.5px;font-weight:600;color:var(--brand-ink);background:var(--brand);border:none;border-radius:6px;padding:4px 9px;cursor:pointer}
  .rv-merge:disabled{opacity:.35;cursor:default;background:var(--line-hi);color:var(--faint)}
  .rv-merge.caution{background:var(--blocked);color:#211803}
  .rv-verify{display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--line);background:var(--panel);font-family:var(--mono);font-size:11px;color:var(--muted)}
  .rv-verify .vbadge{flex:none}
  .rv-verify .vout{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--faint);cursor:pointer}
  .rv-reverify{background:none;border:1px solid var(--line);border-radius:6px;color:var(--muted);font-size:10px;padding:2px 7px;cursor:pointer;font-family:var(--mono)}
  .rv-reverify:hover{color:var(--ink);border-color:var(--line-hi)}
  .rv-vcmd{display:flex;align-items:center;gap:7px;margin-left:14px}
  .rv-vcmd input{font-family:var(--mono);font-size:11px;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:7px;padding:5px 8px;width:230px}
  .rv-vcmd input::placeholder{color:var(--faint)}
  .rv-vcmd button{font-family:var(--mono);font-size:10.5px;color:var(--muted);background:none;border:1px solid var(--line);border-radius:6px;padding:5px 9px;cursor:pointer}
  .rv-vcmd button:hover{color:var(--ink);border-color:var(--line-hi)}
  .rv-diff{flex:1;overflow:auto;padding:8px 10px;font-family:var(--mono);font-size:11.5px;line-height:1.5;white-space:pre;color:var(--muted)}
  .rv-diff > span{display:block;min-height:1.2em}
  .dl-file{color:var(--brand)} .dl-hunk{color:var(--open)} .dl-ctx{color:var(--muted)}
  .dl-add{color:#7fdca0;background:rgba(88,179,104,.08)} .dl-del{color:#e58a92;background:rgba(226,91,103,.08)}
  .rv-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--faint);font-family:var(--mono);font-size:13px;text-align:center;padding:24px}
</style>
</head>
<body>
<header>
  <a class="brand" href="/"><img src="/brand/mark.png" alt="" /><span class="wm">coxpit</span></a>
  <span class="mach"><span class="dot"></span><span id="mach">local</span></span>
  <div class="vtabs">
    <button type="button" class="vtab on" id="vtTerm"><span class="g">⌗</span>Terminal</button>
    <button type="button" class="vtab" id="vtReview"><span class="g">⧉</span>Review</button>
    <button type="button" class="vtab" disabled title="Docs = 보드"><span class="g">▤</span>Docs</button>
  </div>
  <div class="right">
    <span class="ws" id="ws"><span class="dot"></span><span id="wstext">connecting</span></span>
    <a class="toggle" href="/" title="보드(모니터) 뷰로">← Board</a>
  </div>
</header>

<div class="layout">
  <aside class="rail">
    <div class="lbl"><span>Workspace</span><span id="machName" style="color:var(--faint)">local</span></div>
    <div id="tree"></div>
    <div class="railfoot">클릭한 run·세션은 <b>탭</b>으로 열립니다 · split 으로 페인을 나란히 배치</div>
  </aside>

  <main class="stage">
    <div class="tabbar">
      <div class="tabs" id="tabs"></div>
      <div class="tabctl">
        <button class="tc-btn" id="splitRow" title="세로 분할 — 포커스 페인을 좌우로" disabled>▐ split</button>
        <button class="tc-btn" id="splitCol" title="가로 분할 — 포커스 페인을 상하로" disabled>▬ split</button>
        <button class="tc-btn session" id="sessionBtn" title="자유 세션(폴더 지정 터미널) 열기">＋ Session</button>
        <button class="tc-btn" id="closeBtn" title="포커스 페인 닫기(탭은 유지)" disabled>× pane</button>
      </div>
    </div>
    <div class="panes" id="panes"></div>
    <div class="empty" id="empty">
      <div class="card">
        <div class="glyph">⌗ ⌗ ⌗</div>
        <h1>여기서 작업을 시작하세요</h1>
        <p>직접 몰고 갈 <b>작업 세션</b>(자유 터미널)을 열거나, 아래 요청바로 에이전트를 팬아웃하세요. 트리의 <b>run</b> 을 클릭해도 <b>탭</b>으로 열립니다.</p>
        <button class="cta" id="sessionCta">＋ 새 작업 세션 열기</button>
        <div class="hint">세션 = <b>지정한 폴더</b>의 tmux 셸(특정 프로젝트에 소속되지 않음). 그 안에서 <code>claude</code> 를 띄워 “이 프로젝트 구현해줘” 처럼 직접 지시할 수 있습니다.</div>
      </div>
    </div>
    <div class="reqbar">
      <div class="modes">
        <button type="button" class="mode on" data-mode="new" title="새 태스크를 만들고 N개 에이전트로 팬아웃">⌗ New</button>
        <button type="button" class="mode" data-mode="steer" title="포커스한 run 에 후속 지시">➤ Steer</button>
        <button type="button" class="mode" data-mode="bcast" title="열린 모든 페인 터미널에 그대로 입력">⊞ Broadcast</button>
      </div>
      <span class="rlbl" id="newCtl">
        <select id="reqRepo" title="대상 repo"></select>
        <select id="reqAgent" title="에이전트"></select>
        <select id="reqCount" title="팬아웃 개수">
          <option value="1">×1</option><option value="2">×2</option><option value="3" selected>×3</option><option value="4">×4</option>
        </select>
        <label class="rchk" title="실제 CLI 실행 (기본=드라이런)"><input type="checkbox" id="reqReal" /> real</label>
      </span>
      <span class="tgt" id="reqTgt" style="display:none"></span>
      <input class="reqinput" id="reqInput" placeholder="무엇을 만들까요? — 요청을 적고 ⏎ 로 3개 에이전트에 팬아웃" autocomplete="off" />
      <button type="button" class="reqgo" id="reqGo">Run ⏎</button>
    </div>
  </main>
</div>

<section class="review" id="review">
  <div class="rv-head">
    <span style="color:var(--brand)">⧉ Review</span>
    <span>·</span>
    <select id="rvTask" title="비교할 태스크"></select>
    <span class="rv-vcmd">
      <span style="color:var(--faint)">verify:</span>
      <input id="rvVcmd" placeholder="예: npm test — 정착 시 자동 실행" autocomplete="off" />
      <button type="button" id="rvVsave">save</button>
    </span>
    <span id="rvHint" style="margin-left:auto;color:var(--faint)">정착하면 자동 검증 · 승자를 base 에 merge</span>
  </div>
  <div class="rv-cols" id="rvCols"></div>
</section>

<div class="modal" id="pickModal">
  <div class="pick">
    <div class="pick-h"><span class="t">세션 폴더 지정</span><button class="x" id="pickClose" title="닫기">×</button></div>
    <div class="pick-path" id="pickPath">…</div>
    <div class="pick-list" id="pickList"></div>
    <div class="pick-f">
      <button class="home" id="pickHome" title="홈으로">⌂ home</button>
      <input class="pick-name" id="pickName" placeholder="세션 이름 (선택 — 비우면 폴더명)" autocomplete="off" />
      <button class="go" id="pickGo">여기서 열기</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script src="/vendor/xterm.js"></script>
<script src="/vendor/addon-fit.js"></script>
<script src="/vendor/addon-unicode11.js"></script>
<script>
  // 모바일은 터미널 우선 대신 보드(모니터)로.
  if (window.innerWidth <= 860 && matchMedia('(pointer:coarse)').matches) location.replace('/');
  var esc = function(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); };
  var $ = function(id){ return document.getElementById(id); };

  function toast(msg){ var t=$('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toast._h); toast._h=setTimeout(function(){ t.classList.remove('show'); }, 2600); }
  var V_GLYPH = { pass:'✓ verify', fail:'✗ verify', running:'⋯ verify', error:'⚠ verify' };
  function vbadge(status){ if (!status || !V_GLYPH[status]) return ''; return '<span class="vbadge '+status+'" data-role="vbadge">'+V_GLYPH[status]+'</span>'; }

  // ── fleet 상태 ──
  var fleet = { machines:[], repos:[], tasks:[], groups:[], runs:[], providers:[] };
  var runById = {}, taskById = {}, repoById = {};
  var fold = {};   // 접힘 상태(repo/goal/task 노드)
  function isFold(k){ return fold[k]===true; }
  function repoOfRun(runId){ var r=runById[runId]; var t=r&&taskById[r.taskId]; return t?t.repoId:null; }

  async function hydrate(){
    try{
      var d = await (await fetch('/api/fleet?view=all')).json();
      fleet = d; runById = {}; taskById = {}; repoById = {};
      (d.runs||[]).forEach(function(r){ runById[r.id]=r; });
      (d.tasks||[]).forEach(function(t){ taskById[t.id]=t; });
      (d.repos||[]).forEach(function(r){ repoById[r.id]=r; });
      if (d.machines && d.machines[0]) { $('mach').textContent = d.machines[0].slug; $('machName').textContent = d.machines[0].slug; }
      renderTree();
      syncPanes();
      populateReq();
      if (reviewOn) renderReviewPicker();
    }catch(e){ /* 재시도는 WS 재연결 or 다음 hydrate */ }
  }

  // ── 요청바 셀렉트 채우기(선택 유지) ──
  function fillSelect(sel, items, val, label, keep){
    var cur = keep && sel.value; sel.innerHTML='';
    items.forEach(function(it){ var o=document.createElement('option'); o.value=val(it); o.textContent=label(it); sel.appendChild(o); });
    if (cur){ for (var i=0;i<sel.options.length;i++){ if (sel.options[i].value===cur){ sel.value=cur; break; } } }
  }
  function populateReq(){
    var repos = (fleet.repos||[]).filter(function(r){ return r.kind!=='sessions'; });
    fillSelect($('reqRepo'), repos, function(r){return String(r.id);}, function(r){return r.name;}, true);
    // repo 미선택 상태면 포커스 페인의 repo 로 기본
    var fr=(typeof focusedRunId==='function')?focusedRunId():null; if (fr!=null){ var rp = repoOfRun(fr); if (rp!=null) $('reqRepo').value=String(rp); }
    var provs = fleet.providers||[];
    if (provs.length) fillSelect($('reqAgent'), provs, function(p){return p.id;}, function(p){return p.label||p.id;}, true);
    else if (!$('reqAgent').options.length){ var o=document.createElement('option'); o.value='claude-code'; o.textContent='claude-code'; $('reqAgent').appendChild(o); }
  }

  // ── 트리 렌더: Machine ▸ Repo ▸ Goal ▸ Task ▸ Run ──
  function renderTree(){
    var el = $('tree');
    var repos = fleet.repos||[], tasks = fleet.tasks||[], groups = fleet.groups||[], runs = fleet.runs||[];
    var groupById = {}; groups.forEach(function(g){ groupById[g.id]=g; });
    var tasksByRepo = {}; tasks.forEach(function(t){ (tasksByRepo[t.repoId]=tasksByRepo[t.repoId]||[]).push(t); });
    var runsByTask = {}; runs.forEach(function(r){ (runsByTask[r.taskId]=runsByTask[r.taskId]||[]).push(r); });
    // 세션 버킷(kind='sessions') 분리 — 프로젝트 트리와 별개 SESSIONS 섹션
    var sessionRepoIds = {}; repos.forEach(function(r){ if (r.kind==='sessions') sessionRepoIds[r.id]=true; });
    var realRepos = repos.filter(function(r){ return r.kind!=='sessions'; });
    var sessRuns = [];
    tasks.forEach(function(t){ if (sessionRepoIds[t.repoId]) (runsByTask[t.id]||[]).forEach(function(r){ sessRuns.push({run:r, title:t.title}); }); });
    sessRuns.sort(function(a,b){ return b.run.id-a.run.id; });

    var html = '';
    // ── SESSIONS (자유 세션) ──
    html += '<div class="lbl"><span>Sessions</span><span class="lnk" data-newsession="1">＋ 새 세션</span></div>';
    if (sessRuns.length){
      sessRuns.forEach(function(s){
        var r=s.run; var open = tabs[r.id] ? ' open' : '';
        html += '<div class="tnode session'+open+'" data-run="'+r.id+'"><span class="st '+esc(r.status)+'"></span>'
          + '<span class="n">'+esc(s.title||'session')+'</span><span class="p">'+esc((r.worktreePath||'').replace(/^.*\\/([^/]+\\/[^/]+)$/,'…/$1'))+'</span></div>';
      });
    } else {
      html += '<div class="tnode empty" style="padding-left:14px">열린 세션 없음 — ＋ Session 으로 폴더 지정</div>';
    }
    html += '<div class="tree-sep"></div>';
    html += '<div class="lbl"><span>Projects</span></div>';
    if (!realRepos.length){ html += '<div class="tnode empty">등록된 repo 가 없습니다 — 보드에서 추가하세요.</div>'; }
    realRepos.forEach(function(repo){
      var rk = 'repo'+repo.id;
      var rTasks = (tasksByRepo[repo.id]||[]).filter(function(t){ return t.status!=='closed'; });
      var runCount = rTasks.reduce(function(n,t){ return n+((runsByTask[t.id]||[]).length); }, 0);
      html += '<div class="tnode repo" data-fold="'+rk+'"><span class="car">'+(isFold(rk)?'▸':'▾')+'</span>'
        + '<span class="n">'+esc(repo.name)+'</span><span class="meta">'+runCount+' run'+(runCount===1?'':'s')+'</span></div>';
      if (isFold(rk)) return;
      // goal(group) 로 묶기
      var byGroup = {}, ungrouped = [];
      rTasks.forEach(function(t){ if (t.groupId && groupById[t.groupId]) (byGroup[t.groupId]=byGroup[t.groupId]||[]).push(t); else ungrouped.push(t); });
      Object.keys(byGroup).forEach(function(gid){
        var g = groupById[gid]; var gk='goal'+gid;
        html += '<div class="tnode goal" data-fold="'+gk+'"><span class="car">'+(isFold(gk)?'▸':'▾')+'</span>'
          + '<span class="gi">⌁</span><span class="n">'+esc(g.title)+'</span><span class="meta">'+(g.kind||'goal')+'</span></div>';
        if (!isFold(gk)) byGroup[gid].forEach(function(t){ html += taskHTML(t, runsByTask[t.id]||[]); });
      });
      ungrouped.forEach(function(t){ html += taskHTML(t, runsByTask[t.id]||[]); });
      if (!rTasks.length) html += '<div class="tnode empty" style="padding-left:30px">태스크 없음</div>';
    });
    el.innerHTML = html;
  }
  function taskHTML(t, rns){
    var tk='task'+t.id;
    var s = '<div class="tnode task" data-fold="'+tk+'"><span class="car">'+(rns.length?(isFold(tk)?'▸':'▾'):' ')+'</span>'
      + '<span class="n">'+esc(t.title)+'</span></div>';
    if (!isFold(tk)) rns.sort(function(a,b){return a.id-b.id;}).forEach(function(r){
      var open = tabs[r.id] ? ' open' : '';
      s += '<div class="tnode run'+open+'" data-run="'+r.id+'"><span class="st '+esc(r.status)+'"></span>'
        + '<span class="n">r'+r.id+' · '+esc(r.status)+'</span></div>';
    });
    return s;
  }
  $('tree').addEventListener('click', function(e){
    if (e.target.closest('[data-newsession]')){ openSession(); return; }
    var run = e.target.closest('[data-run]');
    if (run){ openRunPane(+run.dataset.run); return; }
    var fn = e.target.closest('[data-fold]');
    if (fn){ var k = fn.dataset.fold; fold[k] = !isFold(k); renderTree(); }
  });
  // 트리 세션 행 더블클릭 → 이름 변경
  $('tree').addEventListener('dblclick', function(e){
    var s = e.target.closest('.tnode.session[data-run]'); if(!s) return;
    var runId=+s.dataset.run; var r=runById[runId]; if(!r) return;
    var cur=(taskById[r.taskId]||{}).title||''; var v=prompt('세션 이름', cur);
    if(v!=null && v.trim()) renameTask(r.taskId, v.trim());
  });

  // ── 탭 + 분할 트리 페인 ──
  // 탭 = 열린 세션/run. 탭이 xterm·WS 를 소유(안 보여도 살아있음). 슬롯(leaf)에 배치돼 표시된다.
  var tabs = {};             // runId -> { runId, name, term, fit, ws, retry, closing, ro, host }
  var tabOrder = [];         // 탭 바 순서(runId)
  var layout = { leaf:true, id:'L0', tab:null };  // 분할 트리 루트
  var focusLeaf = 'L0';
  var leafSeq = 1;
  var MAX_LEAVES = 6;
  var dragRunId = null;

  function newLeafId(){ return 'L'+(leafSeq++); }
  function eachLeaf(node, fn){ if(node.leaf){ fn(node); } else { eachLeaf(node.a,fn); eachLeaf(node.b,fn); } }
  function findLeaf(id, node){ node=node||layout; if(node.leaf) return node.id===id?node:null; return findLeaf(id,node.a)||findLeaf(id,node.b); }
  function findSplit(id, node){ node=node||layout; if(node.leaf) return null; if(node.id===id) return node; return findSplit(id,node.a)||findSplit(id,node.b); }
  function leafOfTab(runId){ var f=null; eachLeaf(layout,function(l){ if(l.tab===runId) f=l; }); return f; }
  function firstLeaf(){ var f=null; eachLeaf(layout,function(l){ if(!f) f=l; }); return f; }
  function countLeaves(){ var n=0; eachLeaf(layout,function(){n++;}); return n; }
  function focusedRunId(){ var l=findLeaf(focusLeaf); return l?l.tab:null; }
  function focusRun(){ return focusedRunId(); }   // 기존 호출부(steer/review) 호환
  function copyInto(dst,src){ Object.keys(dst).forEach(function(k){delete dst[k];}); Object.keys(src).forEach(function(k){dst[k]=src[k];}); }

  function tabName(runId){
    var r=runById[runId]; if(!r) return 'r'+runId;
    var task=taskById[r.taskId]; var rp=task&&repoById[task.repoId];
    if (rp && rp.kind==='sessions') return (task&&task.title)||('session r'+runId);
    return 'r'+runId;
  }

  function ensureTab(runId){
    if (tabs[runId]) return tabs[runId];
    var host=document.createElement('div'); host.className='term-host';
    var term=new window.Terminal({
      fontFamily: "ui-monospace, 'SF Mono', Menlo, Monaco, 'Apple SD Gothic Neo', 'Noto Sans KR', monospace",
      fontSize: 12, cursorBlink: true, allowProposedApi: true, scrollback: 4000,
      theme: { background:'#0b0d12', foreground:'#dee4ec', cursor:'#4ec9b0', selectionBackground:'rgba(78,201,176,.25)', black:'#1c212c', brightBlack:'#5c6675' },
    });
    var fit=new window.FitAddon.FitAddon(); term.loadAddon(fit);
    try{ term.loadAddon(new window.Unicode11Addon.Unicode11Addon()); term.unicode.activeVersion='11'; }catch(e){}
    // term.open 은 host 가 DOM 에 붙은 뒤(attachHosts) 최초 1회 — detached 에서 open 하면 렌더러가 안 뜬다.
    var t={ runId:runId, name:tabName(runId), term:term, fit:fit, ws:null, retry:0, closing:false, host:host, ro:null, opened:false, connected:false };
    term.onData(function(d){ if(t.ws&&t.ws.readyState===1) t.ws.send(JSON.stringify({t:'i',d:d})); });
    tabs[runId]=t; tabOrder.push(runId);
    return t;   // open·connect 는 attachHosts 에서(Phase 2 순서: open → connect)
  }
  function connectTab(t){
    if (t.closing || !t.term) return;
    try{ t.fit.fit(); }catch(e){}
    var proto = location.protocol==='https:'?'wss':'ws';
    var sock = new WebSocket(proto+'://'+location.host+'/ws/term/'+t.runId+'?cols='+t.term.cols+'&rows='+t.term.rows);
    t.ws = sock;
    sock.onopen = function(){ if (sock!==t.ws){ try{sock.close();}catch(e){} return; } t.retry=0; };
    sock.onmessage = function(m){
      if (sock!==t.ws || !t.term) return;
      try{ var d = JSON.parse(m.data);
        if (d.t==='o') t.term.write(d.d);
        else if (d.t==='err') t.term.write('\\r\\n\\x1b[31m'+d.d+'\\x1b[0m\\r\\n');
        else if (d.t==='exit') t.term.write('\\r\\n\\x1b[90m[session ended — 재연결 시 소생]\\x1b[0m\\r\\n');
      }catch(e){}
    };
    sock.onclose = function(){
      if (sock!==t.ws || t.closing) return;
      var delay = Math.min(8000, 800 * Math.pow(2, t.retry++));
      setTimeout(function(){ connectTab(t); }, delay);
    };
  }

  function fitTab(t){ if(!t||!t.fit||!t.term) return; try{ t.fit.fit(); if(t.ws&&t.ws.readyState===1) t.ws.send(JSON.stringify({t:'r',cols:t.term.cols,rows:t.term.rows})); }catch(e){} }
  function fitAllVisible(){ eachLeaf(layout,function(l){ if(l.tab!=null && tabs[l.tab] && tabs[l.tab].host.isConnected) fitTab(tabs[l.tab]); }); }

  // ── 탭 바 렌더(터미널 없음 — 언제든 안전) ──
  function renderTabs(){
    var shown={}; eachLeaf(layout,function(l){ if(l.tab!=null) shown[l.tab]=true; });
    var html='';
    tabOrder.forEach(function(runId){
      var t=tabs[runId]; if(!t) return; var r=runById[runId];
      html += '<div class="tab'+(shown[runId]?' shown':'')+'" draggable="true" data-tab="'+runId+'" title="더블클릭=이름변경 · 드래그=페인에 배치">'
        + '<span class="st '+esc(r?r.status:'')+'"></span>'
        + '<span class="nm">'+esc(t.name)+'</span>'
        + '<button class="x" title="탭 닫기(터미널 종료)">×</button></div>';
    });
    $('tabs').innerHTML = html;
  }
  function buildNode(node){
    if (node.leaf){
      var leaf=document.createElement('div'); leaf.className='leaf'+(node.id===focusLeaf?' focus':''); leaf.dataset.leaf=node.id;
      var t=node.tab!=null?tabs[node.tab]:null; var r=node.tab!=null?runById[node.tab]:null;
      var head=document.createElement('div'); head.className='leaf-h'; head.dataset.leafhead=node.id;
      head.innerHTML = t
        ? '<span class="st '+esc(r?r.status:'')+'"></span><span class="nm">'+esc(t.name)+'</span>'
          + '<span data-role="chip" class="chip '+esc(r?r.status:'')+'">'+esc(r?r.status:'')+'</span>'
          + '<span data-role="vslot">'+vbadge(r&&r.verifyStatus)+'</span>'
          + '<button class="x" title="이 페인 닫기(탭은 유지)">×</button>'
        : '<span class="nm" style="color:var(--faint)">빈 페인</span><button class="x" title="이 페인 닫기">×</button>';
      var body=document.createElement('div'); body.className='leaf-body'; body.dataset.leafbody=node.id;
      if (!t){ var em=document.createElement('div'); em.className='leaf-empty'; em.textContent='탭을 여기로 드래그하거나 탭을 클릭하세요'; body.appendChild(em); }
      leaf.appendChild(head); leaf.appendChild(body); return leaf;
    }
    var el=document.createElement('div'); el.className='node '+(node.dir==='col'?'col':'row'); el.dataset.split=node.id;
    var a=buildNode(node.a), b=buildNode(node.b);
    a.style.flexGrow=String(node.ratio); a.style.flexBasis='0';
    b.style.flexGrow=String(1-node.ratio); b.style.flexBasis='0';
    var g=document.createElement('div'); g.className='gutter '+(node.dir==='col'?'col':'row'); g.dataset.gutter=node.id;
    el.appendChild(a); el.appendChild(g); el.appendChild(b); return el;
  }
  // host 를 DOM 에 붙이고, 최초 1회 open → connect(Phase 2 순서). fit 은 render 의 rAF 에서.
  function attachHosts(){ eachLeaf(layout,function(l){ if(l.tab==null||!tabs[l.tab]) return; var t=tabs[l.tab]; var body=$('panes').querySelector('[data-leafbody="'+l.id+'"]'); if(!body) return; body.appendChild(t.host);
    if(!t.opened){ try{ t.term.open(t.host); t.opened=true; }catch(e){} }
    if(!t.connected){ t.connected=true; connectTab(t); }
  }); }
  function updateControls(){
    var has=tabOrder.length>0; var canSplit=has && countLeaves()<MAX_LEAVES;
    $('splitRow').disabled=!canSplit; $('splitCol').disabled=!canSplit; $('closeBtn').disabled=!has;
  }
  // 구조 변경 시 전체 재구성(탭 열기·닫기·분할·드롭·리사이즈완료)
  function render(){
    var n=tabOrder.length;
    $('empty').style.display = n?'none':'flex';
    $('panes').style.display = n?'flex':'none';
    renderTabs();
    var host=$('panes'); host.innerHTML='';
    if (n){ host.appendChild(buildNode(layout)); attachHosts(); }
    updateControls();
    if (typeof reqMode!=='undefined') setMode(reqMode);
    requestAnimationFrame(fitAllVisible);
    setTimeout(fitAllVisible, 60);   // 레이아웃 확정 후 재핏(초기 0-size 보정)
  }
  function setLeafFocus(id){
    focusLeaf=id;
    Array.prototype.forEach.call($('panes').querySelectorAll('.leaf'),function(el){ el.classList.toggle('focus', el.dataset.leaf===id); });
    var rid=focusedRunId(); if(rid!=null && tabs[rid]) try{ tabs[rid].term.focus(); }catch(e){}
    updateControls();
    if (typeof reqMode!=='undefined' && reqMode!=='new') setMode(reqMode);
  }

  // 탭 열기 = 포커스 슬롯에 표시(강제 분할 없음). 기존 호출부(openRunPane) 호환.
  function openTab(runId){
    ensureTab(runId);
    var l=leafOfTab(runId);
    if (l){ setLeafFocus(l.id); return; }
    var f=findLeaf(focusLeaf) || firstLeaf();
    if (!f){ layout={leaf:true,id:'L0',tab:runId}; focusLeaf='L0'; }
    else { f.tab=runId; focusLeaf=f.id; }
    render(); renderTree();
  }
  function openRunPane(runId){ return openTab(runId); }

  function splitFocused(dir){
    if (!tabOrder.length) return;
    if (countLeaves()>=MAX_LEAVES){ toast('페인 최대 '+MAX_LEAVES+'개'); return; }
    var l=findLeaf(focusLeaf) || firstLeaf(); if(!l) return;
    var keep=l.tab; var aId=l.id, bId=newLeafId();
    delete l.tab; delete l.leaf; l.id=newLeafId(); l.split=true; l.dir=dir; l.ratio=0.5;
    l.a={leaf:true,id:aId,tab:keep}; l.b={leaf:true,id:bId,tab:null};
    focusLeaf=bId; render(); renderTree();
  }
  function closeSlot(id){
    if (countLeaves()<=1){ var only=findLeaf(id)||firstLeaf(); if(only) only.tab=null; if(only) focusLeaf=only.id; render(); renderTree(); return; }
    (function walk(node){
      if(node.leaf) return false;
      if(node.a.leaf && node.a.id===id){ copyInto(node,node.b); return true; }
      if(node.b.leaf && node.b.id===id){ copyInto(node,node.a); return true; }
      return walk(node.a)||walk(node.b);
    })(layout);
    if(!findLeaf(focusLeaf)){ var f=firstLeaf(); focusLeaf=f?f.id:'L0'; }
    render(); renderTree();
  }
  function closeTab(runId){
    var t=tabs[runId]; if(!t) return; t.closing=true;
    try{ if(t.ws) t.ws.close(); }catch(e){}
    try{ if(t.ro) t.ro.disconnect(); }catch(e){}
    try{ t.term.dispose(); }catch(e){}
    eachLeaf(layout,function(l){ if(l.tab===runId) l.tab=null; });
    delete tabs[runId]; tabOrder=tabOrder.filter(function(x){return x!==runId;});
    render(); renderTree();
  }
  // 팬아웃 — N개 탭을 만들고 자동 타일 배치(비교용)
  function buildTiled(ids,dir){
    if(ids.length===1) return {leaf:true,id:newLeafId(),tab:ids[0]};
    var mid=Math.ceil(ids.length/2);
    return {split:true,id:newLeafId(),dir:dir,ratio:mid/ids.length,
      a:buildTiled(ids.slice(0,mid),dir==='row'?'col':'row'),
      b:buildTiled(ids.slice(mid),dir==='row'?'col':'row')};
  }
  function tileTabs(ids){
    ids=(ids||[]).filter(function(x){return x!=null;}); if(!ids.length) return;
    ids.forEach(ensureTab);
    layout=buildTiled(ids,'row'); var f=firstLeaf(); focusLeaf=f?f.id:'L0';
    render(); renderTree();
  }

  // fleet 갱신 시 라벨·상태만 갱신(페인 DOM 재구성 X — 터미널 유지). 사라진 run 탭 정리.
  function syncPanes(){
    tabOrder.slice().forEach(function(runId){ if(!runById[runId]) closeTab(runId); });
    tabOrder.forEach(function(runId){ var t=tabs[runId]; if(t) t.name=tabName(runId); });
    renderTabs();
    eachLeaf(layout,function(l){
      if(l.tab==null) return; var r=runById[l.tab]; if(!r) return;
      var head=$('panes').querySelector('[data-leafhead="'+l.id+'"]'); if(!head) return;
      var nm=head.querySelector('.nm'); if(nm && tabs[l.tab]) nm.textContent=tabs[l.tab].name;
      var st=head.querySelector('.st'); if(st) st.className='st '+r.status;
      var chip=head.querySelector('[data-role=chip]'); if(chip){ chip.className='chip '+r.status; chip.textContent=r.status; }
      var vslot=head.querySelector('[data-role=vslot]'); if(vslot) vslot.innerHTML=vbadge(r.verifyStatus);
    });
  }

  // 인라인 이름 변경(탭 더블클릭)
  function startRename(runId, tabEl){
    var r=runById[runId]; var t=tabs[runId]; if(!r||!t) return;
    var nm=tabEl.querySelector('.nm'); if(!nm) return;
    var input=document.createElement('input'); input.className='ren'; input.value=t.name;
    nm.replaceWith(input); input.focus(); input.select();
    var done=false;
    function finish(commit){ if(done) return; done=true;
      var val=input.value.trim();
      var span=document.createElement('span'); span.className='nm'; span.textContent=(commit&&val)?val:t.name;
      input.replaceWith(span);
      if(commit && val && val!==t.name) renameTask(r.taskId, val);
    }
    input.addEventListener('keydown', function(e){ e.stopPropagation(); if(e.key==='Enter'){ e.preventDefault(); finish(true); } else if(e.key==='Escape'){ finish(false); } });
    input.addEventListener('blur', function(){ finish(true); });
    input.addEventListener('click', function(e){ e.stopPropagation(); });
  }
  async function renameTask(taskId, title){
    try{
      var res=await fetch('/api/tasks/'+taskId,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({title:title})});
      if(res.ok){ if(taskById[taskId]) taskById[taskId].title=title; toast('이름 변경 · '+title); await hydrate(); }
      else { var j=await res.json().catch(function(){return{};}); toast('이름 변경 실패: '+(j.error||res.status)); }
    }catch(e){ toast('이름 변경 실패: '+e); }
  }

  // ── 탭 바 이벤트 ──
  $('tabs').addEventListener('click', function(e){
    var tabEl=e.target.closest('[data-tab]'); if(!tabEl) return; var runId=+tabEl.dataset.tab;
    if (e.target.closest('.x')){ closeTab(runId); return; }
    openTab(runId);
  });
  $('tabs').addEventListener('dblclick', function(e){ var tabEl=e.target.closest('[data-tab]'); if(tabEl) startRename(+tabEl.dataset.tab, tabEl); });
  $('tabs').addEventListener('dragstart', function(e){ var tabEl=e.target.closest('[data-tab]'); if(!tabEl) return; dragRunId=+tabEl.dataset.tab; tabEl.classList.add('drag'); try{ e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain', String(dragRunId)); }catch(_){} });
  $('tabs').addEventListener('dragend', function(e){ var tabEl=e.target.closest('[data-tab]'); if(tabEl) tabEl.classList.remove('drag'); dragRunId=null; });

  // ── 페인(슬롯) 이벤트: 포커스·닫기·드롭·리사이즈 ──
  $('panes').addEventListener('click', function(e){
    var leaf=e.target.closest('[data-leaf]'); if(!leaf) return;
    if (e.target.closest('.leaf-h .x')){ closeSlot(leaf.dataset.leaf); return; }
    setLeafFocus(leaf.dataset.leaf);
  });
  $('panes').addEventListener('dragover', function(e){ var body=e.target.closest('[data-leafbody]'); if(body && dragRunId!=null){ e.preventDefault(); body.classList.add('drop'); } });
  $('panes').addEventListener('dragleave', function(e){ var body=e.target.closest('[data-leafbody]'); if(body) body.classList.remove('drop'); });
  $('panes').addEventListener('drop', function(e){
    var body=e.target.closest('[data-leafbody]'); if(!body || dragRunId==null) return; e.preventDefault(); body.classList.remove('drop');
    var l=findLeaf(body.dataset.leafbody); if(!l) return;
    var rid=dragRunId; eachLeaf(layout,function(x){ if(x.tab===rid) x.tab=null; });
    ensureTab(rid); l.tab=rid; focusLeaf=l.id; render(); renderTree();
  });
  $('panes').addEventListener('mousedown', function(e){
    var g=e.target.closest('[data-gutter]'); if(!g) return; e.preventDefault();
    var node=findSplit(g.dataset.gutter); if(!node) return;
    var container=g.parentElement; var rect=container.getBoundingClientRect(); var horiz=node.dir==='row';
    g.classList.add('drag');
    function mv(ev){
      var pos=horiz?(ev.clientX-rect.left)/rect.width:(ev.clientY-rect.top)/rect.height;
      node.ratio=Math.max(0.1,Math.min(0.9,pos));
      var a=container.children[0], b=container.children[2];
      if(a&&b){ a.style.flexGrow=String(node.ratio); b.style.flexGrow=String(1-node.ratio); }
    }
    function up(){ document.removeEventListener('mousemove',mv); document.removeEventListener('mouseup',up); g.classList.remove('drag'); fitAllVisible(); }
    document.addEventListener('mousemove',mv); document.addEventListener('mouseup',up);
  });
  $('splitRow').addEventListener('click', function(){ splitFocused('row'); });
  $('splitCol').addEventListener('click', function(){ splitFocused('col'); });
  $('closeBtn').addEventListener('click', function(){ if(focusLeaf) closeSlot(focusLeaf); });

  // ── 자유 세션 — 폴더를 지정해 tmux 셸(프로젝트 비소속). ──
  var pickPathCur = '';
  function machineSlug(){ return (fleet.machines && fleet.machines[0] && fleet.machines[0].slug) || 'local'; }
  function openSession(){ $('pickModal').classList.add('on'); $('pickName').value=''; browseTo(''); }
  function closePicker(){ $('pickModal').classList.remove('on'); }
  async function browseTo(p){
    try{
      var d = await (await fetch('/api/browse'+(p?('?path='+encodeURIComponent(p)):''))).json();
      pickPathCur = d.path; $('pickPath').textContent = d.path;
      var html = '';
      if (d.parent && d.parent!==d.path) html += '<div class="pick-row up" data-go="'+esc(d.parent)+'"><span class="ic">↑</span><span>..</span></div>';
      (d.dirs||[]).forEach(function(e){
        var full = d.path==='/' ? '/'+e.name : d.path+'/'+e.name;
        html += '<div class="pick-row" data-go="'+esc(full)+'"><span class="ic">'+(e.isRepo?'◆':'▸')+'</span>'
          + '<span>'+esc(e.name)+'</span>'+(e.isRepo?'<span class="rp">git</span>':'')+'</div>';
      });
      if (!(d.dirs||[]).length) html += '<div class="pick-row" style="cursor:default;color:var(--faint)">하위 폴더 없음 — 이 폴더에서 열 수 있습니다</div>';
      $('pickList').innerHTML = html;
    }catch(e){ $('pickList').innerHTML = '<div class="pick-row" style="color:var(--failed)">폴더를 읽을 수 없습니다</div>'; }
  }
  $('pickList').addEventListener('click', function(e){ var r=e.target.closest('[data-go]'); if (r) browseTo(r.dataset.go); });
  $('pickClose').addEventListener('click', closePicker);
  $('pickHome').addEventListener('click', function(){ browseTo(''); });
  $('pickModal').addEventListener('click', function(e){ if (e.target===this) closePicker(); });
  var openingSession = false;
  $('pickGo').addEventListener('click', async function(){
    if (openingSession || !pickPathCur) return;
    openingSession=true; $('pickGo').disabled=true;
    try{
      var nm = $('pickName').value.trim();
      var res = await fetch('/api/session',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({machineSlug:machineSlug(), path:pickPathCur, title:nm})});
      var j = await res.json().catch(function(){return{};});
      if (res.ok && j.runId){ closePicker(); await hydrate(); openRunPane(j.runId); toast('세션 열림 · '+(nm||pickPathCur)); }
      else toast('세션 실패: '+(j.detail||j.error||res.status));
    }catch(e){ toast('세션 실패: '+e); }
    finally{ openingSession=false; $('pickGo').disabled=false; }
  });
  $('pickName').addEventListener('keydown', function(e){ if(e.key==='Enter'){ e.preventDefault(); $('pickGo').click(); } });
  $('sessionBtn').addEventListener('click', openSession);
  $('sessionCta').addEventListener('click', openSession);

  // ── 요청바: New(팬아웃) / Steer / Broadcast ──
  var reqMode = 'new';
  function setMode(m){
    reqMode = m;
    Array.prototype.forEach.call(document.querySelectorAll('.mode'), function(b){ b.classList.toggle('on', b.dataset.mode===m); });
    var go=$('reqGo'), inp=$('reqInput');
    $('newCtl').style.display = m==='new'?'inline-flex':'none';
    $('reqTgt').style.display = m==='new'?'none':'inline';
    go.className = 'reqgo' + (m==='bcast'?' bcast':m==='steer'?' steer':'');
    if (m==='new'){ go.textContent='Run ⏎'; inp.placeholder='무엇을 만들까요? — 요청을 적고 ⏎ 로 팬아웃'; }
    else if (m==='steer'){ var rid=focusRun(); go.textContent='Steer ⏎';
      $('reqTgt').textContent = rid?('➤ r'+rid+' 에 후속 지시'):'포커스한 페인 없음';
      inp.placeholder = rid?('r'+rid+' 에이전트에게 다음 지시…'):'왼쪽 트리에서 run 을 열어 포커스하세요'; }
    else { go.textContent='Send ⏎'; var n=tabOrder.length;
      $('reqTgt').textContent = '⊞ 열린 탭 '+n+'개에 브로드캐스트';
      inp.placeholder = n?('열린 '+n+'개 터미널에 그대로 전송 (엔터 포함)'):'열린 탭이 없습니다'; }
  }
  Array.prototype.forEach.call(document.querySelectorAll('.mode'), function(b){ b.addEventListener('click', function(){ setMode(b.dataset.mode); $('reqInput').focus(); }); });

  var submitting = false;
  async function submitReq(){
    var inp = $('reqInput'); var text = inp.value.trim();
    if (reqMode==='new'){
      if (!text || submitting) return;
      var repoId = Number($('reqRepo').value); if (!repoId){ toast('repo 를 먼저 등록/선택하세요'); return; }
      submitting=true; $('reqGo').disabled=true;
      try{
        var title = text.length>72 ? text.slice(0,69)+'…' : text;
        var tk = await (await fetch('/api/tasks',{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({repoId:repoId, title:title, prompt:text})})).json();
        if (!tk || !tk.task){ toast('태스크 생성 실패'); return; }
        var count = Number($('reqCount').value)||1;
        var rr = await (await fetch('/api/tasks/'+tk.task.id+'/run',{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({agent:$('reqAgent').value, count:count, real:$('reqReal').checked})})).json();
        var ids = (rr&&rr.runs||[]).map(function(x){return x.id;});
        inp.value='';
        await hydrate();
        // 팬아웃은 비교가 목적 — N개 탭을 만들고 자동 타일 배치
        tileTabs(ids);
        toast(ids.length+'개 에이전트 팬아웃 · r'+ids.join(' r'));
      }catch(e){ toast('요청 실패: '+e); }
      finally{ submitting=false; $('reqGo').disabled=false; }
    } else if (reqMode==='steer'){
      var rid = focusRun(); if (!rid){ toast('포커스한 페인이 없습니다'); return; }
      if (!text || submitting) return;
      submitting=true; $('reqGo').disabled=true;
      try{
        var res = await fetch('/api/runs/'+rid+'/steer',{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({message:text})});
        if (res.ok){ inp.value=''; toast('r'+rid+' 에 후속 지시 전송'); }
        else { var j = await res.json().catch(function(){return{};}); toast('steer 불가: '+(j.error||res.status)); }
      }catch(e){ toast('steer 실패: '+e); }
      finally{ submitting=false; $('reqGo').disabled=false; }
    } else { // broadcast
      if (!tabOrder.length){ toast('열린 탭이 없습니다'); return; }
      var payload = text + '\\r';
      var sent=0;
      tabOrder.forEach(function(rid){ var t=tabs[rid]; if (t && t.ws && t.ws.readyState===1){ t.ws.send(JSON.stringify({t:'i',d:payload})); sent++; } });
      inp.value='';
      toast('브로드캐스트 → '+sent+'개 탭');
    }
  }
  $('reqGo').addEventListener('click', submitReq);
  $('reqInput').addEventListener('keydown', function(e){ if (e.key==='Enter' && !e.isComposing){ e.preventDefault(); submitReq(); } });

  // ── Review 탭: compare(diff 나란히) + merge 승자 ──
  var reviewOn = false, rvTaskId = null;
  function showTerminal(){ reviewOn=false; $('review').classList.remove('on'); $('vtReview').classList.remove('on'); $('vtTerm').classList.add('on'); }
  function showReview(){ reviewOn=true; $('review').classList.add('on'); $('vtReview').classList.add('on'); $('vtTerm').classList.remove('on'); renderReviewPicker(); }
  $('vtTerm').addEventListener('click', showTerminal);
  $('vtReview').addEventListener('click', showReview);
  function reviewableTasks(){
    var byTask = {}; (fleet.runs||[]).forEach(function(r){ byTask[r.taskId]=(byTask[r.taskId]||0)+1; });
    return (fleet.tasks||[]).filter(function(t){
      var rp = repoById[t.repoId]; if (rp && rp.kind==='sessions') return false;  // 세션은 리뷰 대상 아님
      return (byTask[t.id]||0)>=1;
    }).sort(function(a,b){ return b.id-a.id; });
  }
  function renderReviewPicker(){
    var tasks = reviewableTasks(); var sel=$('rvTask');
    var cur = rvTaskId!=null ? String(rvTaskId) : (focusRun()!=null && runById[focusRun()] ? String(runById[focusRun()].taskId) : (tasks[0]?String(tasks[0].id):''));
    sel.innerHTML='';
    tasks.forEach(function(t){ var rp=repoById[t.repoId]; var o=document.createElement('option'); o.value=String(t.id);
      o.textContent = (rp?rp.name+' · ':'')+t.title; sel.appendChild(o); });
    if (!tasks.length){ $('rvCols').innerHTML='<div class="rv-empty">비교할 run 이 있는 태스크가 아직 없습니다. Terminal 에서 팬아웃해 보세요.</div>'; rvTaskId=null; return; }
    if (cur){ sel.value=cur; } rvTaskId = Number(sel.value);
    syncVcmd();
    loadCompare(rvTaskId);
  }
  $('rvTask').addEventListener('change', function(){ rvTaskId=Number(this.value); syncVcmd(); loadCompare(rvTaskId); });
  function diffHTML(text){
    if (!text || !text.trim()) return '<span style="color:var(--faint)">no changes</span>';
    return text.split('\\n').map(function(l){
      var e = esc(l) || '&nbsp;';
      if (l.indexOf('diff --git')===0 || l.indexOf('+++')===0 || l.indexOf('---')===0) return '<span class="dl-file">'+e+'</span>';
      if (l.indexOf('@@')===0) return '<span class="dl-hunk">'+e+'</span>';
      if (l.charAt(0)==='+') return '<span class="dl-add">'+e+'</span>';
      if (l.charAt(0)==='-') return '<span class="dl-del">'+e+'</span>';
      return '<span class="dl-ctx">'+e+'</span>';
    }).join('');
  }
  async function loadCompare(taskId){
    var host=$('rvCols'); host.innerHTML='<div class="rv-empty">불러오는 중…</div>';
    var task = taskById[taskId]; var repo = task && repoById[task.repoId];
    var hasVerify = !!(repo && repo.verifyCmd && repo.verifyCmd.trim());
    try{
      var d = await (await fetch('/api/tasks/'+taskId+'/compare')).json();
      var rns = (d.runs||[]).sort(function(a,b){return a.id-b.id;});
      if (!rns.length){ host.innerHTML='<div class="rv-empty">run 이 없습니다.</div>'; return; }
      host.innerHTML='';
      rns.forEach(function(r){
        var col=document.createElement('div'); col.className='rv-col';
        var st = typeof r.stat==='string' ? r.stat.split('\\n').pop().trim() : '';
        var mergeable = (r.status==='done'||r.status==='open'||r.status==='merged') && r.filesChanged>0;
        // green-gate: verifyCmd 있는데 pass 아니면 "merge anyway"(주의색) — 막지 않고 경고
        var gated = hasVerify && r.verifyStatus!=='pass';
        var mlabel = r.status==='merged' ? 'merged' : (gated ? 'merge anyway' : 'merge ▸');
        var vline = '';
        if (hasVerify){
          var vs = r.verifyStatus||''; var out = (r.verifyOutput||'').split('\\n').pop();
          var txt = vs==='pass'?'통과' : vs==='fail'?'실패' : vs==='running'?'검증 중…' : vs==='error'?'검증 오류' : '미검증';
          vline = '<div class="rv-verify">'+(vbadge(vs)||'<span class="vbadge error">· verify</span>')
            + '<span class="vout" data-vout="'+r.id+'" title="클릭=전체 출력">'+esc(txt+(out?' — '+out:''))+'</span>'
            + '<button class="rv-reverify" data-reverify="'+r.id+'">re-verify</button></div>';
        }
        col.innerHTML = '<div class="rv-col-h"><span class="st '+esc(r.status)+'" style="width:7px;height:7px;border-radius:50%;display:inline-block"></span>'
          + '<span class="rid">r'+r.id+'</span><span class="chip '+esc(r.status)+'">'+esc(r.status)+'</span>'
          + '<span class="stat">'+esc(st)+'</span>'
          + '<button class="rv-merge'+(gated?' caution':'')+'" data-merge="'+r.id+'"'+((r.status==='merged'||!mergeable)?' disabled':'')
          + (gated?' title="검증 미통과 — 그래도 머지"':'')+'>'+mlabel+'</button></div>'
          + vline
          + '<div class="rv-diff">'+diffHTML(r.diff)+'</div>';
        col._vout = { text: r.verifyOutput||'' };
        host.appendChild(col);
      });
      // 전체 verify 출력 저장(툴팁·토스트용)
      voutById = {}; rns.forEach(function(r){ voutById[r.id]=r.verifyOutput||''; });
    }catch(e){ host.innerHTML='<div class="rv-empty">compare 실패: '+esc(String(e))+'</div>'; }
  }
  var voutById = {};
  $('rvCols').addEventListener('click', async function(e){
    var vo = e.target.closest('[data-vout]');
    if (vo){ var t = voutById[vo.dataset.vout]||''; toast(t? t.slice(-600) : '검증 출력 없음'); return; }
    var rv = e.target.closest('[data-reverify]');
    if (rv){ var id=rv.dataset.reverify; rv.disabled=true; rv.textContent='…';
      try{ await fetch('/api/runs/'+id+'/verify',{method:'POST'}); toast('r'+id+' 재검증 시작'); }
      catch(err){ toast('재검증 실패: '+err); rv.disabled=false; rv.textContent='re-verify'; }
      return; }
    var b = e.target.closest('[data-merge]'); if (!b) return;
    var rid = b.dataset.merge; var prev=b.textContent; b.disabled=true; b.textContent='merging…';
    try{
      var res = await fetch('/api/runs/'+rid+'/merge',{method:'POST'});
      var j = await res.json().catch(function(){return{};});
      if (res.ok){ toast('r'+rid+' merge 완료'); await hydrate(); if (rvTaskId!=null) loadCompare(rvTaskId); }
      else { toast('merge 불가: '+(j.error||j.reason||res.status)); b.disabled=false; b.textContent=prev; }
    }catch(err){ toast('merge 실패: '+err); b.disabled=false; b.textContent=prev; }
  });
  // verify 명령 저장(선택 태스크의 repo 에)
  function syncVcmd(){
    var t = rvTaskId!=null?taskById[rvTaskId]:null; var rp = t&&repoById[t.repoId];
    $('rvVcmd').value = rp ? (rp.verifyCmd||'') : '';
    $('rvVcmd').dataset.repo = rp ? String(rp.id) : '';
  }
  async function saveVcmd(){
    var rid = $('rvVcmd').dataset.repo; if (!rid){ toast('repo 를 알 수 없습니다'); return; }
    var cmd = $('rvVcmd').value.trim();
    try{
      var res = await fetch('/api/repos/'+rid,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({verifyCmd:cmd})});
      var j = await res.json().catch(function(){return{};});
      if (res.ok){ if (repoById[rid]) repoById[rid].verifyCmd=cmd; toast(cmd?'verify 명령 저장':'verify 끔'); await hydrate(); if (rvTaskId!=null){ syncVcmd(); loadCompare(rvTaskId); } }
      else toast('저장 실패: '+(j.error||res.status));
    }catch(err){ toast('저장 실패: '+err); }
  }
  $('rvVsave').addEventListener('click', saveVcmd);
  $('rvVcmd').addEventListener('keydown', function(e){ if (e.key==='Enter'){ e.preventDefault(); saveVcmd(); } });

  // ── /ws 라이브 구독 → 트리·페인 갱신 ──
  function wsConnect(){
    var proto = location.protocol==='https:'?'wss':'ws';
    var ws = new WebSocket(proto+'://'+location.host+'/ws');
    ws.onopen = function(){ $('ws').classList.add('on'); $('wstext').textContent='live'; };
    ws.onclose = function(){ $('ws').classList.remove('on'); $('wstext').textContent='reconnecting'; setTimeout(wsConnect, 1500); };
    ws.onmessage = function(){ /* 델타는 종류가 많아 단순히 전체 리하이드레이트(디바운스) */ scheduleHydrate(); };
  }
  var hydT=null;
  function scheduleHydrate(){ if (hydT) return; hydT = setTimeout(function(){ hydT=null; hydrate(); }, 400); }

  setMode('new');
  render();   // 초기 빈 상태 정합(탭 없음 → empty)
  hydrate();
  wsConnect();
  window.addEventListener('resize', fitAllVisible);
</script>
</body>
</html>`;
