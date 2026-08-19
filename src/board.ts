// 데몬이 서빙하는 단일 페이지 플릿 콘솔(빌드 스텝 0, 자가완결).
// /api/fleet 로 하이드레이트 → /ws 구독 델타 → run 상세(타임라인·diff·터미널)·비교/머지.
import { ICON_SPRITE, ICON_CSS, ICON_JS_HELPER } from './icons.js';

export const BOARD_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
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
  .daemon-badge{font-family:var(--mono);font-size:10.5px;color:var(--faint);padding:3px 9px;
    border:1px solid var(--line);border-radius:999px;background:var(--surface);cursor:default}
  .daemon-badge b{color:var(--muted);font-weight:500}
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
  /* ── deliverable 계약 칩(Task compose) ── */
  .ochips{display:flex;flex-wrap:wrap;gap:5px}
  .ochip{background:transparent;color:var(--muted);border:1px solid var(--line);cursor:pointer;
    font-family:var(--mono);font-size:11px;padding:4px 10px;border-radius:999px;
    transition:border-color .15s,color .15s,background .15s}
  .ochip:hover{color:var(--ink);border-color:var(--line-hi)}
  .ochip.on{background:var(--brand-dim);color:var(--brand);border-color:rgba(78,201,176,.4)}

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
  /* ── group bands (goal/swarm 형제 묶음) — 점선 클러스터, 좌측 액센트 바·채움 금지 ── */
  .gband{grid-column:1/-1;border:1px dashed var(--line-hi);border-radius:14px;padding:12px;margin-bottom:0}
  .gband-h{display:flex;align-items:center;gap:10px;margin-bottom:10px;font-family:var(--mono)}
  .gband-glyph{color:var(--brand);font-size:13px}
  .gband-t{color:var(--ink);font-size:12.5px;font-weight:600;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:40%}
  .gband-n{color:var(--faint);font-size:11px}
  .gband-sp{flex:1}
  .gband-fold{background:none;border:none;color:var(--muted);cursor:pointer;font-size:12px}
  .gband.folded .gband-grid{display:none}
  .gband-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:14px}
  .attempt{color:var(--brand);opacity:.8}

  /* ── goal workroom (v4.6) — 한 goal 을 여는 단일 방 ── */
  .gband-open{margin-left:2px}
  .room{width:min(920px,96vw);max-height:90vh;background:var(--surface);border:1px solid var(--line);
    border-radius:16px;display:flex;flex-direction:column;overflow:hidden;box-shadow:var(--shadow)}
  .rh{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--line);
    background:linear-gradient(180deg,var(--brand-dim),transparent)}
  .rh .rh-glyph{color:var(--brand);font-family:var(--mono);font-size:15px}
  .rh .rh-t{font-weight:600;font-size:14px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .rh .rh-n{font-family:var(--mono);font-size:11px;color:var(--faint)}
  .rh .x{background:transparent;border:none;color:var(--muted);font-size:19px;cursor:pointer;
    padding:2px 9px;border-radius:6px;line-height:1}
  .rh .x:hover{color:var(--ink);background:var(--surface2)}
  .chips{display:flex;flex-wrap:wrap;gap:7px;padding:12px 18px;border-bottom:1px solid var(--line)}
  .room .chip{cursor:pointer;transition:border-color .15s,filter .15s}
  .room .chip:hover{filter:brightness(1.15)}
  .room .chip .cid{font-weight:600}
  .room .chip .cmeta{opacity:.7;text-transform:none;letter-spacing:0}
  .room .chip.new{border-style:dashed}
  .body{overflow:auto;flex:1;min-height:120px}
  .feed{display:flex;flex-direction:column;gap:6px;padding:12px 18px;font-family:var(--mono);font-size:11.5px}
  .feed .fl{display:flex;gap:9px;align-items:baseline;min-width:0}
  .feed .fl .who{min-width:52px;flex:none;opacity:.9}
  .feed .fl .ft{color:var(--muted);word-break:break-word;flex:1}
  .feed .fl.mark .who{color:var(--brand)}
  .feed .empty-note{color:var(--faint)}
  .conv{display:flex;flex-direction:column;gap:12px;padding:12px 18px;font-size:12.5px}
  .conv .empty-note{color:var(--faint);font-family:var(--mono);font-size:11.5px}
  .conv .turn{display:flex;flex-direction:column;gap:3px}
  .conv .turn .role{font-family:var(--mono);font-size:9.5px;font-weight:600;text-transform:uppercase;letter-spacing:.06em}
  .conv .turn.you .role{color:var(--muted)}
  .conv .turn.coord .role{color:var(--brand)}
  .conv .turn .msg{color:var(--ink);white-space:pre-wrap;word-break:break-word;line-height:1.55}
  .conv .turn.you .msg{color:var(--muted)}
  .conv .turn .ro-note{font-family:var(--mono);font-size:9.5px;color:var(--faint);letter-spacing:.02em}
  /* ── v4.7 converge cockpit — group action bar + per-run decision rows ── */
  .gbar{display:flex;align-items:center;gap:12px;padding:10px 18px;border-bottom:1px solid var(--line);
    background:var(--surface2);font-family:var(--mono);font-size:11.5px}
  .gbar .selc{color:var(--muted)}
  .gbar .sp{flex:1}
  .gbar button{font-family:var(--mono);font-size:11.5px;background:transparent;border:1px solid var(--line-hi);
    color:var(--muted);border-radius:7px;padding:5px 11px;cursor:pointer}
  .gbar button:hover{color:var(--ink);border-color:var(--line-hi)}
  .gbar button.brand{background:var(--brand);border-color:var(--brand);color:var(--brand-ink);font-weight:700}
  .gbar button.brand[disabled]{opacity:.4;cursor:not-allowed}
  .gbar button.danger{color:var(--s-failed);border-color:rgba(226,91,103,.4)}
  .runs{padding:10px 12px;display:flex;flex-direction:column;gap:8px}
  .runs .empty-note{color:var(--faint);font-family:var(--mono);font-size:11.5px;text-align:center;padding:24px 0}
  .run{border:1px solid var(--line);border-radius:12px;background:var(--surface);overflow:hidden}
  .run.sel{border-color:var(--brand);box-shadow:inset 0 0 0 1px var(--brand-dim)}
  .run.dim{opacity:.6}
  .run-h{display:flex;align-items:center;gap:11px;padding:11px 13px;cursor:pointer}
  .run-h .cb{width:14px;height:14px;border:1px solid var(--line-hi);border-radius:4px;flex:none;
    display:inline-flex;align-items:center;justify-content:center;color:var(--brand);font-size:10px;cursor:pointer}
  .run.sel .run-h .cb{background:var(--brand);border-color:var(--brand);color:var(--brand-ink)}
  .run .dot{width:8px;height:8px;border-radius:50%;flex:none}
  .run-id{font-family:var(--mono);font-size:12px;font-weight:700;color:var(--ink);flex:none}
  .run-title{font-size:13.5px;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
  .run-meta{font-family:var(--mono);font-size:10.5px;color:var(--faint);flex:none}
  .run-badge{font-family:var(--mono);font-size:10px;padding:2px 7px;border-radius:999px;flex:none}
  .run-badge.merged{color:var(--s-merged);border:1px solid rgba(78,201,176,.4)}
  .run-badge.running{color:var(--s-running);border:1px solid rgba(85,167,224,.4)}
  .run-h .grow{flex:1}
  .run .acts{display:flex;gap:6px;flex:none}
  .run .acts .b{font-family:var(--sans);font-size:11.5px;font-weight:600;border-radius:7px;padding:5px 11px;
    cursor:pointer;border:1px solid var(--line-hi);background:transparent;color:var(--muted)}
  .run .acts .b:hover{color:var(--ink)}
  .run .acts .b.merge{background:var(--brand);border-color:var(--brand);color:var(--brand-ink)}
  .run .acts .b.close:hover{color:var(--s-failed);border-color:rgba(226,91,103,.45)}
  .run .acts .b.ghost{color:var(--muted)}
  .run .caret{color:var(--faint);font-family:var(--mono);font-size:12px;flex:none;width:14px;text-align:center;
    transition:transform .16s}
  .run.open .caret{transform:rotate(90deg)}
  .run-b{display:none;border-top:1px solid var(--line);padding:12px 14px 14px;background:#0e1118}
  .run.open .run-b{display:block}
  .run-b .rout{margin-bottom:10px}
  .run-b .rout-cards{display:flex;flex-direction:column;gap:6px}
  .run-b .ocard{padding:8px 11px}
  .run-b .rout-detail{margin-top:8px;border:1px solid var(--line);border-radius:8px;overflow:hidden}
  .run-b .rout-back{font-family:var(--mono);font-size:10.5px;color:var(--muted);cursor:pointer;
    padding:7px 11px;border-bottom:1px solid var(--line);background:var(--surface2)}
  .run-b .rout-back:hover{color:var(--brand)}
  .run-b .rout-body{padding:10px 12px;max-height:300px;overflow:auto}
  .run-b .review{margin:10px 0;display:flex;gap:8px;align-items:flex-start;font-size:12.5px;line-height:1.55}
  .run-b .review .rk{font-family:var(--mono);font-size:10.5px;color:var(--brand);flex:none;padding-top:2px}
  .run-b .review .rt{color:var(--muted)}
  .run-b .fix{margin-top:10px;display:flex;gap:8px}
  .run-b .fix input{flex:1;background:var(--bg);border:1px solid var(--line-hi);border-radius:7px;color:var(--ink);
    font-family:var(--sans);font-size:12.5px;padding:8px 11px;outline:none}
  .run-b .fix input:focus{border-color:var(--brand)}
  .run-b .fix .b{white-space:nowrap;font-family:var(--sans);font-size:11.5px;font-weight:600;border-radius:7px;
    padding:5px 11px;cursor:pointer;border:1px solid var(--line-hi);background:transparent;color:var(--muted)}
  .run-b .fix .b:hover{color:var(--ink);border-color:var(--brand)}
  .send-only{display:flex;gap:8px;align-items:center}
  .send-only .ro-hint{flex:1;font-family:var(--mono);font-size:10px;color:var(--faint);letter-spacing:.02em}
  .composer{border-top:1px solid var(--line);padding:12px 18px;display:flex;flex-direction:column;gap:8px}
  .composer .comp-seg{flex:0 0 auto}
  .composer .comp-hint{font-family:var(--mono);font-size:10.5px;color:var(--faint);letter-spacing:.02em}
  .composer textarea{min-height:52px}
  .verbs{display:flex;gap:8px;align-items:center}
  .verbs .grow{flex:1}
  .conv-menu{position:relative}
  .conv-pop{position:absolute;bottom:calc(100% + 6px);right:0;z-index:5;background:var(--surface2);
    border:1px solid var(--line-hi);border-radius:9px;box-shadow:var(--shadow);padding:4px;min-width:200px;display:none}
  .conv-menu.open .conv-pop{display:block}
  .conv-pop button{display:block;width:100%;text-align:left;background:transparent;border:none;
    color:var(--muted);font-size:12.5px;padding:8px 10px;border-radius:6px;cursor:pointer}
  .conv-pop button:hover{background:var(--surface);color:var(--ink)}
  /* ── active/archive view seg + archive list ── */
  .view-seg{padding:2px;gap:2px}
  .view-seg .seg-opt{padding:4px 12px;font-size:11.5px}
  .view-seg .seg-hint{color:var(--faint);margin-left:4px}
  .arch-bar{display:flex;gap:8px;margin-bottom:12px}
  .arch-bar input{flex:1}
  .arch-bar select{flex:0 0 auto}
  .arch-row{display:flex;align-items:center;gap:14px;padding:10px 14px;border:1px solid var(--line);
    border-radius:9px;background:var(--surface);margin-bottom:7px;cursor:pointer;transition:border-color .15s}
  .arch-row:hover{border-color:var(--line-hi)}
  .ar-title{flex:1;font-weight:600;font-size:13px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
  .ar-runs{font-family:var(--mono);font-size:11px;color:var(--muted);flex:0 1 auto;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;max-width:34%}
  .ar-repo{font-family:var(--mono);font-size:11px;color:var(--faint);flex:0 0 auto}
  .ar-date{font-family:var(--mono);font-size:11px;color:var(--faint);flex:0 0 auto}
  .arch-empty{color:var(--faint);font-family:var(--mono);font-size:12px;padding:30px 0;text-align:center}
  @media (max-width:860px){.ar-repo{display:none}.ar-runs{max-width:44%}}
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
  .meta .resumable{color:var(--brand);opacity:.75}
  .log{border-top:1px solid var(--line);background:#0e1118;padding:10px 14px;font-family:var(--mono);
    font-size:11px;height:150px;overflow:auto;display:flex;flex-direction:column;gap:4px}
  .ev{display:flex;gap:9px;align-items:baseline;min-width:0}
  .ev .k{color:var(--brand);min-width:78px;flex:none;opacity:.85}
  .ev .t{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
  /* ── closed card — 죽은 카드는 확실히 죽어 보이게(빗금 + CLOSED 스탬프) ── */
  .card.closed{opacity:.6;filter:saturate(.45)}
  .card.closed .log{position:relative}
  .card.closed .log::after{content:'';position:absolute;inset:0;pointer-events:none;
    background:repeating-linear-gradient(135deg,transparent 0 9px,rgba(255,255,255,.035) 9px 11px)}
  .card.closed .log::before{content:'CLOSED';position:absolute;top:50%;left:50%;z-index:1;
    transform:translate(-50%,-50%) rotate(-7deg);font-family:var(--mono);font-size:15px;
    letter-spacing:.34em;color:var(--faint);border:1px solid var(--line-hi);
    border-radius:6px;padding:4px 14px;background:rgba(11,13,18,.72)}
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

  /* ── remote access card (v4.5) ──────────── */
  .rmt{font-size:13px;color:var(--muted)}
  .rmt-line{margin:2px 0 10px;line-height:1.55}
  .rmt-name{font-family:var(--mono);font-size:12px;color:var(--ink);background:#0e1118;
    border:1px solid var(--line);border-radius:6px;padding:2px 7px;word-break:break-all}
  .rmt-row{display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid var(--line)}
  .rmt-row .rmt-l{flex:1;min-width:0}
  .rmt-row .rmt-t{color:var(--ink);font-weight:600;font-size:13px}
  .rmt-row .rmt-d{color:var(--faint);font-size:11.5px;margin-top:2px}
  .rmt-row.risky .rmt-t{color:var(--s-failed)}
  .rmt-url{display:flex;align-items:center;gap:7px;margin:6px 0 2px}
  .rmt-url code{flex:1;min-width:0;font-family:var(--mono);font-size:11.5px;color:var(--brand);
    background:#0e1118;border:1px solid var(--line);border-radius:6px;padding:5px 8px;
    overflow-x:auto;white-space:nowrap}
  .rmt-warn{color:var(--s-failed);font-size:11.5px;margin:5px 0 2px;line-height:1.5}
  .rmt-note{color:var(--faint);font-size:11.5px;margin:4px 0 2px;line-height:1.5}
  /* toggle switch — quiet until on (brand) or risky (red) */
  .tgl{position:relative;width:38px;height:22px;flex:none;background:var(--surface2);
    border:1px solid var(--line);border-radius:999px;cursor:pointer;transition:background .15s,border-color .15s}
  .tgl::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
    background:var(--muted);transition:transform .15s,background .15s}
  .tgl.on{background:var(--brand-dim);border-color:var(--brand)}
  .tgl.on::after{transform:translateX(16px);background:var(--brand)}
  .tgl.risky.on{background:rgba(226,91,103,.16);border-color:var(--s-failed)}
  .tgl.risky.on::after{background:var(--s-failed)}
  .tgl[aria-disabled="true"]{opacity:.4;cursor:not-allowed}
  .rmt-cp{font-family:var(--mono);font-size:11px;color:var(--muted);background:var(--surface2);
    border:1px solid var(--line);border-radius:6px;padding:5px 10px;cursor:pointer;flex:none}
  .rmt-cp:hover{color:var(--ink);border-color:var(--line-hi)}
  /* collapsible recipes / url table */
  .rmt-more{margin-top:12px;border-top:1px solid var(--line);padding-top:10px}
  .rmt-more summary{cursor:pointer;font-size:12.5px;color:var(--muted);list-style:none;user-select:none}
  .rmt-more summary::-webkit-details-marker{display:none}
  .rmt-more summary::before{content:'▸ ';color:var(--faint)}
  .rmt-more[open] summary::before{content:'▾ '}
  .rmt-more pre{margin:8px 0 4px;padding:10px 12px;background:#0e1118;border:1px solid var(--line);
    border-radius:8px;font-family:var(--mono);font-size:11px;color:var(--muted);overflow-x:auto;white-space:pre}
  .rmt-cap{color:var(--faint);font-size:11px;margin:2px 0 10px;line-height:1.5}
  .rmt-tbl{width:100%;border-collapse:collapse;margin:8px 0 2px;font-size:11.5px}
  .rmt-tbl th,.rmt-tbl td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);
    color:var(--muted);vertical-align:top}
  .rmt-tbl th{color:var(--faint);font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.1em}
  .rmt-tbl code{font-family:var(--mono);font-size:10.5px;color:var(--brand);white-space:nowrap}
  .rmt-tbl .star{color:var(--brand)}
  /* header remote-access affordance shares the ghost-button look */

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
  /* terminal = 전면 뷰 (모달 아님) — 개인 coxpit 터미널 페이지 패리티 */
  #termOverlay.open{padding:0}
  .modal.term{width:100%;height:100%;max-height:none;border:none;border-radius:0}
  .modal.term .modal-h{padding:9px 14px;background:var(--surface2)}
  .modal.term .modal-h .title{flex:0 1 auto;max-width:240px}
  .term-tabs{display:flex;gap:6px;overflow-x:auto;flex:1;min-width:0;scrollbar-width:none}
  .term-tabs::-webkit-scrollbar{display:none}
  .ttab{font-family:var(--mono);font-size:11px;color:var(--muted);background:var(--surface);
    border:1px solid var(--line);border-radius:6px;padding:3px 10px;cursor:pointer;white-space:nowrap;flex:0 0 auto}
  .ttab:hover{color:var(--ink)}
  .ttab.on{color:var(--ink);border-color:var(--brand);background:rgba(78,201,176,.08)}
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

  /* ── doc mode (rendered output) ─────────── */
  .doc-src{font-family:var(--mono);font-size:10.5px;color:var(--faint);margin-bottom:10px}
  .doc-h{font-family:var(--mono);font-size:10.5px;color:var(--brand);padding:8px 0 4px;
    border-bottom:1px solid var(--line);margin-bottom:8px;word-break:break-all}
  .doc-md{font-size:13px;line-height:1.65;color:var(--muted);margin-bottom:16px;font-family:var(--sans)}
  .doc-md h1,.doc-md h2{font-size:14px;color:var(--ink);margin:12px 0 6px}
  .doc-md h3{font-size:12.5px;color:var(--ink);margin:10px 0 4px}
  .doc-md ul{margin:4px 0 8px;padding-left:18px}
  .doc-md li{margin-bottom:3px}
  .doc-md strong{color:var(--ink)}
  .doc-md code{font-family:var(--mono);font-size:.9em;background:#0e1118;padding:1px 5px;border-radius:4px;color:var(--brand)}
  .doc-md p{margin:0 0 8px}
  .doc-frame{width:100%;height:420px;border:1px solid var(--line);border-radius:8px;background:#fff;margin-bottom:16px}
  .pane-tgl{margin-left:auto;font-size:10px;padding:2px 9px;text-transform:none;letter-spacing:0}
  /* run 모달의 diff 라인 = steer 참조 클릭 타깃(code 카드 상세) */
  #outDetail .dl-line{cursor:pointer;border-radius:3px}
  #outDetail .dl-line:hover{background:rgba(78,201,176,.09)}

  /* ── v4.7 산출물 계약(contract strip) — 모달 헤더 아래 요청 산출물 요약 ── */
  .contract{display:flex;flex-wrap:wrap;align-items:center;gap:7px;padding:9px 18px;
    border-bottom:1px solid var(--line);background:var(--surface2);
    font-family:var(--mono);font-size:10.5px;color:var(--faint);line-height:1.5}
  .contract[hidden]{display:none}
  .contract .clabel{letter-spacing:.04em;text-transform:none}
  .contract .csep{color:var(--line-hi)}
  .req{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;
    border:1px solid var(--line);color:var(--muted);text-transform:none;letter-spacing:.02em}
  .req.ok{color:var(--s-done);border-color:rgba(88,179,104,.4)}
  .req.warn{color:var(--s-preparing);border-color:rgba(214,162,73,.45)}
  .req.aux{color:var(--faint);border-style:dashed}
  .req .rg{font-size:11px;line-height:1}

  /* ── v4.7 출력 카드 목록(오른쪽 컬럼) ── */
  #outWrap{display:flex;flex-direction:column;min-height:0;flex:1}
  #outCards{display:flex;flex-direction:column;gap:8px;padding:12px 16px;overflow:auto;flex:1;min-height:0}
  .ocard{display:flex;align-items:center;gap:10px;padding:11px 13px;border:1px solid var(--line);
    border-radius:var(--r-card);background:var(--surface);cursor:pointer;
    transition:border-color .16s,transform .16s}
  .ocard:hover{border-color:#323b4e;transform:translateY(-1px)}
  .ocard.miss{opacity:.72;border-style:dashed;cursor:default}
  .ocard.miss:hover{transform:none;border-color:var(--line)}
  .ocard .og{font-size:15px;line-height:1;flex:0 0 auto;width:20px;text-align:center;color:var(--muted)}
  .ocard.miss .og{color:var(--s-preparing)}
  .ocard .ob{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
  .ocard .ot{font-family:var(--sans);font-size:12.5px;color:var(--ink);font-weight:600;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ocard .om{font-family:var(--mono);font-size:10px;color:var(--faint);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ocard .obadge{font-family:var(--mono);font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;
    padding:2px 7px;border-radius:999px;border:1px solid var(--line);color:var(--faint);flex:0 0 auto}
  .ocard .obadge.req{color:var(--brand);border-color:rgba(78,201,176,.4)}
  .ocard .obadge.warn{color:var(--s-preparing);border-color:rgba(214,162,73,.45)}
  .ocard .oc{color:var(--faint);font-size:13px;flex:0 0 auto}
  .ocards-empty{color:var(--faint);font-family:var(--mono);font-size:11px;padding:22px 4px;text-align:center}

  /* ── v4.7 출력 카드 상세 뷰어 ── */
  #outDetail{display:none;flex-direction:column;min-height:0;flex:1}
  #outDetail.on{display:flex}
  #outWrap.detailing #outCards{display:none}
  .oback{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:11px;
    color:var(--muted);cursor:pointer;padding:9px 16px;border-bottom:1px solid var(--line);
    background:var(--surface2);flex:0 0 auto}
  .oback:hover{color:var(--brand)}
  .odetail-c{overflow:auto;padding:12px 16px;flex:1;min-height:0}
  .oimg{max-width:100%;border:1px solid var(--line);border-radius:8px;background:#fff}
  .odl{display:inline-block;margin-top:6px;font-family:var(--mono);font-size:11.5px;color:var(--brand);
    text-decoration:none;border:1px solid var(--line);border-radius:var(--r-ctl);padding:6px 11px}
  .odl:hover{border-color:var(--brand)}

  /* ── terminal ───────────────────────────── */
  .term-body{flex:1;min-height:0;background:#0b0d12;padding:8px 4px 4px 10px}
  #xterm{width:100%;height:100%}
  .term-hint{font-family:var(--mono);font-size:11px;color:var(--faint)}
  /* 모바일 입력바 — xterm 직접 타이핑은 소프트웨어 키보드 IME 에서 자모가 낱자로
     전송된다(조합 미지원). 일반 input 은 네이티브로 조합하므로 여기서 완성문을 보낸다. */
  .term-ibar{display:none;gap:6px;padding:8px 10px;border-top:1px solid var(--line);
    background:var(--surface2);align-items:center;
    padding-bottom:calc(8px + env(safe-area-inset-bottom))}
  .term-ibar input{flex:1;min-width:0}
  .tkey{font-family:var(--mono);font-size:11.5px;color:var(--muted);background:var(--surface);
    border:1px solid var(--line);border-radius:6px;padding:7px 9px;cursor:pointer;flex:0 0 auto}
  .tkey:active{color:var(--ink);border-color:var(--brand)}
  @media (max-width:860px),(pointer:coarse){.term-ibar{display:flex}}

  /* ── mobile · the pocket pass ───────────── */
  .menu-btn{display:none;font-size:15px;padding:5px 10px}
  .scrim{position:fixed;inset:0;top:54px;background:rgba(5,7,10,.5);z-index:29;display:none}
  @media (max-width:860px){
    .layout{grid-template-columns:1fr;min-height:calc(100dvh - 55px)}
    /* 사이드바 = 오프캔버스 드로어 — 플릿이 첫 화면, 런처는 ☰ 뒤에 */
    .menu-btn{display:inline-flex}
    aside{position:fixed;top:54px;bottom:0;left:0;width:min(86vw,340px);z-index:30;
      transform:translateX(-103%);transition:transform .22s ease;overflow-y:auto;
      -webkit-overflow-scrolling:touch;box-shadow:var(--shadow)}
    aside.open{transform:translateX(0)}
    .scrim.on{display:block}
    header{padding:0 12px;gap:9px}
    .brand .sub,.daemon-badge,.machines{display:none}
    main{padding:14px}
    .grid{grid-template-columns:1fr}
    /* 모달 = 풀블리드 */
    .overlay.open{padding:0}
    .modal,.modal.wide{width:100%;height:100dvh;max-height:none;border:none;border-radius:0}
    .modal-b{grid-template-columns:1fr;grid-template-rows:1fr 1fr}
    .pane{border-right:none;border-bottom:1px solid var(--line)}
    .modal-f{flex-wrap:wrap;padding:10px 12px}
    #steerRow .seg{flex:0 0 108px}
    /* iOS: 16px 미만 input 포커스 시 강제 줌 — 폰에서만 16px 로 */
    input,textarea,select,.dd-btn{font-size:16px}
    /* 온보딩 패널이 좁은 화면을 넘치지 않게 */
    .empty{padding:24px 0}
    .setup{max-width:100%;width:100%;margin:8px 0}
    .chk .v{min-width:0}
    .cmp{flex-direction:column;overflow-y:auto;overflow-x:hidden}
    .cmp-col{min-width:0;border-right:none;border-bottom:1px solid var(--line);flex:0 0 auto;max-height:72vh}
  }
  @media (prefers-reduced-motion:reduce){aside{transition:none}}
  ${ICON_CSS}
</style>
</head>
<body>
${ICON_SPRITE}
<header>
  <button class="btn-ghost sm menu-btn" id="menuBtn" aria-label="open launcher">☰</button>
  <div class="brand"><span class="mark">coxpit</span><span class="sub">fleet console</span></div>
  <span class="daemon-badge" id="daemonBadge" style="display:none"></span>
  <div class="seg view-seg" id="viewSeg">
    <button type="button" class="seg-opt on" data-view="active">Active</button>
    <button type="button" class="seg-opt" data-view="archive">Archive <span id="archN" class="seg-hint"></span></button>
  </div>
  <div class="ws"><span class="dot" id="wsdot"></span><span id="wstext">connecting</span></div>
  <button class="btn-ghost sm" id="bell" title="notify when a run settles"><svg class="ic"><use href="#i-bell-off"/></svg></button>
  <button class="btn-ghost sm" id="remoteBtn" title="reach this daemon from elsewhere (Tailscale · recipes)"><svg class="ic"><use href="#i-external-link"/></svg></button>
  <div class="machines" id="machines"></div>
</header>
<div class="scrim" id="scrim"></div>
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
        <button type="button" class="btn-ghost sm" id="repoNew" style="flex:0 0 auto" title="start a new project — empty folder in, scaffolded repo out">New</button>
        <button type="button" class="btn-ghost sm" id="repoManual" style="flex:0 0 auto" title="type an absolute path">Path</button>
        <button type="button" class="btn-ghost sm" id="repoBranch" style="flex:0 0 auto" title="change the base branch — merges, Sync base and PRs all target it"><svg class="ic"><use href="#i-branch"/></svg></button>
        <button type="button" class="btn-ghost sm" id="repoRemove" style="flex:0 0 auto" title="remove selected repository from coxpit"><svg class="ic"><use href="#i-x"/></svg></button>
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
          <button type="button" class="btn-ghost sm" id="ghImport">From GitHub issue / PR…</button>
          <div class="seg" id="provSeg" role="group" aria-label="agent provider">
            <button type="button" class="seg-opt on" data-agent="claude-code">Claude</button>
            <button type="button" class="seg-opt" data-agent="codex">Codex</button>
          </div>
          <p class="flabel">model · optional</p>
          <input id="taskModel" placeholder="CLI default" list="modelHist" autocomplete="off" />
          <datalist id="modelHist"></datalist>
          <p class="flabel">design capture · optional</p>
          <select id="taskCapture"><option value="">no design capture</option></select>
          <p class="flabel">deliverables · optional (계약)</p>
          <div class="ochips" id="taskOutputs" role="group" aria-label="declared deliverables">
            <button type="button" class="ochip" data-out="answer">답변</button>
            <button type="button" class="ochip" data-out="code">코드</button>
            <button type="button" class="ochip" data-out="doc">문서</button>
            <button type="button" class="ochip" data-out="page">페이지</button>
            <button type="button" class="ochip" data-out="file">파일</button>
          </div>
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
          <button class="btn" type="submit" id="runFleetBtn"><svg class="ic"><use href="#i-play"/></svg> Run fleet</button>
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
    <div id="archive" hidden>
      <div class="arch-bar">
        <input id="archQ" placeholder="search title…" autocomplete="off" />
        <select id="archRepo"><option value="">all repos</option></select>
        <button type="button" class="btn-ghost sm" id="reclaimBtn" hidden
          title="remove worktrees left by cleaned/failed runs — reclaims disk (active work untouched)"><svg class="ic"><use href="#i-recycle"/></svg> Reclaim <span id="reclaimHint"></span></button>
      </div>
      <div id="archList"></div>
      <div style="text-align:center;margin-top:14px"><button class="btn-ghost sm" id="archMore" hidden>load 50 more</button></div>
    </div>
  </main>
</div>

<div class="overlay" id="overlay">
  <div class="modal">
    <div class="modal-h">
      <span class="rid" id="mRid"></span>
      <span class="title" id="mTitle"></span>
      <span class="chip" id="mChip"><i></i><span id="mChipTxt"></span></span>
      <button class="x" id="mClose" aria-label="close"><svg class="ic"><use href="#i-x"/></svg></button>
    </div>
    <div class="contract" id="mContract" hidden></div>
    <div class="modal-b">
      <div class="pane">
        <div class="pane-h">Timeline</div>
        <div class="pane-c tl" id="mTimeline"></div>
      </div>
      <div class="pane">
        <div class="pane-h" style="display:flex;align-items:center;gap:8px">Outputs <span id="mStat" style="text-transform:none;letter-spacing:0"></span></div>
        <div id="outWrap">
          <div id="outCards"><div class="ocards-empty">loading…</div></div>
          <div id="outDetail">
            <div class="oback" id="outBack">‹ 산출물 목록</div>
            <div class="odetail-c" id="outDetailC"></div>
          </div>
        </div>
      </div>
    </div>
    <div class="modal-f" id="steerRow" style="border-top:1px solid var(--line)">
      <div class="seg" style="flex:0 0 132px" id="steerModeSeg">
        <button type="button" class="seg-opt on" data-mode="work">Work</button>
        <button type="button" class="seg-opt" data-mode="ask">Ask</button>
      </div>
      <input id="steerInput" placeholder="Next instruction — same session &amp; worktree…" style="flex:1" />
      <button class="btn sm" id="steerSend"><svg class="ic"><use href="#i-pencil"/></svg> Send</button>
    </div>
    <div class="modal-f">
      <button class="btn-ghost sm" id="mTerm"><svg class="ic"><use href="#i-terminal"/></svg> Terminal</button>
      <button class="btn-ghost sm" id="mRefreshDiff"><svg class="ic"><use href="#i-refresh"/></svg> Refresh outputs</button>
      <button class="btn-ghost sm" id="mCompare">Compare runs</button>
      <button class="btn-ghost sm" id="mExport"><svg class="ic"><use href="#i-download"/></svg> Export files…</button>
      <button class="btn-ghost sm" id="mSync"><svg class="ic"><use href="#i-branch"/></svg> Sync base</button>
      <button class="btn-ghost sm" id="mShare" title="create a read-only share link (no auth, snapshot view)">Share</button>
      <span class="spacer"></span>
      <button class="btn-danger sm" id="mStop">Stop</button>
      <button class="btn-ghost sm" id="mCleanup">Cleanup</button>
      <button class="btn-ghost sm" id="mCloseTask">Close task</button>
    </div>
  </div>
</div>

<div class="overlay" id="groupRoomOverlay">
  <div class="room">
    <div class="rh">
      <span class="rh-glyph">⌒</span>
      <span class="rh-t" id="roomTitle">Goal</span>
      <span class="rh-n" id="roomCount"></span>
      <button class="x" id="roomClose" aria-label="close"><svg class="ic"><use href="#i-x"/></svg></button>
    </div>
    <div class="chips" id="roomChips"></div>
    <div class="gbar" id="roomGbar">
      <span class="selc" id="roomSelC">☑ 0 selected</span>
      <button type="button" class="brand" id="roomIntegrateSel">Integrate 선택 (0)</button>
      <span class="sp"></span>
      <button type="button" id="roomReviewAll">전체 리뷰</button>
      <button type="button" class="danger" id="roomGroupClose">그룹 클로즈</button>
    </div>
    <div class="body">
      <div class="runs" id="roomRuns"></div>
      <div class="conv" id="roomConv" hidden></div>
    </div>
    <div class="composer">
      <div class="seg comp-seg" id="roomSeg" role="group" aria-label="workroom mode">
        <button type="button" class="seg-opt on" data-rmode="work">✎ Work</button>
        <button type="button" class="seg-opt" data-rmode="ask">? Ask</button>
      </div>
      <div class="comp-hint" id="roomHint"></div>
      <textarea id="roomInput" placeholder="New attempt prompt, or a broadcast to the settled runs…"></textarea>
      <div class="verbs" id="roomVerbs">
        <button type="button" class="btn-ghost sm" id="roomNew"><svg class="ic"><use href="#i-plus"/></svg> New attempt</button>
        <button type="button" class="btn-ghost sm" id="roomBroadcast">→ Broadcast</button>
        <span class="grow"></span>
        <div class="conv-menu" id="roomConvMenu">
          <button type="button" class="btn sm" id="roomConverge">Converge ▾</button>
          <div class="conv-pop">
            <button type="button" id="roomReview">Review group</button>
            <button type="button" id="roomIntegrate">Select runs to integrate</button>
          </div>
        </div>
      </div>
      <div class="send-only" id="roomSend" hidden>
        <span class="ro-hint">read-only — switch to Work to act</span>
        <button type="button" class="btn sm" id="roomAsk">Ask</button>
      </div>
    </div>
  </div>
</div>

<div class="overlay" id="cmpOverlay">
  <div class="modal wide">
    <div class="modal-h">
      <span class="title" id="cmpTitle">Compare</span>
      <button class="btn sm" id="cmpAI">AI review</button>
      <button class="btn-ghost sm" id="cmpDocsTgl">Rendered</button>
      <button class="btn-ghost sm" id="cmpRefresh">Refresh</button>
      <button class="x" id="cmpClose" aria-label="close"><svg class="ic"><use href="#i-x"/></svg></button>
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
      <div class="term-tabs" id="termTabs"></div>
      <span class="term-hint">tmux session · Ctrl-b d detaches · Esc closes</span>
      <button class="x" id="termClose" aria-label="close"><svg class="ic"><use href="#i-x"/></svg></button>
    </div>
    <div class="term-body"><div id="xterm"></div></div>
    <div class="term-ibar" id="termIbar">
      <button class="tkey" data-k="esc" title="Esc">esc</button>
      <button class="tkey" data-k="tab" title="Tab">tab</button>
      <button class="tkey" data-k="cc" title="Ctrl-C">^C</button>
      <button class="tkey" data-k="up" title="Up">↑</button>
      <button class="tkey" data-k="down" title="Down">↓</button>
      <input id="termInput" placeholder="type here — composes IME (한글 OK), Enter sends"
        autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
      <button class="btn sm" id="termSend">⏎</button>
    </div>
  </div>
</div>

<div class="overlay" id="brwOverlay">
  <div class="brw">
    <div class="brw-h">
      <button class="btn-ghost sm" id="brwUp">↑ Up</button>
      <button class="btn-ghost sm" id="brwHome">Home</button>
      <span class="brw-path" id="brwPath"></span>
      <button class="x" id="brwClose" aria-label="close"><svg class="ic"><use href="#i-x"/></svg></button>
    </div>
    <div class="brw-list" id="brwList"></div>
    <div class="brw-f">
      <span class="hint"><span style="color:var(--brand)">git</span> badge = repo (Register) · empty folder = Start here</span>
      <button class="btn-ghost sm" id="brwNewFolder"><svg class="ic"><use href="#i-plus"/></svg> New folder here</button>
      <button class="btn sm" id="brwRegHere" style="display:none">Register this folder</button>
    </div>
    <form class="brw-f" id="brwNewForm" hidden>
      <input id="brwNewName" placeholder="new-project-folder-name" style="flex:1" />
      <button class="btn sm" type="submit" id="brwNewGo">Create &amp; start</button>
    </form>
  </div>
</div>

<div class="toasts" id="toasts"></div>

<div class="selbar" id="selbar">
  <span class="cnt" id="selCnt">0 selected</span>
  <span class="note">merges in selection order · conflicts spawn an integration agent</span>
  <button class="btn sm" id="selGo">Integrate → base</button>
  <button class="btn-ghost sm" id="selCancel">Cancel</button>
</div>

<div class="overlay" id="ghOverlay">
  <div class="cfm">
    <div class="cfm-b">
      <div class="m">Start from a GitHub issue or pull request</div>
      <div class="s">Fetches the title and body into the task form — you review, pick a provider, then Run fleet. Private repos need the gh CLI signed in on the daemon machine.</div>
      <p class="flabel" style="margin-top:12px">issue / PR url</p>
      <input id="ghUrl" placeholder="https://github.com/owner/repo/issues/123" />
    </div>
    <div class="cfm-f">
      <button class="btn-ghost sm" id="ghCancel">Cancel</button>
      <button class="btn sm" id="ghOk">Fetch</button>
    </div>
  </div>
</div>

<div class="overlay" id="npOverlay">
  <div class="cfm">
    <div class="cfm-b">
      <div class="m">Start a new project</div>
      <div class="s">Creates the folder if needed, then git init + an empty initial commit as the base. Never touches non-empty folders. Then: write a task like 'scaffold a … app', run a fleet of 2–3, and compare the foundations.</div>
      <p class="flabel" style="margin-top:12px">new project path</p>
      <input id="npPath" placeholder="/abs/path/to/new-project" />
      <p class="flabel" style="margin-top:10px">name · optional</p>
      <input id="npName" placeholder="defaults to the folder name" />
    </div>
    <div class="cfm-f">
      <button class="btn-ghost sm" id="npCancel">Cancel</button>
      <button class="btn sm" id="npOk">Start new project</button>
    </div>
  </div>
</div>

<div class="overlay" id="remoteOverlay">
  <div class="cfm" style="width:min(560px,94vw)">
    <div class="cfm-b">
      <div class="m">Remote access</div>
      <div class="s">Reach this daemon from your other devices — coxpit detects your Tailscale and drives it, or hands a copy-paste recipe. It never hosts a relay.</div>
      <div id="remoteBody" class="rmt" style="margin-top:14px">loading…</div>
    </div>
    <div class="cfm-f">
      <button class="btn-ghost sm" id="remoteClose">Close</button>
    </div>
  </div>
</div>

<div class="overlay" id="brOverlay">
  <div class="cfm">
    <div class="cfm-b">
      <div class="m">Base branch for this repository</div>
      <div class="s">Merge, Sync base and PR mode all target this branch. Set it to match your repo's flow (e.g. <span style="color:var(--brand);font-family:var(--mono)">develop</span>). Must already exist in the repo.</div>
      <p class="flabel" style="margin-top:12px">branch name</p>
      <input id="brInput" placeholder="main" />
    </div>
    <div class="cfm-f">
      <button class="btn-ghost sm" id="brCancel">Cancel</button>
      <button class="btn sm" id="brOk">Save</button>
    </div>
  </div>
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
<script src="/vendor/addon-unicode11.js"></script>
<script>
const runs = new Map();      // runId -> run object
const tasks = new Map();     // taskId -> task
const groups = new Map();    // groupId -> {id, kind, title}
let repos = [], machines = [], captures = [];
let daemonPort = 8210;    // real config.port — filled from /api/fleet daemon block (recipes interpolate it)
let remoteAuthOpen = false; // true = no password → Funnel guard on (from /api/fleet daemon.authOpen)

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const escA = (s) => esc(s).replace(/"/g, '&quot;');
${ICON_JS_HELPER}   // ic('x') → '<svg class="ic"><use href="#i-x"/></svg>' (Lucide 스프라이트)
const statusColor = (s) => 'var(--s-' + (s||'pending') + ', var(--muted))';

/* ── custom toast / confirm (시스템 alert·confirm 대체) ── */
function toast(msg, kind){
  const el = document.createElement('div');
  el.className = 'toast ' + (kind==='error'?'err':kind==='ok'?'ok':'');
  el.innerHTML = '<span class="tk">'+(kind==='error'?ic('x'):kind==='ok'?ic('check'):'·')+'</span><span>'+esc(msg)+'</span>';
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
        '<div class="brw-row" data-n="'+esc(x.name)+'"><span class="ico">'+ic('folder')+'</span><span class="nm">'+esc(x.name)+'</span>'
        + (x.isRepo ? '<span class="gitchip">git</span><button type="button" class="btn sm" data-reg="'+esc(x.name)+'">Register</button>'
           : x.isEmpty ? '<button type="button" class="btn-ghost sm" data-start="'+esc(x.name)+'">Start here</button>' : '')
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
    return;
  }
  const j = await res.json().catch(()=>({}));
  if (res.status === 400 && j.code === 'NO_COMMITS'){
    const yes = await confirmUI('This folder has no commits yet — start a new project here?',
      { sub: 'coxpit will create an empty initial commit as the base, then register the repo. The folder itself is untouched.', okLabel: 'Start new project' });
    if (yes && await createNewProject(fullPath)) $('brwOverlay').classList.remove('open');
    return;
  }
  toast('register: '+(j.detail||j.error||res.status), 'error');
}
$('repoBrowse').addEventListener('click', ()=>{
  const m = machines.find(x=>x.slug===$('repoMachine').value);
  if (m && m.address){ toast('remote machine — type the path manually for now', 'error'); return; }
  $('brwNewForm').hidden = true; $('brwNewName').value = '';
  $('brwOverlay').classList.add('open');
  brwGo(brwCur || '');
});
$('brwList').addEventListener('click',(e)=>{
  const reg = e.target.closest('button[data-reg]');
  if (reg){ brwRegister(brwCur.replace(/\\/$/,'')+'/'+reg.dataset.reg); return; }
  const start = e.target.closest('button[data-start]');
  if (start){ brwStartHere(brwCur.replace(/\\/$/,'')+'/'+start.dataset.start); return; }
  const row = e.target.closest('.brw-row[data-n]');
  if (row) brwGo(brwCur.replace(/\\/$/,'')+'/'+row.dataset.n);
});
$('brwUp').addEventListener('click',(e)=>brwGo(e.currentTarget.dataset.p));
$('brwHome').addEventListener('click',(e)=>brwGo(e.currentTarget.dataset.p));
$('brwRegHere').addEventListener('click',()=>brwRegister(brwCur));
/* 빈 폴더 행의 Start here — 클릭한 폴더에 greenfield 씨앗 심고 등록 */
async function brwStartHere(fullPath){
  if (await createNewProject(fullPath)) $('brwOverlay').classList.remove('open');
}
/* ＋ New folder here — 현재 탐색 위치에 새 폴더명만 받아 생성+시작 (절대경로 타이핑 불필요) */
$('brwNewFolder').addEventListener('click', ()=>{
  const f = $('brwNewForm'); f.hidden = !f.hidden; if(!f.hidden) $('brwNewName').focus();
});
$('brwNewForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const name = $('brwNewName').value.trim();
  if (!name){ toast('enter a folder name', 'error'); return; }
  if (name.includes('/')){ toast('folder name cannot contain /', 'error'); return; }
  const go = $('brwNewGo'); go.disabled = true; go.textContent = 'Creating…';
  try{
    if (await createNewProject(brwCur.replace(/\\/$/,'')+'/'+name)){
      $('brwNewName').value=''; $('brwNewForm').hidden=true;
      $('brwOverlay').classList.remove('open');
    }
  } finally { go.disabled=false; go.textContent='Create & start'; }
});
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
      if (o.subtype === 'init' || !o.subtype) return { k:'session',
        t:'started'+(o.model?' · '+String(o.model).replace(/\\u001b\\[[0-9;]*m/g,'')
                                                  .replace(/\\x1b\\[[0-9;]*m/g,'') : '') };
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
    if (kind === 'meta' && o.subtask) return { k:'swarm', t:'↳ spawned task #'+o.subtask+' — '+String(o.title||'').slice(0,60)+' ('+((o.runs||[]).map(x=>'r'+x).join(' '))+')' };
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
  let file = '';
  return text.split('\\n').map(l=>{
    const e = esc(l);
    if (l.startsWith('+++')){
      const f = l.replace(/^\\+\\+\\+ [ab]\\//,'').trim();
      if (f && f !== '/dev/null') file = f;
      return '<span class="dl-file">'+e+'</span>';
    }
    if (l.startsWith('---')){
      const f = l.replace(/^--- [ab]\\//,'').trim();
      if (f && f !== '/dev/null') file = f;
      return '<span class="dl-file">'+e+'</span>';
    }
    if (l.startsWith('diff --git')) return '<span class="dl-file">'+e+'</span>';
    if (l.startsWith('@@')) return '<span class="dl-hunk">'+e+'</span>';
    if (l.startsWith('+')) return '<span class="dl-add dl-line" data-f="'+escA(file)+'" title="click to reference in a steer">'+e+'</span>';
    if (l.startsWith('-')) return '<span class="dl-del dl-line" data-f="'+escA(file)+'" title="click to reference in a steer">'+e+'</span>';
    return e;
  }).join('\\n');
}
function chipHTML(status){
  const s = status||'pending';
  return '<span class="chip '+(s==='running'?'running':'')+'" style="color:'+statusColor(s)+';border-color:'+statusColor(s)+'">'
    + '<i></i>'+esc(s)+'</span>';
}
/* 같은 태스크에 run 이 여럿이면 "run i/n" — 같은 제목 카드가 중복이 아니라 시도로 읽히게 */
function attemptHTML(r){
  const sib = [...runs.values()].filter(x=>x.taskId===r.taskId).sort((a,b)=>a.id-b.id);
  if (sib.length<2) return '';
  const i = sib.findIndex(x=>x.id===r.id)+1;
  return '<span class="attempt" title="attempt within this task">run '+i+'/'+sib.length+'</span>';
}

/* ── group fold 상태(기기별, WS 재렌더에도 유지) ── */
let gfold = new Set();
try{ gfold = new Set(JSON.parse(localStorage.getItem('coxpit.gfold')||'[]')); }catch{}
function saveGfold(){ try{ localStorage.setItem('coxpit.gfold', JSON.stringify([...gfold])); }catch{} }
/* 태스크의 모든 run 이 정착했는가 */
function taskSettled(taskId){
  const rs = [...runs.values()].filter(r=>r.taskId===taskId);
  return rs.length>0 && rs.every(r=>['done','failed','stopped','merged'].includes(r.status));
}
function bandHTML(g, grpRuns){
  const glyph = g.kind==='swarm' ? '↳' : '⌁';
  const title = g.kind==='swarm' ? 'swarm of: '+esc(g.title) : esc(g.title);
  const taskIds = [...new Set(grpRuns.map(r=>r.taskId))];
  const settled = taskIds.filter(taskSettled).length;
  const folded = gfold.has(g.id);
  const cards = grpRuns.slice().sort((a,b)=>a.id-b.id).map(cardHTML).join('');
  return '<div class="gband'+(folded?' folded':'')+'" data-g="'+g.id+'">'
    + '<div class="gband-h"><span class="gband-glyph">'+glyph+'</span>'
    + '<span class="gband-t">'+title+'</span>'
    + '<span class="gband-n">'+taskIds.length+' task'+(taskIds.length>1?'s':'')+' · '+settled+' settled</span>'
    + '<span class="gband-sp"></span>'
    + '<button class="btn-ghost sm gband-open" data-groom="'+g.id+'">⌒ Open workroom</button>'
    + '<button class="btn-ghost sm" data-gsel="'+g.id+'">Select runs</button>'
    + '<button class="btn-ghost sm" data-gclose="'+g.id+'">Close group</button>'
    + '<button class="gband-fold" data-gfold="'+g.id+'" title="fold">'+(folded?'▸':'▾')+'</button></div>'
    + '<div class="gband-grid">'+cards+'</div></div>';
}
function render(){
  if (boardView==='archive') return;   // 아카이브 뷰는 자체 리스트 — grid 안 건드림
  const list = [...runs.values()].sort((a,b)=>b.id-a.id);
  $('empty').style.display = list.length ? 'none' : 'flex';
  if (!list.length){ paintOnboarding(); $('grid').innerHTML=''; return; }
  // 그룹 파티션 — grouped run 은 밴드로 클러스터, ungrouped 는 뒤에 flat.
  const byGroup = new Map(); const flat = [];
  for (const r of list){
    const t = tasks.get(r.taskId);
    const gid = t && t.groupId!=null && groups.has(t.groupId) ? t.groupId : null;
    if (gid==null) flat.push(r);
    else { if(!byGroup.has(gid)) byGroup.set(gid, []); byGroup.get(gid).push(r); }
  }
  let html = '';
  for (const gid of [...byGroup.keys()].sort((a,b)=>b-a)) html += bandHTML(groups.get(gid), byGroup.get(gid));
  html += flat.map(cardHTML).join('');
  $('grid').innerHTML = html;
  if (termRunId!=null) termTabsRender();   // 터미널 열려있으면 세션 탭도 동기화
}

/* ── active / archive view ─────────────────────────────── */
let boardView = 'active';
let archOffset = 0, archTotal = 0;
const ARCH_LIMIT = 50;
function setView(v){
  boardView = v;
  document.querySelectorAll('#viewSeg .seg-opt').forEach(b=>{
    const on = b.dataset.view===v;
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', on?'true':'false');
  });
  const archive = v==='archive';
  $('archive').hidden = !archive;
  $('grid').style.display = archive ? 'none' : '';
  $('empty').style.display = archive ? 'none' : ($('grid').innerHTML ? 'none' : 'flex');
  document.querySelector('.toolbar').style.display = archive ? 'none' : '';
  if (archive){ paintArchRepos(); archFetch(true); reclaimRefresh(); }
  else render();
}
document.querySelectorAll('#viewSeg .seg-opt').forEach(b=>b.addEventListener('click', ()=>setView(b.dataset.view)));
function paintArchRepos(){
  const sel = $('archRepo'); const cur = sel.value;
  sel.innerHTML = '<option value="">all repos</option>' + repos.map(r=>'<option value="'+r.id+'">'+esc(r.name)+'</option>').join('');
  sel.value = cur;
}
function archRowHTML(row){
  const runs = row.runs.map(r=>'r'+r.id+' '+r.status).join(' · ');
  const d = row.closedAt ? new Date(row.closedAt*1000) : null;
  const date = d ? (String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')) : '';
  const grp = row.groupTitle ? '<span class="ar-repo" title="group">⌁ '+esc(row.groupTitle.slice(0,24))+'</span>' : '';
  return '<div class="arch-row" data-t="'+row.taskId+'">'
    + '<span class="ar-title">'+esc(row.title)+'</span>'
    + '<span class="ar-runs">'+esc(runs)+'</span>'+grp
    + '<span class="ar-repo">'+esc(row.repoName)+'</span>'
    + '<span class="ar-date">'+date+'</span></div>';
}
async function archFetch(reset){
  if (reset){ archOffset = 0; $('archList').innerHTML = '<div class="arch-empty">loading…</div>'; }
  const q = encodeURIComponent($('archQ').value.trim());
  const repo = $('archRepo').value;
  const url = '/api/archive?offset='+archOffset+'&limit='+ARCH_LIMIT
    + (q?'&q='+q:'') + (repo?'&repo='+repo:'');
  try{
    const j = await fetch(url).then(x=>x.json());
    archTotal = j.total||0;
    const rows = (j.rows||[]).map(archRowHTML).join('');
    if (reset) $('archList').innerHTML = rows || '<div class="arch-empty">no closed tasks match</div>';
    else $('archList').insertAdjacentHTML('beforeend', rows);
    archOffset += (j.rows||[]).length;
    $('archMore').hidden = archOffset >= archTotal || !(j.rows||[]).length;
  }catch{ $('archList').innerHTML = '<div class="arch-empty">archive failed</div>'; }
}
$('archMore').addEventListener('click', ()=>archFetch(false));
let archTimer = null;
$('archQ').addEventListener('input', ()=>{ clearTimeout(archTimer); archTimer = setTimeout(()=>archFetch(true), 300); });
$('archRepo').addEventListener('change', ()=>archFetch(true));
$('archList').addEventListener('click', async (e)=>{
  const row = e.target.closest('.arch-row'); if(!row) return;
  const tid = Number(row.dataset.t);
  try{
    const j = await fetch('/api/tasks/'+tid).then(x=>x.json());
    if (!j.task || !(j.runs||[]).length){ toast('task has no runs', 'error'); return; }
    tasks.set(j.task.id, j.task);
    j.runs.forEach(rn => { if(!runs.has(rn.id)) runs.set(rn.id, { ...rn, events: [] }); });
    openModal(j.runs.map(r=>r.id).sort((a,b)=>a-b)[0]);
  }catch{ toast('could not open task', 'error'); }
});

/* ── Reclaim orphaned worktrees ── cleaned/failed run worktrees are disk debt
   (~180MB each — node_modules lives inside). Only shown when there's something
   to reclaim; active/successful work is never listed by the server. */
let reclaimN = 0;
async function reclaimRefresh(){
  try{
    const j = await fetch('/api/worktrees').then(x=>x.json());
    reclaimN = (j.items||[]).length;
    const mb = Math.round((j.totalKb||0)/1024);
    $('reclaimHint').textContent = reclaimN ? (reclaimN+' · ~'+mb+'MB') : '';
    $('reclaimBtn').hidden = reclaimN===0;
  }catch{ $('reclaimBtn').hidden = true; }
}
$('reclaimBtn').addEventListener('click', async ()=>{
  if (!reclaimN) return;
  const ok = await confirmUI('remove '+reclaimN+' cleaned/failed run worktree'+(reclaimN===1?'':'s')+'?', {
    sub:'active work is untouched — only closed tasks and failed/error/stopped runs are reclaimed',
    okLabel:'Reclaim', danger:true });
  if (!ok) return;
  try{
    const r = await fetch('/api/worktrees/prune',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({})}).then(x=>x.json());
    toast('reclaimed '+(r.count||0)+' worktree'+((r.count||0)===1?'':'s'), 'ok');
  }catch{ toast('reclaim failed', 'error'); }
  reclaimRefresh();
});

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
  const st = ok===null ? '…' : ok ? ic('check') : ic('x');
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
      + chkRow('agent', r.agent ? r.agent.ok : false, r.agent ? (r.agent.ok ? agentBin+' '+r.agent.version : 'not found on PATH') : '')
      + (r.codex && r.codex.ok ? chkRow('codex', true, r.codex.bin+' '+r.codex.version+' · optional 2nd provider') : '');
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
    + '</ol></div>'
    + '<div class="setup-sec"><p class="setup-label">Remote access</p>'
    + '<div id="rmtOnboard" class="rmt">checking Tailscale…</div></div>'
    + '</div>';
  loadRemote();
}
function cardHTML(r){
  const task = tasks.get(r.taskId);
  const closed = task && task.status==='closed';
  const title = (task ? esc(task.title) : ('task ' + (r.taskId ?? '?')))
    + (closed ? ' <span class="closed">· closed</span>' : '');
  const evs = humanLines(r.events).slice(-8).map(h =>
    '<div class="ev"><span class="k">'+esc(h.k)+'</span><span class="t">'+esc(h.t).slice(0,140)+'</span></div>'
  ).join('') || '<div class="ev"><span class="t" style="color:var(--faint)">waiting…</span></div>';
  const selCls = (selectMode?' selmode':'') + (selected.has(r.id)?' selected':'') + (closed?' closed':'');
  return '<div class="card'+selCls+'" id="card-'+r.id+'">'
    + '<div class="card-h"><span class="rid">r'+r.id+'</span><span class="title">'+title+'</span>'
    + '<span class="selbox">'+ic('check')+'</span>'+chipHTML(r.status)+'</div>'
    + '<div class="meta"><span>branch <b>'+esc(r.branch||'—')+'</b></span>'
    + '<span>files <b>'+(r.filesChanged??0)+'</b></span>'
    + '<span>'+esc(r.agent||'')+'</span>'
    + attemptHTML(r)
    + (r.model ? '<span title="model">⚙ '+esc(r.model)+'</span>' : '')
    + (task && task.parentRunId ? '<span title="spawned by agent r'+task.parentRunId+'">↳ by r'+task.parentRunId+'</span>' : '')
    + (r.sessionId && ['done','failed','stopped'].includes(r.status)
        ? '<span class="resumable" title="agent session preserved — open the run and Send a next instruction to continue">↻ resumable</span>' : '')
    + (r.prUrl ? '<a href="'+esc(r.prUrl)+'" target="_blank" rel="noopener" style="margin-left:auto">PR '+ic('external-link')+'</a>' : '')
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
  const r = await fetch('/api/fleet?view=active').then(x=>x.json());
  machines = r.machines||[]; repos = r.repos||[]; captures = r.captures||[];
  if (r.counts){ const n = r.counts.closedTasks||0; $('archN').textContent = n ? '· '+n : ''; }
  tasks.clear();
  (r.tasks||[]).forEach(t => tasks.set(t.id, t));
  groups.clear();
  (r.groups||[]).forEach(g => groups.set(g.id, g));
  runs.clear();
  (r.runs||[]).forEach(rn => runs.set(rn.id, { ...rn, events: rn.events||[] }));
  if (r.daemon) {
    const d = r.daemon;
    if (d.port) daemonPort = d.port;
    remoteAuthOpen = !!d.authOpen;
    const db = String(d.dbPath||'').replace(/^\\/(?:Users|home)\\/[^/]+/, '~');
    const el = $('daemonBadge');
    el.innerHTML = 'daemon <b>v'+esc(String(d.version||'?'))+'</b> · :'+esc(String(d.port||'?'));
    el.title = 'pid '+d.pid+' · db '+db;
    el.style.display = '';
  }
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
/* ── 기본 브랜치 변경 ── */
$('repoBranch').addEventListener('click', ()=>{
  const rid = $('taskRepo').value;
  if (!rid){ toast('no repository selected', 'error'); return; }
  const repo = repos.find(r=>String(r.id)===String(rid));
  $('brInput').value = repo ? repo.defaultBranch : '';
  $('brOverlay').classList.add('open'); $('brInput').focus();
});
$('brCancel').addEventListener('click', ()=>$('brOverlay').classList.remove('open'));
$('brOverlay').addEventListener('click',(e)=>{ if(e.target===$('brOverlay')) $('brOverlay').classList.remove('open'); });
async function brSave(){
  const rid = $('taskRepo').value; const branch = $('brInput').value.trim();
  if (!rid || !branch) return;
  const res = await fetch('/api/repos/'+rid,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({defaultBranch:branch})});
  const j = await res.json().catch(()=>({}));
  if (res.ok){ $('brOverlay').classList.remove('open'); toast('base branch → '+j.defaultBranch, 'ok'); hydrate(); }
  else toast('branch: '+(j.error||res.status), 'error');
}
$('brOk').addEventListener('click', brSave);
$('brInput').addEventListener('keydown',(e)=>{ if(e.key==='Enter') brSave(); });
$('repoManual').addEventListener('click', ()=>{
  const f = $('repoForm'); f.hidden = !f.hidden;
  if (!f.hidden) $('repoPath').focus();
});

/* ── 완료 알림(브라우저) — 벨 토글, run 정착 시 통지 ── */
let notifyOn = false;
try { notifyOn = localStorage.getItem('coxpit.notify') === '1' && Notification.permission === 'granted'; } catch {}
function paintBell(){ $('bell').innerHTML = ic(notifyOn ? 'bell' : 'bell-off'); }
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
    const n = new Notification('coxpit · r'+ev.runId+' '+ev.status, {
      body: (t ? t.title+' — ' : '') + (ev.filesChanged??0)+' file(s) changed',
      tag: 'coxpit-r'+ev.runId,
    });
    // 딥링크 — 알림 탭이 곧 그 run 의 모달
    n.onclick = ()=>{ try{ window.focus(); }catch{} if (runs.has(ev.runId)) openModal(ev.runId); n.close(); };
  } catch {}
}

function connectWS(){
  const proto = location.protocol==='https:'?'wss':'ws';
  const ws = new WebSocket(proto+'://'+location.host+'/ws');
  ws.onopen = ()=>{ $('wsdot').classList.add('on'); $('wstext').textContent='live'; };
  ws.onclose = ()=>{ $('wsdot').classList.remove('on'); $('wstext').textContent='reconnecting'; setTimeout(connectWS,1500); };
  ws.onmessage = (m)=>{
    let ev; try{ ev = JSON.parse(m.data); }catch{ return; }
    // 아카이브 뷰는 정적 스냅샷 — 라이브 갱신으로 뒤엎지 않는다.
    if (boardView==='archive' && (ev.type==='run'||ev.type==='event'||ev.type==='task')) return;
    roomOnWS(ev);   // 워크룸이 열려있으면 그룹 소속 run/event 를 방에 반영
    if (ev.type==='run'){
      const rid = ev.runId ?? ev.id;
      const known = runs.has(rid);
      // 아카이브된(맵에 없는) run 의 뒤늦은 echo 는 무시 — 신규는 항상 pending 으로 먼저 온다.
      if (!known && ev.status && ev.status!=='pending') return;
      upsertRun(ev);
      if (!known && ev.taskId==null){ hydrate(); return; }
      if (ev.taskId!=null && !tasks.has(ev.taskId)) hydrate(); // 통합 태스크 등 신규 태스크 동기화
      render(); flash(rid); paintModal();
      if (openRunId===rid && ['done','failed','error','stopped'].includes(ev.status)) loadDiff();
      if (cmpTaskId!=null && ['done','failed','error','stopped','merged'].includes(ev.status)) paintCompare();
      if (['done','failed','error','stopped'].includes(ev.status)) notifySettleUI(ev);
    } else if (ev.type==='event'){
      const r = runs.get(ev.runId); if(!r) return;   // 아카이브 run 의 이벤트는 무시(맵에 없으면 resurrect X)
      r.events = r.events||[]; r.events.push({ kind:ev.kind, payload:ev.payload });
      render(); flash(ev.runId); paintModal();
    } else if (ev.type==='task'){
      const t = tasks.get(ev.taskId);
      if (t){ if (ev.status!=null) t.status = ev.status; if (ev.groupId!=null) t.groupId = ev.groupId; render(); paintModal(); } else { hydrate(); }
    } else if (ev.type==='capture'){
      captures.push(ev.capture); paintSidebar();
    }
  };
}

/* ── run detail modal ── */
let openRunId = null;
/* 터미널이 붙을 수 없는 사유(있으면 그 문자열, 없으면 '') — 닫힌 task·정리된 worktree.
   cleanupRun 이 worktreePath 를 비우므로 merged/cleanup/closed 는 모두 여기서 걸린다. */
function termUnavailReason(r, task){
  if (task && task.status==='closed') return 'worktree cleaned — terminal unavailable (task closed)';
  if (r.status==='merged') return 'worktree cleaned — terminal unavailable (merged)';
  if ('worktreePath' in r && !r.worktreePath) return 'worktree cleaned — terminal unavailable';
  return '';
}
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
  // 터미널 가드 — 닫힌 task·worktree 정리된 run(merged/cleanup) 은 tmux 세션이 죽어
  //   attach 하면 에러. 버튼을 잠그고 사유를 툴팁으로.
  const termGuard = termUnavailReason(r, task);
  const tbtn = $('mTerm');
  tbtn.disabled = !!termGuard;
  tbtn.title = termGuard || 'attach a tmux terminal to this run';
  $('mTimeline').innerHTML = humanLines(r.events).map(h =>
    '<div class="ev"><span class="k">'+esc(h.k)+'</span><span class="t">'+esc(h.t)+'</span></div>'
  ).join('') || '<span style="color:var(--faint)">no events yet</span>';
}
/* ── v4.7 산출물 계약 · 출력 카드 — 오른쪽 컬럼(diff/Rendered 토글을 흡수) ──
   /outputs 로 카드 목록을 받아 렌더하고, 클릭하면 타입별 실뷰어를 오른쪽에 띄운다.
   answer/doc → mdLite · page → sandbox iframe · code → 기존 diff 렌더러 · file → 이미지/다운로드. */
let outCards = [];                 // 이 run 의 마지막 카드 목록(RunOutputCard[])
const OUT_ICON = { answer:'message', code:'code', doc:'file', page:'image', file:'image' };
const OUT_LABEL = { answer:'답변', code:'코드', doc:'문서', page:'페이지', file:'파일' };
function contractHTML(cards){
  const declared = cards.filter(c=>c.required);
  const aux = cards.filter(c=>!c.required && c.present);
  if (!declared.length && !aux.length) return '';   // 계약도 부수도 없으면 스트립 숨김
  let h = '<span class="clabel">요청 산출물(계약):</span>';
  if (declared.length){
    h += declared.map(c=>{
      const ok = c.present;
      return '<span class="req '+(ok?'ok':'warn')+'"><span class="rg">'+ic(ok?'check':'alert-triangle')+'</span>'
        + esc(OUT_LABEL[c.type]||c.type)+'</span>';
    }).join('');
  } else h += '<span class="req aux">없음</span>';
  if (aux.length){
    h += '<span class="csep">—</span><span class="clabel">부수:</span>'
      + aux.map(c=>'<span class="req aux">'+esc(OUT_LABEL[c.type]||c.type)+'</span>').join('');
  }
  return h;
}
function outCardHTML(c, i){
  const miss = !c.present;
  const badge = c.required
    ? '<span class="obadge '+(c.present?'req':'warn')+'">요청됨</span>'
    : '<span class="obadge">부수</span>';
  const gname = miss ? 'alert-triangle' : (OUT_ICON[c.type] || 'circle');
  const meta = miss ? '산출물 미충족 — '+esc(c.meta||'') : esc(c.meta||'');
  return '<div class="ocard'+(miss?' miss':'')+'" data-oi="'+i+'">'
    + '<span class="og">'+ic(gname)+'</span>'
    + '<span class="ob"><span class="ot">'+esc(c.title||c.type)+'</span>'
    + '<span class="om">'+meta+'</span></span>'
    + badge
    + (miss?'':'<span class="oc">'+ic('chevron')+'</span>')
    + '</div>';
}
/* run 형태로 기본 카드 선택 — 코드 변경 없고 answer/doc 있으면 그걸, 코드 위주면 code,
   아니면 첫 present 선언 카드(없으면 첫 present 카드). 미충족 카드는 절대 자동 오픈 안 함. */
function pickDefaultCard(cards){
  const present = cards.filter(c=>c.present);
  if (!present.length) return -1;
  const hasCode = present.some(c=>c.type==='code');
  const docish = present.find(c=>c.type==='answer' || c.type==='doc');
  if (!hasCode && docish) return cards.indexOf(docish);
  if (hasCode){
    const codeCard = present.find(c=>c.type==='code');
    // 코드 위주라도 선언된 문서/답변이 있으면 그 계약을 우선(코드는 언제나 카드로 접근 가능)
    const declaredDoc = present.find(c=>c.required && (c.type==='answer'||c.type==='doc'||c.type==='page'));
    if (declaredDoc) return cards.indexOf(declaredDoc);
    return cards.indexOf(codeCard);
  }
  const declared = present.find(c=>c.required);
  return cards.indexOf(declared || present[0]);
}
async function loadDiff(){   // 이름은 유지(모달 refresh·정착 이벤트가 호출) — 이제 outputs 를 로드
  if (openRunId==null) return;
  const rid = openRunId;
  $('outCards').innerHTML = '<div class="ocards-empty">loading…</div>';
  $('mStat').textContent='';
  showOutCards();   // 상세에서 목록으로
  try{
    const j = await fetch('/api/runs/'+rid+'/outputs').then(x=>x.json());
    if (rid !== openRunId) return;
    outCards = (j.outputs)||[];
    $('mContract').innerHTML = contractHTML(outCards);
    $('mContract').hidden = !$('mContract').innerHTML;
    const nPresent = outCards.filter(c=>c.present).length;
    $('mStat').textContent = nPresent ? '· '+nPresent+' output'+(nPresent>1?'s':'') : '· none';
    if (!outCards.length){ $('outCards').innerHTML = '<div class="ocards-empty">no outputs yet</div>'; return; }
    $('outCards').innerHTML = outCards.map(outCardHTML).join('');
    const def = pickDefaultCard(outCards);
    if (def>=0) openOutCard(def);
  }catch{ $('outCards').innerHTML = '<div class="ocards-empty">outputs failed</div>'; }
}
function showOutCards(){
  $('outWrap').classList.remove('detailing');
  $('outDetail').classList.remove('on');
}
function showOutDetail(){
  $('outWrap').classList.add('detailing');
  $('outDetail').classList.add('on');
}
/* 카드 상세 렌더러(재사용) — 모달 오른쪽 컬럼과 워크룸 펼침 peek 이 공유.
   rid = 대상 run, c = 카드, box = 그릴 곳, alive() = 아직 이 뷰가 유효한지(스테일 가드). */
async function renderOutCardInto(rid, c, box, alive){
  if (!c || !c.present) return;
  const ok = alive || (()=>true);
  box.innerHTML = '<span style="color:var(--faint);font-family:var(--mono);font-size:11px">rendering…</span>';
  try{
    if (c.type==='answer' || c.type==='doc'){
      const q = '/api/runs/'+rid+'/output?type='+c.type+(c.path?'&path='+encodeURIComponent(c.path):'');
      const j = await fetch(q).then(x=>x.json());
      if (!ok()) return;
      box.innerHTML = (c.path?'<div class="doc-h">'+esc(c.path)+'</div>':'')
        + '<div class="doc-md">'+mdLite(j.content||'')+'</div>';
    } else if (c.type==='page'){
      const q = '/api/runs/'+rid+'/output?type=page'+(c.path?'&path='+encodeURIComponent(c.path):'');
      const j = await fetch(q).then(x=>x.json());
      if (!ok()) return;
      box.innerHTML = (c.path?'<div class="doc-h">'+esc(c.path)+'</div>':'')
        + '<iframe class="doc-frame" sandbox="" srcdoc="'+escA(j.content||'')+'"></iframe>';
    } else if (c.type==='code'){
      box.innerHTML = '<pre class="diff">loading…</pre>';
      const d = await fetch('/api/runs/'+rid+'/diff').then(x=>x.json());
      if (!ok()) return;
      const pre = box.querySelector('pre.diff'); if (!pre) return;
      if (!d.ok){ pre.textContent = d.stat||'no worktree — diff unavailable'; return; }
      pre.innerHTML = diffHTML(d.diff||'');
    } else if (c.type==='file'){
      const raw = '/api/runs/'+rid+'/file?path='+encodeURIComponent(c.path||'');
      const isImg = /\\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(c.path||'');
      if (isImg){
        box.innerHTML = '<div class="doc-h">'+esc(c.path||'')+'</div>'
          + '<img class="oimg" src="'+escA(raw)+'" alt="'+escA(c.path||'')+'">';
      } else {
        const isText = /\\.(txt|md|json|csv|log|ya?ml|ini|cfg|xml|ts|js|py|sh)$/i.test(c.path||'');
        let extra = '';
        if (isText){
          try{
            const r = await fetch(raw);
            if (ok() && r.ok){
              const t = await r.text();
              extra = '<pre class="diff" style="margin-top:8px">'+esc(t.slice(0,20000))+'</pre>';
            }
          }catch{}
        }
        box.innerHTML = '<div class="doc-h">'+esc(c.path||'')+'</div>'
          + '<a class="odl" href="'+escA(raw)+'" download>↓ download</a>' + extra;
      }
    }
  }catch{ box.innerHTML = '<span style="color:var(--faint)">viewer failed</span>'; }
}
async function openOutCard(i){
  const c = outCards[i]; if (!c || !c.present) return;
  const rid = openRunId;
  showOutDetail();
  await renderOutCardInto(rid, c, $('outDetailC'), ()=>rid===openRunId);
}
function docsHTML(docs){
  if (!docs.length) return '<span style="color:var(--faint)">no changed docs (md/html) in this worktree</span>';
  return docs.map(d=>'<div class="doc-h">'+esc(d.path)+'</div>'
    + (d.kind==='md'
        ? '<div class="doc-md">'+mdLite(d.content)+'</div>'
        : '<iframe class="doc-frame" sandbox="" srcdoc="'+escA(d.content)+'"></iframe>')).join('');
}
/* 출력 카드 클릭 → 상세 뷰어 */
$('outCards').addEventListener('click', (e)=>{
  const card = e.target.closest ? e.target.closest('.ocard') : null;
  if (!card || card.classList.contains('miss')) return;
  openOutCard(Number(card.dataset.oi));
});
$('outBack').addEventListener('click', showOutCards);
/* code 카드 diff 라인 클릭 → steer 입력에 참조 인용 (정착 run 에서만 — steerRow 표시 중일 때) */
$('outDetail').addEventListener('click', (e)=>{
  const t = e.target.closest ? e.target.closest('.dl-line') : null;
  if (!t) return;
  if ($('steerRow').style.display === 'none') return;
  const line = (t.textContent||'').slice(1).trim().slice(0,120);
  const f = t.dataset.f || '';
  $('steerInput').value = (f ? f+': ' : '') + '"'+line+'" — ';
  $('steerInput').focus();
});
async function openModal(id){
  openRunId = id;
  outCards = [];
  showOutCards();
  $('mContract').hidden = true; $('mContract').innerHTML = '';
  $('outCards').innerHTML = '<div class="ocards-empty">loading…</div>';
  paintModal(); $('overlay').classList.add('open'); loadDiff();   // loadDiff = /outputs 로드
  // fleet 는 run 당 최근 40 이벤트만 내림 — 모달은 전체 타임라인을 다시 가져온다.
  try{
    const j = await fetch('/api/runs/'+id).then(x=>x.json());
    if (j.run){ const r = runs.get(id); if (r){ r.events = j.events||[]; if (openRunId===id) paintModal(); } }
  }catch{}
}
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

/* ── 그룹 밴드 액션 (fold / Select runs / Close group) ── */
$('grid').addEventListener('click', async (e)=>{
  const groom = e.target.closest('[data-groom]');
  if (groom){ openRoom(Number(groom.dataset.groom)); return; }
  const fold = e.target.closest('[data-gfold]');
  if (fold){ const g=Number(fold.dataset.gfold); if(gfold.has(g)) gfold.delete(g); else gfold.add(g); saveGfold(); render(); return; }
  const gsel = e.target.closest('[data-gsel]');
  if (gsel){
    const g=Number(gsel.dataset.gsel);
    if (!selectMode) setSelectMode(true);
    const tids = new Set([...tasks.values()].filter(t=>t.groupId===g).map(t=>t.id));
    for (const r of [...runs.values()].sort((a,b)=>a.id-b.id)){
      if (!tids.has(r.taskId)) continue;
      const ok = ['done','failed','stopped'].includes(r.status) && (r.filesChanged||0)>0 && r.status!=='merged';
      if (ok && !selected.has(r.id)){ selected.add(r.id); selOrder.push(r.id); }
    }
    $('selCnt').textContent = selected.size + ' selected';
    render();
    if (!selected.size) toast('no settled runs with changes in this group yet', 'error');
    return;
  }
  const gclose = e.target.closest('[data-gclose]');
  if (gclose){ await closeGroup(Number(gclose.dataset.gclose)); return; }
});
async function closeGroup(g){
  const tids = [...tasks.values()].filter(t=>t.groupId===g && t.status!=='closed').map(t=>t.id);
  if (!tids.length){ toast('nothing open in this group', 'ok'); return; }
  const grp = groups.get(g)||{};
  const yes = await confirmUI('Close this whole group?',
    { sub: (grp.title||'group')+' — stops and cleans every worktree/branch of '+tids.length+' task(s).', danger:true, okLabel:'Close group' });
  if (!yes) return;
  const closeOne = (id,force)=>fetch('/api/tasks/'+id+'/close',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({force})});
  const risky = [];
  for (const id of tids){
    const res = await closeOne(id,false);
    if (res.status===409){ const j=await res.json().catch(()=>({})); (j.atRisk||[]).forEach(a=>risky.push(a)); }
  }
  if (risky.length){
    const list = risky.map(a=>'r'+a.runId+' · '+a.filesChanged+' file'+(a.filesChanged>1?'s':'')).join(' · ');
    const ok = await confirmUI('Close and delete unmerged output?',
      { danger:true, sub: list+' — not merged, not exported. Worktrees are deleted on close.', okLabel:'Close anyway' });
    if (!ok){ await hydrate(); return; }
    for (const id of tids) await closeOne(id,true);
  }
  toast('closed '+tids.length+' task'+(tids.length>1?'s':'')+' in the group', 'ok');
  await hydrate();
}
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
document.addEventListener('keydown',(e)=>{ if(e.key==='Escape'){ closeDropdowns(); cfmClose(false); $('brwOverlay').classList.remove('open'); $('expOverlay').classList.remove('open'); $('ghOverlay').classList.remove('open'); $('npOverlay').classList.remove('open'); $('brOverlay').classList.remove('open'); $('remoteOverlay').classList.remove('open'); closeRoom(); closeTerm(); closeModal(); cmpTaskId=null; $('cmpOverlay').classList.remove('open'); } });
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
  const close = (force)=>fetch('/api/tasks/'+r.taskId+'/close',{method:'POST',
    headers:{'content-type':'application/json'}, body:JSON.stringify({force})});
  let res = await close(false);
  if (res.status===409){
    const j = await res.json().catch(()=>({}));
    const risk = (j.atRisk||[]).map(a=>'r'+a.runId+' · '+a.filesChanged+' file'+(a.filesChanged>1?'s':'')).join(' · ');
    const ok = await confirmUI('Close and delete unmerged output?',
      { danger:true, sub: risk+' — not merged, not exported. Worktrees are deleted on close.', okLabel:'Close anyway' });
    if (!ok) return;
    res = await close(true);
  }
  if (!res.ok){ toast('close failed ('+res.status+')', 'error'); return; }
  toast('task closed — all runs cleaned', 'ok');
  closeModal(); hydrate();
});

/* ── compare view ── */
let cmpTaskId = null;
let cmpDocMode = false;
async function openCompare(taskId){
  cmpTaskId = taskId;
  cmpDocMode = false; $('cmpDocsTgl').textContent = 'Rendered';
  $('cmpReview').hidden = true; $('cmpReview').innerHTML = '';
  $('cmpOverlay').classList.add('open');
  $('cmpBody').innerHTML = '<div class="empty" style="flex:1">loading…</div>';
  await paintCompare();
}
$('cmpDocsTgl').addEventListener('click', async ()=>{
  cmpDocMode = !cmpDocMode;
  $('cmpDocsTgl').textContent = cmpDocMode ? 'Diff' : 'Rendered';
  await paintCompare();
});
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
      + (r.prUrl ? '<a href="'+esc(r.prUrl)+'" target="_blank" rel="noopener">PR '+ic('external-link')+' '+esc(r.prUrl.split('/').slice(-1)[0])+'</a>' : '')
      + '</span>'
      + (merged
        ? chipHTML('merged')
        : (r.prUrl ? '' : '<button class="btn-ghost sm" data-pr="'+r.id+'"'+(mergeable?'':' disabled')+'>Open PR</button>')
          + '<button class="btn sm" data-merge="'+r.id+'"'+(mergeable?'':' disabled')+'>Merge this</button>')
      + '</div></div>';
  }).join('');
  // doc 모드 — 각 열의 diff 를 렌더된 문서로 치환 (열별 비동기, 도착 순)
  if (cmpDocMode){
    for (const r of d.runs){
      fetch('/api/runs/'+r.id+'/docs').then(x=>x.json()).then(j=>{
        const col = document.querySelector('.cmp-col[data-run="'+r.id+'"] .cmp-diff');
        if (col && cmpDocMode) col.innerHTML = docsHTML(j.docs||[]);
      }).catch(()=>{});
    }
  }
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

/* ── goal workroom (v4.6 L1) — 한 goal 을 여는 단일 방 ── */
let roomGroupId = null;               // 열려있는 그룹 id (null = 닫힘)
const roomRunSet = new Set();         // 이 그룹에 속한 runId — WS 필터용
let roomRuns = [];                    // 마지막 aggregate 의 runs (chips/scope hint)
const roomTurns = [];                 // Ask 대화 턴 [{role:'you'|'coord', text}] — 읽기 전용
let roomMode = 'work';                // 'work' | 'ask' — 방 composer 모드(스틸모드와 무관, 방 전용)
/* run → 상태색 (chip / who) */
function roomStatusColor(s){ return statusColor(s); }
function roomChipHTML(r){
  const s = r.status||'pending';
  const meta = ['done','failed','stopped','merged'].includes(s)
    ? (r.filesChanged? '+'+r.filesChanged+'f' : 'no changes')
    : (r.agent||'agent')+(s==='running'?' · editing…':'');
  return '<span class="chip'+(s==='running'?' running':'')+(r.isNew?' new':'')+'" data-roomrun="'+r.runId+'"'
    + ' style="color:'+roomStatusColor(s)+';border-color:'+roomStatusColor(s)+'">'
    + '<i></i><span class="cid">r'+r.runId+'</span> <span class="cmeta">'+esc(meta)+'</span></span>';
}
function roomRenderChips(){
  $('roomChips').innerHTML = roomRuns.length
    ? roomRuns.map(roomChipHTML).join('')
    : '<span style="color:var(--faint);font-family:var(--mono);font-size:11.5px">no runs yet</span>';
}
/* ── 수렴 콕핏(Work body) — run 하나당 결정 행. 서버 엔드포인트만 재사용(merge/steer/review/close). ──
   접힘 head = 체크박스·상태점·rN·제목·메타·인라인[리뷰][수정][머지][클로즈]·caret.
   펼침 body = P2 출력 카드(리뷰 peek, renderRunOutputsInto 재사용) + 수정(steer) 입력. */
const roomSel = new Set();      // Integrate 선택된 runId
const roomOpen = new Set();     // 펼쳐진 runId (WS 재렌더에도 유지)
function roomDone(s){ return ['done','failed','stopped'].includes(s); }
function roomRunRowHTML(r){
  const s = r.status||'pending';
  const merged = s==='merged';
  const running = r.live || s==='running' || s==='preparing' || s==='pending';
  const sel = roomSel.has(r.runId);
  const open = roomOpen.has(r.runId);
  const dotCls = merged?'merged':(running?'running':(s==='failed'?'failed':'done'));
  const meta = (r.agent?esc(r.agent)+' · ':'') + (r.filesChanged? '+'+r.filesChanged+'f' : 'no changes');
  let acts;
  if (merged){
    acts = '<div class="acts"><button class="b ghost" data-ract="open" data-rrid="'+r.runId+'">열기</button></div>';
  } else if (running){
    acts = '<div class="acts"><button class="b ghost" data-ract="open" data-rrid="'+r.runId+'">열기 · 정착 후 결정</button></div>';
  } else {
    acts = '<div class="acts">'
      + '<button class="b ghost" data-ract="review" data-rrid="'+r.runId+'">리뷰</button>'
      + '<button class="b" data-ract="fix" data-rrid="'+r.runId+'">수정</button>'
      + '<button class="b merge" data-ract="merge" data-rrid="'+r.runId+'">머지</button>'
      + '<button class="b close" data-ract="close" data-rrid="'+r.runId+'">클로즈</button>'
      + '</div>';
  }
  const badge = merged
    ? '<span class="run-badge merged">merged → base</span>'
    : (running ? '<span class="run-badge running">running</span>' : '');
  // running·merged 는 체크박스로 선택 불가(정착·미머지만 Integrate 대상)
  const selectable = !merged && !running && (r.filesChanged||0)>0;
  const cb = '<span class="cb" data-rcb="'+(selectable?r.runId:'')+'"'+(selectable?'':' style="opacity:.4;cursor:default"')+'>'+(sel?ic('check'):'')+'</span>';
  return '<div class="run'+(sel?' sel':'')+(merged?' dim':'')+(open?' open':'')+'" data-rrun="'+r.runId+'">'
    + '<div class="run-h">'+cb
    + '<span class="dot '+dotCls+'"></span>'
    + '<span class="run-id">r'+r.runId+'</span>'
    + '<span class="run-title">'+esc(r.title||'task '+r.taskId)+'</span>'
    + '<span class="grow"></span>'
    + badge
    + '<span class="run-meta">'+meta+'</span>'
    + acts
    + '<span class="caret">›</span>'
    + '</div>'
    + '<div class="run-b" data-rbody="'+r.runId+'">'
    +   '<div class="rout" data-rout="'+r.runId+'"><div class="rout-cards"><div class="ocards-empty">…</div></div></div>'
    +   (roomDone(s) && r.steerable
        ? '<div class="fix"><input data-rfix="'+r.runId+'" placeholder="수정 지시 — 같은 세션·worktree 이어서…" />'
          + '<button class="b" data-ract="fixsend" data-rrid="'+r.runId+'">수정 지시 → 세션 이어서</button></div>'
        : '<div class="review"><span class="rk">·</span><span class="rt">이 run 은 steer 불가('
          + (running?'아직 실행 중':(roomDone(s)?'세션 없음 — dry/정리됨':'상태 '+esc(s)))+').</span></div>')
    + '</div></div>';
}
function roomRenderRuns(){
  const el = $('roomRuns');
  if (!roomRuns.length){
    el.innerHTML = '<div class="empty-note">no runs yet — spawn an attempt or wait for the plan to fan out</div>';
    roomUpdateGbar(); return;
  }
  el.innerHTML = roomRuns.map(roomRunRowHTML).join('');
  // 펼쳐진 행의 출력 카드 재하이드레이트
  for (const r of roomRuns){ if (roomOpen.has(r.runId)) roomLoadRunOutputs(r.runId); }
  roomUpdateGbar();
}
function roomUpdateGbar(){
  const n = roomSel.size;
  $('roomSelC').textContent = '☑ '+n+' selected';
  $('roomIntegrateSel').textContent = 'Integrate 선택 ('+n+')';
  $('roomIntegrateSel').disabled = n===0;
}
/* 펼친 행의 출력 카드 로드 — 모달과 같은 /outputs + renderOutCardInto 재사용(중복 없음). */
async function roomLoadRunOutputs(rid){
  const wrap = document.querySelector('.rout[data-rout="'+rid+'"]'); if (!wrap) return;
  const cards = wrap.querySelector('.rout-cards');
  cards.innerHTML = '<div class="ocards-empty">loading…</div>';
  try{
    const j = await fetch('/api/runs/'+rid+'/outputs').then(x=>x.json());
    if (!roomOpen.has(rid)) return;
    const list = j.outputs||[];
    if (!list.length){ cards.innerHTML = '<div class="ocards-empty">no outputs yet</div>'; return; }
    wrap.dataset.cards = JSON.stringify(list);
    cards.innerHTML = list.map(outCardHTML).join('');
  }catch{ cards.innerHTML = '<div class="ocards-empty">outputs failed</div>'; }
}
/* 워크룸 출력 카드 클릭 → 그 행 안에서 상세 뷰어(모달과 동일 렌더러). */
function roomOpenCard(rid, i){
  const wrap = document.querySelector('.rout[data-rout="'+rid+'"]'); if (!wrap) return;
  const list = wrap.dataset.cards ? JSON.parse(wrap.dataset.cards) : [];
  const c = list[i]; if (!c || !c.present) return;
  let det = wrap.querySelector('.rout-detail');
  if (!det){
    det = document.createElement('div'); det.className='rout-detail';
    det.innerHTML = '<div class="rout-back">‹ 산출물 목록</div><div class="rout-body"></div>';
    wrap.appendChild(det);
  }
  det.style.display='';
  renderOutCardInto(rid, c, det.querySelector('.rout-body'), ()=>roomOpen.has(rid));
}
/* Ask 대화(읽기 전용) — you / coordinator 턴. 코디네이터 답 아래 read-only 노트. */
function roomRenderConv(){
  if (!roomTurns.length){
    $('roomConv').innerHTML = '<div class="empty-note">read-only coordinator — ask what these attempts are doing. it never acts.</div>';
    return;
  }
  $('roomConv').innerHTML = roomTurns.map(t=>{
    const role = t.role==='you' ? 'you' : 'coordinator';
    const note = t.role==='coord'
      ? '<span class="ro-note">read-only — switch to Work to act</span>' : '';
    return '<div class="turn '+t.role+'"><span class="role">'+esc(role)+'</span>'
      + '<span class="msg">'+esc(t.text)+'</span>'+note+'</div>';
  }).join('');
  $('roomConv').scrollTop = $('roomConv').scrollHeight;
}
function roomRenderHeaderAndHint(){
  const g = groups.get(roomGroupId) || {};
  const done = roomRuns.filter(r=>['done','failed','stopped','merged'].includes(r.status)).length;
  const running = roomRuns.filter(r=>r.live).length;
  $('roomTitle').textContent = 'Goal: '+(g.title||'');
  $('roomCount').textContent = '· '+roomRuns.length+' run'+(roomRuns.length===1?'':'s')
    +' · '+done+' done · '+running+' running';
  roomRenderHint();
}
/* Work=정직한 steer 스코프, Ask=읽기 전용 안내. 모드에 따라 힌트/뷰/composer 전환. */
function roomRenderHint(){
  if (roomMode==='ask'){
    $('roomHint').textContent = 'read-only coordinator · reads run diffs, never acts';
    return;
  }
  const running = roomRuns.filter(r=>r.live).length;
  const steerable = roomRuns.filter(r=>r.steerable).length;
  $('roomHint').textContent = steerable+' steerable now · '+running+' still running';
}
/* runs(수렴 콕핏)↔conv, verbs↔send-only 를 roomMode 로 스왑. Work=결정 패널·Ask=읽기전용. */
function roomApplyMode(){
  const ask = roomMode==='ask';
  $('roomRuns').hidden = ask;
  $('roomGbar').hidden = ask;    // 그룹 액션 바는 Work 에서만
  $('roomConv').hidden = !ask;
  $('roomVerbs').hidden = ask;
  $('roomSend').hidden = !ask;
  $('roomInput').placeholder = ask
    ? 'Ask the coordinator about these attempts (read-only)…'
    : 'New attempt prompt, or a broadcast to the settled runs…';
  document.querySelectorAll('#roomSeg .seg-opt').forEach(x=>x.classList.toggle('on', x.dataset.rmode===roomMode));
  roomRenderHint();
  if (ask) roomRenderConv();
}
async function openRoom(groupId){
  roomGroupId = groupId;
  roomRunSet.clear(); roomRuns = []; roomTurns.length = 0;
  roomSel.clear(); roomOpen.clear();
  roomMode = 'work';
  $('roomInput').value = '';
  $('roomChips').innerHTML = '<span style="color:var(--faint);font-family:var(--mono);font-size:11.5px">loading…</span>';
  $('roomRuns').innerHTML = '';
  $('roomConv').innerHTML = '';
  $('roomTitle').textContent = 'Goal';
  $('roomCount').textContent = '';
  $('roomHint').textContent = '';
  roomUpdateGbar();
  roomApplyMode();
  $('groupRoomOverlay').classList.add('open');
  await roomLoad();
}
async function roomLoad(){
  if (roomGroupId==null) return;
  let j;
  try{ j = await fetch('/api/groups/'+roomGroupId).then(x=>x.json()); }
  catch{ toast('workroom load failed', 'error'); return; }
  if (!j || !j.group){ toast('group not found', 'error'); return; }
  if (!groups.has(j.group.id)) groups.set(j.group.id, j.group);
  roomRuns = j.runs||[];
  roomRunSet.clear();
  roomRuns.forEach(r=>roomRunSet.add(r.runId));
  // 사라진 run 은 선택/펼침에서 정리
  for (const id of [...roomSel]) if (!roomRunSet.has(id)) roomSel.delete(id);
  for (const id of [...roomOpen]) if (!roomRunSet.has(id)) roomOpen.delete(id);
  roomRenderChips();
  roomRenderHeaderAndHint();
  roomRenderRuns();
}
function closeRoom(){ roomGroupId = null; $('groupRoomOverlay').classList.remove('open'); }
/* chip 클릭 → 그 run 을 기존 run 모달로 */
$('roomChips').addEventListener('click',(e)=>{
  const c = e.target.closest('[data-roomrun]'); if(!c) return;
  const rid = Number(c.dataset.roomrun);
  closeRoom();
  if (runs.has(rid)) openModal(rid);
  else { // 아카이브 등 맵에 없는 run — 태스크로 하이드레이트 후 연다
    fetch('/api/runs/'+rid).then(x=>x.json()).then(d=>{ if(d.run){ runs.set(rid, {...d.run, events:d.events||[]}); openModal(rid); } }).catch(()=>{});
  }
});
$('roomClose').addEventListener('click', closeRoom);
$('groupRoomOverlay').addEventListener('click',(e)=>{ if(e.target===$('groupRoomOverlay')) closeRoom(); });

/* ── 수렴 콕핏 상호작용 — 행 펼침·체크박스·인라인 액션(전부 기존 엔드포인트 재사용) ── */
$('roomRuns').addEventListener('click', async (e)=>{
  // 출력 카드 클릭 → 행 안 상세 뷰어
  const card = e.target.closest ? e.target.closest('.ocard') : null;
  if (card && !card.classList.contains('miss')){
    const wrap = card.closest('.rout'); if (wrap){ roomOpenCard(Number(wrap.dataset.rout), Number(card.dataset.oi)); return; }
  }
  const back = e.target.closest ? e.target.closest('.rout-back') : null;
  if (back){ const det = back.closest('.rout-detail'); if (det) det.style.display='none'; return; }
  // 체크박스 → Integrate 선택 토글
  const cb = e.target.closest ? e.target.closest('.cb') : null;
  if (cb){
    e.stopPropagation();
    const id = Number(cb.dataset.rcb); if (!id) return;
    if (roomSel.has(id)) roomSel.delete(id); else roomSel.add(id);
    cb.innerHTML = roomSel.has(id) ? ic('check') : '';
    cb.closest('.run').classList.toggle('sel', roomSel.has(id));
    roomUpdateGbar();
    return;
  }
  // 인라인 액션 버튼
  const ab = e.target.closest ? e.target.closest('[data-ract]') : null;
  if (ab){ e.stopPropagation(); await roomRunAction(ab.dataset.ract, Number(ab.dataset.rrid)); return; }
  // head 클릭 → 펼침 토글
  const head = e.target.closest ? e.target.closest('.run-h') : null;
  if (head){
    const rid = Number(head.parentElement.dataset.rrun);
    if (roomOpen.has(rid)){ roomOpen.delete(rid); head.parentElement.classList.remove('open'); }
    else { roomOpen.add(rid); head.parentElement.classList.add('open'); roomLoadRunOutputs(rid); }
  }
});
/* 행 액션 디스패치 — merge/steer/review/close 서버 엔드포인트만. 결정 로직 재구현 없음. */
async function roomRunAction(act, rid){
  const r = roomRuns.find(x=>x.runId===rid); if(!r) return;
  if (act==='open'){
    closeRoom();
    if (runs.has(rid)) openModal(rid);
    else fetch('/api/runs/'+rid).then(x=>x.json()).then(d=>{ if(d.run){ runs.set(rid,{...d.run,events:d.events||[]}); openModal(rid); } }).catch(()=>{});
    return;
  }
  if (act==='fix'){ // 펼치고 steer 입력에 포커스
    if (!roomOpen.has(rid)){ roomOpen.add(rid); const row=document.querySelector('.run[data-rrun="'+rid+'"]'); if(row){ row.classList.add('open'); roomLoadRunOutputs(rid); } }
    const inp = document.querySelector('[data-rfix="'+rid+'"]'); if (inp) inp.focus();
    else toast('r'+rid+': steer 불가(정착·세션 필요)', 'error');
    return;
  }
  if (act==='fixsend'){
    const inp = document.querySelector('[data-rfix="'+rid+'"]'); const msg = inp ? inp.value.trim() : '';
    if (!msg){ if(inp) inp.focus(); return; }
    const res = await fetch('/api/runs/'+rid+'/steer',{method:'POST',
      headers:{'content-type':'application/json'}, body:JSON.stringify({message:msg, mode:'work'})});
    if (res.ok){ if(inp) inp.value=''; toast('r'+rid+': 수정 지시 — 같은 세션 이어서', 'ok'); }
    else { const j = await res.json().catch(()=>({})); toast('steer: '+(j.detail||res.status), 'error'); }
    return;
  }
  if (act==='review'){
    await reviewOneRun(r);
    return;
  }
  if (act==='merge'){
    const yes = await confirmUI('Merge r'+rid+' into the base branch?',
      { sub: 'Uncommitted worktree changes are committed first. Conflicts abort automatically.', okLabel: 'Merge' });
    if (!yes) return;
    const res = await fetch('/api/runs/'+rid+'/merge',{method:'POST'});
    const j = await res.json().catch(()=>({detail:'merge failed'}));
    if (res.ok){ toast('r'+rid+' merged to base', 'ok'); await roomLoad(); hydrate(); }
    else toast('merge: '+(j.detail||res.status), 'error');
    return;
  }
  if (act==='close'){
    const yes = await confirmUI('Close r'+rid+' task?',
      { sub: 'Stops any live runs and removes every worktree and branch of the task.', danger:true, okLabel:'Close task' });
    if (!yes) return;
    const close = (force)=>fetch('/api/tasks/'+r.taskId+'/close',{method:'POST',
      headers:{'content-type':'application/json'}, body:JSON.stringify({force})});
    let res = await close(false);
    if (res.status===409){
      const j = await res.json().catch(()=>({}));
      const risk = (j.atRisk||[]).map(a=>'r'+a.runId+' · '+a.filesChanged+' file'+(a.filesChanged>1?'s':'')).join(' · ');
      const ok = await confirmUI('Close and delete unmerged output?',
        { danger:true, sub: risk+' — not merged, not exported. Worktrees are deleted on close.', okLabel:'Close anyway' });
      if (!ok) return;
      res = await close(true);
    }
    if (!res.ok){ toast('close failed ('+res.status+')', 'error'); return; }
    toast('r'+rid+' task closed', 'ok');
    await roomLoad(); hydrate();
    return;
  }
}
/* [리뷰] — 그 run 의 태스크에 reviewTask(/tasks/:id/review) 를 돌려 요약을 행 안에 인라인 표시. */
async function reviewOneRun(r){
  const row = document.querySelector('.run[data-rrun="'+r.runId+'"]'); if(!row) return;
  if (!roomOpen.has(r.runId)){ roomOpen.add(r.runId); row.classList.add('open'); roomLoadRunOutputs(r.runId); }
  const body = row.querySelector('.run-b');
  let rv = body.querySelector('.review.airev');
  if (!rv){ rv = document.createElement('div'); rv.className='review airev'; body.insertBefore(rv, body.querySelector('.fix')||null); }
  const real = $('taskReal').checked;
  rv.innerHTML = '<span class="rk">'+ic('message')+' 리뷰</span><span class="rt">reviewing… ('+(real?'real':'dry')+')</span>';
  try{
    const res = await fetch('/api/tasks/'+r.taskId+'/review',{method:'POST',
      headers:{'content-type':'application/json'}, body:JSON.stringify({real})});
    const j = await res.json().catch(()=>({}));
    if (res.ok){ rv.innerHTML = '<span class="rk">'+ic('message')+' 리뷰</span><span class="rt">'+mdLite(j.review||'(no summary)')+'</span>'; }
    else { rv.innerHTML = '<span class="rk">'+ic('message')+' 리뷰</span><span class="rt">review 실패 — '+esc(j.detail||String(res.status))+'</span>'; toast('review: '+(j.detail||res.status), 'error'); }
  }catch{ rv.innerHTML = '<span class="rk">'+ic('message')+' 리뷰</span><span class="rt">review 요청 실패</span>'; }
}
/* steer 입력 Enter → 전송 */
$('roomRuns').addEventListener('keydown', (e)=>{
  const inp = e.target.closest ? e.target.closest('[data-rfix]') : null;
  if (inp && e.key==='Enter'){ e.preventDefault(); roomRunAction('fixsend', Number(inp.dataset.rfix)); }
});
/* ── 그룹 액션 바 — Integrate 선택 · 전체 리뷰 · 그룹 클로즈(전부 기존 흐름 재사용) ── */
$('roomIntegrateSel').addEventListener('click', async ()=>{
  if (!roomSel.size){ toast('select settled runs with changes first', 'error'); return; }
  // 기존 select mode + selbar + /api/integrate 재사용 — 방을 닫고 선택을 밴드 select 로 옮긴다.
  const ids = [...roomSel].sort((a,b)=>a-b);
  closeRoom();
  if (!selectMode) setSelectMode(true);
  selected.clear(); selOrder.length = 0;
  for (const id of ids){
    const r = runs.get(id);
    const ok = r && ['done','failed','stopped'].includes(r.status) && (r.filesChanged||0)>0 && r.status!=='merged';
    if (ok){ selected.add(id); selOrder.push(id); }
  }
  $('selCnt').textContent = selected.size + ' selected';
  render();
  if (!selected.size) toast('selected runs are no longer integratable', 'error');
  else toast(selected.size+' run(s) staged — press Integrate in the bar', 'ok');
});
$('roomReviewAll').addEventListener('click', async ()=>{
  // 정착·변경 있는 run 을 위→아래로 리뷰(reviewTask 루프). dry/real 은 전역 토글.
  const targets = roomRuns.filter(r=>roomDone(r.status) && (r.filesChanged||0)>0 && r.status!=='merged');
  if (!targets.length){ toast('no settled runs with changes to review', 'error'); return; }
  const btn = $('roomReviewAll'); btn.disabled = true;
  try{ for (const r of targets) await reviewOneRun(r); }
  finally { btn.disabled = false; }
});
$('roomGroupClose').addEventListener('click', async ()=>{
  if (roomGroupId==null) return;
  const g = roomGroupId;
  await closeGroup(g);       // 기존 그룹 클로즈(guard·atRisk 집계 재사용)
  if (roomGroupId===g) await roomLoad();
});
/* ＋ New attempt — 같은 그룹에 새 시도 발사 (현재 dry/real 토글 반영) */
$('roomNew').addEventListener('click', async ()=>{
  if (roomGroupId==null) return;
  const prompt = $('roomInput').value.trim();
  if (!prompt){ toast('write a prompt for the new attempt', 'error'); return; }
  const real = $('taskReal').checked;
  const btn = $('roomNew'); btn.disabled = true;
  try{
    const res = await fetch('/api/groups/'+roomGroupId+'/spawn',{method:'POST',
      headers:{'content-type':'application/json'}, body:JSON.stringify({prompt, real})});
    const j = await res.json().catch(()=>({}));
    if (res.ok){
      $('roomInput').value='';
      (j.tasks||[]).forEach(t=>{ roomRunSet.add(t.runId); });
      toast((j.tasks||[]).length+' attempt(s) launched'+(real?'':' (dry)'), 'ok');
      await roomLoad(); hydrate();
    } else toast('spawn: '+(j.error||res.status), 'error');
  } finally { btn.disabled = false; }
});
/* → Broadcast — 그룹의 정착 steerable run 전부에 후속 지시(라이브/드라이는 정직하게 skip) */
$('roomBroadcast').addEventListener('click', async ()=>{
  if (roomGroupId==null) return;
  const message = $('roomInput').value.trim();
  if (!message){ toast('write a broadcast message', 'error'); return; }
  const btn = $('roomBroadcast'); btn.disabled = true;
  try{
    const res = await fetch('/api/groups/'+roomGroupId+'/steer',{method:'POST',
      headers:{'content-type':'application/json'}, body:JSON.stringify({message, mode:roomMode})});
    const j = await res.json().catch(()=>({}));
    if (res.ok){
      $('roomInput').value='';
      toast('broadcast: '+j.detail, (j.skipped&&j.skipped.length)?undefined:'ok');
      await roomLoad();
    } else toast('broadcast: '+(j.error||res.status), 'error');
  } finally { btn.disabled = false; }
});
/* Converge ▾ — 기존 review/integrate 를 노출(재구현 아님) */
$('roomConverge').addEventListener('click',(e)=>{ e.stopPropagation(); $('roomConvMenu').classList.toggle('open'); });
document.addEventListener('click',()=>$('roomConvMenu').classList.remove('open'));
$('roomReview').addEventListener('click', ()=>{
  $('roomConvMenu').classList.remove('open');
  // 그룹 태스크가 여럿이면 각 태스크가 자체 비교/리뷰를 가짐 — 첫 태스크의 Compare 로 진입.
  const first = roomRuns[0];
  if (!first){ toast('no runs to review', 'error'); return; }
  closeRoom(); openCompare(first.taskId);
});
$('roomIntegrate').addEventListener('click', ()=>{
  $('roomConvMenu').classList.remove('open');
  const g = roomGroupId; closeRoom();
  if (!selectMode) setSelectMode(true);
  // 그룹의 정착·변경 run 전부 사전 선택(기존 밴드 Select runs 와 동일 규칙)
  const tids = new Set([...tasks.values()].filter(t=>t.groupId===g).map(t=>t.id));
  for (const r of [...runs.values()].sort((a,b)=>a.id-b.id)){
    if (!tids.has(r.taskId)) continue;
    const ok = ['done','failed','stopped'].includes(r.status) && (r.filesChanged||0)>0 && r.status!=='merged';
    if (ok && !selected.has(r.id)){ selected.add(r.id); selOrder.push(r.id); }
  }
  $('selCnt').textContent = selected.size + ' selected';
  render();
  if (!selected.size) toast('no settled runs with changes in this group yet', 'error');
});
/* Work | Ask 세그 — Work=행동(spawn/broadcast/converge), Ask=읽기 전용 코디네이터. 방 전용 모드. */
document.querySelectorAll('#roomSeg .seg-opt').forEach(b=>{
  b.addEventListener('click', ()=>{
    roomMode = b.dataset.rmode;
    roomApplyMode();
  });
});
/* ? Ask — 그룹 스코프 읽기 전용 코디네이터. 절대 발사·steer·쓰기 없음 (POST /ask). */
$('roomAsk').addEventListener('click', async ()=>{
  if (roomGroupId==null) return;
  const message = $('roomInput').value.trim();
  if (!message){ toast('write a question for the coordinator', 'error'); return; }
  const real = $('taskReal').checked;
  const btn = $('roomAsk'); btn.disabled = true;
  roomTurns.push({ role:'you', text:message });
  roomRenderConv();
  $('roomInput').value='';
  try{
    const res = await fetch('/api/groups/'+roomGroupId+'/ask',{method:'POST',
      headers:{'content-type':'application/json'}, body:JSON.stringify({message, real})});
    const j = await res.json().catch(()=>({}));
    if (res.ok && j.answer){
      roomTurns.push({ role:'coord', text:j.answer });
    } else {
      roomTurns.push({ role:'coord', text:'(ask failed — '+(j.error||res.status)+')' });
      toast('ask: '+(j.error||res.status), 'error');
    }
    roomRenderConv();
  } catch { toast('ask request failed', 'error'); }
  finally { btn.disabled = false; }
});
/* WS 라이브 — 그룹 소속 run/event 만 방에 반영 (connectWS 가 호출) */
function roomOnWS(ev){
  if (roomGroupId==null) return;
  if (ev.type==='run'){
    const rid = ev.runId ?? ev.id;
    if (!roomRunSet.has(rid)) return;   // 이 방 소속만
    roomLoad();                          // 상태·steerable 재계산 → 결정 행 재렌더(aggregate, 정확)
  }
  // event 티커는 수렴 콕핏에선 행 안 출력 카드로 대체 — 상태 변화는 run 이벤트가 재렌더한다.
}

/* ── terminal — 초기크기 접속·자동 재연결(백오프)·unicode11·CJK 폰트 ── */
let termWS = null, termObj = null, fitAddon = null, termResizeObs = null;
let termRunId = null, termClosing = false, termRetry = 0, termRetryTimer = null;
function termConnect(){
  if (termRunId==null || termClosing || !termObj) return;
  const proto = location.protocol==='https:'?'wss':'ws';
  // 소켓 정체성 가드 — close 이벤트는 비동기라 termClosing 토글만으론 못 막는다.
  // 대체된(sock!==termWS) 소켓은 출력도 재연결도 금지: 같은 tmux 세션에 WS 가
  // 누적 attach 되면 tmux 가 전 클라이언트에 미러링해 글자가 N번씩 보인다.
  const sock = new WebSocket(proto+'://'+location.host+'/ws/term/'+termRunId
    +'?cols='+termObj.cols+'&rows='+termObj.rows);
  termWS = sock;
  sock.onopen = ()=>{
    if (sock!==termWS){ try{ sock.close(); }catch{} return; }
    termRetry = 0;
    $('termTitle').textContent = ((runs.get(termRunId)||{}).tmuxWindow||'terminal');
    termObj.focus();
  };
  sock.onmessage = (m)=>{
    if (sock!==termWS || !termObj) return;
    try{
      const d = JSON.parse(m.data);
      if (d.t==='o') termObj.write(d.d);
      else if (d.t==='err') termObj.write('\\r\\n\\x1b[31m'+d.d+'\\x1b[0m\\r\\n');
      else if (d.t==='exit') termObj.write('\\r\\n\\x1b[90m[session ended — reconnecting will revive it]\\x1b[0m\\r\\n');
    }catch{}
  };
  sock.onclose = ()=>{
    if (sock!==termWS) return;
    if (termClosing || termRunId==null) return;
    // 예기치 않은 끊김 — 백오프 재연결(서버가 죽은 세션도 소생시킴)
    const delay = Math.min(8000, 800 * Math.pow(2, termRetry++));
    $('termTitle').textContent = 'reconnecting…';
    termRetryTimer = setTimeout(termConnect, delay);
  };
}
/* 세션 탭 — 살아있는 세션(running·open) 사이를 터미널 안에서 바로 전환 */
function termTabsRender(){
  const el = $('termTabs');
  const list = [...runs.values()].filter(r=>r.status==='running'||r.status==='open').sort((a,b)=>a.id-b.id);
  el.innerHTML = list.map(r=>{
    const kind = r.agent==='workbench' ? 'bench' : (r.agent||'agent');
    return '<button class="ttab'+(r.id===termRunId?' on':'')+'" data-id="'+r.id+'">r'+r.id+' · '+esc(kind)+'</button>';
  }).join('');
  el.querySelectorAll('.ttab').forEach(b=>b.addEventListener('click',()=>termSwitch(+b.dataset.id)));
}
function termSwitch(id){
  if (id===termRunId || !termObj) return;
  if (termRetryTimer){ clearTimeout(termRetryTimer); termRetryTimer=null; }
  if (termWS){ termClosing=true; try{ termWS.close(); }catch{} termWS=null; }
  termClosing = false; termRetry = 0; termRunId = id;
  $('termRid').textContent = 'r'+id;
  $('termTitle').textContent = ((runs.get(id)||{}).tmuxWindow||'terminal');
  termObj.reset();
  termTabsRender();
  termConnect();
}
function openTerm(runId){
  const r = runs.get(runId); if(!r) return;
  // 재진입 방어 — 이전 소켓/타이머가 남아 있으면 정리(중복 attach 방지)
  if (termRetryTimer){ clearTimeout(termRetryTimer); termRetryTimer=null; }
  if (termWS){ const old=termWS; termWS=null; try{ old.close(); }catch{} }
  termRunId = runId; termClosing = false; termRetry = 0;
  $('termRid').textContent = 'r'+runId;
  $('termTitle').textContent = (r.tmuxWindow||'terminal');
  termTabsRender();
  $('termOverlay').classList.add('open');
  const el = $('xterm'); el.innerHTML = '';
  termObj = new window.Terminal({
    fontFamily: "ui-monospace, 'SF Mono', Menlo, Monaco, 'Apple SD Gothic Neo', 'Noto Sans KR', 'Malgun Gothic', monospace",
    fontSize: 12.5, cursorBlink: true, allowProposedApi: true,
    theme: { background:'#0b0d12', foreground:'#dee4ec', cursor:'#4ec9b0',
      selectionBackground:'rgba(78,201,176,.25)', black:'#1c212c', brightBlack:'#5c6675' },
  });
  fitAddon = new window.FitAddon.FitAddon();
  termObj.loadAddon(fitAddon);
  try{ // 이모지·CJK 폭 보정 — TUI(claude) 줄 밀림 방지
    termObj.loadAddon(new window.Unicode11Addon.Unicode11Addon());
    termObj.unicode.activeVersion = '11';
  }catch{}
  termObj.open(el);
  fitAddon.fit();               // 접속 전에 크기 확정 → 80x24 경유 없이 바로 정사이즈 attach
  termConnect();
  termObj.onData((d)=>{ if(termWS && termWS.readyState===1) termWS.send(JSON.stringify({t:'i',d})); });
  termResizeObs = new ResizeObserver(()=>{
    if (!fitAddon || !termObj) return;
    fitAddon.fit();
    if (termWS && termWS.readyState===1) termWS.send(JSON.stringify({t:'r',cols:termObj.cols,rows:termObj.rows}));
  });
  termResizeObs.observe(el);
}
function closeTerm(){
  termClosing = true; termRunId = null;
  if (termRetryTimer){ clearTimeout(termRetryTimer); termRetryTimer=null; }
  $('termOverlay').classList.remove('open');
  if (termResizeObs){ termResizeObs.disconnect(); termResizeObs=null; }
  if (termWS){ try{ termWS.close(); }catch{} termWS=null; }
  if (termObj){ try{ termObj.dispose(); }catch{} termObj=null; fitAddon=null; }
}
/* 모바일 입력바 — 조합 완료된 텍스트를 통째로 PTY 에 (IME-안전 경로) */
function termSendRaw(d){ if (termWS && termWS.readyState===1) termWS.send(JSON.stringify({t:'i', d})); }
function termSendLine(){
  const inp = $('termInput');
  const v = inp.value;
  if (!v) { termSendRaw('\\r'); return; }
  termSendRaw(v + '\\r');
  inp.value = '';
}
$('termSend').addEventListener('click', termSendLine);
$('termInput').addEventListener('keydown', (e)=>{
  if (e.isComposing) return;                 // 조합 중 Enter 는 IME 확정용 — 보내지 않음
  if (e.key === 'Enter'){ e.preventDefault(); termSendLine(); }
});
const TKEYS = { esc:'\\x1b', tab:'\\t', cc:'\\x03', up:'\\x1b[A', down:'\\x1b[B' };
document.querySelectorAll('#termIbar .tkey').forEach(b=>{
  b.addEventListener('click', ()=>{ const k=TKEYS[b.dataset.k]; if(k) termSendRaw(k); });
});
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
  const path = $('repoPath').value.trim();
  const body = { machineSlug: $('repoMachine').value, path };
  if (!path) return;
  const res = await fetch('/api/repos',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  if (res.ok){ $('repoPath').value=''; toast('repo registered', 'ok'); await hydrate(); return; }
  const j = await res.json().catch(()=>({}));
  if (res.status === 400 && j.code === 'NO_COMMITS'){
    const yes = await confirmUI('This folder has no commits yet — start a new project here?',
      { sub: 'coxpit will create an empty initial commit as the base, then register the repo. The folder itself is untouched.', okLabel: 'Start new project' });
    if (yes && await createNewProject(path)) $('repoPath').value='';
    return;
  }
  toast('repo: '+(j.detail||j.error||res.status), 'error');
});
$('taskForm').addEventListener('submit', async (e)=>{
  e.preventDefault();
  setDrawer(false); // 모바일: 발사하면 드로어를 닫고 플릿을 보여준다
  if (lTab === 'goal') return submitGoal();
  if (lTab === 'bench') return submitBench();
  const repoId = Number($('taskRepo').value);
  const title = $('taskTitle').value.trim();
  if (!repoId || !title){ toast(!repoId?'register a repo first':'task title required', 'error'); return; }
  const capId = Number($('taskCapture').value) || undefined;
  const outputs = selectedOutputs();
  const t = await fetch('/api/tasks',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({repoId,title,prompt:$('taskPrompt').value,designCaptureId:capId,outputs})}).then(x=>x.json());
  if (!t.ok){ toast('task create failed', 'error'); return; }
  tasks.set(t.task.id, t.task);
  const model = $('taskModel').value.trim();
  await fetch('/api/tasks/'+t.task.id+'/run',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({count:Number($('taskCount').value)||1, real: $('taskReal').checked, agent: selAgent, model})});
  if (model) rememberModel(model);
  $('taskTitle').value=''; $('taskPrompt').value=''; clearOutputs();
});
/* ── deliverable 계약 칩 — 선택된 타입 배열을 tasks.outputs 로 보낸다(기본=빈=오늘의 동작) ── */
const OUTPUT_ORDER = ['answer','code','doc','page','file'];
function selectedOutputs(){
  const on = new Set(Array.from(document.querySelectorAll('#taskOutputs .ochip.on')).map(b=>b.dataset.out));
  return OUTPUT_ORDER.filter(t=>on.has(t));
}
function clearOutputs(){ document.querySelectorAll('#taskOutputs .ochip.on').forEach(b=>b.classList.remove('on')); }
document.querySelectorAll('#taskOutputs .ochip').forEach(b=>{
  b.addEventListener('click', ()=>{
    const on = b.classList.toggle('on');
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
});

/* ── model 최근값 기억(기기별, 최대 5) ── */
function rememberModel(m){
  try{
    const h = JSON.parse(localStorage.getItem('coxpit.models')||'[]');
    localStorage.setItem('coxpit.models', JSON.stringify([m, ...h.filter(x=>x!==m)].slice(0,5)));
  }catch{}
  paintModelHist();
}
function paintModelHist(){
  let h = [];
  try{ h = JSON.parse(localStorage.getItem('coxpit.models')||'[]'); }catch{}
  $('modelHist').innerHTML = h.map(m=>'<option value="'+escA(m)+'"></option>').join('');
}
paintModelHist();

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

/* ── provider segmented control — Task 탭 전용(Goal 플래너·Workbench 는 무관) ── */
let selAgent = 'claude-code';
const provOpts = Array.from(document.querySelectorAll('#provSeg .seg-opt'));
function setProvider(id, persist){
  selAgent = id;
  for (const b of provOpts){
    const on = b.dataset.agent === id;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  if (persist) try { localStorage.setItem('coxpit.agent', id); } catch {}
}
for (const b of provOpts) b.addEventListener('click', ()=>setProvider(b.dataset.agent, true));
let savedAgent = null;
try { savedAgent = localStorage.getItem('coxpit.agent'); } catch {}
if (savedAgent === 'codex') setProvider('codex', false);

/* ── GitHub 이슈/PR → 태스크 초안 ── */
$('ghImport').addEventListener('click', ()=>{ $('ghUrl').value=''; $('ghOverlay').classList.add('open'); $('ghUrl').focus(); });
$('ghCancel').addEventListener('click', ()=>$('ghOverlay').classList.remove('open'));
$('ghOverlay').addEventListener('click',(e)=>{ if(e.target===$('ghOverlay')) $('ghOverlay').classList.remove('open'); });
async function ghFetch(){
  const url = $('ghUrl').value.trim();
  if (!url) return;
  $('ghOk').disabled = true; $('ghOk').textContent = 'Fetching…';
  try{
    const res = await fetch('/api/tasks/from-github',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url})});
    const j = await res.json().catch(()=>({}));
    if (!res.ok){ toast('github: '+(j.error||res.status), 'error'); return; }
    $('taskTitle').value = j.title; $('taskPrompt').value = j.prompt;
    $('ghOverlay').classList.remove('open');
    toast('drafted from GitHub — review, then Run fleet', 'ok');
  } finally { $('ghOk').disabled = false; $('ghOk').textContent = 'Fetch'; }
}
$('ghOk').addEventListener('click', ghFetch);
$('ghUrl').addEventListener('keydown',(e)=>{ if(e.key==='Enter') ghFetch(); });

