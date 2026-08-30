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

  /* ── pane grid (창분할) ── */
  .stage{display:flex;flex-direction:column;min-width:0;background:var(--bg)}
  .panebar{display:flex;align-items:center;gap:8px;height:36px;padding:0 12px;border-bottom:1px solid var(--line);background:var(--panel);font-family:var(--mono);font-size:11.5px;color:var(--faint)}
  .panebar .grow{flex:1}
  .pb-btn{background:none;border:1px solid var(--line);border-radius:6px;color:var(--muted);font-size:11px;padding:3px 9px;cursor:pointer;font-family:var(--mono)}
  .pb-btn:hover:not([disabled]){color:var(--ink);border-color:var(--line-hi)}
  .pb-btn[disabled]{opacity:.4;cursor:default}
  .panes{flex:1;display:none;gap:1px;background:var(--line);padding:1px;min-height:0}  /* 초기 숨김 — layoutPanes 가 페인 있을 때만 grid 로 */
  .pane{display:flex;flex-direction:column;background:var(--bg);min-width:0;min-height:0;overflow:hidden}
  .pane.focus .pane-h{background:var(--brand-dim)}
  .pane.focus{box-shadow:inset 0 0 0 1px rgba(78,201,176,.4)}
  .pane-h{display:flex;align-items:center;gap:8px;height:28px;padding:0 10px;background:var(--surface);border-bottom:1px solid var(--line);font-family:var(--mono);font-size:11px;color:var(--muted);cursor:pointer;flex:none}
  .pane-h .rid{color:var(--ink);font-weight:600}
  .pane-h .chip{font-size:9px;text-transform:uppercase;letter-spacing:.04em;padding:1px 6px;border-radius:999px}
  .chip.running{color:var(--running);background:rgba(85,167,224,.14)}
  .chip.done,.chip.merged{color:var(--done);background:rgba(88,179,104,.14)}
  .chip.blocked,.chip.preparing,.chip.pending,.chip.starting{color:var(--blocked);background:rgba(214,162,73,.16)}
  .chip.failed,.chip.error{color:var(--failed);background:rgba(226,91,103,.14)}
  .chip.open{color:var(--open);background:rgba(127,156,245,.14)}
  .chip.stopped{color:var(--stopped);background:rgba(181,139,224,.14)}
  .pane-h .title{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--faint)}
  .pane-h .x{color:var(--faint);border:none;background:none;cursor:pointer;font-size:13px;padding:0 3px}
  .pane-h .x:hover{color:var(--failed)}
  .vbadge{font-size:9px;font-weight:600;letter-spacing:.03em;padding:1px 6px;border-radius:999px;white-space:nowrap}
  .vbadge.pass{color:var(--done);background:rgba(88,179,104,.16)}
  .vbadge.fail{color:var(--failed);background:rgba(226,91,103,.16)}
  .vbadge.running{color:var(--blocked);background:rgba(214,162,73,.16)}
  .vbadge.error{color:var(--failed);background:rgba(226,91,103,.12)}
  .pane-term{flex:1;min-height:0;padding:4px 2px 2px 8px}
  .pane-term .xterm{height:100%}

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
    <div class="railfoot">클릭한 run 은 오른쪽 페인에서 열립니다 · 분할(⊞)로 여러 에이전트를 나란히</div>
  </aside>

  <main class="stage">
    <div class="panebar">
      <span id="paneCount">0 panes</span>
      <span style="color:var(--faint)">· run 을 열수록 자동 분할(타일)</span>
      <span class="grow"></span>
      <button class="pb-btn session" id="sessionBtn" title="에이전트에 안 묶인 자유 작업 세션(터미널) 열기">＋ Session</button>
      <button class="pb-btn" id="closeBtn" disabled title="포커스 페인 닫기">× close focused</button>
    </div>
    <div class="panes" id="panes"></div>
    <div class="empty" id="empty">
      <div class="card">
        <div class="glyph">⌗ ⌗ ⌗</div>
        <h1>여기서 작업을 시작하세요</h1>
        <p>직접 몰고 갈 <b>작업 세션</b>(자유 터미널)을 열거나, 아래 요청바로 에이전트를 팬아웃하세요. 트리의 <b>run</b> 을 클릭해도 그 터미널이 페인으로 열립니다.</p>
        <button class="cta" id="sessionCta">＋ 새 작업 세션 열기</button>
        <div class="hint">세션 = repo 워크트리 + tmux 셸. 그 안에서 <code>claude</code> 를 띄워 “이 프로젝트 구현해줘” 처럼 직접 지시할 수 있습니다.</div>
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
    var repos = fleet.repos||[];
    fillSelect($('reqRepo'), repos, function(r){return String(r.id);}, function(r){return r.name;}, true);
    // repo 미선택 상태면 포커스 페인의 repo 로 기본
    if (focusId){ var rp = repoOfRun((panes.find(function(p){return p.id===focusId;})||{}).runId); if (rp!=null) $('reqRepo').value=String(rp); }
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
    if (!repos.length){ el.innerHTML = '<div class="tnode empty">등록된 repo 가 없습니다 — 보드에서 추가하세요.</div>'; return; }
    var html = '';
    repos.forEach(function(repo){
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
      var open = paneByRun[r.id] ? ' open' : '';
      s += '<div class="tnode run'+open+'" data-run="'+r.id+'"><span class="st '+esc(r.status)+'"></span>'
        + '<span class="n">r'+r.id+' · '+esc(r.status)+'</span></div>';
    });
    return s;
  }
  $('tree').addEventListener('click', function(e){
    var run = e.target.closest('.tnode.run');
    if (run){ openRunPane(+run.dataset.run); return; }
    var fn = e.target.closest('[data-fold]');
    if (fn){ var k = fn.dataset.fold; fold[k] = !isFold(k); renderTree(); }
  });

  // ── 페인 그리드(창분할, 오토타일) ──
  var panes = [];            // { id, runId, el, term, fit, ws, retry, closing, ro }
  var paneByRun = {};        // runId -> pane
  var focusId = null;
  var paneSeq = 0;
  var MAX_PANES = 8;

  function layoutPanes(){
    var host = $('panes'); var n = panes.length;
    $('empty').style.display = n ? 'none' : 'flex';
    host.style.display = n ? 'grid' : 'none';
    $('paneCount').textContent = n + ' pane' + (n===1?'':'s');
    $('closeBtn').disabled = !focusId;
    if (typeof reqMode!=='undefined' && reqMode==='bcast') setMode('bcast');
    if (!n) return;
    var cols = Math.ceil(Math.sqrt(n));
    var rows = Math.ceil(n / cols);
    host.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
    host.style.gridTemplateRows = 'repeat(' + rows + ', 1fr)';
    // 레이아웃 후 각 터미널 리핏
    requestAnimationFrame(function(){ panes.forEach(fitPane); });
  }
  function fitPane(p){
    if (!p.fit || !p.term) return;
    try{ p.fit.fit(); if (p.ws && p.ws.readyState===1) p.ws.send(JSON.stringify({t:'r',cols:p.term.cols,rows:p.term.rows})); }catch(e){}
  }
  function setFocus(id){
    focusId = id;
    panes.forEach(function(p){ p.el.classList.toggle('focus', p.id===id); });
    $('closeBtn').disabled = !focusId;
    var p = panes.find(function(x){return x.id===id;});
    if (p && p.term) try{ p.term.focus(); }catch(e){}
    if (typeof reqMode!=='undefined' && reqMode!=='new') setMode(reqMode);
  }
  function openRunPane(runId){
    var existing = paneByRun[runId];
    if (existing){ setFocus(existing.id); return; }
    if (panes.length >= MAX_PANES){ return; }
    var r = runById[runId];
    var p = { id: ++paneSeq, runId: runId, retry: 0, closing: false };
    var el = document.createElement('div'); el.className = 'pane'; p.el = el;
    el.innerHTML = '<div class="pane-h"><span class="rid">r'+runId+'</span>'
      + '<span class="chip '+esc(r?r.status:'')+'" data-role="chip">'+esc(r?r.status:'')+'</span>'
      + '<span data-role="vslot">'+vbadge(r&&r.verifyStatus)+'</span>'
      + '<span class="title" data-role="title">'+esc(r&&r.tmuxWindow||'terminal')+'</span>'
      + '<button class="x" title="close">×</button></div>'
      + '<div class="pane-term"></div>';
    $('panes').appendChild(el);
    el.querySelector('.pane-h').addEventListener('click', function(ev){
      if (ev.target.closest('.x')) return; setFocus(p.id);
    });
    el.querySelector('.x').addEventListener('click', function(){ closePane(p.id); });
    // xterm
    var term = new window.Terminal({
      fontFamily: "ui-monospace, 'SF Mono', Menlo, Monaco, 'Apple SD Gothic Neo', 'Noto Sans KR', monospace",
      fontSize: 12, cursorBlink: true, allowProposedApi: true, scrollback: 4000,
      theme: { background:'#0b0d12', foreground:'#dee4ec', cursor:'#4ec9b0', selectionBackground:'rgba(78,201,176,.25)', black:'#1c212c', brightBlack:'#5c6675' },
    });
    p.term = term;
    p.fit = new window.FitAddon.FitAddon(); term.loadAddon(p.fit);
    try{ term.loadAddon(new window.Unicode11Addon.Unicode11Addon()); term.unicode.activeVersion='11'; }catch(e){}
    term.open(el.querySelector('.pane-term'));
    term.onData(function(d){ if (p.ws && p.ws.readyState===1) p.ws.send(JSON.stringify({t:'i',d:d})); });
    p.ro = new ResizeObserver(function(){ fitPane(p); }); p.ro.observe(el.querySelector('.pane-term'));
    panes.push(p); paneByRun[runId] = p;
    layoutPanes();
    connectPane(p);
    setFocus(p.id);
    renderTree();
  }
  function connectPane(p){
    if (p.closing || !p.term) return;
    try{ p.fit.fit(); }catch(e){}
    var proto = location.protocol==='https:'?'wss':'ws';
    var sock = new WebSocket(proto+'://'+location.host+'/ws/term/'+p.runId+'?cols='+p.term.cols+'&rows='+p.term.rows);
    p.ws = sock;
    sock.onopen = function(){ if (sock!==p.ws){ try{sock.close();}catch(e){} return; } p.retry=0; };
    sock.onmessage = function(m){
      if (sock!==p.ws || !p.term) return;
      try{ var d = JSON.parse(m.data);
        if (d.t==='o') p.term.write(d.d);
        else if (d.t==='err') p.term.write('\\r\\n\\x1b[31m'+d.d+'\\x1b[0m\\r\\n');
        else if (d.t==='exit') p.term.write('\\r\\n\\x1b[90m[session ended — 재연결 시 소생]\\x1b[0m\\r\\n');
      }catch(e){}
    };
    sock.onclose = function(){
      if (sock!==p.ws || p.closing) return;
      var delay = Math.min(8000, 800 * Math.pow(2, p.retry++));
      setTimeout(function(){ connectPane(p); }, delay);
    };
  }
  function closePane(id){
    var i = panes.findIndex(function(p){return p.id===id;});
    if (i<0) return;
    var p = panes[i]; p.closing = true;
    try{ if (p.ws) p.ws.close(); }catch(e){}
    try{ if (p.ro) p.ro.disconnect(); }catch(e){}
    try{ if (p.term) p.term.dispose(); }catch(e){}
    try{ p.el.remove(); }catch(e){}
    delete paneByRun[p.runId];
    panes.splice(i,1);
    if (focusId===id) focusId = panes.length ? panes[panes.length-1].id : null;
    layoutPanes(); if (focusId) setFocus(focusId);
    renderTree();
  }
  // 페인 상태/타이틀을 fleet 갱신에 맞춰 갱신 + 사라진 run 페인 정리
  function syncPanes(){
    panes.forEach(function(p){
      var r = runById[p.runId];
      var chip = p.el.querySelector('[data-role=chip]'); var title = p.el.querySelector('[data-role=title]');
      var vslot = p.el.querySelector('[data-role=vslot]');
      if (r){ if(chip){ chip.className='chip '+r.status; chip.textContent=r.status; } if(title) title.textContent = r.tmuxWindow||'terminal';
        if(vslot) vslot.innerHTML = vbadge(r.verifyStatus); }
    });
  }
  $('closeBtn').addEventListener('click', function(){ if (focusId) closePane(focusId); });

  // ── 자유 작업 세션(workbench) — 에이전트에 안 묶인 터미널. repo 워크트리 + tmux 셸. ──
  var openingSession = false;
  async function openSession(){
    if (openingSession) return;
    var repos = fleet.repos||[];
    if (!repos.length){ toast('먼저 repo 를 등록하세요 — 보드(← Board)에서 Add repository'); return; }
    var repoId = Number($('reqRepo').value) || repos[0].id;
    var rp = repoById[repoId];
    openingSession = true; $('sessionBtn').disabled = true;
    try{
      var res = await fetch('/api/workbench',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({repoId:repoId, title:'Session'})});
      var j = await res.json().catch(function(){return{};});
      if (res.ok && j.runId){
        await hydrate();
        openRunPane(j.runId);
        toast('세션 열림'+(rp?(' · '+rp.name):'')+' — 이 터미널에서 직접 에이전트를 구동하세요');
      } else { toast('세션 실패: '+(j.detail||j.error||res.status)); }
    }catch(e){ toast('세션 실패: '+e); }
    finally{ openingSession=false; $('sessionBtn').disabled=false; }
  }
  $('sessionBtn').addEventListener('click', openSession);
  $('sessionCta').addEventListener('click', openSession);

  // ── 요청바: New(팬아웃) / Steer / Broadcast ──
  var reqMode = 'new';
  function focusRun(){ if (!focusId) return null; var p = panes.find(function(x){return x.id===focusId;}); return p?p.runId:null; }
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
    else { go.textContent='Send ⏎'; var n=panes.length;
      $('reqTgt').textContent = '⊞ 열린 페인 '+n+'개에 브로드캐스트';
      inp.placeholder = n?('열린 '+n+'개 터미널에 그대로 전송 (엔터 포함)'):'열린 페인이 없습니다'; }
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
        // 팬아웃 자동 타일: 생성된 run 을 전부 페인으로
        ids.forEach(function(id){ openRunPane(id); });
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
      if (!panes.length){ toast('열린 페인이 없습니다'); return; }
      var payload = text + '\\r';
      var sent=0;
      panes.forEach(function(p){ if (p.ws && p.ws.readyState===1){ p.ws.send(JSON.stringify({t:'i',d:payload})); sent++; } });
      inp.value='';
      toast('브로드캐스트 → '+sent+'개 페인');
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
    return (fleet.tasks||[]).filter(function(t){ return (byTask[t.id]||0)>=1; })
      .sort(function(a,b){ return b.id-a.id; });
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
  layoutPanes();   // 초기 빈 상태 정합(paneCount·close 비활성·panes 숨김)
  hydrate();
  wsConnect();
  window.addEventListener('resize', function(){ panes.forEach(fitPane); });
</script>
</body>
</html>`;
