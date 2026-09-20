// HUD — 플릿을 **작게 다시 내놓는** 한 장 (v5.28 Part K, GET /hud).
// board.ts · cockpit.ts 와 같은 자가완결 단일 HTML 문자열(빌드 0, 프레임워크 0, 모노·다크·기존 토큰).
//
// 이 페이지가 하는 일은 넷뿐이다:
//   ① 알약으로 한눈에 본다(점 + 대기 수)  ② 펼쳐서 나를 기다리는 것부터 훑는다
//   ③ 한 줄을 고르면 **목록 옆에** 상세가 열린다   ④ 대기 중인 에이전트에게 코크핏을 열지 않고 답한다
//
// [!] 이 페이지는 **브라우저에서 단독으로 돈다**. 창(프레임리스·항상 위)·전역 단축키·크기 변경은
// 데스크톱 쪽 일(K1/K2, desktop/main.cjs)이고, 여기는 그쪽을 한 줄도 모른다 —
// 배치 상태를 <html data-hud="pill|list|detail"> 에 적고, 창이 붙어 있을 때만
// window.coxpitHud.size({state,w,h}) 로 "이만큼 필요하다"고 말할 뿐이다(없으면 아무 일도 없다).
// 창을 실제로 줄이고 늘리는 것도, 화면 밖으로 안 나가게 물리는 것도 전부 메인 프로세스다.
//
// 데이터는 전부 코크핏이 이미 읽는 것: GET /api/fleet(+ agentStates · real) 과 /ws 델타.
// 새 창구는 하나뿐 — POST /api/runs/:id/input (살아 있는 tmux 에 한 줄 써 넣기, getScrollback 의 쓰기 쌍둥이).
import { HUMANIZE_JS } from './humanize';
import { ACTIVITY_JS } from './activity';