/* ── greenfield — start a new project (empty folder in, scaffolded repo out) ── */
// POST /api/repos/new; 성공 시 hydrate 후 새 repo 를 자동 선택하고 toast.
async function createNewProject(path, name){
  const body = { machineSlug: $('repoMachine').value, path };
  if (name) body.name = name;
  const res = await fetch('/api/repos/new',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const j = await res.json().catch(()=>({}));
  if (!res.ok){ toast(j.error||('new project: '+res.status), 'error'); return false; }
  await hydrate();
  if (j.repo){
    $('taskRepo').value = String(j.repo.id);
    syncSelect('taskRepo');
  }
  toast('project ready — write a scaffold task and Run fleet', 'ok');
  return true;
}
$('repoNew').addEventListener('click', ()=>{
  const m = machines.find(x=>x.slug===$('repoMachine').value);
  $('npPath').value = ''; $('npName').value = '';
  $('npOverlay').classList.add('open'); $('npPath').focus();
});
$('npCancel').addEventListener('click', ()=>$('npOverlay').classList.remove('open'));
$('npOverlay').addEventListener('click',(e)=>{ if(e.target===$('npOverlay')) $('npOverlay').classList.remove('open'); });
async function npStart(){
  const path = $('npPath').value.trim();
  if (!path){ toast('enter an absolute project path', 'error'); return; }
  $('npOk').disabled = true; $('npOk').textContent = 'Starting…';
  try{
    const ok = await createNewProject(path, $('npName').value.trim());
    if (ok) $('npOverlay').classList.remove('open');
  } finally { $('npOk').disabled = false; $('npOk').textContent = 'Start new project'; }
}
$('npOk').addEventListener('click', npStart);
$('npPath').addEventListener('keydown',(e)=>{ if(e.key==='Enter') npStart(); });
$('npName').addEventListener('keydown',(e)=>{ if(e.key==='Enter') npStart(); });

/* ── 읽기 전용 공유 링크 ── */
$('mShare').addEventListener('click', async ()=>{
  if (openRunId==null) return;
  const res = await fetch('/api/runs/'+openRunId+'/share',{method:'POST'});
  const j = await res.json().catch(()=>({}));
  if (!res.ok){ toast('share: '+(j.error||res.status), 'error'); return; }
  const url = location.origin + j.url;
  let copied = false;
  try{ await navigator.clipboard.writeText(url); copied = true; }catch{}
  toast((j.existing?'share link (existing)':'share link created')+(copied?' — copied':'')+': '+url, 'ok');
});

/* ── remote access (v4.5) — detect Tailscale, drive Serve/Funnel, or hand a recipe.
   coxpit never hosts a relay: it detects and drives the user's own tool. ── */
let remoteData = null, remoteBusy = false;

// clipboard write with a synchronous execCommand fallback (clipboard API alone is
// unreliable outside secure/focused contexts — mirrors the terminal copy helper).
function copyText(text){
  let ok = false;
  try{ if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); ok = true; } }catch{}
  try{
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly',''); ta.style.position='fixed'; ta.style.top='-1000px';
    document.body.appendChild(ta); ta.select();
    if (document.execCommand('copy')) ok = true;
    document.body.removeChild(ta);
  }catch{}
  return ok;
}

