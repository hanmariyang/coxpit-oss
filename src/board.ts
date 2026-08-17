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
    --s-done:#57ab5a; --s-failed:#e05561; --s-error:#e05561;
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
  const title = task ? esc(task.title) : ('task ' + (r.taskId ?? '?'));
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
      render(); flash(ev.runId ?? ev.id);
    } else if (ev.type==='event'){
      const r = runs.get(ev.runId); if(!r){ hydrate(); return; }
      r.events = r.events||[]; r.events.push({ kind:ev.kind, payload:ev.payload });
      render(); flash(ev.runId);
    }
  };
}

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
