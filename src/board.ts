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
    --s-done:#58b368; --s-failed:#e25b67; --s-error:#e25b67; --s-stopped:#b58be0; --s-merged:#4ec9b0; --s-open:#7f9cf5;
    --mono:ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,monospace;
    --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,Roboto,sans-serif;
    --r-card:10px; --r-ctl:8px; --shadow:0 8px 28px rgba(0,0,0,.35);
  }
  *{box-sizing:border-box}
  [hidden]{display:none !important}
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

  .flabel{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.1em;
    color:var(--faint);margin:2px 0 -2px}
  .btn[disabled]{opacity:.4;cursor:not-allowed;filter:none}

  /* ── repo browser ── */
  .brw{width:min(560px,94vw);max-height:78vh;background:var(--surface);border:1px solid var(--line);
    border-radius:14px;box-shadow:var(--shadow);display:flex;flex-direction:column;overflow:hidden}
  .brw-h{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--line)}
  .brw-path{flex:1;font-family:var(--mono);font-size:11.5px;color:var(--muted);overflow:hidden;
    white-space:nowrap;text-overflow:ellipsis;direction:rtl;text-align:left}
  .brw-list{overflow:auto;flex:1;min-height:200px;padding:6px}
  .brw-row{display:flex;align-items:center;gap:9px;padding:7px 10px;border-radius:7px;cursor:pointer;
    font-family:var(--mono);font-size:12.5px;color:var(--muted)}
  .brw-row:hover{background:var(--surface2);color:var(--ink)}
  .brw-row .ico{color:var(--faint);flex:none}
  .brw-row .nm{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
  .brw-row .gitchip{font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--brand);
    border:1px solid rgba(78,201,176,.4);border-radius:999px;padding:1px 7px;flex:none}
  .brw-row .btn{flex:none}
  .brw-f{display:flex;gap:8px;padding:11px 16px;border-top:1px solid var(--line);align-items:center}
  .brw-f .hint{font-family:var(--mono);font-size:11px;color:var(--faint);flex:1}

  /* ── custom dropdown (native select 대체) ── */
  .dd{position:relative}
  .dd-btn{width:100%;display:flex;align-items:center;gap:8px;background:#0e1118;color:var(--ink);
    border:1px solid var(--line);border-radius:var(--r-ctl);padding:8px 10px;font-family:var(--mono);
    font-size:12px;cursor:pointer;transition:border-color .15s;text-align:left}
  .dd-btn:hover{border-color:var(--line-hi)}
  .dd.open .dd-btn{border-color:rgba(78,201,176,.55)}
  .dd-lbl{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
  .dd-car{color:var(--faint);font-size:10px;transition:transform .15s}
  .dd.open .dd-car{transform:rotate(180deg)}
  .dd-panel{position:absolute;top:calc(100% + 5px);left:0;right:0;z-index:40;background:var(--surface2);
    border:1px solid var(--line-hi);border-radius:9px;box-shadow:var(--shadow);max-height:230px;
    overflow:auto;padding:4px;display:none}
  .dd.open .dd-panel{display:block}
  .dd-opt{padding:7px 10px;border-radius:6px;font-family:var(--mono);font-size:12px;color:var(--muted);
    cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .dd-opt:hover{background:var(--surface);color:var(--ink)}
  .dd-opt.on{color:var(--brand)}
  .dd-opt.on::before{content:'✓ ';font-size:10px}
  .seg{display:flex;gap:3px;padding:3px;border:1px solid var(--line);border-radius:var(--r-ctl);background:#0e1118}
  .seg-opt{flex:1;display:flex;flex-direction:column;align-items:center;gap:1px;padding:6px 8px;border:none;
    background:transparent;color:var(--muted);font-size:12px;font-weight:600;cursor:pointer;
    border-radius:calc(var(--r-ctl) - 3px);transition:background .15s,color .15s}
  .seg-opt:hover{color:var(--ink)}
  .seg-opt.on{background:var(--surface2);color:var(--ink)}
  .seg-opt[data-real="1"].on{background:var(--brand);color:var(--brand-ink)}
  .seg-hint{font-family:var(--mono);font-size:9.5px;font-weight:500;text-transform:uppercase;letter-spacing:.06em;opacity:.7}

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
  /* ── select mode (integrate) ── */
  .toolbar{display:flex;justify-content:flex-end;gap:8px;margin-bottom:12px}
  .card.selmode{cursor:copy}
  .card .selbox{display:none;width:20px;height:20px;border-radius:50%;border:1px solid var(--line-hi);
    align-items:center;justify-content:center;font-size:11px;color:transparent;flex:none}
  .card.selmode .selbox{display:flex}
  .card.selected{border-color:var(--brand)}
  .card.selected .selbox{background:var(--brand);border-color:var(--brand);color:var(--brand-ink)}
  .selbar{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:45;display:none;
    align-items:center;gap:12px;background:var(--surface);border:1px solid var(--line-hi);border-radius:12px;
    padding:10px 16px;box-shadow:var(--shadow)}
  .selbar.on{display:flex}
  .selbar .cnt{font-family:var(--mono);font-size:12px;color:var(--brand)}
  .selbar .note{font-family:var(--mono);font-size:11px;color:var(--faint)}

  .empty{color:var(--faint);font-family:var(--mono);font-size:12px;padding:64px 24px;text-align:center;
    display:flex;flex-direction:column;gap:10px;align-items:center}
  .empty .glyph{font-size:22px;color:#2c3444;letter-spacing:4px}

  /* ── onboarding (first run) ─────────────── */
  .setup{max-width:560px;margin:40px auto;border:1px solid var(--line);border-radius:14px;
    background:var(--surface);overflow:hidden;text-align:left}
  .setup-h{padding:18px 22px 14px;border-bottom:1px solid var(--line)}
  .setup-h .t{font-weight:700;font-size:16px}
  .setup-h .d{color:var(--muted);font-size:13px;margin-top:3px}
  .setup-sec{padding:14px 22px;border-bottom:1px solid var(--line)}
  .setup-sec:last-child{border-bottom:none}
  .setup-label{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.14em;
    color:var(--faint);margin:0 0 9px}
  .chk{display:flex;align-items:center;gap:10px;padding:6px 0;font-size:13px}
  .chk .st{font-family:var(--mono);font-size:12px;width:18px;text-align:center;flex:none}
  .chk.ok .st{color:var(--s-done)} .chk.bad .st{color:var(--s-failed)} .chk.wait .st{color:var(--faint)}
  .chk .nm{color:var(--ink);min-width:88px;font-weight:500}
  .chk .v{color:var(--faint);font-family:var(--mono);font-size:11.5px;overflow:hidden;
    white-space:nowrap;text-overflow:ellipsis}
  .setup-fix{margin:8px 0 2px;padding:10px 13px;background:#0e1118;border:1px solid var(--line);
    border-radius:8px;font-family:var(--mono);font-size:11.5px;color:var(--muted);overflow-x:auto;white-space:pre}
  .setup-steps{margin:0;padding-left:20px;color:var(--muted);font-size:13px}
  .setup-steps li{margin-bottom:7px}
  .setup-steps b{color:var(--ink)}

  /* ── toasts ─────────────────────────────── */
  .toasts{position:fixed;top:66px;right:18px;z-index:60;display:flex;flex-direction:column;gap:8px;
    max-width:380px}
  .toast{border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--ink);
    padding:10px 14px;font-size:13px;box-shadow:var(--shadow);display:flex;gap:9px;align-items:baseline;
    animation:tin .18s ease}
  .toast .tk{font-family:var(--mono);font-size:11px;flex:none}
  .toast.err{border-color:rgba(226,91,103,.5)} .toast.err .tk{color:var(--s-failed)}
  .toast.ok{border-color:rgba(78,201,176,.5)} .toast.ok .tk{color:var(--brand)}
  @keyframes tin{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
  @media (prefers-reduced-motion:reduce){.toast{animation:none}}

  /* ── confirm dialog ─────────────────────── */
  .cfm{width:min(440px,92vw);background:var(--surface);border:1px solid var(--line);border-radius:14px;
    box-shadow:var(--shadow);overflow:hidden}
  .cfm-b{padding:20px 22px 14px}
  .cfm-b .m{font-size:14px;color:var(--ink);line-height:1.6}
  .cfm-b .s{font-size:12.5px;color:var(--faint);margin-top:6px}
  .cfm-f{display:flex;gap:8px;justify-content:flex-end;padding:12px 18px;border-top:1px solid var(--line)}
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

  /* ── AI review panel (compare) ── */
  .cmp-review{border-bottom:1px solid var(--line);background:var(--surface2);padding:14px 20px;
    max-height:42vh;overflow:auto;font-size:13px;line-height:1.65;color:var(--muted)}
  .cmp-review[hidden]{display:none}
  .cmp-review h2{font-size:13px;color:var(--brand);margin:14px 0 6px;letter-spacing:.02em}
  .cmp-review h3{font-size:12.5px;color:var(--ink);margin:12px 0 4px}
  .cmp-review ul{margin:4px 0 8px;padding-left:18px}
  .cmp-review li{margin-bottom:3px}
  .cmp-review strong{color:var(--ink)}
  .cmp-review code{font-family:var(--mono);font-size:.9em;background:#0e1118;padding:1px 5px;border-radius:4px;color:var(--brand)}
  .cmp-review p{margin:0 0 8px}

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
  <button class="btn-ghost sm" id="bell" title="notify when a run settles">🔕</button>
  <div class="machines" id="machines"></div>
</header>
<div class="layout">
  <aside>
    <div class="sect">
      <p class="sect-label">Context</p>
      <p class="flabel">machine</p>
      <select id="repoMachine"></select>
      <p class="flabel">repository</p>
      <select id="taskRepo"></select>
      <div class="row">
        <button type="button" class="btn-ghost sm" id="repoBrowse" style="flex:1">Browse…</button>
        <button type="button" class="btn-ghost sm" id="repoManual" style="flex:0 0 auto" title="type an absolute path">Path</button>
        <button type="button" class="btn-ghost sm" id="repoRemove" style="flex:0 0 auto" title="remove selected repository from coxpit">×</button>
      </div>
      <form id="repoForm" hidden>
        <div class="row">
          <input id="repoPath" placeholder="/abs/path/to/repo" />
          <button class="btn-ghost sm" type="submit" style="flex:0 0 auto">Register</button>
        </div>
      </form>
    </div>

    <div class="sect">
      <p class="sect-label">Start</p>
      <div class="seg" id="launchTabs">
        <button type="button" class="seg-opt on" data-tab="task">Task</button>
        <button type="button" class="seg-opt" data-tab="goal">Goal</button>
        <button type="button" class="seg-opt" data-tab="bench">Workbench</button>
      </div>
      <form id="taskForm">
        <div id="panelTask" style="display:flex;flex-direction:column;gap:8px">
          <input id="taskTitle" placeholder="Task title" />
          <textarea id="taskPrompt" placeholder="Prompt — target files, constraints, how to verify"></textarea>
          <p class="flabel">design capture · optional</p>
          <select id="taskCapture"><option value="">no design capture</option></select>
        </div>
        <div id="panelGoal" hidden style="flex-direction:column;gap:8px">
          <textarea id="planGoal" placeholder="One goal — a planner agent reads the repo, splits it into independent tasks, and launches them all. Converge with Select runs → Integrate."></textarea>
        </div>
        <div id="panelBench" hidden style="flex-direction:column;gap:8px">
          <input id="benchTitle" placeholder="Workbench name · optional" />
          <p style="font-size:11.5px;color:var(--faint);margin:0;line-height:1.55">Isolated worktree + terminal. Work interactively — run <span style="color:var(--brand);font-family:var(--mono)">claude</span> inside, take hours — then decide the merge from the card.</p>
        </div>
        <div class="seg" id="modeSeg" role="group" aria-label="agent mode">
          <button type="button" class="seg-opt" data-real="0">Dry run</button>
          <button type="button" class="seg-opt" data-real="1">Real agent<span class="seg-hint">spends credits</span></button>
        </div>
        <input type="checkbox" id="taskReal" hidden />
        <div class="row">
          <input id="taskCount" class="narrow" type="number" min="1" max="8" value="1" title="agents — 1 for a job, N to explore variants" />
          <button class="btn" type="submit" id="runFleetBtn">Run fleet</button>
        </div>
      </form>
    </div>

    <details class="sect" id="libraryBox">
      <summary class="sect-label" style="cursor:pointer;list-style:none">Library · design captures ▾</summary>
      <div id="captures" style="display:flex;flex-direction:column;gap:6px;margin-top:10px"></div>
      <a id="bmk" class="btn-ghost sm" style="text-decoration:none;text-align:center;display:block;padding:6px;margin-top:6px"
         title="drag me to your bookmarks bar, then click it on your running app">⌖ coxpit inspect</a>
      <span style="font-size:11px;color:var(--faint)">Drag to bookmarks. Click it on your app, then click an element.
      With auth on, append ?k=&lt;pass&gt; to the script URL.</span>
    </details>
  </aside>
  <main>
    <div class="toolbar"><button class="btn-ghost sm" id="selToggle">Select runs</button></div>
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
    <div class="modal-f" id="steerRow" style="border-top:1px solid var(--line)">
      <div class="seg" style="flex:0 0 132px" id="steerModeSeg">
        <button type="button" class="seg-opt on" data-mode="work">Work</button>
        <button type="button" class="seg-opt" data-mode="ask">Ask</button>
      </div>
      <input id="steerInput" placeholder="Next instruction — same session &amp; worktree…" style="flex:1" />
      <button class="btn sm" id="steerSend">Send</button>
    </div>
    <div class="modal-f">
      <button class="btn-ghost sm" id="mTerm">Terminal</button>
      <button class="btn-ghost sm" id="mRefreshDiff">Refresh diff</button>
      <button class="btn-ghost sm" id="mCompare">Compare runs</button>
      <button class="btn-ghost sm" id="mExport">Export files…</button>
      <button class="btn-ghost sm" id="mSync">Sync base</button>
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
      <button class="btn sm" id="cmpAI">AI review</button>
      <button class="btn-ghost sm" id="cmpRefresh">Refresh</button>
      <button class="x" id="cmpClose" aria-label="close">×</button>
    </div>
    <div class="cmp-review" id="cmpReview" hidden></div>
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

<div class="overlay" id="brwOverlay">
  <div class="brw">
    <div class="brw-h">
      <button class="btn-ghost sm" id="brwUp">↑ Up</button>
      <button class="btn-ghost sm" id="brwHome">Home</button>
      <span class="brw-path" id="brwPath"></span>
      <button class="x" id="brwClose" aria-label="close">×</button>
    </div>
    <div class="brw-list" id="brwList"></div>
    <div class="brw-f">
      <span class="hint">folders with a <span style="color:var(--brand)">git</span> badge are repositories — hit Register</span>
      <button class="btn sm" id="brwRegHere" style="display:none">Register this folder</button>
    </div>
  </div>
</div>

<div class="toasts" id="toasts"></div>

<div class="selbar" id="selbar">
  <span class="cnt" id="selCnt">0 selected</span>
  <span class="note">merges in selection order · conflicts spawn an integration agent</span>
  <button class="btn sm" id="selGo">Integrate → base</button>
  <button class="btn-ghost sm" id="selCancel">Cancel</button>
</div>

<div class="overlay" id="expOverlay">
  <div class="cfm">
    <div class="cfm-b">
      <div class="m">Export this run's changed files</div>
      <div class="s">Copies changed &amp; new files (with their folder structure) out of the worktree — no merge. Good for reports and one-off artifacts.</div>
      <p class="flabel" style="margin-top:12px">destination folder</p>
      <input id="expDest" placeholder="empty = ~/coxpit-exports/r<id>" />
    </div>
    <div class="cfm-f">
      <button class="btn-ghost sm" id="expCancel">Cancel</button>
      <button class="btn sm" id="expOk">Export</button>
    </div>
  </div>
</div>

<div class="overlay" id="cfmOverlay">
  <div class="cfm">
    <div class="cfm-b"><div class="m" id="cfmMsg"></div><div class="s" id="cfmSub"></div></div>
    <div class="cfm-f">
      <button class="btn-ghost sm" id="cfmCancel">Cancel</button>
      <button class="btn sm" id="cfmOk">Confirm</button>
    </div>
  </div>
</div>

<script src="/vendor/xterm.js"></script>
<script src="/vendor/addon-fit.js"></script>
<script>
const runs = new Map();      // runId -> run object
const tasks = new Map();     // taskId -> task
let repos = [], machines = [], captures = [];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const statusColor = (s) => 'var(--s-' + (s||'pending') + ', var(--muted))';

/* ── custom toast / confirm (시스템 alert·confirm 대체) ── */
function toast(msg, kind){
  const el = document.createElement('div');
  el.className = 'toast ' + (kind==='error'?'err':kind==='ok'?'ok':'');
  el.innerHTML = '<span class="tk">'+(kind==='error'?'✕':kind==='ok'?'✓':'·')+'</span><span>'+esc(msg)+'</span>';
  $('toasts').appendChild(el);
  setTimeout(()=>{ el.style.opacity='0'; el.style.transition='opacity .25s'; setTimeout(()=>el.remove(),260); }, 4200);
}
/* ── custom dropdown — 숨긴 native select 를 상태 보관용으로 감싼다 ── */
function dressSelect(id){
  const sel = $(id); if(!sel || sel.dataset.dd) return;
  sel.dataset.dd = '1';
  const dd = document.createElement('div'); dd.className = 'dd';
  dd.innerHTML = '<button type="button" class="dd-btn"><span class="dd-lbl"></span><span class="dd-car">▾</span></button><div class="dd-panel"></div>';
  sel.parentNode.insertBefore(dd, sel);
  sel.style.display = 'none';
  dd.querySelector('.dd-btn').addEventListener('click', (e)=>{
    e.stopPropagation();
    const wasOpen = dd.classList.contains('open');
    closeDropdowns();
    if (!wasOpen) dd.classList.add('open');
  });
  dd.querySelector('.dd-panel').addEventListener('click', (e)=>{
    const o = e.target.closest('.dd-opt'); if(!o) return;
    sel.value = o.dataset.v;
    dd.classList.remove('open');
    syncSelect(id);
  });
  syncSelect(id);
}
function syncSelect(id){
  const sel = $(id); if(!sel) return;
  const dd = sel.previousElementSibling;
  if (!dd || !dd.classList || !dd.classList.contains('dd')) return;
  const cur = sel.options[sel.selectedIndex];
  dd.querySelector('.dd-lbl').textContent = cur ? cur.textContent : '—';
  dd.querySelector('.dd-panel').innerHTML = [...sel.options].map(o =>
    '<div class="dd-opt'+(o.value===sel.value?' on':'')+'" data-v="'+esc(o.value)+'">'+esc(o.textContent)+'</div>').join('');
}
function closeDropdowns(){ document.querySelectorAll('.dd.open').forEach(d=>d.classList.remove('open')); }
document.addEventListener('click', closeDropdowns);

/* ── repo browser — 경로 타이핑 없이 클릭으로 등록 ── */
let brwCur = '';
async function brwGo(p){
  let d;
  try{ d = await fetch('/api/browse'+(p?('?path='+encodeURIComponent(p)):'')).then(x=>x.json()); }
  catch{ toast('browse failed', 'error'); return; }
  brwCur = d.path;
  $('brwPath').textContent = d.path;
  $('brwUp').dataset.p = d.parent;
  $('brwHome').dataset.p = d.home;
  $('brwRegHere').style.display = d.isRepo ? '' : 'none';
  $('brwList').innerHTML =
    (d.error ? '<div class="brw-row"><span class="nm" style="color:var(--s-failed)">'+esc(d.error)+'</span></div>' : '')
    + (d.dirs.map(x =>
        '<div class="brw-row" data-n="'+esc(x.name)+'"><span class="ico">▸</span><span class="nm">'+esc(x.name)+'</span>'
        + (x.isRepo ? '<span class="gitchip">git</span><button type="button" class="btn sm" data-reg="'+esc(x.name)+'">Register</button>' : '')
        + '</div>').join('')
      || '<div class="brw-row"><span class="nm" style="color:var(--faint)">no folders here</span></div>');
}
async function brwRegister(fullPath){
  const res = await fetch('/api/repos',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({machineSlug:$('repoMachine').value, path:fullPath})});
  if (res.ok){
    toast('repo registered — pick it under Launch agents', 'ok');
    $('brwOverlay').classList.remove('open');
    await hydrate();
  } else {
    const j = await res.json().catch(()=>({}));
    toast('register: '+(j.detail||j.error||res.status), 'error');
  }
}
$('repoBrowse').addEventListener('click', ()=>{
  const m = machines.find(x=>x.slug===$('repoMachine').value);
  if (m && m.address){ toast('remote machine — type the path manually for now', 'error'); return; }
  $('brwOverlay').classList.add('open');
  brwGo(brwCur || '');
});
$('brwList').addEventListener('click',(e)=>{
  const reg = e.target.closest('button[data-reg]');
  if (reg){ brwRegister(brwCur.replace(/\\/$/,'')+'/'+reg.dataset.reg); return; }
  const row = e.target.closest('.brw-row[data-n]');
  if (row) brwGo(brwCur.replace(/\\/$/,'')+'/'+row.dataset.n);
});
$('brwUp').addEventListener('click',(e)=>brwGo(e.currentTarget.dataset.p));
$('brwHome').addEventListener('click',(e)=>brwGo(e.currentTarget.dataset.p));
$('brwRegHere').addEventListener('click',()=>brwRegister(brwCur));
$('brwClose').addEventListener('click',()=>$('brwOverlay').classList.remove('open'));
$('brwOverlay').addEventListener('click',(e)=>{ if(e.target===$('brwOverlay')) $('brwOverlay').classList.remove('open'); });

let cfmResolve = null;
function confirmUI(message, opts){
  opts = opts || {};
  $('cfmMsg').textContent = message;
  $('cfmSub').textContent = opts.sub || '';
  $('cfmSub').style.display = opts.sub ? '' : 'none';
  const ok = $('cfmOk');
  ok.textContent = opts.okLabel || 'Confirm';
  ok.className = (opts.danger ? 'btn-danger sm' : 'btn sm');
  $('cfmOverlay').classList.add('open');
  return new Promise((resolve)=>{ cfmResolve = resolve; });
}
function cfmClose(v){ $('cfmOverlay').classList.remove('open'); if(cfmResolve){ cfmResolve(v); cfmResolve=null; } }
$('cfmOk').addEventListener('click', ()=>cfmClose(true));
$('cfmCancel').addEventListener('click', ()=>cfmClose(false));
$('cfmOverlay').addEventListener('click',(e)=>{ if(e.target===$('cfmOverlay')) cfmClose(false); });

/* 이벤트 인간화 — JSON 원문 대신 사람이 읽는 한 줄로. null = 표시 생략(노이즈). */
function humanize(e){
  const kind = e.kind, payload = e.payload;
  if (kind === 'rate_limit_event') return null;
  if (kind === 'steer') return { k:'steer', t:'→ '+payload };
  if (kind === 'ask') return { k:'ask', t:'? '+payload };
  if (kind === 'sync') return { k:'sync', t:payload };
  if (kind === 'export'){ try{ const o=JSON.parse(payload); return { k:'export', t:o.copied+' file(s) → '+o.dest }; }catch{ return { k:'export', t:payload }; } }
  if (kind === 'pr') return { k:'pr', t:payload };
  if (kind === 'stderr') return { k:'stderr', t:payload };
  try{
    const o = JSON.parse(payload);
    if (o.type === 'system'){
      if (o.subtype === 'init' || !o.subtype) return { k:'session', t:'started'+(o.model?' · '+o.model:'') };
      if (o.subtype === 'permission_denied') return { k:'denied', t:'⛔ '+(o.tool_name||o.tool||'tool use')+' blocked — attach the Terminal to approve, or widen COXPIT_AGENT_PERM' };
      return null; // thinking_tokens 등 스트림 잡음
    }
    if (o.type === 'user') return null; // tool 결과 회신 — 노이즈
    if (o.type === 'assistant' && o.message){
      const parts = [];
      for (const x of (o.message.content||[])){
        if (x.type === 'text' && x.text) parts.push({ k:'said', t:x.text });
        else if (x.type === 'tool_use'){
          const i = x.input || {};
          const arg = i.file_path || i.command || i.path || i.pattern || '';
          parts.push({ k:'tool', t:'▸ '+x.name+(arg?' — '+String(arg).split('/').slice(-2).join('/').slice(0,60):'') });
        }
      }
      return parts.length ? parts : null;
    }
    if (o.type === 'assistant' && o.text) return { k:'said', t:o.text };
    if (o.type === 'result') return { k:'done', t:o.result || 'finished' };
    if (kind === 'meta') return { k:'start', t:'worktree '+String(o.worktree||'').split('/').slice(-2).join('/') };
    return { k:kind, t:payload.slice(0,140) };
  }catch{
    // 파싱 실패(과거에 잘려 저장된 이벤트 등) — JSON 잔해를 그대로 보여주지 않는다:
    // text 조각만 구제하고, 없으면 생략.
    if (payload.trim().startsWith('{')){
      const texts = [];
      const re = /"text":"((?:[^"\\\\]|\\\\.)*)"/g; let m;
      while ((m = re.exec(payload)) && texts.length < 2) texts.push(m[1].replace(/\\\\n/g,' ').slice(0,140));
      return texts.length ? { k:'said', t:texts.join(' · ') } : null;
    }
    return { k:kind, t:payload };
  }
}
function humanLines(events){
  const out = [];
  for (const e of (events||[])){
    const h = humanize(e);
    if (!h) continue;
    if (Array.isArray(h)) out.push(...h); else out.push(h);
  }
  return out;
}
function summarize(kind, payload){
  const h = humanize({kind, payload});
  if (!h) return '';
  return Array.isArray(h) ? h.map(x=>x.t).join(' · ') : h.t;
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
  if (!list.length) paintOnboarding();
  $('grid').innerHTML = list.map(cardHTML).join('');
}

/* ── first-run onboarding (빈 보드 = 준비 상태 점검 + 시작 안내) ── */
let readiness = null, probing = false;
async function probeFirstMachine(){
  if (probing || !machines.length) return;
  probing = true;
  try{
    readiness = await fetch('/api/machines/'+encodeURIComponent(machines[0].slug)+'/probe',{method:'POST'}).then(x=>x.json());
  }catch{ readiness = { reachable:false }; }
  probing = false;
  if (![...runs.values()].length) paintOnboarding();
}
function chkRow(name, ok, val){
  const cls = ok===null ? 'wait' : ok ? 'ok' : 'bad';
  const st = ok===null ? '…' : ok ? '✓' : '✕';
  return '<div class="chk '+cls+'"><span class="st">'+st+'</span><span class="nm">'+esc(name)+'</span>'
    + '<span class="v">'+esc(val||'')+'</span></div>';
}
function paintOnboarding(){
  const r = readiness;
  const agentBin = r && r.agent ? r.agent.bin : 'claude';
  let checks;
  if (!r){
    checks = chkRow('machine', null, 'checking…') ;
    probeFirstMachine();
  } else {
    checks = chkRow('connection', !!r.reachable, machines.length ? machines[0].slug : '')
      + chkRow('git', r.git ? r.git.ok : false, r.git ? r.git.version : '')
      + chkRow('tmux', r.tmux ? r.tmux.ok : false, r.tmux ? r.tmux.version : '')
      + chkRow('agent', r.agent ? r.agent.ok : false, r.agent ? (r.agent.ok ? agentBin+' '+r.agent.version : 'not found on PATH') : '');
  }
  const agentMissing = r && r.agent && !r.agent.ok;
  $('empty').innerHTML = '<div class="setup">'
    + '<div class="setup-h"><div class="t">Welcome to coxpit</div>'
    + '<div class="d">Run a fleet of coding agents on this machine — each in its own git worktree.</div></div>'
    + '<div class="setup-sec"><p class="setup-label">This machine</p>' + checks
    + (agentMissing
        ? '<div class="setup-fix"># install the agent CLI, then sign in once:\\nnpm i -g @anthropic-ai/claude-code\\n'+esc(agentBin)+'   # first run opens browser login</div>'
        : '<div class="setup-fix" style="white-space:normal">Agent CLI found. If real runs fail with an auth error, run <b>'+esc(agentBin)+'</b> once in a terminal to sign in.</div>')
    + '</div>'
    + '<div class="setup-sec"><p class="setup-label">Get started</p><ol class="setup-steps">'
    + '<li><b>Register a repo</b> — absolute path, in the left sidebar</li>'
    + '<li><b>Write a task</b> — title + a prompt that names the target files</li>'
    + '<li><b>Run fleet</b> — try <b>Dry run</b> first (free rehearsal), then <b>Real agent</b></li>'
    + '</ol></div></div>';
}
function cardHTML(r){
  const task = tasks.get(r.taskId);
  const closed = task && task.status==='closed';
  const title = (task ? esc(task.title) : ('task ' + (r.taskId ?? '?')))
    + (closed ? ' <span class="closed">· closed</span>' : '');
  const evs = humanLines(r.events).slice(-8).map(h =>
    '<div class="ev"><span class="k">'+esc(h.k)+'</span><span class="t">'+esc(h.t).slice(0,140)+'</span></div>'
  ).join('') || '<div class="ev"><span class="t" style="color:var(--faint)">waiting…</span></div>';
  const selCls = (selectMode?' selmode':'') + (selected.has(r.id)?' selected':'');
  return '<div class="card'+selCls+'" id="card-'+r.id+'">'
    + '<div class="card-h"><span class="rid">r'+r.id+'</span><span class="title">'+title+'</span>'
    + '<span class="selbox">✓</span>'+chipHTML(r.status)+'</div>'
    + '<div class="meta"><span>branch <b>'+esc(r.branch||'—')+'</b></span>'
    + '<span>files <b>'+(r.filesChanged??0)+'</b></span>'
    + '<span>'+esc(r.agent||'')+'</span>'
    + (r.prUrl ? '<a href="'+esc(r.prUrl)+'" target="_blank" rel="noopener" style="margin-left:auto">PR ↗</a>' : '')
    + '</div>'
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
  machines = r.machines||[]; repos = r.repos||[]; captures = r.captures||[];
  tasks.clear();
  (r.tasks||[]).forEach(t => tasks.set(t.id, t));
  runs.clear();
  (r.runs||[]).forEach(rn => runs.set(rn.id, { ...rn, events: rn.events||[] }));
  paintSidebar(); render();
}
function paintSidebar(){
  $('machines').innerHTML = machines.map(m =>
    '<span class="mchip"><span class="mdot '+(m.online?'on':'')+'"></span><b>'+esc(m.slug)+'</b></span>').join('');
  $('repoMachine').innerHTML = machines.map(m=>'<option value="'+esc(m.slug)+'">'+esc(m.slug)+'</option>').join('');
  const prevRepo = $('taskRepo').value;
  $('taskRepo').innerHTML = repos.length
    ? repos.map(r=>'<option value="'+r.id+'">'+esc(r.name)+' · '+esc(r.defaultBranch)+'</option>').join('')
    : '<option value="">register a repo — Browse… ↓</option>';
  if (prevRepo && repos.some(r=>String(r.id)===prevRepo)) $('taskRepo').value = prevRepo;
  $('runFleetBtn').disabled = !repos.length;
  const capSel = $('taskCapture');
  const cur = capSel.value;
  capSel.innerHTML = '<option value="">no design capture</option>' + captures.map(c=>
    '<option value="'+c.id+'">#'+c.id+' '+esc((c.selector||'').slice(0,40))+'</option>').join('');
  capSel.value = cur;
  ['repoMachine','taskRepo','taskCapture'].forEach(id => { dressSelect(id); syncSelect(id); });
  $('captures').innerHTML = captures.map(c=>
    '<div class="repo"><span class="nm">'+esc((c.selector||'?').slice(0,46))+'</span>'
    + '<button class="x" data-delcap="'+c.id+'" style="float:right;background:none;border:none;color:var(--faint);cursor:pointer">×</button>'
    + '<div class="path">'+esc((c.url||'').slice(0,70))+'</div></div>').join('')
    || '<div class="repo" style="color:var(--faint)">none captured</div>';
  $('bmk').href = "javascript:(function(){var s=document.createElement('script');s.src='"
    + location.origin + "/design/bookmarklet.js';document.body.appendChild(s)})()";
}
$('captures').addEventListener('click', async (e)=>{
  const b = e.target.closest('button[data-delcap]'); if(!b) return;
  await fetch('/api/design/'+b.dataset.delcap,{method:'DELETE'});
  hydrate();
});
$('repoRemove').addEventListener('click', async ()=>{
  const rid = $('taskRepo').value;
  if (!rid){ toast('no repository selected', 'error'); return; }
  const yes = await confirmUI('Remove the selected repository from coxpit?',
    { sub: 'The repo itself is untouched — only the registration is removed. Refused while it has open tasks.', danger: true, okLabel: 'Remove' });
  if (!yes) return;
  const res = await fetch('/api/repos/'+rid,{method:'DELETE'});
  const j = await res.json().catch(()=>({}));
  if (res.ok){ toast('repo removed', 'ok'); hydrate(); }
  else toast('remove: '+(j.detail||res.status), 'error');
});
$('repoManual').addEventListener('click', ()=>{
  const f = $('repoForm'); f.hidden = !f.hidden;
  if (!f.hidden) $('repoPath').focus();
});

/* ── 완료 알림(브라우저) — 벨 토글, run 정착 시 통지 ── */
let notifyOn = false;
try { notifyOn = localStorage.getItem('coxpit.notify') === '1' && Notification.permission === 'granted'; } catch {}
function paintBell(){ $('bell').textContent = notifyOn ? '🔔' : '🔕'; }
$('bell').addEventListener('click', async ()=>{
  if (!('Notification' in window)){ toast('this browser has no notification support', 'error'); return; }
  if (!notifyOn){
    const perm = await Notification.requestPermission();
    if (perm !== 'granted'){ toast('notification permission denied', 'error'); return; }
    notifyOn = true;
  } else notifyOn = false;
  try { localStorage.setItem('coxpit.notify', notifyOn ? '1' : '0'); } catch {}
  paintBell();
  toast(notifyOn ? 'will notify when runs settle' : 'notifications off', 'ok');
});
paintBell();
function notifySettleUI(ev){
  if (!notifyOn) return;
  const t = tasks.get(ev.taskId ?? (runs.get(ev.runId)||{}).taskId);
  try {
    new Notification('coxpit · r'+ev.runId+' '+ev.status, {
      body: (t ? t.title+' — ' : '') + (ev.filesChanged??0)+' file(s) changed',
      tag: 'coxpit-r'+ev.runId,
    });
  } catch {}
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
      if (ev.taskId!=null && !tasks.has(ev.taskId)) hydrate(); // 통합 태스크 등 신규 태스크 동기화
      render(); flash(ev.runId ?? ev.id); paintModal();
      if (openRunId===(ev.runId??ev.id) && ['done','failed','error','stopped'].includes(ev.status)) loadDiff();
      if (cmpTaskId!=null && ['done','failed','error','stopped','merged'].includes(ev.status)) paintCompare();
      if (['done','failed','error','stopped'].includes(ev.status)) notifySettleUI(ev);
    } else if (ev.type==='event'){
      const r = runs.get(ev.runId); if(!r){ hydrate(); return; }
      r.events = r.events||[]; r.events.push({ kind:ev.kind, payload:ev.payload });
      render(); flash(ev.runId); paintModal();
    } else if (ev.type==='task'){
      const t = tasks.get(ev.taskId);
      if (t){ t.status = ev.status; render(); paintModal(); } else { hydrate(); }
    } else if (ev.type==='capture'){
      captures.push(ev.capture); paintSidebar();
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
  // steer 는 정착한 real run 에서만 의미(드라이런은 세션 없음 — 서버가 사유와 함께 거절)
  $('steerRow').style.display = ['done','failed','stopped'].includes(r.status) ? '' : 'none';
  $('mTimeline').innerHTML = humanLines(r.events).map(h =>
    '<div class="ev"><span class="k">'+esc(h.k)+'</span><span class="t">'+esc(h.t)+'</span></div>'
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
/* ── select mode (integrate) ── */
let selectMode = false;
const selected = new Set();
const selOrder = [];
function setSelectMode(on){
  selectMode = on;
  if (!on){ selected.clear(); selOrder.length = 0; }
  $('selToggle').textContent = on ? 'Exit select' : 'Select runs';
  $('selbar').classList.toggle('on', on);
  $('selCnt').textContent = selected.size + ' selected';
  render();
}
$('selToggle').addEventListener('click', ()=>setSelectMode(!selectMode));
$('selCancel').addEventListener('click', ()=>setSelectMode(false));
$('selGo').addEventListener('click', async ()=>{
  if (!selOrder.length){ toast('select settled runs with changes first', 'error'); return; }
  const yes = await confirmUI('Integrate '+selOrder.length+' run(s) into the base branch?',
    { sub: 'Merged one by one in selection order. A run that conflicts spawns an integration agent (real, spends credits) to resolve it.', okLabel: 'Integrate' });
  if (!yes) return;
  const res = await fetch('/api/integrate',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({runIds:selOrder})});
  const j = await res.json().catch(()=>({}));
  if (res.ok){
    toast('integrate: '+j.merged+' merged · '+j.conflicts+' conflict→agent · '+j.skipped+' skipped', j.conflicts||j.skipped ? undefined : 'ok');
    setSelectMode(false); hydrate();
  } else toast('integrate: '+(j.error||res.status), 'error');
});

$('grid').addEventListener('click',(e)=>{
  const card = e.target.closest('.card'); if(!card) return;
  const id = Number(card.id.replace('card-',''));
  if (selectMode){
    const r = runs.get(id);
    const eligible = r && ['done','failed','stopped'].includes(r.status) && (r.filesChanged||0) > 0 && r.status!=='merged';
    if (!eligible){ toast('r'+id+': only settled runs with changes can be integrated', 'error'); return; }
    if (selected.has(id)){ selected.delete(id); selOrder.splice(selOrder.indexOf(id),1); }
    else { selected.add(id); selOrder.push(id); }
    $('selCnt').textContent = selected.size + ' selected';
    render();
    return;
  }
  openModal(id);
});
$('mClose').addEventListener('click', closeModal);
$('overlay').addEventListener('click',(e)=>{ if(e.target===$('overlay')) closeModal(); });
document.addEventListener('keydown',(e)=>{ if(e.key==='Escape'){ closeDropdowns(); cfmClose(false); $('brwOverlay').classList.remove('open'); $('expOverlay').classList.remove('open'); closeTerm(); closeModal(); cmpTaskId=null; $('cmpOverlay').classList.remove('open'); } });
$('mRefreshDiff').addEventListener('click', loadDiff);
$('mExport').addEventListener('click', ()=>{
  if (openRunId==null) return;
  $('expDest').value='';
  $('expDest').placeholder='empty = ~/coxpit-exports/r'+openRunId;
  $('expOverlay').classList.add('open');
});
async function doExport(){
  if (openRunId==null) return;
  const res = await fetch('/api/runs/'+openRunId+'/export',{method:'POST',
    headers:{'content-type':'application/json'}, body:JSON.stringify({dest:$('expDest').value.trim()})});
  const j = await res.json().catch(()=>({}));
  $('expOverlay').classList.remove('open');
  if (res.ok) toast(j.copied+' file(s) → '+j.dest, 'ok');
  else toast('export: '+(j.detail||res.status), 'error');
}
$('expOk').addEventListener('click', doExport);
$('expDest').addEventListener('keydown',(e)=>{ if(e.key==='Enter'){ e.preventDefault(); doExport(); } });
$('expCancel').addEventListener('click', ()=>$('expOverlay').classList.remove('open'));
$('expOverlay').addEventListener('click',(e)=>{ if(e.target===$('expOverlay')) $('expOverlay').classList.remove('open'); });
let steerMode = 'work';
document.querySelectorAll('#steerModeSeg .seg-opt').forEach(b=>{
  b.addEventListener('click', ()=>{
    steerMode = b.dataset.mode;
    document.querySelectorAll('#steerModeSeg .seg-opt').forEach(x=>x.classList.toggle('on', x===b));
    $('steerInput').placeholder = steerMode==='ask'
      ? 'Ask the session — status, decisions, anything (no file changes)…'
      : 'Next instruction — same session & worktree…';
  });
});
async function sendSteer(){
  if (openRunId==null) return;
  const msg = $('steerInput').value.trim(); if(!msg) return;
  const res = await fetch('/api/runs/'+openRunId+'/steer',{method:'POST',
    headers:{'content-type':'application/json'}, body:JSON.stringify({message:msg, mode:steerMode})});
  if (res.ok){
    $('steerInput').value='';
    toast(steerMode==='ask' ? 'asking — answer lands in the timeline' : 'working — same session & worktree', 'ok');
  }
  else { const j = await res.json().catch(()=>({})); toast('steer: '+(j.detail||res.status), 'error'); }
}
$('mSync').addEventListener('click', async ()=>{
  if (openRunId==null) return;
  const res = await fetch('/api/runs/'+openRunId+'/sync',{method:'POST'});
  const j = await res.json().catch(()=>({}));
  if (res.ok){ toast('base merged into session worktree', 'ok'); loadDiff(); }
  else toast('sync: '+(j.detail||res.status), 'error');
});
$('steerSend').addEventListener('click', sendSteer);
$('steerInput').addEventListener('keydown',(e)=>{ if(e.key==='Enter') sendSteer(); });
$('mStop').addEventListener('click', async ()=>{
  if (openRunId==null) return;
  await fetch('/api/runs/'+openRunId+'/stop',{method:'POST'});
});
$('mCleanup').addEventListener('click', async ()=>{
  if (openRunId==null) return;
  const yes = await confirmUI('Remove the worktree and branch for r'+openRunId+'?',
    { sub: 'Unmerged changes in this run will be lost. This cannot be undone.', danger: true, okLabel: 'Cleanup' });
  if (!yes) return;
  await fetch('/api/runs/'+openRunId+'/cleanup',{method:'POST'});
  toast('r'+openRunId+' cleaned up', 'ok');
  closeModal(); hydrate();
});
$('mCloseTask').addEventListener('click', async ()=>{
  if (openRunId==null) return;
  const r = runs.get(openRunId); if(!r) return;
  const yes = await confirmUI('Close this task?',
    { sub: 'Stops any live runs and removes every worktree and branch of the task.', danger: true, okLabel: 'Close task' });
  if (!yes) return;
  await fetch('/api/tasks/'+r.taskId+'/close',{method:'POST'});
  toast('task closed — all runs cleaned', 'ok');
  closeModal(); hydrate();
});

/* ── compare view ── */
let cmpTaskId = null;
async function openCompare(taskId){
  cmpTaskId = taskId;
  $('cmpReview').hidden = true; $('cmpReview').innerHTML = '';
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
      + '<div class="cmp-f"><span class="msg" id="cmpMsg-'+r.id+'">'
      + (r.prUrl ? '<a href="'+esc(r.prUrl)+'" target="_blank" rel="noopener">PR ↗ '+esc(r.prUrl.split('/').slice(-1)[0])+'</a>' : '')
      + '</span>'
      + (merged
        ? chipHTML('merged')
        : (r.prUrl ? '' : '<button class="btn-ghost sm" data-pr="'+r.id+'"'+(mergeable?'':' disabled')+'>Open PR</button>')
          + '<button class="btn sm" data-merge="'+r.id+'"'+(mergeable?'':' disabled')+'>Merge this</button>')
      + '</div></div>';
  }).join('');
}
$('cmpBody').addEventListener('click', async (e)=>{
  const prBtn = e.target.closest('button[data-pr]');
  if (prBtn){
    const rid = Number(prBtn.dataset.pr);
    const yes = await confirmUI('Open a pull request from r'+rid+'?',
      { sub: 'Commits the worktree, pushes the branch to origin, and opens a PR against the base branch (needs gh CLI signed in).', okLabel: 'Open PR' });
    if (!yes) return;
    prBtn.disabled = true;
    const res = await fetch('/api/runs/'+rid+'/pr',{method:'POST'});
    const j = await res.json().catch(()=>({}));
    if (res.ok){ toast('PR opened: '+j.url, 'ok'); await paintCompare(); hydrate(); }
    else { toast('PR: '+(j.detail||res.status), 'error'); prBtn.disabled = false; }
    return;
  }
  const btn = e.target.closest('button[data-merge]'); if(!btn) return;
  const rid = Number(btn.dataset.merge);
  const yes = await confirmUI('Merge r'+rid+' into the base branch?',
    { sub: 'Uncommitted worktree changes are committed first. Conflicts abort automatically.', okLabel: 'Merge' });
  if (!yes) return;
  btn.disabled = true;
  const res = await fetch('/api/runs/'+rid+'/merge',{method:'POST'});
  const j = await res.json().catch(()=>({detail:'merge failed'}));
  const msg = $('cmpMsg-'+rid);
  if (msg) msg.textContent = j.detail || (res.ok?'merged':'failed');
  if (res.ok){ toast('r'+rid+' merged to base', 'ok'); await paintCompare(); hydrate(); }
  else { toast('merge: '+(j.detail||res.status), 'error'); btn.disabled = false; }
});
$('cmpClose').addEventListener('click', ()=>{ cmpTaskId=null; $('cmpOverlay').classList.remove('open'); });
$('cmpOverlay').addEventListener('click',(e)=>{ if(e.target===$('cmpOverlay')){ cmpTaskId=null; $('cmpOverlay').classList.remove('open'); } });
$('cmpRefresh').addEventListener('click', paintCompare);
/* 초경량 md 렌더 (리뷰 표시용) */
function mdLite(src){
  let s = esc(src);
  s = s.replace(/\`\`\`[a-z]*\\n([\\s\\S]*?)\`\`\`/g, (m,c)=>'<pre style="background:#0e1118;border:1px solid var(--line);border-radius:7px;padding:8px 10px;overflow-x:auto">'+c+'</pre>');
  s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  s = s.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  s = s.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
  s = s.replace(/(<li>[\\s\\S]*?<\\/li>)(?!\\s*<li>)/g, '<ul>$1</ul>');
  s = s.split(/\\n{2,}/).map(b => /^<(h2|h3|ul|pre)/.test(b.trim()) ? b : (b.trim()? '<p>'+b.replace(/\\n/g,'<br>')+'</p>':'' )).join('');
  return s;
}
$('cmpAI').addEventListener('click', async ()=>{
  if (cmpTaskId==null) return;
  const yes = await confirmUI('Run an AI review of these implementations?',
    { sub: 'A reviewer agent reads every diff and summarizes each approach, pros/cons, and a recommendation — so you judge instead of reading all the code. Real agent, spends credits (~1–2 min).', okLabel: 'Review' });
  if (!yes) return;
  const btn = $('cmpAI');
  btn.disabled = true; btn.textContent = 'Reviewing…';
  try{
    const res = await fetch('/api/tasks/'+cmpTaskId+'/review',{method:'POST',
      headers:{'content-type':'application/json'}, body:JSON.stringify({real:true})});
    const j = await res.json().catch(()=>({}));
    if (res.ok){ $('cmpReview').innerHTML = mdLite(j.review||''); $('cmpReview').hidden = false; }
    else toast('review: '+(j.detail||res.status), 'error');
  } finally { btn.disabled = false; btn.textContent = 'AI review'; }
});
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
/* ── 런처 탭 — 하나의 시작점: Task | Goal | Workbench ── */
let lTab = 'task';
const L_LABEL = { task: 'Run fleet', goal: 'Plan & fan out', bench: 'Open workbench' };
document.querySelectorAll('#launchTabs .seg-opt').forEach(b=>{
  b.addEventListener('click', ()=>{
    lTab = b.dataset.tab;
    document.querySelectorAll('#launchTabs .seg-opt').forEach(x=>x.classList.toggle('on', x===b));
    $('panelTask').style.display = lTab==='task' ? 'flex' : 'none';
    $('panelGoal').hidden = lTab!=='goal';
    $('panelGoal').style.display = lTab==='goal' ? 'flex' : 'none';
    $('panelBench').hidden = lTab!=='bench';
    $('panelBench').style.display = lTab==='bench' ? 'flex' : 'none';
    $('modeSeg').style.display = lTab==='bench' ? 'none' : 'flex';   // workbench 는 에이전트 없음
    $('taskCount').style.display = lTab==='task' ? '' : 'none';
    $('runFleetBtn').textContent = L_LABEL[lTab];
  });
});

async function submitGoal(){
  const repoId = Number($('taskRepo').value);
  const goal = $('planGoal').value.trim();
  if (!repoId){ toast('register a repo first', 'error'); return; }
  if (!goal){ toast('write a goal first', 'error'); return; }
  const real = $('taskReal').checked;
  const btn = $('runFleetBtn');
  btn.disabled = true; btn.textContent = real ? 'Planning… (1–3 min)' : 'Planning…';
  try{
    const res = await fetch('/api/plan',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({repoId, goal, real})});
    const j = await res.json().catch(()=>({}));
    if (res.ok){ toast(j.tasks.length+' task(s) planned & launched', 'ok'); $('planGoal').value=''; hydrate(); }
    else toast('plan: '+(j.detail||j.error||res.status), 'error');
  } finally { btn.disabled = false; btn.textContent = L_LABEL[lTab]; }
}

async function submitBench(){
  const repoId = Number($('taskRepo').value);
  if (!repoId){ toast('register a repo first', 'error'); return; }
  const res = await fetch('/api/workbench',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({repoId, title: $('benchTitle').value.trim()})});
  const j = await res.json().catch(()=>({}));
  if (!res.ok){ toast('workbench: '+(j.detail||j.error||res.status), 'error'); return; }
  toast('workbench open — terminal attached', 'ok');
  $('benchTitle').value='';
  await hydrate();
  openTerm(j.runId);   // 바로 터미널로
}

$('repoForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const body = { machineSlug: $('repoMachine').value, path: $('repoPath').value.trim() };
  if (!body.path) return;
  const res = await fetch('/api/repos',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  if (res.ok){ $('repoPath').value=''; toast('repo registered', 'ok'); await hydrate(); }
  else { const j = await res.json().catch(()=>({})); toast('repo: '+(j.detail||j.error||res.status), 'error'); }
});
$('taskForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  if (lTab === 'goal') return submitGoal();
  if (lTab === 'bench') return submitBench();
  const repoId = Number($('taskRepo').value);
  const title = $('taskTitle').value.trim();
  if (!repoId || !title){ toast(!repoId?'register a repo first':'task title required', 'error'); return; }
  const capId = Number($('taskCapture').value) || undefined;
  const t = await fetch('/api/tasks',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({repoId,title,prompt:$('taskPrompt').value,designCaptureId:capId})}).then(x=>x.json());
  if (!t.ok){ toast('task create failed', 'error'); return; }
  tasks.set(t.task.id, t.task);
  await fetch('/api/tasks/'+t.task.id+'/run',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({count:Number($('taskCount').value)||1, real: $('taskReal').checked})});
  $('taskTitle').value=''; $('taskPrompt').value='';
});

/* ── agent mode segmented control (mirrors hidden #taskReal) ── */
const segOpts = Array.from(document.querySelectorAll('#modeSeg .seg-opt'));
function setMode(real, persist){
  $('taskReal').checked = real;
  for (const b of segOpts){
    const on = (b.dataset.real === '1') === real;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  if (persist) try { localStorage.setItem('coxpit.real', real ? '1' : '0'); } catch {}
}
for (const b of segOpts) b.addEventListener('click', ()=>setMode(b.dataset.real === '1', true));
let savedMode = null;
try { savedMode = localStorage.getItem('coxpit.real'); } catch {}
setMode(savedMode === '1', false);

hydrate().then(connectWS);
</script>
</body>
</html>`;