// recipe text with the daemon's REAL port interpolated (guidance, not magic).
function cfRecipe(){
  return 'cloudflared tunnel --url http://localhost:'+daemonPort+'\\n'
    + '# or a named tunnel + Cloudflare Access policy (recommended — exposes shells)';
}
function caddyRecipe(){
  return 'coxpit.example.com {\\n  reverse_proxy 127.0.0.1:'+daemonPort+'\\n}';
}
function urlTableHTML(){
  const rows = [
    ['local', 'http://127.0.0.1:'+daemonPort, 'same machine'],
    ['LAN', 'http://192.168.x.y:'+daemonPort, 'home network'],
    ['Tailscale IP', 'http://100.x.y.z:'+daemonPort, 'your tailnet'],
    ['MagicDNS', 'http://&lt;machine&gt;.&lt;tailnet&gt;.ts.net:'+daemonPort, 'your tailnet'],
    ['Serve ⭐', 'https://&lt;machine&gt;.&lt;tailnet&gt;.ts.net', 'your tailnet · HTTPS'],
    ['Funnel', 'https://&lt;machine&gt;.&lt;tailnet&gt;.ts.net', 'public internet'],
    ['Cloudflare', 'https://coxpit.yourdomain.com', 'public (+ CF Access)'],
    ['reverse proxy', 'https://coxpit.yourdomain.com', 'public'],
  ];
  let body = '';
  for (const row of rows){
    const star = row[0].indexOf('⭐') >= 0 ? ' class="star"' : '';
    body += '<tr'+star+'><td>'+esc(row[0])+'</td><td><code>'+row[1]+'</code></td><td>'+esc(row[2])+'</td></tr>';
  }
  return '<table class="rmt-tbl"><tr><th>method</th><th>url shape</th><th>who reaches it</th></tr>'+body+'</table>'
    + '<div class="rmt-cap">coxpit hands you a <code style="color:var(--brand)">*.ts.net</code> name in one click; a <b>custom</b> domain stays a Cloudflare/proxy recipe.</div>';
}
function recipesHTML(){
  return '<details class="rmt-more"><summary>Recipes — Cloudflare Tunnel &amp; reverse proxy</summary>'
    + '<pre>'+esc(cfRecipe())+'</pre>'
    + '<div class="rmt-cap">public = shells exposed; keep coxpit auth on.</div>'
    + '<pre>'+esc(caddyRecipe())+'</pre>'
    + '<div class="rmt-cap">public = shells exposed; keep coxpit auth on.</div>'
    + '</details>';
}

