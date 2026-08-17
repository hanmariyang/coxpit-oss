// 데몬이 서빙하는 단일 페이지 플릿 콘솔(빌드 스텝 0, 자가완결).
// /api/fleet 로 하이드레이트 → /ws 구독 델타 → run 상세(타임라인·diff·터미널)·비교/머지.
export const BOARD_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>coxpit · fleet</title>
<link rel="stylesheet" href="/vendor/xterm.css" />
<style>
  :root{
    --bg:#0b0d12; --surface:#12151c; --surface2:#171b24; --line:#222835; --line-hi:#2f3648;
    --ink:#dee4ec; --muted:#8792a2; --faint:#5c6675;
    --brand:#4ec9b0; --brand-ink:#062822; --brand-dim:rgba(78,201,176,.13);
    --s-pending:#8792a2; --s-preparing:#d6a249; --s-running:#55a7e0;
    --s-done:#58b368; --s-failed:#e25b67; --s-error:#e25b67; --s-stopped:#b58be0; --s-merged:#4ec9b0;
    --mono:ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,monospace;
    --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,Roboto,sans-serif;
    --r-card:10px; --r-ctl:8px; --shadow:0 8px 28px rgba(0,0,0,.35);
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.5;
    -webkit-font-smoothing:antialiased}
  ::selection{background:var(--brand-dim)}
  ::-webkit-scrollbar{width:9px;height:9px}
  ::-webkit-scrollbar-thumb{background:#252c3a;border-radius:5px;border:2px solid var(--bg)}
  ::-webkit-scrollbar-track{background:transparent}
  button{font-family:var(--sans)}
  :focus-visible{outline:2px solid rgba(78,201,176,.5);outline-offset:1px;border-radius:4px}

  /* ── header ─────────────────────────────── */
  header{display:flex;align-items:center;gap:14px;height:54px;padding:0 20px;
    border-bottom:1px solid var(--line);background:rgba(18,21,28,.92);backdrop-filter:blur(8px);
    position:sticky;top:0;z-index:10}
  .brand{display:flex;align-items:baseline;gap:9px;font-family:var(--mono)}
  .brand .mark{color:var(--brand);font-size:15px;font-weight:700;letter-spacing:.01em}
  .brand .sub{color:var(--faint);font-size:11px;text-transform:uppercase;letter-spacing:.14em}
  .ws{display:flex;align-items:center;gap:7px;font-family:var(--mono);font-size:11px;color:var(--muted);
    padding:4px 10px;border:1px solid var(--line);border-radius:999px;background:var(--surface)}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--s-failed);transition:background .3s}
  .dot.on{background:var(--s-done)}
  .machines{margin-left:auto;display:flex;gap:7px;flex-wrap:wrap}
  .mchip{display:flex;align-items:center;gap:7px;font-family:var(--mono);font-size:11px;padding:4px 11px;
    border:1px solid var(--line);border-radius:999px;color:var(--muted);background:var(--surface)}
  .mchip b{color:var(--ink);font-weight:500}
  .mdot{width:6px;height:6px;border-radius:50%;background:var(--faint)}
  .mdot.on{background:var(--s-done)}

  /* ── layout ─────────────────────────────── */
  .layout{display:grid;grid-template-columns:318px 1fr;min-height:calc(100vh - 55px)}
  aside{border-right:1px solid var(--line);padding:20px 18px;background:var(--surface);
    display:flex;flex-direction:column;gap:26px}
  main{padding:20px;overflow:auto}
  .sect{display:flex;flex-direction:column;gap:10px}
  .sect-label{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.14em;color:var(--faint);margin:0}
  .repo{font-family:var(--mono);font-size:12px;padding:9px 11px;border:1px solid var(--line);
    border-radius:var(--r-ctl);background:var(--surface2)}
  .repo .nm{color:var(--ink)}
  .repo .br{color:var(--brand);margin-left:6px;font-size:11px}
  .repo .path{color:var(--faint);font-size:10.5px;word-break:break-all;margin-top:2px}
  form{display:flex;flex-direction:column;gap:8px}
  input,select,textarea{width:100%;background:#0e1118;color:var(--ink);border:1px solid var(--line);
    border-radius:var(--r-ctl);padding:8px 10px;font-family:var(--mono);font-size:12px;
    transition:border-color .15s}
  input:focus,select:focus,textarea:focus{border-color:rgba(78,201,176,.55);outline:none}
  input::placeholder,textarea::placeholder{color:var(--faint)}
  textarea{resize:vertical;min-height:56px;line-height:1.5}
  .row{display:flex;gap:8px}
  .row>*{flex:1}
  .row .narrow{flex:0 0 64px}
  .check{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);cursor:pointer;user-select:none}
  .check input{width:auto;accent-color:var(--brand)}

  /* ── buttons ────────────────────────────── */
  .btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:none;cursor:pointer;
    border-radius:var(--r-ctl);padding:8px 14px;font-size:13px;font-weight:600;
    background:var(--brand);color:var(--brand-ink);transition:filter .15s,transform .05s}
  .btn:hover{filter:brightness(1.08)}
  .btn:active{transform:translateY(1px)}
  .btn-ghost{background:transparent;color:var(--muted);border:1px solid var(--line);font-weight:500}
  .btn-ghost:hover{color:var(--ink);border-color:var(--line-hi);filter:none}
  .btn-danger{background:transparent;color:var(--s-failed);border:1px solid rgba(226,91,103,.45);font-weight:500}
  .btn-danger:hover{background:rgba(226,91,103,.1);filter:none}
  .btn[disabled],.btn-ghost[disabled]{opacity:.4;cursor:not-allowed}
  .btn.sm,.btn-ghost.sm,.btn-danger.sm{padding:5px 11px;font-size:12px}

  /* ── run cards ──────────────────────────── */
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:14px}
  .card{border:1px solid var(--line);border-radius:var(--r-card);background:var(--surface);
    overflow:hidden;display:flex;flex-direction:column;cursor:pointer;
    transition:border-color .18s,transform .18s,box-shadow .18s}
  .card:hover{border-color:#323b4e;transform:translateY(-1px);box-shadow:var(--shadow)}
  .card-h{display:flex;align-items:center;gap:10px;padding:12px 14px}
  .card-h .rid{font-family:var(--mono);font-size:11px;color:var(--faint)}
  .card-h .title{font-weight:600;font-size:13px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .card-h .closed{color:var(--faint);font-weight:400;font-size:12px}
  .chip{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:10.5px;
    padding:3px 9px;border-radius:999px;text-transform:uppercase;letter-spacing:.06em;
    border:1px solid;background:transparent}
  .chip i{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
  .chip.running i{animation:pulse 1.2s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
  @media (prefers-reduced-motion:reduce){.chip.running i{animation:none}.card:hover{transform:none}}
  .meta{display:flex;gap:16px;padding:0 14px 10px;font-family:var(--mono);font-size:11px;color:var(--faint)}
  .meta b{color:var(--muted);font-weight:500;font-variant-numeric:tabular-nums}
  .log{border-top:1px solid var(--line);background:#0e1118;padding:10px 14px;font-family:var(--mono);
    font-size:11px;height:150px;overflow:auto;display:flex;flex-direction:column;gap:4px}
  .ev{display:flex;gap:9px;align-items:baseline;min-width:0}
  .ev .k{color:var(--brand);min-width:78px;flex:none;opacity:.85}
  .ev .t{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
  .empty{color:var(--faint);font-family:var(--mono);font-size:12px;padding:64px 24px;text-align:center;
    display:flex;flex-direction:column;gap:10px;align-items:center}
  .empty .glyph{font-size:22px;color:#2c3444;letter-spacing:4px}
  .flash{animation:flash .5s ease}
  @keyframes flash{from{border-color:rgba(78,201,176,.6)}to{border-color:var(--line)}}

  /* ── overlays ───────────────────────────── */
  .overlay{position:fixed;inset:0;background:rgba(5,7,10,.66);backdrop-filter:blur(3px);display:none;z-index:20}
  .overlay.open{display:flex;align-items:center;justify-content:center;padding:26px}
  .modal{width:min(1020px,100%);max-height:92vh;background:var(--surface);border:1px solid var(--line);
    border-radius:14px;display:flex;flex-direction:column;overflow:hidden;box-shadow:var(--shadow)}
  .modal.wide{width:min(1460px,100%)}
  .modal.term{width:min(1200px,100%);height:min(760px,92vh)}
  .modal-h{display:flex;align-items:center;gap:10px;padding:13px 18px;border-bottom:1px solid var(--line)}
  .modal-h .rid{font-family:var(--mono);font-size:12px;color:var(--faint)}
  .modal-h .title{font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .modal-h .x{background:transparent;border:none;color:var(--muted);font-size:19px;cursor:pointer;
    padding:2px 9px;border-radius:6px;line-height:1}
  .modal-h .x:hover{color:var(--ink);background:var(--surface2)}
  .modal-b{display:grid;grid-template-columns:1fr 1fr;overflow:hidden;flex:1;min-height:0}
  .pane{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--line)}
  .pane:last-child{border-right:none}
  .pane-h{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.14em;color:var(--faint);
    padding:9px 16px;border-bottom:1px solid var(--line);background:var(--surface2)}
  .pane-c{overflow:auto;padding:12px 16px;font-family:var(--mono);font-size:11px;flex:1;min-height:0}
  .tl .ev{margin-bottom:6px}
  .tl .ev .t{white-space:normal;word-break:break-word}
  pre.diff{margin:0;white-space:pre-wrap;word-break:break-all;line-height:1.5;font-family:var(--mono)}
  .dl-add{color:var(--s-done)} .dl-del{color:var(--s-failed)} .dl-hunk{color:var(--s-running)}
  .dl-file{color:var(--brand);font-weight:600}
  .modal-f{display:flex;gap:8px;padding:12px 18px;border-top:1px solid var(--line);align-items:center}
  .modal-f .spacer{flex:1}

  /* ── compare ────────────────────────────── */
  .cmp{display:flex;overflow-x:auto;flex:1;min-height:0}
  .cmp-col{min-width:360px;flex:1;border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
  .cmp-col:last-child{border-right:none}
  .cmp-h{display:flex;align-items:center;gap:9px;padding:11px 14px;border-bottom:1px solid var(--line)}
  .cmp-h .rid{font-family:var(--mono);font-size:12px;color:var(--faint)}
  .cmp-h .files{margin-left:auto;font-family:var(--mono);font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}
  .cmp-meta{font-family:var(--mono);font-size:11px;color:var(--faint);padding:8px 14px;border-bottom:1px solid var(--line);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:var(--surface2)}
  .cmp-diff{overflow:auto;padding:11px 14px;flex:1;min-height:0}
  .cmp-f{padding:10px 14px;border-top:1px solid var(--line);display:flex;gap:8px;align-items:center}
  .cmp-f .msg{font-family:var(--mono);font-size:11px;color:var(--muted);flex:1;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

  /* ── terminal ───────────────────────────── */
  .term-body{flex:1;min-height:0;background:#0b0d12;padding:8px 4px 4px 10px}
  #xterm{width:100%;height:100%}
  .term-hint{font-family:var(--mono);font-size:11px;color:var(--faint)}

  @media (max-width:860px){
    .layout{grid-template-columns:1fr}
    aside{border-right:none;border-bottom:1px solid var(--line)}
    .modal-b{grid-template-columns:1fr}
    .pane{border-right:none;border-bottom:1px solid var(--line)}
  }
</style>
</head>
<body>
<header>
  <div class="brand"><span class="mark">coxpit</span><span class="sub">fleet console</span></div>
  <div class="ws"><span class="dot" id="wsdot"></span><span id="wstext">connecting</span></div>
  <div class="machines" id="machines"></div>
</header>
<div class="layout">
  <aside>
    <div class="sect">
      <p class="sect-label">Repositories</p>
      <div id="repos" style="display:flex;flex-direction:column;gap:6px"></div>
      <form id="repoForm">
        <div class="row">
          <select id="repoMachine" class="narrow" style="flex:0 0 96px"></select>
          <input id="repoPath" placeholder="/abs/path/to/repo" />
        </div>
        <button class="btn-ghost sm" type="submit">Register repo</button>
      </form>
    </div>
    <div class="sect">
      <p class="sect-label">Launch agents</p>
      <form id="taskForm">
        <select id="taskRepo"></select>
        <input id="taskTitle" placeholder="Task title" />
        <textarea id="taskPrompt" placeholder="Prompt for the agents…"></textarea>
        <div class="row">
          <input id="taskCount" class="narrow" type="number" min="1" max="8" value="2" title="number of agents" />
          <button class="btn" type="submit">Run fleet</button>
        </div>
        <label class="check"><input type="checkbox" id="taskReal" /> real agent · spends credits</label>
      </form>
    </div>
  </aside>
  <main>
    <div class="grid" id="grid"></div>
    <div class="empty" id="empty">
      <span class="glyph">▚▞▚</span>
      <span>No runs yet</span>
      <span style="color:#3d4657">register a repo, write a task, hit Run fleet</span>
    </div>
  </main>
</div>

<div class="overlay" id="overlay">
  <div class="modal">
    <div class="modal-h">
      <span class="rid" id="mRid"></span>
      <span class="title" id="mTitle"></span>
      <span class="chip" id="mChip"><i></i><span id="mChipTxt"></span></span>
      <button class="x" id="mClose" aria-label="close">×</button>
    </div>
    <div class="modal-b">
      <div class="pane">
        <div class="pane-h">Timeline</div>
        <div class="pane-c tl" id="mTimeline"></div>
      </div>
      <div class="pane">
        <div class="pane-h">Diff <span id="mStat" style="text-transform:none;letter-spacing:0"></span></div>
        <div class="pane-c"><pre class="diff" id="mDiff">loading…</pre></div>
      </div>
    </div>
    <div class="modal-f">
      <button class="btn-ghost sm" id="mTerm">Terminal</button>
      <button class="btn-ghost sm" id="mRefreshDiff">Refresh diff</button>
      <button class="btn-ghost sm" id="mCompare">Compare runs</button>
      <span class="spacer"></span>
      <button class="btn-danger sm" id="mStop">Stop</button>
      <button class="btn-ghost sm" id="mCleanup">Cleanup</button>
      <button class="btn-ghost sm" id="mCloseTask">Close task</button>
    </div>
  </div>
</div>

<div class="overlay" id="cmpOverlay">
  <div class="modal wide">
    <div class="modal-h">
      <span class="title" id="cmpTitle">Compare</span>
      <button class="btn-ghost sm" id="cmpRefresh">Refresh</button>
      <button class="x" id="cmpClose" aria-label="close">×</button>
    </div>
    <div class="cmp" id="cmpBody"></div>
  </div>
</div>

<div class="overlay" id="termOverlay">
  <div class="modal term">
    <div class="modal-h">
      <span class="rid" id="termRid"></span>
      <span class="title" id="termTitle">terminal</span>
      <span class="term-hint">tmux session · Ctrl-b d detaches</span>
      <button class="x" id="termClose" aria-label="close">×</button>
    </div>
    <div class="term-body"><div id="xterm"></div></div>
  </div>
</div>

<script src="/vendor/xterm.js"></script>
<script src="/vendor/addon-fit.js"></script>
<script>
const runs = new Map();      // runId -> run object
const tasks = new Map();     // taskId -> task
let repos = [], machines = [];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const statusColor = (s) => 'var(--s-' + (s||'pending') + ', var(--muted))';

function summarize(kind, payload){
  try{
    const o = JSON.parse(payload);
    if (o.type === 'assistant' && o.message){
      const c = (o.message.content||[]).map(x => x.type==='text' ? x.text : (x.type==='tool_use' ? '['+x.name+']' : '')).join(' ');
      return c || '(assistant)';
    }
    if (o.type === 'assistant' && o.text) return o.text;
    if (o.type === 'result') return o.result || '(result)';
    if (o.type === 'user') return '(tool result)';
    if (o.type === 'system') return o.subtype || 'system';
    if (kind === 'meta') return 'worktree ' + (o.worktree||'');
    return kind;
  }catch{ return payload; }
}
function diffHTML(text){
  if (!text.trim()) return '<span style="color:var(--faint)">no changes</span>';
  return text.split('\\n').map(l=>{
    const e = esc(l);
    if (l.startsWith('diff --git')||l.startsWith('+++')||l.startsWith('---')) return '<span class="dl-file">'+e+'</span>';
    if (l.startsWith('@@')) return '<span class="dl-hunk">'+e+'</span>';
    if (l.startsWith('+')) return '<span class="dl-add">'+e+'</span>';
    if (l.startsWith('-')) return '<span class="dl-del">'+e+'</span>';
    return e;
  }).join('\\n');
}
function chipHTML(status){
  const s = status||'pending';
  return '<span class="chip '+(s==='running'?'running':'')+'" style="color:'+statusColor(s)+';border-color:'+statusColor(s)+'">'
    + '<i></i>'+esc(s)+'</span>';
}

function render(){
  const list = [...runs.values()].sort((a,b)=>b.id-a.id);
  $('empty').style.display = list.length ? 'none' : 'flex';
  $('grid').innerHTML = list.map(cardHTML).join('');
}
function cardHTML(r){
  const task = tasks.get(r.taskId);
  const closed = task && task.status==='closed';
  const title = (task ? esc(task.title) : ('task ' + (r.taskId ?? '?')))
    + (closed ? ' <span class="closed">· closed</span>' : '');
  const evs = (r.events||[]).slice(-8).map(e =>
    '<div class="ev"><span class="k">'+esc(e.kind)+'</span><span class="t">'+esc(summarize(e.kind,e.payload)).slice(0,140)+'</span></div>'
  ).join('') || '<div class="ev"><span class="t" style="color:var(--faint)">waiting…</span></div>';
  return '<div class="card" id="card-'+r.id+'">'
    + '<div class="card-h"><span class="rid">r'+r.id+'</span><span class="title">'+title+'</span>'+chipHTML(r.status)+'</div>'
    + '<div class="meta"><span>branch <b>'+esc(r.branch||'—')+'</b></span>'
    + '<span>files <b>'+(r.filesChanged??0)+'</b></span>'
    + '<span>'+esc(r.agent||'')+'</span></div>'
    + '<div class="log">'+evs+'</div></div>';
}
function flash(id){ const el=$('card-'+id); if(el){ el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); } }

function upsertRun(patch){
  const cur = runs.get(patch.runId ?? patch.id) || { id: patch.runId ?? patch.id, events: [] };
  Object.assign(cur, patch, { id: cur.id, events: cur.events });
  if (patch.runId) cur.id = patch.runId;
  runs.set(cur.id, cur);
}

async function hydrate(){
  const r = await fetch('/api/fleet').then(x=>x.json());
  machines = r.machines||[]; repos = r.repos||[];
  tasks.clear();
  (r.tasks||[]).forEach(t => tasks.set(t.id, t));
  runs.clear();
  (r.runs||[]).forEach(rn => runs.set(rn.id, { ...rn, events: rn.events||[] }));
  paintSidebar(); render();
}
function paintSidebar(){
  $('machines').innerHTML = machines.map(m =>
    '<span class="mchip"><span class="mdot '+(m.online?'on':'')+'"></span><b>'+esc(m.slug)+'</b></span>').join('');
  $('repos').innerHTML = repos.map(r =>
    '<div class="repo"><span class="nm">'+esc(r.name)+'</span><span class="br">'+esc(r.defaultBranch)+'</span>'
    + '<div class="path">'+esc(r.path)+'</div></div>').join('')
    || '<div class="repo" style="color:var(--faint)">none registered</div>';
  $('repoMachine').innerHTML = machines.map(m=>'<option value="'+esc(m.slug)+'">'+esc(m.slug)+'</option>').join('');
  $('taskRepo').innerHTML = repos.map(r=>'<option value="'+r.id+'">'+esc(r.name)+'</option>').join('');
}

function connectWS(){
  const proto = location.protocol==='https:'?'wss':'ws';
  const ws = new WebSocket(proto+'://'+location.host+'/ws');
  ws.onopen = ()=>{ $('wsdot').classList.add('on'); $('wstext').textContent='live'; };
  ws.onclose = ()=>{ $('wsdot').classList.remove('on'); $('wstext').textContent='reconnecting'; setTimeout(connectWS,1500); };
  ws.onmessage = (m)=>{
    let ev; try{ ev = JSON.parse(m.data); }catch{ return; }
    if (ev.type==='run'){
      const known = runs.has(ev.runId ?? ev.id);
      upsertRun(ev);
      if (!known && ev.taskId==null){ hydrate(); return; }
      render(); flash(ev.runId ?? ev.id); paintModal();
      if (openRunId===(ev.runId??ev.id) && ['done','failed','error','stopped'].includes(ev.status)) loadDiff();
      if (cmpTaskId!=null && ['done','failed','error','stopped','merged'].includes(ev.status)) paintCompare();
    } else if (ev.type==='event'){
      const r = runs.get(ev.runId); if(!r){ hydrate(); return; }
      r.events = r.events||[]; r.events.push({ kind:ev.kind, payload:ev.payload });
      render(); flash(ev.runId); paintModal();
    } else if (ev.type==='task'){
      const t = tasks.get(ev.taskId);
      if (t){ t.status = ev.status; render(); paintModal(); } else { hydrate(); }
    }
  };
}

/* ── run detail modal ── */
let openRunId = null;
function paintModal(){
  if (openRunId==null) return;
  const r = runs.get(openRunId); if(!r) return;
  const task = tasks.get(r.taskId);
  $('mRid').textContent = 'r'+r.id;
  $('mTitle').textContent = task ? task.title : 'task '+(r.taskId??'?');
  const chip = $('mChip');
  chip.className = 'chip ' + (r.status==='running'?'running':'');
  chip.style.color = statusColor(r.status);
  chip.style.borderColor = statusColor(r.status);
  $('mChipTxt').textContent = r.status||'pending';
  $('mStop').style.display = (r.status==='running'||r.status==='preparing'||r.status==='pending') ? '' : 'none';
  $('mTimeline').innerHTML = (r.events||[]).map(e =>
    '<div class="ev"><span class="k">'+esc(e.kind)+'</span><span class="t">'+esc(summarize(e.kind,e.payload))+'</span></div>'
  ).join('') || '<span style="color:var(--faint)">no events yet</span>';
}
async function loadDiff(){
  if (openRunId==null) return;
  $('mDiff').textContent = 'loading…'; $('mStat').textContent='';
  try{
    const d = await fetch('/api/runs/'+openRunId+'/diff').then(x=>x.json());
    if (!d.ok){ $('mDiff').textContent = d.stat||'no worktree'; return; }
    const files = d.stat ? d.stat.split('\\n').filter(Boolean).length : 0;
    $('mStat').textContent = files ? '· '+files+' file'+(files>1?'s':'') : '· clean';
    $('mDiff').innerHTML = diffHTML(d.diff||'');
  }catch{ $('mDiff').textContent = 'diff failed'; }
}
function openModal(id){ openRunId = id; paintModal(); $('overlay').classList.add('open'); loadDiff(); }
function closeModal(){ openRunId=null; $('overlay').classList.remove('open'); }
$('grid').addEventListener('click',(e)=>{
  const card = e.target.closest('.card'); if(!card) return;
  openModal(Number(card.id.replace('card-','')));
});
$('mClose').addEventListener('click', closeModal);
$('overlay').addEventListener('click',(e)=>{ if(e.target===$('overlay')) closeModal(); });
document.addEventListener('keydown',(e)=>{ if(e.key==='Escape'){ closeTerm(); closeModal(); cmpTaskId=null; $('cmpOverlay').classList.remove('open'); } });
$('mRefreshDiff').addEventListener('click', loadDiff);
$('mStop').addEventListener('click', async ()=>{
  if (openRunId==null) return;
  await fetch('/api/runs/'+openRunId+'/stop',{method:'POST'});
});
$('mCleanup').addEventListener('click', async ()=>{
  if (openRunId==null) return;
  if (!confirm('Remove worktree + branch for r'+openRunId+'?')) return;
  await fetch('/api/runs/'+openRunId+'/cleanup',{method:'POST'});
  closeModal(); hydrate();
});
$('mCloseTask').addEventListener('click', async ()=>{
  if (openRunId==null) return;
  const r = runs.get(openRunId); if(!r) return;
  if (!confirm('Close task — stop + cleanup ALL its runs?')) return;
  await fetch('/api/tasks/'+r.taskId+'/close',{method:'POST'});
  closeModal(); hydrate();
});

/* ── compare view ── */
let cmpTaskId = null;
async function openCompare(taskId){
  cmpTaskId = taskId;
  $('cmpOverlay').classList.add('open');
  $('cmpBody').innerHTML = '<div class="empty" style="flex:1">loading…</div>';
  await paintCompare();
}
async function paintCompare(){
  if (cmpTaskId==null) return;
  let d;
  try{ d = await fetch('/api/tasks/'+cmpTaskId+'/compare').then(x=>x.json()); }
  catch{ $('cmpBody').innerHTML = '<div class="empty" style="flex:1">compare failed</div>'; return; }
  $('cmpTitle').textContent = 'Compare · '+(d.task ? d.task.title : 'task '+cmpTaskId);
  if (!d.runs || !d.runs.length){ $('cmpBody').innerHTML = '<div class="empty" style="flex:1">no runs</div>'; return; }
  $('cmpBody').innerHTML = d.runs.map(r=>{
    const files = r.stat ? r.stat.split('\\n').filter(Boolean).length : 0;
    const summary = (r.exitSummary||'').slice(0,140);
    const mergeable = ['done','failed','stopped'].includes(r.status) && files>0;
    const merged = r.status==='merged';
    return '<div class="cmp-col" data-run="'+r.id+'">'
      + '<div class="cmp-h"><span class="rid">r'+r.id+'</span>'+chipHTML(r.status)
      + '<span class="files">'+files+' file'+(files===1?'':'s')+'</span></div>'
      + '<div class="cmp-meta" title="'+esc(summary)+'">'+(summary?esc(summary):'—')+'</div>'
      + '<div class="cmp-diff"><pre class="diff">'+diffHTML(r.diff||'')+'</pre></div>'
      + '<div class="cmp-f"><span class="msg" id="cmpMsg-'+r.id+'"></span>'
      + (merged
        ? chipHTML('merged')
        : '<button class="btn sm" data-merge="'+r.id+'"'+(mergeable?'':' disabled')+'>Merge this</button>')
      + '</div></div>';
  }).join('');
}
$('cmpBody').addEventListener('click', async (e)=>{
  const btn = e.target.closest('button[data-merge]'); if(!btn) return;
  const rid = Number(btn.dataset.merge);
  if (!confirm('Merge r'+rid+' into the base branch?')) return;
  btn.disabled = true;
  const res = await fetch('/api/runs/'+rid+'/merge',{method:'POST'});
  const j = await res.json().catch(()=>({detail:'merge failed'}));
  const msg = $('cmpMsg-'+rid);
  if (msg) msg.textContent = j.detail || (res.ok?'merged':'failed');
  if (res.ok){ await paintCompare(); hydrate(); } else { btn.disabled = false; }
});
$('cmpClose').addEventListener('click', ()=>{ cmpTaskId=null; $('cmpOverlay').classList.remove('open'); });
$('cmpOverlay').addEventListener('click',(e)=>{ if(e.target===$('cmpOverlay')){ cmpTaskId=null; $('cmpOverlay').classList.remove('open'); } });
$('cmpRefresh').addEventListener('click', paintCompare);
$('mCompare').addEventListener('click', ()=>{
  if (openRunId==null) return;
  const r = runs.get(openRunId); if(!r) return;
  closeModal(); openCompare(r.taskId);
});

/* ── terminal ── */
let termWS = null, termObj = null, fitAddon = null, termResizeObs = null;
function openTerm(runId){
  const r = runs.get(runId); if(!r) return;
  $('termRid').textContent = 'r'+runId;
  $('termTitle').textContent = (r.tmuxWindow||'terminal');
  $('termOverlay').classList.add('open');
  const el = $('xterm'); el.innerHTML = '';
  termObj = new window.Terminal({
    fontFamily: 'ui-monospace, SF Mono, Menlo, Consolas, monospace',
    fontSize: 12.5, cursorBlink: true,
    theme: { background:'#0b0d12', foreground:'#dee4ec', cursor:'#4ec9b0',
      selectionBackground:'rgba(78,201,176,.25)', black:'#1c212c', brightBlack:'#5c6675' },
  });
  fitAddon = new window.FitAddon.FitAddon();
  termObj.loadAddon(fitAddon);
  termObj.open(el);
  fitAddon.fit();
  const proto = location.protocol==='https:'?'wss':'ws';
  termWS = new WebSocket(proto+'://'+location.host+'/ws/term/'+runId);
  termWS.onopen = ()=>{
    termWS.send(JSON.stringify({t:'r',cols:termObj.cols,rows:termObj.rows}));
    termObj.focus();
  };
  termWS.onmessage = (m)=>{
    try{
      const d = JSON.parse(m.data);
      if (d.t==='o') termObj.write(d.d);
      else if (d.t==='err') termObj.write('\\r\\n\\x1b[31m'+d.d+'\\x1b[0m\\r\\n');
      else if (d.t==='exit') termObj.write('\\r\\n\\x1b[90m[detached]\\x1b[0m\\r\\n');
    }catch{}
  };
  termObj.onData((d)=>{ if(termWS && termWS.readyState===1) termWS.send(JSON.stringify({t:'i',d})); });
  termResizeObs = new ResizeObserver(()=>{
    if (!fitAddon || !termObj) return;
    fitAddon.fit();
    if (termWS && termWS.readyState===1) termWS.send(JSON.stringify({t:'r',cols:termObj.cols,rows:termObj.rows}));
  });
  termResizeObs.observe(el);
}
function closeTerm(){
  $('termOverlay').classList.remove('open');
  if (termResizeObs){ termResizeObs.disconnect(); termResizeObs=null; }
  if (termWS){ try{ termWS.close(); }catch{} termWS=null; }
  if (termObj){ try{ termObj.dispose(); }catch{} termObj=null; fitAddon=null; }
}
$('termClose').addEventListener('click', closeTerm);
$('termOverlay').addEventListener('click',(e)=>{ if(e.target===$('termOverlay')) closeTerm(); });
$('mTerm').addEventListener('click', ()=>{
  if (openRunId==null) return;
  const id = openRunId;
  closeModal(); openTerm(id);
});

/* ── forms ── */
$('repoForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const body = { machineSlug: $('repoMachine').value, path: $('repoPath').value.trim() };
  if (!body.path) return;
  const res = await fetch('/api/repos',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  if (res.ok){ $('repoPath').value=''; await hydrate(); } else { alert('repo: '+(await res.text())); }
});
$('taskForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const repoId = Number($('taskRepo').value);
  const title = $('taskTitle').value.trim();
  if (!repoId || !title) return;
  const t = await fetch('/api/tasks',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({repoId,title,prompt:$('taskPrompt').value})}).then(x=>x.json());
  if (!t.ok){ alert('task failed'); return; }
  tasks.set(t.task.id, t.task);
  await fetch('/api/tasks/'+t.task.id+'/run',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({count:Number($('taskCount').value)||1, real: $('taskReal').checked})});
  $('taskTitle').value=''; $('taskPrompt').value='';
});

hydrate().then(connectWS);
</script>
</body>
</html>`;