export const HUD_HTML = /* html */ `<!doctype html>
<html lang="en" data-hud="pill">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>coxpit · hud</title>
<link rel="icon" href="/brand/favicon.ico" sizes="any" />
<style>
  /* 토큰은 코크핏과 **같은 팔레트 그대로**다(board.ts/cockpit.ts 의 :root 블록). 새 색은 0개. */
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
  html,body{height:100%;overscroll-behavior:none}
  /* 지면은 보드·코크핏과 같은 --bg 다. (데스크톱 창이 프레임리스·투명으로 이걸 띄울 때는
     그 실행분에서 투명 배경을 덧입힌다 — 지금은 브라우저에서 단독으로 열려도 어두워야 한다.) */
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:13px;line-height:1.45;
    -webkit-font-smoothing:antialiased;overflow:hidden;display:flex;align-items:flex-start;justify-content:center;padding:6px}
  button{font-family:var(--sans);cursor:pointer}
  :focus-visible{outline:2px solid rgba(78,201,176,.5);outline-offset:1px;border-radius:4px}
  *{scrollbar-width:thin;scrollbar-color:var(--line-hi) transparent}
  ::-webkit-scrollbar{width:7px;height:7px}
  ::-webkit-scrollbar-track{background:transparent}
  ::-webkit-scrollbar-thumb{background:var(--line-hi);border-radius:4px}

  /* 세 가지 배치 = 한 장의 세 상태. data-hud 는 데스크톱이 창 크기를 맞출 때 읽어 갈 자리이기도 하다. */
  html[data-hud="pill"] #panel{display:none}
  html[data-hud="list"] #pill,html[data-hud="detail"] #pill{display:none}
  html[data-hud="pill"] body{align-items:flex-start}

  /* ── K3. 접힌 알약 — 이것이 평상시의 전부다 ───────────────────────────── */
  /* app-region: 프레임 없는 창(K1)에서 알약과 헤더가 **손잡이**다. 안의 컨트롤은 no-drag 여야
     눌린다 — drag 영역은 클릭을 삼킨다. 브라우저에서는 이 속성이 아무 뜻도 없다. */
  .pill{display:inline-flex;align-items:center;gap:8px;height:26px;padding:0 11px;border-radius:999px;
    background:var(--surface);border:1px solid var(--line);box-shadow:0 8px 28px rgba(0,0,0,.35);
    font-family:var(--mono);font-size:11px;color:var(--muted);-webkit-app-region:drag}
  .pill:hover{border-color:var(--line-hi);color:var(--ink)}
  .pill>*{-webkit-app-region:no-drag}
  .pdots{display:inline-flex;align-items:center;gap:4px}
  .pwait{color:var(--blocked);font-size:11px;letter-spacing:.02em}
  .pquiet{color:var(--faint);font-size:10.5px}

  /* 상태 점 — Part A 매핑 그대로(working=--running · waiting=--blocked 맥박 · idle=--faint · exited=--done) */
  .st{width:7px;height:7px;border-radius:50%;background:var(--faint);display:inline-block;flex:none}
  .st.as-working{background:var(--running)}
  .st.as-waiting{background:var(--blocked);animation:aspulse 1.5s ease-in-out infinite}
  .st.as-idle{background:var(--faint)}
  .st.as-exited{background:var(--done)}
  @keyframes aspulse{0%,100%{opacity:1}50%{opacity:.35}}
  @media (prefers-reduced-motion:reduce){ .st.as-waiting{animation:none} }

  /* ── K4. 펼친 분류 목록 ─────────────────────────────────────────────── */
  .panel{width:100%;max-width:250px;display:flex;flex-direction:column;max-height:calc(100vh - 12px);
    background:var(--surface);border:1px solid var(--line);border-radius:10px;
    box-shadow:0 8px 28px rgba(0,0,0,.35);overflow:hidden}
  html[data-hud="detail"] .panel{max-width:570px}
  .hh{display:flex;align-items:center;gap:7px;padding:7px 9px;border-bottom:1px solid var(--line);
    font-family:var(--mono);font-size:11px;-webkit-app-region:drag}
  .hh>button{-webkit-app-region:no-drag}
  .lead{color:var(--blocked);white-space:nowrap}
  .lead.clear{color:var(--done)}
  .subs{color:var(--faint);font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .hx{margin-left:auto;background:none;border:none;color:var(--faint);font-family:var(--mono);font-size:13px;
    line-height:1;padding:2px 5px;border-radius:5px}
  .hx:hover{color:var(--ink);background:var(--surface2)}
  .hbody{display:flex;min-height:0;flex:1}
  .hlist{width:250px;flex:none;overflow-y:auto;padding:5px 0}
  html[data-hud="list"] .hlist{width:100%}
  .hdetail{flex:1;min-width:0;border-left:1px solid var(--line);overflow-y:auto;padding:9px 11px;background:var(--panel)}
  html[data-hud="list"] .hdetail{display:none}
  .lbl{font-family:var(--mono);font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--faint);
    padding:6px 11px 3px}
  .row{display:flex;align-items:center;gap:7px;width:100%;text-align:left;background:none;border:none;
    padding:5px 11px;font-family:var(--mono);font-size:11.5px;color:var(--muted)}
  .row:hover{background:var(--surface2);color:var(--ink)}
  .row.on{background:var(--brand-dim);color:var(--ink);box-shadow:inset 2px 0 0 var(--brand)}
  .row .rn{color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46%}
  .row.wait .rn{color:var(--blocked)}
  .row .rp{color:var(--faint);font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
  .row .rel{margin-left:auto;color:var(--faint);font-size:10px;flex:none}
  .dryc{flex:none;font-family:var(--mono);font-size:9px;color:var(--faint);border:1px solid var(--line-hi);
    border-radius:4px;padding:0 3px;letter-spacing:.04em}
  .cnt{display:block;width:100%;text-align:left;background:none;border:none;padding:5px 11px;
    font-family:var(--mono);font-size:10.5px;color:var(--faint)}
  .cnt:hover{color:var(--ink)}
  .clearbox{padding:11px;font-family:var(--mono);font-size:11px;color:var(--muted);line-height:1.6}
  .clearbox .big{color:var(--done);display:block;margin-bottom:3px}
  .hfoot{display:flex;align-items:center;gap:8px;padding:5px 9px;border-top:1px solid var(--line);
    font-family:var(--mono);font-size:9.5px;color:var(--faint)}
  .hver{margin-left:auto;opacity:.8}

  /* ── K5. 상세(목록 오른쪽) ────────────────────────────────────────── */
  .d-h{display:flex;align-items:center;gap:6px;font-family:var(--mono);font-size:11px;margin-bottom:6px}
  .d-h .dnm{color:var(--ink)}
  .d-chip{font-size:9.5px;color:var(--faint)}
  .d-chip.as-working{color:var(--running)} .d-chip.as-waiting{color:var(--blocked)}
  .d-chip.as-idle{color:var(--faint)} .d-chip.as-exited{color:var(--done)}
  .d-meta{font-family:var(--mono);font-size:10px;color:var(--faint);margin-bottom:8px;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .d-q{border:1px solid var(--line-hi);border-radius:8px;background:var(--surface);padding:8px 9px;margin-bottom:8px}
  .d-q .qk{display:block;font-family:var(--mono);font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;
    color:var(--faint);margin-bottom:4px}
  .d-q pre{margin:0;font-family:var(--mono);font-size:11px;color:var(--ink);white-space:pre-wrap;word-break:break-word;
    max-height:150px;overflow:auto}
  .d-q .unk{font-family:var(--mono);font-size:11px;color:var(--muted)}
  .d-sec{font-family:var(--mono);font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);
    margin:9px 0 4px}
  .d-now{font-family:var(--mono);font-size:11.5px;color:var(--ink);margin-bottom:4px}
  .d-tl{border-left:1px solid var(--line);padding-left:8px;max-height:130px;overflow:auto}
  .d-l{display:flex;gap:6px;font-family:var(--mono);font-size:10.5px;line-height:1.5}
  .d-l .ak{flex:none;color:var(--faint);min-width:42px}
  .d-l .at{color:var(--muted);white-space:pre-wrap;word-break:break-word}
  .d-tail{margin:0;font-family:var(--mono);font-size:10.5px;color:var(--muted);background:var(--panel);
    border:1px solid var(--line);border-radius:7px;padding:7px 8px;max-height:210px;overflow:auto;
    white-space:pre-wrap;word-break:break-word}
  .d-diff{margin:6px 0 0;font-family:var(--mono);font-size:10px;color:var(--muted);max-height:160px;overflow:auto;
    white-space:pre;background:var(--panel);border:1px solid var(--line);border-radius:7px;padding:7px 8px}
  .d-bar{display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin-top:9px;padding-top:8px;border-top:1px solid var(--line)}
  .dbtn{font-family:var(--mono);font-size:10px;color:var(--muted);background:none;border:1px solid var(--line);
    border-radius:6px;padding:3px 8px}
  .dbtn:hover,.dbtn:focus-visible{color:var(--ink);border-color:var(--line-hi);background:var(--surface2)}
  .dbtn.prim{color:var(--brand);border-color:rgba(78,201,176,.4)}
  .dbtn.danger:hover{color:var(--failed);border-color:var(--failed)}
  /* 빠른 답은 대기의 색(--blocked)을 빌린다 — 코크핏 .qbtn 과 같은 주의색, 새 색 없음 */
  .qbtn{font-family:var(--mono);font-size:10.5px;color:var(--blocked);background:none;border:1px solid var(--line-hi);
    border-radius:999px;padding:3px 10px}
  .qbtn:hover,.qbtn:focus-visible{color:var(--ink);border-color:var(--blocked)}
  .d-steer{display:flex;gap:5px;margin-top:8px}
  .d-steer input{flex:1;min-width:0;font-family:var(--mono);font-size:11px;color:var(--ink);background:var(--panel);
    border:1px solid var(--line-hi);border-radius:6px;padding:5px 8px;outline:none}
  .d-steer input:focus{border-color:var(--brand)}
  .d-empty{font-family:var(--mono);font-size:11px;color:var(--faint);padding:14px 4px}
  .toast{position:fixed;left:50%;bottom:9px;transform:translateX(-50%);max-width:92%;
    font-family:var(--mono);font-size:10.5px;color:var(--ink);background:var(--surface2);
    border:1px solid var(--line-hi);border-radius:7px;padding:5px 10px;opacity:0;pointer-events:none;
    transition:opacity .16s ease;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .toast.on{opacity:1}
</style>
</head>
<body>
  <!-- K3 — 접힌 알약. 누르면 펼쳐진다(창 크기는 데스크톱이 나중에 data-hud 를 보고 맞춘다). -->
  <button type="button" id="pill" class="pill" aria-label="coxpit fleet">
    <span class="pdots" id="pillDots"></span>
    <span class="pwait" id="pillWait" hidden></span>
    <span class="pquiet" id="pillQuiet" hidden>quiet</span>
  </button>

  <!-- K4/K5 — 펼친 분류 목록(+ 고른 행의 상세가 오른쪽에) -->
  <section id="panel" class="panel" aria-label="fleet triage">
    <header class="hh">
      <span class="lead" id="hudLead">connecting</span>
      <span class="subs" id="hudSubs"></span>
      <button type="button" class="hx" id="hudMin" title="알약으로 접기 (esc)">&minus;</button>
    </header>
    <div class="hbody">
      <div class="hlist" id="hudList"></div>
      <div class="hdetail" id="hudDetail"></div>
    </div>
    <div class="hfoot"><span>j/k &middot; enter &middot; y/n/c &middot; esc</span><span class="hver">v__COXPIT_VER__</span></div>
  </section>
  <div class="toast" id="toast"></div>

<script>
(function(){
  var $=function(id){ return document.getElementById(id); };
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function escA(s){ return esc(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  var toastT=null;
  function toast(msg){
    var el=$('toast'); el.textContent=msg; el.classList.add('on');
    if(toastT) clearTimeout(toastT);
    toastT=setTimeout(function(){ el.classList.remove('on'); }, 3200);
  }

  // ── 레이아웃 상태 = 데스크톱이 읽어 갈 자리 ────────────────────────────
  // 창을 줄이고 늘리는 것은 **여기가 아니다**(K1, 데스크톱 창). 이 페이지는 원하는 크기를
  // <html data-hud> 에 적어 두고, 자기 안에서는 그 값으로 배치만 바꾼다.
  // 데스크톱 창에 실려 있으면 그 크기를 한 번 더 **말해 준다** — 창을 만지는 쪽은 언제나 저쪽이다.
  // 알약 120x26 · 목록 250 · 상세 570 (+ 지면 여백 6px 양쪽). 창은 이 값을 화면 크기로 한 번 더 물린다.
  var HUD_SIZE={ pill:{w:132,h:38}, list:{w:262,h:380}, detail:{w:582,h:440} };
  function reportSize(next){
    var api=window.coxpitHud;
    if(!api||typeof api.size!=='function') return;   // 브라우저에서 단독으로 열린 경우 — 아무 일도 없다
    var s=HUD_SIZE[next]||HUD_SIZE.pill;
    var w=s.w, h=s.h;
    // 알약만은 **재서** 말한다 — 폭이 점 수에 따라 달라져서 고정값이면 잘리거나 빈자리가 남는다.
    if(next==='pill'){
      var el=$('pill');
      if(el&&el.offsetWidth){ w=Math.ceil(el.offsetWidth)+12; h=Math.ceil(el.offsetHeight)+12; }
    }
    try{ api.size({state:next, w:w, h:h}); }catch(e){}
  }
  var layout='pill';
  function setLayout(next){
    layout=next;
    document.documentElement.setAttribute('data-hud', next);
    reportSize(next);
    if(next==='pill'){ try{ $('pill').focus(); }catch(e){} }
  }
  function expand(){ if(layout==='pill'){ setLayout('list'); render(); } }
  function collapse(){ sel=null; $('hudDetail').innerHTML=''; setLayout('pill'); }
  $('pill').addEventListener('click', expand);
  $('hudMin').addEventListener('click', collapse);

  // ── 플릿 상태 — 코크핏과 같은 창구, 같은 판정 규칙 ─────────────────────
  var fleet={runs:[],tasks:[],repos:[]}, runById={}, taskById={}, repoById={};
  var agentState={};   // runId -> 'working'|'waiting'|'idle'|'exited' (서버가 준 것만; 짐작하지 않는다)
  var AS_CLASS={ working:'as-working', waiting:'as-waiting', idle:'as-idle', exited:'as-exited' };
  function asClass(s){ return AS_CLASS[s]||''; }
  function agentStateOf(runId){ return agentState[runId]||''; }
  // dry 판정은 한 줄뿐이다(Part H): real===false 인 것만 dry. undefined 는 모르는 것이지 dry 가 아니다.
  function isDryRun(r){ return !!r && r.real===false; }
  function dryChip(r){ return isDryRun(r) ? '<span class="dryc" title="dry run — 모의 스트림이 만든 변경입니다">dry</span>' : ''; }
  function runIsSession(runId){ var r=runById[runId]; var t=r&&taskById[r.taskId]; var rp=t&&repoById[t.repoId]; return !!(rp&&rp.kind==='sessions'); }
  function runLive(runId){ var r=runById[runId]; if(!r) return false;
    return r.status==='running'||r.status==='pending'||r.status==='preparing'||r.status==='open'; }
  function runLabel(runId){
    var r=runById[runId]; if(!r) return 'r'+runId;
    if(runIsSession(runId)){ var t=taskById[r.taskId]; return (t&&t.title)||('r'+runId); }
    return r.title || r.agent || ('r'+runId);
  }
  function runPath(runId){
    var r=runById[runId]; if(!r) return '';
    var t=taskById[r.taskId], rp=t&&repoById[t.repoId];
    return (rp?rp.name:'?')+' \\u25b8 '+((t&&t.title)||('task '+(r.taskId!=null?r.taskId:'?')));
  }
  function runMeta(runId){
    var r=runById[runId]; if(!r) return '';
    var bits=[]; if(r.model) bits.push(r.model);
    bits.push(runIsSession(runId) ? (r.worktreePath||'session') : (r.branch||'in-place'));
    return bits.join(' \\u00b7 ');
  }
  function elapsed(runId){
    var r=runById[runId]; if(!r||!r.startedAt) return '';
    var t=new Date(r.startedAt).getTime(); if(!t) return '';
    var s=Math.max(0, Math.floor((Date.now()-t)/1000));
    if(s<60) return s+'s';
    if(s<3600) return Math.floor(s/60)+'m';
    if(s<86400) return Math.floor(s/3600)+'h';
    return Math.floor(s/86400)+'d';
  }

  // 코크핏·보드와 **같은 한 벌**. 사본을 만들지 않는다.
${HUMANIZE_JS}
${ACTIVITY_JS}

  // ── K4. 세 갈래 — 나를 기다리는 것 / 도는 것 / 나머지 ────────────────
  // 갈래는 Part A 가 준 상태와 run.status 로만 정한다(지어낸 상태 없음).
  function buckets(){
    var wait=[], run=[], rest=[];
    (fleet.runs||[]).forEach(function(r){
      var s=agentStateOf(r.id), sess=runIsSession(r.id);
      var live=(r.status==='running'||r.status==='pending'||r.status==='preparing');
      if(s==='waiting'){ wait.push(r); return; }
      if(!sess && (s==='working'||live)){ run.push(r); return; }
      if(sess && r.tmuxWindow && r.status==='open'){ rest.push(r); return; }
      if(s==='idle'||s==='exited') rest.push(r);
    });
    var byId=function(a,b){ return a.id-b.id; };
    wait.sort(byId); run.sort(byId); rest.sort(byId);
    return { wait:wait, run:run, rest:rest };
  }

  var sel=null;        // 고른 run (상세의 주인)
  var curId=null;      // j/k 하이라이트가 서 있는 run — **id 로 기억한다**(다시 그려도 안 흔들리게)
  var cur=-1;          // 그 id 의 지금 위치
  var restOpen=false;  // idle/session 접힘 — 기본은 한 줄 숫자다
  var rowIds=[];       // 지금 화면에 선 행들(키보드 이동 대상)
  function markedId(){ return curId!=null ? curId : sel; }

  function rowHTML(r, kind){
    var s=agentStateOf(r.id);
    var bits='<span class="st '+asClass(s)+'"></span>'
      + '<span class="rn">'+esc(runLabel(r.id))+'</span>';
    if(kind==='wait') bits+='<span class="rp">'+esc(runPath(r.id))+'</span>';
    else if(kind==='run') bits+='<span class="rp">'+esc(actNowText(r.id))+'</span>';
    else bits+='<span class="rp">'+esc(runIsSession(r.id)?'session':(s||r.status||''))+'</span>';
    bits+=dryChip(r)+'<span class="rel">'+esc(elapsed(r.id))+'</span>';
    return '<button type="button" class="row '+(kind==='wait'?'wait ':'')+(markedId()===r.id?'on':'')+'"'
      + ' data-run="'+r.id+'" title="'+escA(runPath(r.id))+'">'+bits+'</button>';
  }

  function render(){
    if(layout==='pill'){ paintPill(); return; }
    var b=buckets();
    // 헤더 — 기다리는 것이 있으면 그것이 먼저다(호박색), 없으면 all clear(초록).
    var lead=$('hudLead'), subs=$('hudSubs');
    if(b.wait.length){ lead.textContent=b.wait.length+' needs you'; lead.classList.remove('clear'); }
    else { lead.textContent='all clear'; lead.classList.add('clear'); }
    subs.textContent='\\u00b7 '+b.run.length+' running \\u00b7 '+b.rest.length+' idle';

    var h='', ids=[];
    if(b.wait.length){
      h+='<div class="lbl">needs you</div>';
      b.wait.forEach(function(r){ h+=rowHTML(r,'wait'); ids.push(r.id); });
    }
    if(b.run.length){
      h+='<div class="lbl">running '+b.run.length+'</div>';
      b.run.forEach(function(r){ h+=rowHTML(r,'run'); ids.push(r.id); });
    }
    if(!b.wait.length && !b.run.length){
      // 대기가 0일 때는 빈 목록이 아니라 **차분한 요약**이다 — 어조가 상태를 따라간다.
      h+='<div class="clearbox"><span class="big">all clear</span>'
        + '기다리는 에이전트가 없습니다.<br>'+b.rest.length+' idle \\u00b7 도는 것 없음</div>';
    }
    if(b.rest.length){
      h+='<button type="button" class="cnt" id="restToggle">'+(restOpen?'\\u25be':'\\u25b8')+' idle / session '+b.rest.length+'</button>';
      if(restOpen) b.rest.forEach(function(r){ h+=rowHTML(r,'rest'); ids.push(r.id); });
    }
    if(!ids.length && !b.rest.length && !b.wait.length && !b.run.length && !(fleet.runs||[]).length){
      h+='<div class="d-empty">아직 run 이 없습니다</div>';
    }
    $('hudList').innerHTML=h;
    rowIds=ids;
    var mk=markedId();
    cur=(mk!=null)?ids.indexOf(mk):-1;
    if(cur<0) curId=null;
    paintPill();
  }

  // ── K3. 알약 — 점 + 대기 수. 대기가 없으면 조용하다(맥박 없음). ──────────
  function paintPill(){
    var b=buckets();
    var dots='';
    b.wait.slice(0,3).forEach(function(){ dots+='<span class="st as-waiting"></span>'; });
    b.run.slice(0,3).forEach(function(){ dots+='<span class="st as-working"></span>'; });
    if(!b.wait.length && !b.run.length) dots+='<span class="st as-idle"></span>';
    $('pillDots').innerHTML=dots;
    var w=$('pillWait'), q=$('pillQuiet');
    if(b.wait.length){ w.hidden=false; w.textContent='\\u25d4 '+b.wait.length; q.hidden=true; }
    else { w.hidden=true; q.hidden=false; q.textContent=b.run.length?(b.run.length+' running'):'quiet'; }
    $('pill').title = b.wait.length ? (b.wait.length+' 개가 답을 기다립니다') : (b.run.length+' 개가 도는 중');
    // 점이 늘고 줄면 알약의 폭도 달라진다 — 떠 있는 창이라면 그때마다 다시 말해 준다.
    if(layout==='pill') reportSize('pill');
  }

  // ── K5. 상세 — 고른 행 하나. 목록은 그대로 옆에 남는다. ────────────────
  // 종류에 따라 셋: 기다리는 에이전트 · 도는 에이전트 · 세션(자유 터미널).
  var HUD_REPLIES=[
    { k:'approve', label:'승인', send:'1' },
    { k:'deny',    label:'거절', send:'2' },
    { k:'cont',    label:'계속', send:'계속' }
  ];
  function replyFor(k){ for(var i=0;i<HUD_REPLIES.length;i++){ if(HUD_REPLIES[i].k===k) return HUD_REPLIES[i]; } return null; }

  function detailHTML(runId){
    var r=runById[runId]; if(!r) return '<div class="d-empty">사라진 run 입니다</div>';
    var s=agentStateOf(runId), sess=runIsSession(runId);
    var h='<div class="d-h"><span class="dnm">'+esc(runLabel(runId))+'</span>'
      + '<span class="d-chip '+asClass(s)+'" data-role="dchip">'+esc(s||r.status||'')+'</span>'
      + dryChip(r)+'</div>'
      + '<div class="d-meta">'+esc(runPath(runId))+' \\u00b7 '+esc(runMeta(runId))+'</div>';

    if(sess){
      // 세션 = 에이전트가 없다. 질문도 steer 도 없고, 지금 화면(스크롤백 꼬리)이 전부다.
      h+='<div class="d-sec">terminal tail</div>'
       + '<pre class="d-tail" data-role="tail">읽는 중\\u2026</pre>'
       + '<div class="d-bar">'
       +   '<a class="dbtn prim" href="/cockpit?run='+encodeURIComponent(runId)+'">터미널 열기</a>'
       +   '<button type="button" class="dbtn" data-rename="'+runId+'">이름변경</button>'
       +   '<button type="button" class="dbtn danger" data-del="'+runId+'">삭제</button>'
       + '</div>';
      return h;
    }

    if(s==='waiting'){
      // 질문은 **지어내지 않는다** — 파싱된 스트림/터미널 화면에서 온 것만 보여주고, 없으면 없다고 말한다.
      h+='<div class="d-q" data-role="qbox"><span class="qk">pending</span>'
       +   '<div class="unk" data-role="qtext">무엇을 묻는지 읽는 중\\u2026</div></div>'
       + '<div class="d-bar" data-role="qr">';
      HUD_REPLIES.forEach(function(q){
        h+='<button type="button" class="qbtn" data-qr="'+runId+'" data-qk="'+escA(q.k)+'"'
         + ' title="고정 문자열 전송 \\u00b7 '+escA(q.send)+'">'+esc(q.label)+'</button>';
      });
      h+='</div>';
    }

    h+='<div class="d-sec">now</div>'
     + '<div class="d-now" data-role="dnow">'+esc(actNowText(runId))+'</div>'
     + '<div class="d-sec">최근 활동</div>'
     + '<div class="d-tl" data-role="dtl"></div>'
     + '<div class="d-sec">change</div>'
     + '<div><span class="d-now">filesChanged '+((r.filesChanged)||0)+'</span> '
     +   '<button type="button" class="dbtn" data-diff="'+runId+'">Changes</button></div>'
     + '<pre class="d-diff" data-role="ddiff" hidden></pre>'
     + '<div class="d-steer">'
     +   '<input id="steerInput" placeholder="'+(runLive(runId)?'이어서 보낼 한 줄':'후속 지시 (steer)')+'" autocomplete="off" spellcheck="false" />'
     +   '<button type="button" class="dbtn prim" data-steer="'+runId+'">Steer</button>'
     + '</div>'
     + '<div class="d-bar">'
     +   '<a class="dbtn" href="/cockpit?run='+encodeURIComponent(runId)+'">코크핏에서 열기</a>'
     +   '<button type="button" class="dbtn danger" data-stop="'+runId+'">정지</button>'
     + '</div>';
    return h;
  }

  function openDetail(runId){
    sel=runId; curId=runId;
    setLayout('detail');
    $('hudDetail').innerHTML=detailHTML(runId);
    paintTimeline(runId);
    if(runIsSession(runId)) loadTail(runId);
    else if(agentStateOf(runId)==='waiting') loadQuestion(runId);
    render();
  }
  function closeDetail(){
    sel=null; $('hudDetail').innerHTML='';
    setLayout('list'); render();
  }
  function paintTimeline(runId){
    var el=$('hudDetail').querySelector('[data-role=dtl]'); if(!el) return;
    var r=runById[runId];
    var lines=humanLines((r&&r.events)||[]).slice(-6);
    if(!lines.length){ el.innerHTML='<div class="d-l"><span class="at">아직 이벤트가 없습니다</span></div>'; return; }
    var h=''; lines.forEach(function(l){
      h+='<div class="d-l"><span class="ak">'+esc(l.k)+'</span><span class="at">'+esc(String(l.t).slice(0,200))+'</span></div>';
    });
    el.innerHTML=h;
  }
  // 기다리는 에이전트가 **무엇을 묻는지** — 코크핏을 열지 않고 알아야 하는 한 가지.
  // 출처는 둘뿐이다: 터미널의 지금 화면(스크롤백 꼬리) 또는 파싱된 스트림의 마지막 말.
  // 둘 다 없으면 없다고 말한다. 추측한 질문을 보여주면 그 위에서 내리는 결정이 전부 거짓이 된다.
  function loadQuestion(runId){
    var lastSaid='';
    var r=runById[runId];
    var lines=humanLines((r&&r.events)||[]);
    for(var i=lines.length-1;i>=0;i--){ if(lines[i].k==='said'||lines[i].k==='ask'){ lastSaid=String(lines[i].t); break; } }
    fetch('/api/runs/'+runId+'/scrollback?lines=60').then(function(x){ return x.json(); }).then(function(d){
      if(sel!==runId) return;
      var box=$('hudDetail').querySelector('[data-role=qbox]'); if(!box) return;
      var tail=(d&&d.ok&&d.text)?String(d.text).replace(/\\s+$/,''):'';
      if(tail){
        var keep=tail.split('\\n').slice(-14).join('\\n');
        box.innerHTML='<span class="qk">터미널 마지막 화면</span><pre>'+esc(keep)+'</pre>';
        return;
      }
      if(lastSaid){ box.innerHTML='<span class="qk">마지막 말</span><pre>'+esc(lastSaid.slice(0,600))+'</pre>'; return; }
      box.innerHTML='<span class="qk">pending</span><div class="unk">무엇을 묻는지 읽지 못했습니다 \\u2014 터미널을 열어 확인하세요</div>';
    }).catch(function(){
      if(sel!==runId) return;
      var box=$('hudDetail').querySelector('[data-role=qbox]'); if(!box) return;
      box.innerHTML='<span class="qk">pending</span><div class="unk">무엇을 묻는지 읽지 못했습니다 \\u2014 터미널을 열어 확인하세요</div>';
    });
  }
  function loadTail(runId){
    fetch('/api/runs/'+runId+'/scrollback?lines=80').then(function(x){ return x.json(); }).then(function(d){
      if(sel!==runId) return;
      var el=$('hudDetail').querySelector('[data-role=tail]'); if(!el) return;
      if(d&&d.ok&&String(d.text||'').trim()){
        el.textContent=String(d.text).replace(/\\s+$/,'').split('\\n').slice(-30).join('\\n');
      } else el.textContent=(d&&d.text)||'터미널 화면을 읽지 못했습니다';
    }).catch(function(){
      if(sel!==runId) return;
      var el=$('hudDetail').querySelector('[data-role=tail]'); if(el) el.textContent='터미널 화면을 읽지 못했습니다';
    });
  }
  function loadDiff(runId){
    var el=$('hudDetail').querySelector('[data-role=ddiff]'); if(!el) return;
    el.hidden=false; el.textContent='Loading\\u2026';
    fetch('/api/runs/'+runId+'/diff').then(function(x){ return x.json(); }).then(function(d){
      if(sel!==runId) return;
      if(d&&d.ok) el.textContent=String((d.stat?d.stat+'\\n\\n':'')+(d.diff||'')).split('\\n').slice(0,60).join('\\n')||'변경 없음';
      else el.textContent=(d&&d.stat)||'worktree 가 없어 diff 를 볼 수 없습니다';
    }).catch(function(){ if(sel===runId) el.textContent='diff 를 가져오지 못했습니다'; });
  }

  // ── 행동 — 전부 이미 있는 창구다(새로 생긴 것은 input 하나뿐) ───────────
  // 살아 있는 run 에 한 줄 써 넣기 = POST /api/runs/:id/input (tmux send-keys).
  // 정착한 run 은 steer(--resume) 가 옳은 길이므로 그쪽으로 보낸다.
  function sendInput(runId, text){
    return fetch('/api/runs/'+runId+'/input', {
      method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({text:text}),
    }).then(function(x){ return x.json().then(function(j){ return {code:x.status, j:j}; }); });
  }
  function quickReply(runId, k){
    var q=replyFor(k); if(!q) return;
    sendInput(runId, q.send).then(function(res){
      if(res.code===200 && res.j && res.j.ok) toast('보냄 \\u00b7 '+q.send);
      else toast('보내지 못했습니다: '+((res.j&&(res.j.detail||res.j.error))||res.code));
    }).catch(function(){ toast('보내지 못했습니다'); });
  }
  function steer(runId){
    var inp=$('steerInput'); if(!inp) return;
    var v=(inp.value||'').trim();
    if(!v){ inp.focus(); toast('보낼 한 줄을 적으세요'); return; }
    if(runLive(runId)){
      sendInput(runId, v).then(function(res){
        if(res.code===200 && res.j && res.j.ok){ inp.value=''; toast('보냄'); }
        else toast('보내지 못했습니다: '+((res.j&&(res.j.detail||res.j.error))||res.code));
      }).catch(function(){ toast('보내지 못했습니다'); });
      return;
    }
    fetch('/api/runs/'+runId+'/steer', {
      method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({message:v}),
    }).then(function(x){ return x.json().then(function(j){ return {code:x.status, j:j}; }); })
      .then(function(res){
        if(res.code===202 || (res.j&&res.j.ok)){ inp.value=''; toast('이어서 보냈습니다'); }
        else toast('보내지 못했습니다: '+((res.j&&(res.j.detail||res.j.error))||res.code));
      }).catch(function(){ toast('보내지 못했습니다'); });
  }
  function stop(runId){
    fetch('/api/runs/'+runId+'/stop', {method:'POST'}).then(function(x){ return x.json(); }).then(function(j){
      toast(j&&j.ok?('r'+runId+' 정지'):('정지 실패: '+((j&&(j.detail||j.error))||'')));
      hydrate();
    }).catch(function(){ toast('정지 실패'); });
  }
  // 세션 이름 변경 — 네이티브 prompt 를 띄우지 않는다. 버튼 자리가 그대로 입력칸이 된다.
  function startRename(runId, btn){
    var r=runById[runId]; if(!r) return;
    var t=taskById[r.taskId]; if(!t) return;
    var box=document.createElement('span');
    box.className='d-steer';
    box.innerHTML='<input id="renameInput" value="'+escA(t.title||'')+'" autocomplete="off" spellcheck="false" />';
    btn.replaceWith(box);
    var inp=$('renameInput'); inp.focus(); inp.select();
    var commit=function(){
      var v=(inp.value||'').trim();
      if(!v || v===t.title){ openDetail(runId); return; }
      fetch('/api/tasks/'+r.taskId, {
        method:'PATCH', headers:{'content-type':'application/json'}, body:JSON.stringify({title:v}),
      }).then(function(x){ return x.json(); }).then(function(j){
        if(j&&j.ok!==false) toast('이름 변경'); else toast('이름 변경 실패: '+((j&&j.error)||''));
        hydrate();
      }).catch(function(){ toast('이름 변경 실패'); });
    };
    inp.addEventListener('keydown', function(e){
      if(e.key==='Enter'){ e.preventDefault(); commit(); }
      else if(e.key==='Escape'){ e.preventDefault(); e.stopPropagation(); openDetail(runId); }
    });
  }
  // 삭제는 되돌릴 수 없다 — 버튼이 두 걸음이 된다(네이티브 confirm 금지, DESIGN.md 규칙).
  function armDelete(runId, btn){
    if(btn.dataset.armed==='1'){
      fetch('/api/runs/'+runId, {method:'DELETE'}).then(function(x){ return x.json(); }).then(function(j){
        if(j&&j.ok){ toast('세션 삭제 \\u00b7 폴더는 그대로입니다'); closeDetail(); }
        else toast('삭제 실패: '+((j&&(j.detail||j.error))||''));
        hydrate();
      }).catch(function(){ toast('삭제 실패'); });
      return;
    }
    btn.dataset.armed='1';
    btn.textContent='정말 삭제? (폴더는 보존)';
    setTimeout(function(){ if(btn&&btn.dataset.armed==='1'){ btn.dataset.armed=''; btn.textContent='삭제'; } }, 4000);
  }

  // ── 클릭 위임 ────────────────────────────────────────────────────────
  $('hudList').addEventListener('click', function(e){
    var t=e.target.closest('#restToggle');
    if(t){ restOpen=!restOpen; render(); return; }
    var row=e.target.closest('.row'); if(!row) return;
    openDetail(Number(row.dataset.run));
  });
  $('hudDetail').addEventListener('click', function(e){
    var b=e.target.closest('button'); if(!b) return;
    if(b.dataset.qr) return quickReply(Number(b.dataset.qr), b.dataset.qk);
    if(b.dataset.steer) return steer(Number(b.dataset.steer));
    if(b.dataset.stop) return stop(Number(b.dataset.stop));
    if(b.dataset.diff) return loadDiff(Number(b.dataset.diff));
    if(b.dataset.rename) return startRename(Number(b.dataset.rename), b);
    if(b.dataset.del) return armDelete(Number(b.dataset.del), b);
  });
  $('hudDetail').addEventListener('keydown', function(e){
    if(e.key==='Enter' && e.target.id==='steerInput'){ e.preventDefault(); if(sel!=null) steer(sel); }
  });

  // ── 키보드: j/k 이동 · enter 상세 · y/n/c 즉답 · esc 한 겹씩 닫기 ────────
  function move(d){
    if(!rowIds.length) return;
    cur=(cur<0)?(d>0?0:rowIds.length-1):Math.max(0, Math.min(rowIds.length-1, cur+d));
    curId=rowIds[cur];
    Array.prototype.forEach.call($('hudList').querySelectorAll('.row'), function(el){
      el.classList.toggle('on', Number(el.dataset.run)===curId);
    });
    var on=$('hudList').querySelector('.row.on'); if(on&&on.scrollIntoView) on.scrollIntoView({block:'nearest'});
  }
  document.addEventListener('keydown', function(e){
    var tag=(e.target&&e.target.tagName)||'';
    var typing=(tag==='INPUT'||tag==='TEXTAREA');
    if(e.key==='Escape'){
      if(typing){ e.target.blur(); return; }
      e.preventDefault();
      if(layout==='detail') closeDetail(); else if(layout==='list') collapse();
      return;
    }
    if(typing) return;
    if(layout==='pill'){
      if(e.key==='Enter'||e.key===' '){ e.preventDefault(); expand(); }
      return;
    }
    if(e.key==='j'){ e.preventDefault(); move(1); return; }
    if(e.key==='k'){ e.preventDefault(); move(-1); return; }
    if(e.key==='Enter'){ e.preventDefault(); if(cur>=0) openDetail(rowIds[cur]); return; }
    if(e.key==='y'||e.key==='n'||e.key==='c'){
      var id=(cur>=0)?rowIds[cur]:sel;
      if(id==null) return;
      // 즉답은 **대기 중인 행에만** 선다 — 아무 run 에나 글자를 밀어 넣지 않는다.
      if(agentStateOf(id)!=='waiting'){ toast('대기 중인 에이전트에만 답할 수 있습니다'); return; }
      e.preventDefault();
      quickReply(id, e.key==='y'?'approve':(e.key==='n'?'deny':'cont'));
    }
  });

  // ── 데이터: /api/fleet + /ws (코크핏과 같은 델타 규율) ──────────────────
  async function hydrate(){
    try{
      var d=await (await fetch('/api/fleet?view=all')).json();
      fleet=d; runById={}; taskById={}; repoById={};
      (d.runs||[]).forEach(function(r){ runById[r.id]=r; });
      (d.tasks||[]).forEach(function(t){ taskById[t.id]=t; });
      (d.repos||[]).forEach(function(r){ repoById[r.id]=r; });
      agentState={};
      var asm=d.agentStates||{};
      Object.keys(asm).forEach(function(k){ var s=asm[k]&&asm[k].state; if(s&&s!=='unknown') agentState[k]=s; });
      if(sel!=null && !runById[sel]){ closeDetail(); return; }
      render();
      if(sel!=null && layout==='detail'){ paintTimeline(sel); paintDetailState(sel); }
    }catch(e){ /* 재시도는 WS 재연결 or 다음 hydrate */ }
  }
  // 상태 델타 한 건 = 그 자리만 칠한다(리하이드레이트 없음 — Part A 규율 그대로).
  function paintDetailState(runId){
    if(sel!==runId || layout!=='detail') return;
    var s=agentStateOf(runId);
    var chip=$('hudDetail').querySelector('[data-role=dchip]');
    if(chip){ chip.className='d-chip '+asClass(s); chip.textContent=s||((runById[runId]&&runById[runId].status)||''); }
    var now=$('hudDetail').querySelector('[data-role=dnow]');
    if(now) now.textContent=actNowText(runId);
  }
  function paintAgentState(runId, state){
    var prevBucket=bucketOf(runId);
    if(state&&state!=='unknown') agentState[runId]=state; else delete agentState[runId];
    if(bucketOf(runId)!==prevBucket){ render(); }   // 갈래가 바뀌면 목록만 다시 그린다(가져오기 없음)
    else {
      var row=$('hudList').querySelector('.row[data-run="'+runId+'"] .st');
      if(row) row.className='st '+asClass(agentStateOf(runId));
      paintPill();
    }
    paintDetailState(runId);
  }
  function bucketOf(runId){
    var r=runById[runId]; if(!r) return 'none';
    var s=agentStateOf(runId), sess=runIsSession(runId);
    var live=(r.status==='running'||r.status==='pending'||r.status==='preparing');
    if(s==='waiting') return 'wait';
    if(!sess && (s==='working'||live)) return 'run';
    if(sess && r.tmuxWindow && r.status==='open') return 'rest';
    if(s==='idle'||s==='exited') return 'rest';
    return 'none';
  }
  var hydT=null;
  function scheduleHydrate(){ if(hydT) return; hydT=setTimeout(function(){ hydT=null; hydrate(); }, 400); }
  function wsConnect(){
    var proto=location.protocol==='https:'?'wss':'ws';
    var ws=new WebSocket(proto+'://'+location.host+'/ws');
    ws.onclose=function(){ setTimeout(wsConnect, 1500); };
    ws.onmessage=function(m){
      var ev=null; try{ ev=JSON.parse(m.data); }catch(e){}
      if(ev && ev.type==='agentstate'){ paintAgentState(ev.runId, ev.state); return; }
      scheduleHydrate();
    };
  }

  setLayout('pill');
  hydrate();
  wsConnect();
  setInterval(function(){ if(layout!=='pill') render(); }, 30000);   // 경과 시간만 천천히 갱신
})();
</script>
</body>
</html>`;