// authOpen: no password set → Funnel would expose shells to the internet.
function remoteCardHTML(rd){
  if (!rd) return '<div class="rmt-line">checking Tailscale…</div>' + recipesHTML();
  const authOpen = !!rd.authOpen;
  let h = '';
  if (rd.tailscale === 'missing'){
    h += '<div class="rmt-line">Install Tailscale to reach this daemon by name from your other devices — or use a reverse-proxy recipe below. '
      + '<a href="https://tailscale.com/download" target="_blank" rel="noopener" style="color:var(--brand)">tailscale.com/download</a></div>';
  } else if (rd.tailscale === 'stopped'){
    h += '<div class="rmt-line">Tailscale is installed but not running. Start it, then <a href="#" id="rmtRefresh" style="color:var(--brand)">refresh</a>.</div>';
  } else {
    // running
    h += '<div class="rmt-line">This machine on your tailnet: <span class="rmt-name">'+esc(rd.dnsName||'')+'</span></div>';
    const serveUrl = 'https://'+(rd.dnsName||'');
    // Serve row (safe default)
    h += '<div class="rmt-row"><div class="rmt-l"><div class="rmt-t">Serve</div>'
      + '<div class="rmt-d">your tailnet only · HTTPS · no port</div></div>'
      + '<div class="tgl'+(rd.serve?' on':'')+'" id="rmtServe" role="switch" aria-checked="'+(rd.serve?'true':'false')+'"></div></div>';
    if (rd.serve){
      h += '<div class="rmt-url"><code>'+esc(serveUrl)+'</code>'
        + '<button class="rmt-cp" data-copy="'+escA(serveUrl)+'">Copy</button></div>';
    }
    // Funnel row (risky)
    h += '<div class="rmt-row risky"><div class="rmt-l"><div class="rmt-t">Funnel · Public internet</div>'
      + '<div class="rmt-d">'+(authOpen?'set COXPIT_AUTH_PASS first — Funnel exposes shells':'anyone with the URL can reach this — auth is your only gate')+'</div></div>'
      + '<div class="tgl risky'+(rd.funnel?' on':'')+'" id="rmtFunnel" role="switch" aria-checked="'+(rd.funnel?'true':'false')+'"'+(authOpen?' aria-disabled="true"':'')+'></div></div>';
    if (rd.funnel){
      h += '<div class="rmt-url"><code>'+esc(serveUrl)+'</code>'
        + '<button class="rmt-cp" data-copy="'+escA(serveUrl)+'">Copy</button></div>';
      h += '<div class="rmt-warn">anyone with the URL can reach this — auth is your only gate.</div>';
    }
  }
  h += recipesHTML();
  h += '<details class="rmt-more"><summary>how URLs differ</summary>'+urlTableHTML()+'</details>';
  return h;
}

