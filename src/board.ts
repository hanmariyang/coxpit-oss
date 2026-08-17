// 데몬이 서빙하는 단일 페이지 플릿 보드(빌드 스텝 0, 자가완결).
// /api/fleet 로 하이드레이트 → /ws 구독해 run/event 델타 실시간 반영.
export const BOARD_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>coxpit · fleet</title>
<style>
  :root{
    --bg:#0e1116; --panel:#161b22; --panel2:#1b2129; --line:#232a33;
    --fg:#d6dde5; --muted:#7d8894; --accent:#4ec9b0;
    --s-pending:#7d8894; --s-preparing:#d3a04e; --s-running:#4ea1d3;
    --s-done:#57ab5a; --s-failed:#e05561; --s-error:#e05561; --s-stopped:#b085d6; --s-merged:#4ec9b0;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    --sans:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans);font-size:14px;line-height:1.5}
  a{color:var(--accent)}
  header{display:flex;align-items:center;gap:16px;padding:12px 18px;border-bottom:1px solid var(--line);
    background:var(--panel);position:sticky;top:0;z-index:5}
  header h1{font-family:var(--mono);font-size:15px;font-weight:600;margin:0;letter-spacing:.02em}
  header h1 .dim{color:var(--muted);font-weight:400}
  .ws{display:flex;align-items:center;gap:7px;font-family:var(--mono);font-size:12px;color:var(--muted)}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--s-failed);transition:background .3s}
  .dot.on{background:var(--s-done)}
  .machines{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}
  .mchip{font-family:var(--mono);font-size:12px;padding:3px 9px;border:1px solid var(--line);border-radius:999px;color:var(--muted)}
  .mchip b{color:var(--fg);font-weight:500}
  .mchip .online{color:var(--s-done)}
  .layout{display:grid;grid-template-columns:300px 1fr;gap:0;min-height:calc(100vh - 53px)}
  aside{border-right:1px solid var(--line);padding:16px;background:var(--panel);display:flex;flex-direction:column;gap:20px}
  main{padding:18px;overflow:auto}
  .sect-label{font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 8px}
  .repo{font-family:var(--mono);font-size:12px;padding:7px 9px;border:1px solid var(--line);border-radius:6px;margin-bottom:6px;background:var(--panel2)}
  .repo .path{color:var(--muted);font-size:11px;word-break:break-all}
  form{display:flex;flex-direction:column;gap:7px}
  label{font-size:12px;color:var(--muted)}
  input,select,textarea{width:100%;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;
    padding:7px 9px;font-family:var(--mono);font-size:12px}
  textarea{resize:vertical;min-height:52px}
  button{background:var(--accent);color:#06231d;border:none;border-radius:6px;padding:8px 12px;font-weight:600;
    font-family:var(--sans);font-size:13px;cursor:pointer}
  button.ghost{background:transparent;color:var(--muted);border:1px solid var(--line);font-weight:500}
  button:active{transform:translateY(1px)}
  .row{display:flex;gap:7px}
  .row>*{flex:1}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:14px}
  .card{border:1px solid var(--line);border-radius:9px;background:var(--panel);overflow:hidden;display:flex;flex-direction:column}
  .card-h{display:flex;align-items:center;gap:9px;padding:11px 13px;border-bottom:1px solid var(--line)}
  .card-h .rid{font-family:var(--mono);font-size:12px;color:var(--muted)}
  .card-h .title{font-weight:600;font-size:13px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .chip{font-family:var(--mono);font-size:11px;padding:2px 8px;border-radius:999px;text-transform:uppercase;letter-spacing:.04em;
    border:1px solid currentColor}
  .meta{display:flex;gap:14px;padding:8px 13px;font-family:var(--mono);font-size:11px;color:var(--muted);border-bottom:1px solid var(--line)}
  .meta b{color:var(--fg);font-weight:500}
  .log{padding:9px 13px;font-family:var(--mono);font-size:11px;max-height:190px;overflow:auto;display:flex;flex-direction:column;gap:3px}
  .ev{display:flex;gap:8px;align-items:baseline}
  .ev .k{color:var(--accent);min-width:74px}
  .ev .t{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
  .empty{color:var(--muted);font-family:var(--mono);font-size:12px;padding:40px;text-align:center}
  .flash{animation:flash .6s ease}
  @keyframes flash{from{background:var(--panel2)}to{background:var(--panel)}}
  @media (prefers-reduced-motion:reduce){.flash{animation:none}}
  .card{cursor:pointer}
  /* run 상세 모달 */
  .overlay{position:fixed;inset:0;background:rgba(8,10,14,.72);display:none;z-index:20}
  .overlay.open{display:flex;align-items:center;justify-content:center;padding:28px}
  .modal{width:min(980px,100%);max-height:90vh;background:var(--panel);border:1px solid var(--line);
    border-radius:10px;display:flex;flex-direction:column;overflow:hidden}
  .modal-h{display:flex;align-items:center;gap:10px;padding:13px 16px;border-bottom:1px solid var(--line)}
  .modal-h .title{font-weight:600;flex:1}
  .modal-h .x{background:transparent;border:none;color:var(--muted);font-size:18px;cursor:pointer;padding:2px 8px}
  .modal-b{display:grid;grid-template-columns:1fr 1fr;gap:0;overflow:hidden;flex:1;min-height:0}
  .pane{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--line)}
  .pane:last-child{border-right:none}
  .pane-h{font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);
    padding:9px 14px;border-bottom:1px solid var(--line)}
  .pane-c{overflow:auto;padding:10px 14px;font-family:var(--mono);font-size:11px;flex:1;min-height:0}
  .tl .ev{margin-bottom:5px}
  .tl .ev .t{white-space:normal;word-break:break-word}
  pre.diff{margin:0;white-space:pre-wrap;word-break:break-all;line-height:1.45}
  .dl-add{color:var(--s-done)} .dl-del{color:var(--s-failed)} .dl-hunk{color:var(--s-running)} .dl-file{color:var(--accent);font-weight:600}
  .modal-f{display:flex;gap:8px;padding:11px 16px;border-top:1px solid var(--line)}
  .modal-f .spacer{flex:1}
  button.danger{background:transparent;color:var(--s-failed);border:1px solid var(--s-failed);font-weight:500}
  @media (max-width:760px){.modal-b{grid-template-columns:1fr}.pane{border-right:none;border-bottom:1px solid var(--line)}}
  /* 비교 뷰 — run 컬럼 나란히 */
  .modal.wide{width:min(1400px,100%)}
  .cmp{display:flex;gap:0;overflow-x:auto;flex:1;min-height:0}
  .cmp-col{min-width:340px;flex:1;border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
  .cmp-col:last-child{border-right:none}
  .cmp-h{display:flex;align-items:center;gap:8px;padding:10px 13px;border-bottom:1px solid var(--line)}
  .cmp-h .rid{font-family:var(--mono);font-size:12px;color:var(--muted)}
  .cmp-meta{font-family:var(--mono);font-size:11px;color:var(--muted);padding:7px 13px;border-bottom:1px solid var(--line);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cmp-meta b{color:var(--fg);font-weight:500}
  .cmp-diff{overflow:auto;padding:9px 13px;flex:1;min-height:0}
  .cmp-f{padding:9px 13px;border-top:1px solid var(--line);display:flex;gap:7px;align-items:center}
  .cmp-f .msg{font-family:var(--mono);font-size:11px;color:var(--muted);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  button.merge{background:var(--s-merged);color:#06231d}
  button[disabled]{opacity:.45;cursor:not-allowed}
</style>
</head>
<body>
<header>
  <h1>coxpit <span class="dim">· fleet</span></h1>
  <div class="ws"><span class="dot" id="wsdot"></span><span id="wstext">connecting…</span></div>
  <div class="machines" id="machines"></div>
</header>
<div class="layout">
  <aside>
    <div>
      <p class="sect-label">Repos</p>
      <div id="repos"></div>
      <form id="repoForm">
        <div class="row">
          <select id="repoMachine"></select>
          <input id="repoPath" placeholder="/abs/path/to/repo" />
        </div>
        <button class="ghost" type="submit">+ register repo</button>
      </form>
    </div>
    <div>
      <p class="sect-label">New task → run</p>
      <form id="taskForm">
        <select id="taskRepo"></select>
        <input id="taskTitle" placeholder="task title" />
        <textarea id="taskPrompt" placeholder="prompt for the agent"></textarea>
        <div class="row">
          <input id="taskCount" type="number" min="1" max="8" value="2" title="agents" />
          <button type="submit">run</button>
        </div>
        <label><input type="checkbox" id="taskReal" style="width:auto" /> real agent (spends credits)</label>
      </form>
    </div>
  </aside>
  <main>
    <div class="grid" id="grid"></div>
    <div class="empty" id="empty">No runs yet — create a task and hit run.</div>
  </main>
</div>
<div class="overlay" id="overlay">
  <div class="modal">
    <div class="modal-h">
      <span class="rid" id="mRid" style="font-family:var(--mono);color:var(--muted)"></span>
      <span class="title" id="mTitle"></span>
      <span class="chip" id="mChip"></span>
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
      <button class="ghost" id="mRefreshDiff">refresh diff</button>
      <button class="ghost" id="mCompare">compare runs</button>
      <span class="spacer"></span>
      <button class="danger" id="mStop">stop</button>
      <button class="ghost" id="mCleanup">cleanup worktree</button>
      <button class="ghost" id="mCloseTask">close task</button>
    </div>
  </div>
</div>
<div class="overlay" id="cmpOverlay">
  <div class="modal wide">
    <div class="modal-h">
      <span class="title" id="cmpTitle">compare</span>
      <button class="ghost" id="cmpRefresh">refresh</button>
      <button class="x" id="cmpClose" aria-label="close">×</button>
    </div>
    <div class="cmp" id="cmpBody"></div>
  </div>
</div>
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
    if (kind === 'meta') return 'worktree ' + (o.worktree||'') ;
    return kind;
  }catch{ return payload; }
}

function render(){
  const list = [...runs.values()].sort((a,b)=>b.id-a.id);
  $('empty').style.display = list.length ? 'none' : 'block';
  $('grid').innerHTML = list.map(cardHTML).join('');
}
function cardHTML(r){
  const task = tasks.get(r.taskId);
  const closed = task && task.status==='closed';
  const title = (task ? esc(task.title) : ('task ' + (r.taskId ?? '?')))
    + (closed ? ' <span style="color:var(--muted);font-weight:400">· closed</span>' : '');
  const evs = (r.events||[]).slice(-8).map(e =>
    '<div class="ev"><span class="k">'+esc(e.kind)+'</span><span class="t">'+esc(summarize(e.kind,e.payload)).slice(0,120)+'</span></div>'
  ).join('') || '<div class="ev"><span class="t" style="color:var(--muted)">waiting…</span></div>';
  return '<div class="card" id="card-'+r.id+'">'
    + '<div class="card-h"><span class="rid">r'+r.id+'</span><span class="title">'+title+'</span>'
    + '<span class="chip" style="color:'+statusColor(r.status)+'">'+esc(r.status||'pending')+'</span></div>'
    + '<div class="meta"><span>branch <b>'+esc(r.branch||'—')+'</b></span>'
    + '<span>files <b>'+(r.filesChanged??0)+'</b></span>'
    + '<span>'+esc(r.agent||'')+'</span></div>'
    + '<div class="log">'+evs+'</div></div>';
}
function flash(id){ const el=$( 'card-'+id); if(el){ el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); } }

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
    '<span class="mchip"><b>'+esc(m.slug)+'</b> '+(m.online?'<span class="online">●</span>':'○')+'</span>').join('');
  $('repos').innerHTML = repos.map(r =>
    '<div class="repo"><div>'+esc(r.name)+' · '+esc(r.defaultBranch)+'</div><div class="path">'+esc(r.path)+'</div></div>').join('')
    || '<div class="repo" style="color:var(--muted)">none yet</div>';
  const mopt = machines.map(m=>'<option value="'+esc(m.slug)+'">'+esc(m.slug)+'</option>').join('');
  $('repoMachine').innerHTML = mopt;
  $('taskRepo').innerHTML = repos.map(r=>'<option value="'+r.id+'">'+esc(r.name)+'</option>').join('');
}

