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
  .panes{flex:1;display:grid;gap:1px;background:var(--line);padding:1px;min-height:0}
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
  .pane-term{flex:1;min-height:0;padding:4px 2px 2px 8px}
  .pane-term .xterm{height:100%}

  .empty{flex:1;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px}
  .empty .card{max-width:440px}
  .empty .glyph{font-family:var(--mono);font-size:24px;color:#2c3444;letter-spacing:5px;margin-bottom:14px}
  .empty h1{font-family:var(--mono);font-size:16px;margin:0 0 8px;color:var(--ink)}
  .empty p{color:var(--muted);font-size:13px;margin:0}

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
    <button type="button" class="vtab" disabled title="Phase 3"><span class="g">⧉</span>Review</button>
    <button type="button" class="vtab" disabled title="Phase 3"><span class="g">▤</span>Docs</button>
  </div>
  <div class="right">
    <span class="ws" id="ws"><span class="dot"></span><span id="wstext">connecting</span></span>
    <span class="wip">preview · Phase 2</span>
    <a class="toggle" href="/">← Board</a>
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
      <button class="pb-btn" id="closeBtn" disabled title="포커스 페인 닫기">× close focused</button>
    </div>
    <div class="panes" id="panes"></div>
    <div class="empty" id="empty">
      <div class="card">
        <div class="glyph">⌗ ⌗ ⌗</div>
        <h1>페인이 비어 있습니다</h1>
        <p>왼쪽 트리에서 <b>run</b> 을 클릭하면 그 에이전트 터미널이 여기 페인으로 열립니다. 여러 개 열면 자동으로 분할(타일)됩니다.</p>
      </div>
    </div>
    <div class="reqbar">
      <span class="ctx">cockpit</span><span class="caret">›</span>
      <span class="ph">요청바 — Phase 3 (repo 문맥에서 팬아웃)</span>
      <span class="kbd">⏎</span>
    </div>
  </main>
</div>

<script src="/vendor/xterm.js"></script>
<script src="/vendor/addon-fit.js"></script>
<script src="/vendor/addon-unicode11.js"></script>
<script>
  // 모바일은 터미널 우선 대신 보드(모니터)로.
  if (window.innerWidth <= 860 && matchMedia('(pointer:coarse)').matches) location.replace('/');
  var esc = function(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); };
  var $ = function(id){ return document.getElementById(id); };

  // ── fleet 상태 ──
  var fleet = { machines:[], repos:[], tasks:[], groups:[], runs:[] };
  var runById = {};
  var fold = {};   // 접힘 상태(repo/goal/task 노드)
  function isFold(k){ return fold[k]===true; }

  async function hydrate(){
    try{
      var d = await (await fetch('/api/fleet?view=all')).json();
      fleet = d; runById = {};
      (d.runs||[]).forEach(function(r){ runById[r.id]=r; });
      if (d.machines && d.machines[0]) { $('mach').textContent = d.machines[0].slug; $('machName').textContent = d.machines[0].slug; }
      renderTree();
      syncPanes();
    }catch(e){ /* 재시도는 WS 재연결 or 다음 hydrate */ }
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
      if (r){ if(chip){ chip.className='chip '+r.status; chip.textContent=r.status; } if(title) title.textContent = r.tmuxWindow||'terminal'; }
    });
  }
  $('closeBtn').addEventListener('click', function(){ if (focusId) closePane(focusId); });

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

  hydrate();
  wsConnect();
  window.addEventListener('resize', function(){ panes.forEach(fitPane); });
</script>
</body>
</html>`;