async function loadRemote(){
  // /api/remote stays a pure RemoteState; the auth-open flag comes from /api/fleet
  // (remoteAuthOpen) so the Funnel toggle can disable itself before any POST.
  try{
    const rd = await fetch('/api/remote').then(x=>x.json());
    remoteData = rd; remoteData.authOpen = remoteAuthOpen;
    paintRemote();
  }catch{ remoteData = { tailscale:'missing', serve:false, funnel:false, authOpen: remoteAuthOpen }; paintRemote(); }
}

function paintRemote(){
  const html = remoteCardHTML(remoteData);
  const ov = $('remoteBody'); if (ov) ov.innerHTML = html;
  const ob = $('rmtOnboard'); if (ob) ob.innerHTML = html;
  wireRemote($('remoteOverlay'));
  wireRemote(document.getElementById('empty'));
}

function wireRemote(scope){
  if (!scope) return;
  scope.querySelectorAll('[data-copy]').forEach(b=>{
    if (b.dataset.wired) return; b.dataset.wired='1';
    b.addEventListener('click', ()=>{
      const ok = copyText(b.getAttribute('data-copy')||'');
      toast(ok?'URL copied':'copy failed — select it manually', ok?'ok':'error');
    });
  });
  const rf = scope.querySelector('#rmtRefresh');
  if (rf && !rf.dataset.wired){ rf.dataset.wired='1'; rf.addEventListener('click',(e)=>{ e.preventDefault(); loadRemote(); }); }
  const sv = scope.querySelector('#rmtServe');
  if (sv && !sv.dataset.wired){ sv.dataset.wired='1'; sv.addEventListener('click', ()=>toggleRemote('serve', !(remoteData&&remoteData.serve))); }
  const fn = scope.querySelector('#rmtFunnel');
  if (fn && !fn.dataset.wired){ fn.dataset.wired='1'; fn.addEventListener('click', ()=>{
    if (fn.getAttribute('aria-disabled')==='true'){ toast('set COXPIT_AUTH_PASS first — Funnel exposes shells', 'error'); return; }
    toggleRemote('funnel', !(remoteData&&remoteData.funnel));
  }); }
}