function connectWS(){
  const proto = location.protocol==='https:'?'wss':'ws';
  const ws = new WebSocket(proto+'://'+location.host+'/ws');
  ws.onopen = ()=>{ $('wsdot').classList.add('on'); $('wstext').textContent='live'; };
  ws.onclose = ()=>{ $('wsdot').classList.remove('on'); $('wstext').textContent='reconnecting…'; setTimeout(connectWS,1500); };
  ws.onmessage = (m)=>{
    let ev; try{ ev = JSON.parse(m.data); }catch{ return; }
    if (ev.type==='run'){
      const known = runs.has(ev.runId ?? ev.id);
      upsertRun(ev);
      if (!known && ev.taskId==null){ hydrate(); return; } // unknown run w/o task → resync
      render(); flash(ev.runId ?? ev.id); paintModal();
      // run 이 끝나면 열려있는 상세의 diff / 비교 뷰 자동 갱신
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

// ── run 상세 모달 ─────────────────────────────────────────────
let openRunId = null;
function diffHTML(text){
  if (!text.trim()) return '<span style="color:var(--muted)">no changes</span>';
  return text.split('\\n').map(l=>{
    const e = esc(l);
    if (l.startsWith('diff --git')||l.startsWith('+++')||l.startsWith('---')) return '<span class="dl-file">'+e+'</span>';
    if (l.startsWith('@@')) return '<span class="dl-hunk">'+e+'</span>';
    if (l.startsWith('+')) return '<span class="dl-add">'+e+'</span>';
    if (l.startsWith('-')) return '<span class="dl-del">'+e+'</span>';
    return e;
  }).join('\\n');
}
function paintModal(){
  if (openRunId==null) return;
  const r = runs.get(openRunId); if(!r) return;
  const task = tasks.get(r.taskId);
  $('mRid').textContent = 'r'+r.id;
  $('mTitle').textContent = task ? task.title : 'task '+(r.taskId??'?');
  const chip = $('mChip');
  chip.textContent = r.status||'pending';
  chip.style.color = statusColor(r.status);
  $('mStop').style.display = (r.status==='running'||r.status==='preparing'||r.status==='pending') ? '' : 'none';
  $('mTimeline').innerHTML = (r.events||[]).map(e =>
    '<div class="ev"><span class="k">'+esc(e.kind)+'</span><span class="t">'+esc(summarize(e.kind,e.payload))+'</span></div>'
  ).join('') || '<span style="color:var(--muted)">no events yet</span>';
}
async function loadDiff(){
  if (openRunId==null) return;
  $('mDiff').textContent = 'loading…'; $('mStat').textContent='';
  try{
    const d = await fetch('/api/runs/'+openRunId+'/diff').then(x=>x.json());
    if (!d.ok){ $('mDiff').textContent = d.stat||'no worktree'; return; }
    const files = d.stat ? d.stat.split('\\n').length : 0;
    $('mStat').textContent = files ? '· '+files+' file'+(files>1?'s':'') : '· clean';
    $('mDiff').innerHTML = diffHTML(d.diff||'');
  }catch{ $('mDiff').textContent = 'diff failed'; }
}
function openModal(id){
  openRunId = id; paintModal(); $('overlay').classList.add('open'); loadDiff();
}
function closeModal(){ openRunId=null; $('overlay').classList.remove('open'); }
$('grid').addEventListener('click',(e)=>{
  const card = e.target.closest('.card'); if(!card) return;
  openModal(Number(card.id.replace('card-','')));
});
$('mClose').addEventListener('click', closeModal);
$('overlay').addEventListener('click',(e)=>{ if(e.target===$('overlay')) closeModal(); });
document.addEventListener('keydown',(e)=>{ if(e.key==='Escape') closeModal(); });
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

// ── 비교/리뷰 뷰 ─────────────────────────────────────────────
let cmpTaskId = null;
async function openCompare(taskId){
  cmpTaskId = taskId;
  $('cmpOverlay').classList.add('open');
  $('cmpBody').innerHTML = '<div class="empty">loading…</div>';
  await paintCompare();
}
async function paintCompare(){
  if (cmpTaskId==null) return;
  let d;
  try{ d = await fetch('/api/tasks/'+cmpTaskId+'/compare').then(x=>x.json()); }
  catch{ $('cmpBody').innerHTML = '<div class="empty">compare failed</div>'; return; }
  $('cmpTitle').textContent = 'compare · '+(d.task ? d.task.title : 'task '+cmpTaskId);
  if (!d.runs || !d.runs.length){ $('cmpBody').innerHTML = '<div class="empty">no runs</div>'; return; }
  $('cmpBody').innerHTML = d.runs.map(r=>{
    const files = r.stat ? r.stat.split('\\n').filter(Boolean).length : 0;
    const summary = (r.exitSummary||'').slice(0,140);
    const mergeable = ['done','failed','stopped'].includes(r.status) && files>0;
    const merged = r.status==='merged';
    return '<div class="cmp-col" data-run="'+r.id+'">'
      + '<div class="cmp-h"><span class="rid">r'+r.id+'</span>'
      + '<span class="chip" style="color:'+statusColor(r.status)+'">'+esc(r.status)+'</span>'
      + '<span class="rid">'+files+' file'+(files===1?'':'s')+'</span></div>'
      + '<div class="cmp-meta" title="'+esc(summary)+'">'+(summary?esc(summary):'—')+'</div>'
      + '<div class="cmp-diff"><pre class="diff">'+diffHTML(r.diff||'')+'</pre></div>'
      + '<div class="cmp-f"><span class="msg" id="cmpMsg-'+r.id+'"></span>'
      + (merged
        ? '<span class="chip" style="color:var(--s-merged)">merged</span>'
        : '<button class="merge" data-merge="'+r.id+'"'+(mergeable?'':' disabled')+'>merge this</button>')
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