async function toggleRemote(which, on){
  if (remoteBusy) return; remoteBusy = true;
  try{
    const res = await fetch('/api/remote/'+which,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({on})});
    const j = await res.json().catch(()=>({}));
    if (!res.ok){
      if (j.code==='NO_AUTH'){ remoteAuthOpen = true; if (remoteData) remoteData.authOpen = true; paintRemote(); toast('set COXPIT_AUTH_PASS first — Funnel exposes shells', 'error'); }
      else toast(which+': '+(j.error||res.status), 'error');
      return;
    }
    remoteData = j; remoteData.authOpen = remoteAuthOpen;
    paintRemote();
    toast(which+(on?' on':' off'), 'ok');
  } finally { remoteBusy = false; }
}

$('remoteBtn').addEventListener('click', ()=>{ $('remoteOverlay').classList.add('open'); loadRemote(); });
$('remoteClose').addEventListener('click', ()=>$('remoteOverlay').classList.remove('open'));
$('remoteOverlay').addEventListener('click',(e)=>{ if(e.target===$('remoteOverlay')) $('remoteOverlay').classList.remove('open'); });

/* ── mobile drawer ── */
const asideEl = document.querySelector('aside');
function setDrawer(on){ asideEl.classList.toggle('open', on); $('scrim').classList.toggle('on', on); }
$('menuBtn').addEventListener('click', ()=>setDrawer(!asideEl.classList.contains('open')));
$('scrim').addEventListener('click', ()=>setDrawer(false));

/* 딥링크 — /?run=N 이면 하이드레이션 후 그 run 모달을 연다 (웹훅 링크·알림용) */
function openFromURL(){
  const q = new URLSearchParams(location.search).get('run');
  const id = Number(q);
  if (q && runs.has(id)){ openModal(id); }
  if (q) history.replaceState(null, '', location.pathname);
}

hydrate().then(()=>{ connectWS(); openFromURL(); });
</script>
</body>
</html>`;
