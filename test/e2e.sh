#!/usr/bin/env bash
# Coxpit E2E — boots the daemon against a throwaway repo and exercises the full
# dry-run pipeline: registry, fleet run, events, diff, compare, merge (+guards),
# stop semantics, task close, design capture -> prompt injection, auth gate.
# No credits spent (dry-run agent). Exits non-zero on first failure.
set -euo pipefail

# coxpit 터미널(tmux) 안에서 e2e 를 돌려도 테스트 데몬의 tmux 가 그 소켓을 상속해
# 실데몬 세션을 건드리지 않도록 — 항상 기본 서버를 쓴다.
unset TMUX

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${COXPIT_TEST_PORT:-8261}"
B="http://127.0.0.1:$PORT"
WORK="$(mktemp -d)"
REPO="$WORK/repo"
DB="$WORK/coxpit.db"
PASS_COUNT=0

fail(){ echo "FAIL: $*" >&2; exit 1; }
pass(){ PASS_COUNT=$((PASS_COUNT+1)); echo "ok $PASS_COUNT - $*"; }
# bash 3.2(macOS) nested-quote bug workaround: always capture into a var first.
expect_code(){
  local want="$1"; shift
  local got
  got=$(curl -s -o /dev/null -w '%{http_code}' "$@")
  [ "$got" = "$want" ] || fail "expected HTTP $want, got $got ($*)"
}
cleanup(){
  [ -n "${DPID:-}" ] && kill "$DPID" 2>/dev/null || true
  [ -n "${HPID:-}" ] && kill "$HPID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# throwaway git repo — 사이드 브랜치에 체크아웃해 defaultBranch 감지를 시험
mkdir -p "$REPO"
git -C "$REPO" init -q -b main
printf 'hello\n' > "$REPO/README.md"
git -C "$REPO" add -A
git -C "$REPO" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q -m init
git -C "$REPO" checkout -q -b wip-side-branch

# settle 웹훅 수신용 미니 리스너
HOOKPORT=$((PORT+1))
node -e 'require("http").createServer((q,s)=>{let b="";q.on("data",d=>b+=d);q.on("end",()=>{require("fs").appendFileSync(process.argv[1],b+"\n");s.end("ok")})}).listen(process.argv[2])' "$WORK/hooks.log" "$HOOKPORT" &
HPID=$!

# boot daemon (dry-run agent, auth off, 웹훅 연결)
COXPIT_AUTH_DISABLED=1 COXPIT_DB="$DB" COXPIT_PORT="$PORT" COXPIT_WEBHOOK_URL="http://127.0.0.1:$HOOKPORT/" \
  COXPIT_PUBLIC_URL="http://board.example:9999/" \
  node --import tsx "$ROOT/src/index.ts" >"$WORK/daemon.log" 2>&1 &
DPID=$!
for i in $(seq 1 40); do curl -sf "$B/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "$B/api/health" | grep -q '"ok":true' || fail "daemon did not boot: $(tail -5 "$WORK/daemon.log")"
pass "daemon boots, health ok"

# (보드가 커서 grep -q 조기종료→SIGPIPE→pipefail 오탐 — 파이프 없이 패턴 매칭)
BOARD_HTML=$(curl -s "$B/")
case "$BOARD_HTML" in *'<title>coxpit'*) : ;; *) fail "board not served";; esac
case "$BOARD_HTML" in *'id="menuBtn"'*) : ;; *) fail "mobile drawer button missing";; esac
case "$BOARD_HTML" in *'openFromURL'*) : ;; *) fail "deep-link handler missing";; esac
case "$BOARD_HTML" in *'dl-line'*) : ;; *) fail "clickable diff lines missing";; esac
case "$BOARD_HTML" in *'id="termIbar"'*) : ;; *) fail "terminal input bar missing";; esac
case "$BOARD_HTML" in *'id="taskModel"'*) : ;; *) fail "model input missing";; esac
case "$BOARD_HTML" in *'id="repoBranch"'*) : ;; *) fail "base branch button missing";; esac
case "$BOARD_HTML" in *'card.closed .log::before'*) : ;; *) fail "closed-card hatching missing";; esac
case "$BOARD_HTML" in *'gband-h'*) : ;; *) fail "group band markup missing";; esac
case "$BOARD_HTML" in *'attemptHTML'*) : ;; *) fail "attempt counter missing";; esac
case "$BOARD_HTML" in *'arch-row'*) : ;; *) fail "archive row styles missing";; esac
pass "board served (v4.1..v4.3 UI assets present)"

# v5.2 — brand: logo lockup (mark + Pixelify wordmark), mascot in empty state, favicon/font wiring
case "$BOARD_HTML" in *'/brand/mark.png'*) : ;; *) fail "board nav mark image missing";; esac
case "$BOARD_HTML" in *"font-family:'Pixelify'"*) : ;; *) fail "Pixelify @font-face missing";; esac
case "$BOARD_HTML" in *'/brand/sleep.png'*) : ;; *) fail "empty-state mascot missing";; esac
expect_code 200 "$B/brand/mark.png"
expect_code 200 "$B/brand/sleep.png"
expect_code 200 "$B/brand/wave.png"
expect_code 200 "$B/brand/pixelify.woff2"
expect_code 200 "$B/brand/favicon.ico"
expect_code 200 "$B/favicon.ico"
expect_code 404 "$B/brand/nope.png"
BRAND_CT=$(curl -s -o /dev/null -w '%{content_type}' "$B/brand/pixelify.woff2")
case "$BRAND_CT" in font/woff2*) : ;; *) fail "woff2 content-type wrong ($BRAND_CT)";; esac
pass "v5.2 brand assets served (mark · mascot · font · favicon)"

# v5.2.1 — Add-repository opens ONLY the folder browser (no stray New-task sheet);
# every close-X has a base style so no overlay renders a native white button.
case "$BOARD_HTML" in *"function openRepoBrowse"*) : ;; *) fail "openRepoBrowse helper missing";; esac
case "$BOARD_HTML" in *"repoAdd').addEventListener('click', openRepoBrowse"*) : ;; *) fail "Add-repository must open the browser directly (not the New sheet)";; esac
case "$BOARD_HTML" in *"button.x{"*) : ;; *) fail "close-X base style missing (white-button guard)";; esac
pass "v5.2.1 repo-add opens browser only · close-X base style present"

# v5.3 — Settings view (board) + settings API
case "$BOARD_HTML" in *'data-view="settings"'*) : ;; *) fail "Settings nav entry missing";; esac
case "$BOARD_HTML" in *'id="setbox"'*) : ;; *) fail "Settings view container missing";; esac
case "$BOARD_HTML" in *"function renderSettings"*) : ;; *) fail "renderSettings missing";; esac
# Remote access moved out of onboarding into Settings
case "$BOARD_HTML" in *'rmtSettings'*) : ;; *) fail "Settings remote-access container missing";; esac
case "$BOARD_HTML" in *'rmtOnboard'*) fail "remote access should be removed from onboarding (rmtOnboard present)";; *) : ;; esac
# Phase 0 — Cockpit scaffold (terminal-first shell, parallel dev at /cockpit)
expect_code 200 "$B/cockpit"
CKPT=$(curl -s "$B/cockpit")
case "$CKPT" in *'coxpit · cockpit'*'workspace'*) : ;; *) fail "cockpit shell title missing";; esac
case "$CKPT" in *'class="toggle" href="/"'*) : ;; *) fail "cockpit → board toggle missing";; esac
case "$CKPT" in *'id="menuBtn"'*'id="termIbar"'*'function isMobile'*) : ;; *) fail "cockpit mobile support (drawer + IME input bar) missing";; esac
case "$BOARD_HTML" in *'href="/cockpit"'*) : ;; *) fail "board Cockpit-preview link missing";; esac
pass "Phase 0 cockpit scaffold served + board toggle (parallel, non-breaking)"

# Phase 2 — workspace tree + pane-grid terminal (xterm via /vendor + /api/fleet + /ws/term)
case "$CKPT" in *'/vendor/xterm.js'*'/vendor/addon-fit.js'*'/vendor/addon-unicode11.js'*) : ;; *) fail "cockpit xterm vendor scripts missing";; esac
case "$CKPT" in *'function renderTree'*'function openRunPane'*) : ;; *) fail "cockpit tree/pane logic missing";; esac
case "$CKPT" in *'/api/fleet?view=all'*'/ws/term/'*) : ;; *) fail "cockpit fleet/term wiring missing";; esac
pass "Phase 2 cockpit workspace tree + pane-grid terminal (xterm attach, auto-tile)"

# Phase 3 — request bar (New fan-out / Steer / Broadcast) + Review tab (compare/merge)
case "$CKPT" in *'data-mode="new"'*'data-mode="steer"'*'data-mode="bcast"'*) : ;; *) fail "cockpit request-bar modes missing";; esac
case "$CKPT" in *'function submitReq'*"'/api/tasks'"*"/run'"*) : ;; *) fail "cockpit fan-out wiring missing";; esac
case "$CKPT" in *"/steer'"*"{t:'i',d:payload}"*) : ;; *) fail "cockpit steer/broadcast wiring missing";; esac
case "$CKPT" in *'function loadCompare'*'/compare'*"/merge'"*) : ;; *) fail "cockpit Review compare/merge missing";; esac
pass "Phase 3 cockpit request bar (fan-out/steer/broadcast) + Review compare/merge"

# Phase 4 — verify in-loop UI (badge/green-gate + cmd editor). backend test is late (needs a fresh repo).
case "$CKPT" in *"'✓ verify'"*'function vbadge'*'merge anyway'*) : ;; *) fail "cockpit verify badge / green-gate missing";; esac
case "$CKPT" in *'id="rvVcmd"'*"/verify'"*'function saveVcmd'*) : ;; *) fail "cockpit verify cmd editor missing";; esac
pass "Phase 4 cockpit verify badge + green-gate + verifyCmd editor (UI)"

# Free session (workbench) opener + empty-state fix (panes hidden until a pane exists — no grey ghost box)
case "$CKPT" in *'id="sessionBtn"'*'id="sessionCta"'*'function openSession'*) : ;; *) fail "cockpit free-session opener missing";; esac
case "$CKPT" in *'id="pickModal"'*'function browseTo'*'/api/browse'*"/api/session'"*) : ;; *) fail "cockpit folder picker / session wiring missing";; esac
case "$CKPT" in *"kind!=='sessions'"*'>Sessions<'*) : ;; *) fail "cockpit sessions tree section / project split missing";; esac
case "$CKPT" in *'.panes{flex:1;display:none'*) : ;; *) fail "cockpit empty panes should default to display:none (grey-box fix)";; esac
pass "cockpit free session (workbench) opener + empty-state grey-box fix"

# Tabs + split-tree panes: open=tab, manual split, drag tab→slot, fan-out auto-tiles, rename
case "$CKPT" in *'id="tabs"'*'id="splitRow"'*'function buildNode'*'function splitFocused'*) : ;; *) fail "cockpit tab bar / split-tree missing";; esac
case "$CKPT" in *'function tileTabs'*'tileTabs(ids)'*) : ;; *) fail "cockpit fan-out should auto-tile into tabs (tileTabs)";; esac
case "$CKPT" in *'function startRename'*'function renameTask'*"'/api/tasks/'"*) : ;; *) fail "cockpit tab rename wiring missing";; esac
case "$CKPT" in *'id="pickName"'*'title:nm'*) : ;; *) fail "cockpit session-name input missing";; esac
pass "cockpit tabs + split-tree panes + session naming/rename"

# Phase 5 — desktop app default entry flips to /cockpit (web `/` stays board; mobile self-redirects)
DMAIN=$(cat "$ROOT/desktop/main.cjs" 2>/dev/null || cat desktop/main.cjs)
case "$DMAIN" in *"ENTRY_PATH = process.env.COXPIT_ENTRY || '/cockpit'"*) : ;; *) fail "desktop ENTRY_PATH default not /cockpit";; esac
case "$DMAIN" in *"port + ENTRY_PATH"*"boardOrigin.port + ENTRY_PATH"*) : ;; *) fail "desktop loadURL not using ENTRY_PATH";; esac
# no window-content loadURL should still hardcode board '/'
case "$DMAIN" in *"loadURL('http://127.0.0.1:' + port + '/'"*) fail "desktop still loads board '/' as window entry";; *) : ;; esac
pass "Phase 5 desktop default entry = /cockpit (env-overridable, board still reachable in-app)"
# GET /api/settings shape + env locks (this suite boots with COXPIT_PORT/AUTH_DISABLED/WEBHOOK_URL set)
SET=$(curl -s "$B/api/settings")
case "$SET" in *'"effective"'*'"envLocked"'*'"auth"'*) : ;; *) fail "settings GET shape: $SET";; esac
case "$SET" in *'"port":true'*) : ;; *) fail "envLocked.port should be true (COXPIT_PORT set): $SET";; esac
# env-locked port is ignored by PATCH (no restart flag); an editable field (host) flags restartRequired
curl -s -X PATCH "$B/api/settings" -H 'content-type: application/json' -d '{"port":8299}' | grep -q '"restartRequired":false' || fail "env-locked port must be ignored (no restart flag)"
PR=$(curl -s -X PATCH "$B/api/settings" -H 'content-type: application/json' -d '{"host":"127.0.0.1"}')
case "$PR" in *'"restartRequired":true'*) : ;; *) fail "host change should flag restartRequired: $PR";; esac
# PATCH persists an agent default (count)
curl -sf -X PATCH "$B/api/settings" -H 'content-type: application/json' -d '{"agent":{"count":3}}' | grep -q '"ok":true' || fail "settings PATCH (agent.count)"
curl -s "$B/api/settings" | grep -q '"count":3' || fail "settings PATCH did not persist count"
# key management refused under env auth control (COXPIT_AUTH_DISABLED here) → 409
expect_code 409 -X POST "$B/api/settings/key" -H 'content-type: application/json' -d '{"key":"abcdef"}'
expect_code 409 -X DELETE "$B/api/settings/key"
pass "v5.3 settings view + API (GET shape · env-lock respected · PATCH persists · key env-guard)"

# v5.0 Part A — navigator rail (machine switcher · repo list · view nav · New)
case "$BOARD_HTML" in *'id="repoList"'*) : ;; *) fail "rail repo list (#repoList) missing";; esac
case "$BOARD_HTML" in *'id="viewNav"'*) : ;; *) fail "rail view nav (#viewNav) missing";; esac
case "$BOARD_HTML" in *'id="newBtn"'*) : ;; *) fail "rail New button (#newBtn) missing";; esac
case "$BOARD_HTML" in *'class="machine"'*) : ;; *) fail "rail machine switcher (.machine) missing";; esac
case "$BOARD_HTML" in *'data-view="active"'*) : ;; *) fail "view nav Active entry missing";; esac
case "$BOARD_HTML" in *'data-view="goals"'*) : ;; *) fail "view nav Goals entry missing";; esac
case "$BOARD_HTML" in *'data-view="archive"'*) : ;; *) fail "view nav Archive entry missing";; esac
case "$BOARD_HTML" in *'id="repoAdd"'*) : ;; *) fail "rail Add-repository button (#repoAdd) missing";; esac
case "$BOARD_HTML" in *'function renderRail'*) : ;; *) fail "rail render (renderRail) missing";; esac
case "$BOARD_HTML" in *'function setScope'*) : ;; *) fail "repo scoping (setScope) missing";; esac
# view nav moved OUT of the header — the old #viewSeg must be gone
case "$BOARD_HTML" in *'id="viewSeg"'*) fail "old header view seg (#viewSeg) still present — should move to #viewNav";; *) : ;; esac
pass "board serves v5.0 navigator rail (#repoList + #viewNav Active/Goals/Archive + #newBtn + .machine; #viewSeg gone)"

# v5.0 — dark-control contract: no native browser chrome leaking white (selects/model/count/mode seg)
# selects route through the custom .dd dropdown (state-holder pattern) — dressSelect + hidden holders present
case "$BOARD_HTML" in *'function dressSelect'*) : ;; *) fail "custom dropdown (dressSelect) missing";; esac
case "$BOARD_HTML" in *"['repoMachine','taskRepo','taskCapture']"*) : ;; *) fail "sheet selects not dressed through .dd";; esac
# any bare <select> also strips the OS arrow (appearance:none) so no white native chrome
case "$BOARD_HTML" in *'select{appearance:none'*) : ;; *) fail "bare select appearance:none guard missing";; esac
# model field is a custom combo, NOT a native datalist popup
case "$BOARD_HTML" in *'id="modelCombo"'*) : ;; *) fail "model combo (custom recent-models menu) missing";; esac
case "$BOARD_HTML" in *'<datalist'*) fail "native datalist still present — should be a .dd-style menu";; *) : ;; esac
case "$BOARD_HTML" in *'id="taskModel"'*'list='*) fail "taskModel still bound to a native list= datalist";; *) : ;; esac
# count has a token stepper and the native number spinner is suppressed
case "$BOARD_HTML" in *'id="taskCountStep"'*) : ;; *) fail "count stepper wrapper missing";; esac
case "$BOARD_HTML" in *'id="cntUp"'*) : ;; *) fail "count + stepper button missing";; esac
case "$BOARD_HTML" in *'id="cntDown"'*) : ;; *) fail "count - stepper button missing";; esac
case "$BOARD_HTML" in *'webkit-inner-spin-button'*) : ;; *) fail "native number spinner not suppressed";; esac
# agent mode is a compact switch toggle (role=switch), not a boxy two-option seg
case "$BOARD_HTML" in *'id="modeSeg" class="realtog" role="switch"'*) : ;; *) fail "agent mode toggle (realtog switch) missing";; esac
case "$BOARD_HTML" in *'.realtog[aria-checked="true"] .realtog-knob::after{transform'*) : ;; *) fail "realtog knob does not slide on real mode";; esac
# type/provider segs stay slim single-row (never the boxy flex-direction:column stack)
case "$BOARD_HTML" in *'.seg-opt{flex:1;display:inline-flex;flex-direction:row'*) : ;; *) fail "type/provider seg still boxy (.seg-opt not a single row)";; esac
# rail repo rows render as role=button divs so nested action buttons stay valid HTML (not hoisted → white)
case "$BOARD_HTML" in *'role="button" tabindex="0" data-repo='*) : ;; *) fail "repo rows not role=button divs (nested action buttons would hoist)";; esac
# rail repo-row actions are icon-ghost (transparent), never white buttons
case "$BOARD_HTML" in *'#repoList .repo .rmbtn{background:transparent'*) : ;; *) fail "rail repo-row buttons not icon-ghost";; esac
# v5.1 A2 — settled-but-no-op runs get a distinct chip (not silently 'done')
case "$BOARD_HTML" in *'.chip.noop{'*) : ;; *) fail "no-op run chip styling missing";; esac
case "$BOARD_HTML" in *"r.noopReason==='blocked'"*) : ;; *) fail "cardHTML no-op/blocked branch missing";; esac
# v5.1 A3 — group sibling-overlap affordance + endpoint
case "$BOARD_HTML" in *'data-goverlap='*) : ;; *) fail "group overlap button missing";; esac
OV=$(curl -s -o /dev/null -w "%{http_code}" "$B/api/groups/999999/overlap")
case "$OV" in 200) : ;; *) fail "overlap endpoint not 200 for unknown group (got $OV)";; esac
# v5.1 step 2 — land-target/drift endpoint + decision-point drift warning
LT=$(curl -s "$B/api/runs/999999/land-target")
case "$LT" in *'"target"'*) : ;; *) fail "land-target endpoint shape missing (got $LT)";; esac
case "$BOARD_HTML" in *'function driftNote'*) : ;; *) fail "drift warning wiring missing";; esac
# v5.1 step 3 — conflict preview endpoint (merge-tree) shape
PV=$(curl -s "$B/api/runs/999999/merge/preview")
case "$PV" in *'"conflicts"'*'"clean"'*|*'"clean"'*'"conflicts"'*) : ;; *) fail "merge preview endpoint shape missing (got $PV)";; esac
# v5.1 step 4 — origin-aware land: product branch naming + step-5 conflict path wired
case "$BOARD_HTML" in *'coxpit/<task>-r'*) : ;; *) fail "product PR branch naming copy missing";; esac
# v5.1 step 5 — in-app conflict resolution loop (agent edits markers, coxpit lands)
case "$BOARD_HTML" in *'/land/resolve'*) : ;; *) fail "land/resolve wiring missing";; esac
RS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B/api/runs/999999/land/resolve")
case "$RS" in 404) : ;; *) fail "land/resolve endpoint missing (expected 404 for unknown run, got $RS)";; esac
# v5.1 Documents (문서함) — aggregate endpoint + rail nav view
DOCS=$(curl -s "$B/api/documents")
case "$DOCS" in *'"runs"'*) : ;; *) fail "documents endpoint shape missing (got $DOCS)";; esac
case "$BOARD_HTML" in *'data-view="documents"'*) : ;; *) fail "Documents nav view missing";; esac
case "$BOARD_HTML" in *'function renderDocbox'*) : ;; *) fail "docbox render wiring missing";; esac
pass "board serves dark-control contract (.dd selects · custom model menu · token stepper/no spinner · slim mode seg · icon-ghost rail actions)"

# v4.4 — greenfield launcher affordances present in the board (UI contract)
case "$BOARD_HTML" in *'id="npOverlay"'*) : ;; *) fail "greenfield new-project overlay missing";; esac
case "$BOARD_HTML" in *'id="repoNew"'*) : ;; *) fail "greenfield New button missing";; esac
pass "board serves greenfield New button + npOverlay"

# v4.5.1 — Browse-driven new project: create-folder control + form in the picker
case "$BOARD_HTML" in *'id="brwNewFolder"'*) : ;; *) fail "browse New-folder button missing";; esac
case "$BOARD_HTML" in *'id="brwNewForm"'*) : ;; *) fail "browse New-folder form missing";; esac
pass "board serves Browse new-folder controls"

# v4.5 — remote access card assets present (UI contract) + recipe port interpolation
case "$BOARD_HTML" in *'id="remoteOverlay"'*) : ;; *) fail "remote access overlay missing";; esac
case "$BOARD_HTML" in *'id="remoteBtn"'*) : ;; *) fail "remote access header button missing";; esac
case "$BOARD_HTML" in *'reverse_proxy 127.0.0.1:'*) : ;; *) fail "caddy recipe port interpolation missing";; esac
pass "board serves remote access card (#remoteOverlay + recipe port)"

# v4.7 P2 — run modal outputs cards + real viewers + request UI (UI contract)
case "$BOARD_HTML" in *'id="mContract"'*) : ;; *) fail "contract strip missing";; esac
case "$BOARD_HTML" in *'id="outCards"'*) : ;; *) fail "output cards container missing";; esac
case "$BOARD_HTML" in *'id="outDetail"'*) : ;; *) fail "output detail viewer missing";; esac
case "$BOARD_HTML" in *'id="outBack"'*) : ;; *) fail "output detail back link missing";; esac
case "$BOARD_HTML" in *'‹ Outputs'*) : ;; *) fail "output back label missing";; esac
case "$BOARD_HTML" in *'function openOutCard'*) : ;; *) fail "openOutCard viewer dispatch missing";; esac
case "$BOARD_HTML" in *'function pickDefaultCard'*) : ;; *) fail "default-card heuristic missing";; esac
case "$BOARD_HTML" in *'/outputs'*) : ;; *) fail "outputs fetch missing";; esac
case "$BOARD_HTML" in *'/file?path='*) : ;; *) fail "file preview src missing";; esac
case "$BOARD_HTML" in *'id="taskOutputs"'*) : ;; *) fail "task-compose deliverables selector missing";; esac
case "$BOARD_HTML" in *'function selectedOutputs'*) : ;; *) fail "selectedOutputs collector missing";; esac
case "$BOARD_HTML" in *'class="ochip" data-out="answer"'*) : ;; *) fail "deliverable chips missing";; esac
pass "board serves outputs cards + real viewers + request-side deliverables selector"

# v5.0 Part B — the New sheet (type-tabbed compose: Task | Goal | Workbench)
case "$BOARD_HTML" in *'id="newSheet"'*) : ;; *) fail "New sheet overlay (#newSheet) missing";; esac
case "$BOARD_HTML" in *'class="sheet"'*) : ;; *) fail "New sheet card (.sheet) missing";; esac
case "$BOARD_HTML" in *'id="sheetRepoLbl"'*) : ;; *) fail "sheet header repo label (#sheetRepoLbl) missing";; esac
case "$BOARD_HTML" in *'id="launchTabs"'*) : ;; *) fail "sheet type seg (#launchTabs) missing";; esac
case "$BOARD_HTML" in *'data-tab="task"'*) : ;; *) fail "type seg Task entry missing";; esac
case "$BOARD_HTML" in *'data-tab="goal"'*) : ;; *) fail "type seg Goal entry missing";; esac
case "$BOARD_HTML" in *'data-tab="bench"'*) : ;; *) fail "type seg Workbench entry missing";; esac
case "$BOARD_HTML" in *'function setV'*) : ;; *) fail "sheet type-switch (setV) missing";; esac
# footer adapts per type — Run fleet / Plan & run / Open workbench live in L_LABEL
case "$BOARD_HTML" in *"Plan & run"*) : ;; *) fail "Goal footer label (Plan & run) missing";; esac
case "$BOARD_HTML" in *'Open workbench'*) : ;; *) fail "Workbench footer label missing";; esac
# progressive Options reveal (rarely-used Task fields)
case "$BOARD_HTML" in *'id="taskOptToggle"'*) : ;; *) fail "Options reveal toggle (#taskOptToggle) missing";; esac
case "$BOARD_HTML" in *'id="taskOptBody"'*) : ;; *) fail "Options reveal body (#taskOptBody) missing";; esac
case "$BOARD_HTML" in *'function setTaskOpt'*) : ;; *) fail "Options reveal handler (setTaskOpt) missing";; esac
# the Phase-1 temporary overlay is retired
case "$BOARD_HTML" in *'id="launchOverlay"'*) fail "retired Phase-1 launch overlay (#launchOverlay) still present";; *) : ;; esac
pass "board serves v5.0 New sheet (#newSheet + Task/Goal/Workbench type seg + adapting footer + Options reveal; #launchOverlay retired)"

# v5.0 Part D (folded) — English label sweep: deliverables chips + contract + converge (no Korean leaks)
case "$BOARD_HTML" in *'data-out="answer">Answer<'*) : ;; *) fail "deliverable chip Answer (English) missing";; esac
case "$BOARD_HTML" in *'data-out="code">Code<'*) : ;; *) fail "deliverable chip Code (English) missing";; esac
case "$BOARD_HTML" in *'data-out="doc">Doc<'*) : ;; *) fail "deliverable chip Doc (English) missing";; esac
case "$BOARD_HTML" in *'data-out="page">Page<'*) : ;; *) fail "deliverable chip Page (English) missing";; esac
case "$BOARD_HTML" in *'data-out="file">File<'*) : ;; *) fail "deliverable chip File (English) missing";; esac
case "$BOARD_HTML" in *'Required outputs (contract)'*) : ;; *) fail "contract strip English label missing";; esac
case "$BOARD_HTML" in *'data-ract="review" data-rrid'*) : ;; *) fail "converge Review action missing";; esac
# the old Korean deliverables/contract/converge labels must be gone from the served board
case "$BOARD_HTML" in *'답변'*|*'요청됨'*|*'요청 산출물'*|*'전체 리뷰'*|*'그룹 클로즈'*|*'>리뷰<'*|*'>머지<'*|*'>클로즈<'*) fail "Korean deliverables/contract/converge label still leaks in served board";; *) : ;; esac
pass "English label sweep (deliverables chips Answer/Code/Doc/Page/File + contract + converge; old Korean gone)"

# v4.8 Part B — Lucide icon sprite + .ic usage inline in the board (no CDN, CSP-safe)
case "$BOARD_HTML" in *'id="i-terminal"'*) : ;; *) fail "icon sprite: #i-terminal symbol missing";; esac
case "$BOARD_HTML" in *'id="i-lock"'*) : ;; *) fail "icon sprite: #i-lock symbol missing";; esac
case "$BOARD_HTML" in *'id="i-recycle"'*) : ;; *) fail "icon sprite: #i-recycle symbol missing";; esac
case "$BOARD_HTML" in *'id="i-alert-triangle"'*) : ;; *) fail "icon sprite: #i-alert-triangle symbol missing";; esac
case "$BOARD_HTML" in *'class="ic"'*) : ;; *) fail "icon .ic usage missing from board";; esac
case "$BOARD_HTML" in *'use href="#i-x"'*) : ;; *) fail "icon <use href=#i-x> not wired in board";; esac
case "$BOARD_HTML" in *'.ic{width:1em'*) : ;; *) fail ".ic CSS (currentColor stroke) missing";; esac
# replaced system emoji must be gone from the served board (spot-check a couple)
case "$BOARD_HTML" in *'🔗'*|*'♻'*|*'🔕'*|*'◆ 리뷰'*) fail "replaced emoji still present in served board";; *) : ;; esac
pass "board inlines Lucide sprite + .ic usage; replaced emoji gone"

# v5.0 — rail icons (server/layers/target/archive) added to the sprite
case "$BOARD_HTML" in *'id="i-server"'*) : ;; *) fail "icon sprite: #i-server (machine switcher) missing";; esac
case "$BOARD_HTML" in *'id="i-layers"'*) : ;; *) fail "icon sprite: #i-layers (Active) missing";; esac
case "$BOARD_HTML" in *'id="i-target"'*) : ;; *) fail "icon sprite: #i-target (Goals) missing";; esac
case "$BOARD_HTML" in *'id="i-archive"'*) : ;; *) fail "icon sprite: #i-archive (Archive) missing";; esac
pass "board sprite carries v5.0 rail icons (server/layers/target/archive)"

# v5.0 Part C — pocket board: mobile FAB + drawer wiring
case "$BOARD_HTML" in *'id="fab"'*) : ;; *) fail "pocket-board mobile FAB (#fab) missing";; esac
case "$BOARD_HTML" in *".fab{display:inline-flex}"*) : ;; *) fail "FAB is never shown on mobile (media rule missing)";; esac
case "$BOARD_HTML" in *"\$('fab')"*) : ;; *) fail "FAB not wired to open the compose sheet";; esac
case "$BOARD_HTML" in *'#newBtn,.newnote{display:none}'*) : ;; *) fail "rail New button not hidden on mobile (should defer to FAB)";; esac
pass "pocket board: mobile FAB served + wired to the sheet; rail New hidden on mobile"

# v5.0 Part C — mobile stability: horizontal rubber-band/pan guard on the root
case "$BOARD_HTML" in *'html{overscroll-behavior:none}'*) : ;; *) fail "root overscroll-behavior guard missing (iOS rubber-band)";; esac
case "$BOARD_HTML" in *'-webkit-font-smoothing:antialiased;overflow-x:hidden'*) : ;; *) fail "body overflow-x:hidden clamp missing";; esac
# must NOT clamp overflow on html (breaks iOS position:fixed/sticky the header+drawer rely on)
case "$BOARD_HTML" in *'html,body{height:100%;overflow'*|*'html{overflow-x'*|*'html{overflow:'*) fail "overflow on <html> would break iOS fixed/sticky — clamp body only";; *) : ;; esac
pass "mobile stability: overscroll-behavior on root + body overflow-x clamp (html not clamped)"

# v5.0 — the served board's inline client JS parses (SyntaxError in the giant template literal blanks the board)
BHFILE="$WORK/board.html"
printf '%s' "$BOARD_HTML" > "$BHFILE"
node -e '
  const fs=require("fs");
  const html=fs.readFileSync(process.argv[1],"utf8");
  const m=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]);
  const js=m[m.length-1];
  if(!js||js.length<1000){console.error("client script extract failed");process.exit(2);}
  fs.writeFileSync(process.argv[2],js);
' "$BHFILE" "$WORK/board-client.js" || fail "could not extract board client script"
node --check "$WORK/board-client.js" || fail "board client JS has a syntax error (board would blank)"
pass "served board client JS parses (node --check)"

# machine probe
curl -sf -X POST "$B/api/machines/local/probe" | grep -q '"ready":true' || fail "local probe not ready (git/tmux required)"
pass "local machine probe ready"

# directory browser (repo picker)
curl -sf "$B/api/browse" | grep -q '"dirs"' || fail "browse endpoint"
pass "directory browser lists folders"

# v4.5.1 — browse flags empty folders so the picker can offer greenfield "Start here"
BT="$WORK/browsetest"; mkdir -p "$BT/emptyone" "$BT/fullone"; echo x > "$BT/fullone/f"
BRES=$(curl -sf "$B/api/browse?path=$BT")
case "$BRES" in *'"name":"emptyone","isRepo":false,"isEmpty":true'*) : ;; *) fail "browse should mark empty dir isEmpty:true: $BRES";; esac
case "$BRES" in *'"name":"fullone","isRepo":false,"isEmpty":false'*) : ;; *) fail "browse should mark non-empty dir isEmpty:false: $BRES";; esac
pass "browse reports isEmpty for greenfield Start-here gating"

# repo registry + validation
curl -sf -X POST "$B/api/repos" -H 'content-type: application/json' \
  -d "{\"machineSlug\":\"local\",\"path\":\"$REPO\"}" | grep -q '"ok":true' || fail "repo register"
expect_code 400 -X POST "$B/api/repos" -H 'content-type: application/json' -d "{\"machineSlug\":\"local\",\"path\":\"$WORK\"}"
pass "repo registry + work-tree validation"

# defaultBranch 감지: wip 브랜치에 체크아웃돼 있어도 main 이어야 함 (aiplab 함정 재발 방지)
curl -s "$B/api/repos" | grep -q '"defaultBranch":"main"' || fail "defaultBranch should resolve to main, not the checked-out branch"
git -C "$REPO" checkout -q main
pass "defaultBranch resolves to repo default (not checked-out branch)"

# design capture
curl -sf -X POST "$B/api/design/capture" -H 'content-type: application/json' \
  -d '{"url":"http://app.local/x","selector":"div#hero > button.cta","html":"<button>Go</button>","css":"{}"}' | grep -q '"ok":true' || fail "capture"
pass "design capture stored"

# task with capture + fleet run x2 (dry)
curl -sf -X POST "$B/api/tasks" -H 'content-type: application/json' \
  -d '{"repoId":1,"title":"e2e","prompt":"restyle the button","designCaptureId":1}' | grep -q '"ok":true' || fail "task create"
curl -sf -X POST "$B/api/tasks/1/run" -H 'content-type: application/json' -d '{"count":2}' | grep -q '"ok":true' || fail "run launch"
D=0
for i in $(seq 1 60); do
  # grep no-match exits 1 — pipefail+set -e 가드
  D=$(curl -s "$B/api/tasks/1" | { grep -o '"status":"done"' || true; } | wc -l | tr -d ' ')
  [ "$D" -ge 2 ] && break; sleep 0.5
done
[ "$D" -ge 2 ] || fail "runs did not settle: $(curl -s "$B/api/tasks/1")"
pass "fleet run x2 settles (worktree+branch+events)"

# events + diff
curl -s "$B/api/runs/1" | grep -q '"kind":"result"' || fail "no result event"
curl -s "$B/api/runs/1/diff" | grep -q 'COXPIT_DRYRUN' || fail "diff missing dry-run file"
pass "event stream parsed + diff shows changes"

# compare + merge winner
curl -s "$B/api/tasks/1/compare" | grep -q '"runs":\[' || fail "compare shape"
curl -sf -X POST "$B/api/runs/1/merge" | grep -q '"ok":true' || fail "merge r1"
[ -f "$REPO/COXPIT_DRYRUN.txt" ] || fail "merged file not on main"
pass "compare + winner merged to base branch"

# merge guards: dirty repo -> 409
printf 'junk\n' > "$REPO/dirty.txt"
expect_code 409 -X POST "$B/api/runs/2/merge"
rm -f "$REPO/dirty.txt"
pass "merge dirty-repo guard 409"

# conflict -> auto-abort, base stays clean
printf 'DIFFERENT\n' > "$WORK/repo-wt-marker" # noop marker
WT2=$(curl -s "$B/api/runs/2" | grep -oE '"worktreePath":"[^"]+"' | sed 's/.*:"//;s/"//')
printf 'DIFFERENT CONTENT\n' > "$WT2/COXPIT_DRYRUN.txt"
expect_code 409 -X POST "$B/api/runs/2/merge"
[ -z "$(git -C "$REPO" status --porcelain)" ] || fail "base repo dirty after abort"
pass "merge conflict auto-abort, base clean"

# settle 웹훅 수신 확인 (run 2개 정착 → run.settled 2건)
sleep 1
HOOKS=$(grep -c 'run.settled' "$WORK/hooks.log" 2>/dev/null || echo 0)
[ "$HOOKS" -ge 2 ] || fail "webhook: expected >=2 run.settled, got $HOOKS"
grep -q 'http://board.example:9999/?run=' "$WORK/hooks.log" || fail "webhook missing deep-link url (COXPIT_PUBLIC_URL)"
pass "settle webhook delivers run.settled + deep-link url"

# base sync: 이미 머지된 r1 은 up-to-date(ok), 충돌 상태 r2 는 409+conflict
curl -sf -X POST "$B/api/runs/1/sync" | grep -q '"ok":true' || fail "sync r1 clean"
pass "base sync (clean path)"

# AI 리뷰: 리허설 모드 응답 + 정착 run 2개 요구 가드
curl -sf -X POST "$B/api/tasks/1/review" -H 'content-type: application/json' -d '{"real":false}' | grep -q 'AI Review' || fail "review rehearsal"
pass "AI review returns digest (rehearsal mode)"

# integrate: 충돌 run → 통합 태스크 자동 발사 (real:false = 모의 에이전트로 배관만 검증)
INTEG=$(curl -sf -X POST "$B/api/integrate" -H 'content-type: application/json' -d '{"runIds":[2],"real":false}')
echo "$INTEG" | grep -q '"conflicts":1' || fail "integrate should report 1 conflict: $INTEG"
ITID=$(echo "$INTEG" | python3 -c 'import sys,json;print(json.load(sys.stdin)["results"][0]["integrationTaskId"])')
IRID=$(echo "$INTEG" | python3 -c 'import sys,json;print(json.load(sys.stdin)["results"][0]["integrationRunId"])')
S=''
for i in $(seq 1 40); do
  S=$(curl -s "$B/api/runs/$IRID" | { grep -oE '"status":"(done|failed|error)"' || true; } | head -1)
  [ -n "$S" ] && break; sleep 0.5
done
[ -n "$S" ] || fail "integration run did not settle"
curl -s "$B/api/tasks/$ITID" | grep -q 'Integrate r2' || fail "integration task title"
pass "integrate: conflict spawns integration agent task (run settles)"

# export: r2 worktree 산출물을 머지 없이 회수
curl -sf -X POST "$B/api/runs/2/export" -H 'content-type: application/json' -d "{\"dest\":\"$WORK/exp\"}" | grep -q '"ok":true' || fail "export"
[ -f "$WORK/exp/COXPIT_DRYRUN.txt" ] || fail "exported file missing"
pass "export files without merge"

# doc 모드: worktree 의 변경 md 를 내용째 회수 (렌더 비교용)
printf '# Hello Doc\n\nrendered *output*\n' > "$WT2/REPORT.md"
DOCS=$(curl -sf "$B/api/runs/2/docs")
echo "$DOCS" | grep -q '"path":"REPORT.md"' || fail "docs missing REPORT.md: $DOCS"
echo "$DOCS" | grep -q '"kind":"md"' || fail "docs kind should be md"
echo "$DOCS" | grep -q 'Hello Doc' || fail "docs content missing"
echo "$DOCS" | grep -q '"source":"worktree"' || fail "docs source should be worktree while alive"
pass "doc mode: changed md returned with content"

# v4.1 B — 공유 페이지가 문서를 렌더(run 2 는 REPORT.md 보유, worktree 라이브)
SH2=$(curl -sf -X POST "$B/api/runs/2/share")
STOK2=$(printf '%s' "$SH2" | { grep -o '"url":"/share/[^"]*"' || true; } | cut -d'"' -f4)
[ -n "$STOK2" ] || fail "share2 create: $SH2"
SPAGE2=$(curl -sf "$B$STOK2")
case "$SPAGE2" in *'Documents'*) : ;; *) fail "share page missing Documents section";; esac
case "$SPAGE2" in *'Hello Doc'*) : ;; *) fail "share page did not render the doc";; esac
curl -sf -X DELETE "$B/api/runs/2/share" >/dev/null
pass "share page renders changed documents"

# v4.0 — 에이전트 오케스트레이션 토큰 가드 + GitHub 초안 검증 + 공유 링크
expect_code 401 -X POST "$B/api/agent/subtasks" -H 'content-type: application/json' -d '{"title":"x","prompt":"y"}'
expect_code 401 -X GET "$B/api/agent/subtasks" -H 'authorization: Bearer bogus'
expect_code 400 -X POST "$B/api/tasks/from-github" -H 'content-type: application/json' -d '{"url":"https://gitlab.com/x/y/issues/1"}'
pass "agent-orch token gate 401 + from-github url validation 400"

SH=$(curl -sf -X POST "$B/api/runs/1/share")
STOK=$(printf '%s' "$SH" | { grep -o '"url":"/share/[^"]*"' || true; } | cut -d'"' -f4)
[ -n "$STOK" ] || fail "share create: $SH"
SPAGE=$(curl -sf "$B$STOK")
case "$SPAGE" in *'read-only snapshot'*) : ;; *) fail "share page missing";; esac
case "$SPAGE" in *'e2e'*) : ;; *) fail "share page missing task title";; esac
curl -sf -X POST "$B/api/runs/1/share" | grep -q '"existing":true' || fail "share should reuse existing token"
curl -sf -X DELETE "$B/api/runs/1/share" >/dev/null
expect_code 404 "$B$STOK"
pass "share link: create -> page -> reuse -> revoke"

# PR 가드: origin 리모트 없는 repo -> 409
expect_code 409 -X POST "$B/api/runs/2/pr"
pass "PR guard (no origin remote 409)"

# repo 삭제 가드: 열린 태스크 있으면 409
expect_code 409 -X DELETE "$B/api/repos/1"
pass "repo delete guarded while tasks open"

# steer guards: dry-run has no session -> 409; missing message -> 400; ask 모드도 동일 배관
expect_code 409 -X POST "$B/api/runs/2/steer" -H 'content-type: application/json' -d '{"message":"do more"}'
expect_code 409 -X POST "$B/api/runs/2/steer" -H 'content-type: application/json' -d '{"message":"status?","mode":"ask"}'
expect_code 400 -X POST "$B/api/runs/2/steer" -H 'content-type: application/json' -d '{}'
pass "steer guards (no session 409, ask mode plumbed, empty 400)"

# v4.1 C+D — 런치별 모델 저장/검증 + close 가드 (신선 repo — main 에 COXPIT_DRYRUN.txt 부재 → dry 가 실제 변경)
REPO2="$WORK/repo2"
mkdir -p "$REPO2"; git -C "$REPO2" init -q -b main
printf 'seed\n' > "$REPO2/README.md"; git -C "$REPO2" add -A
git -C "$REPO2" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q -m init
R2=$(curl -sf -X POST "$B/api/repos" -H 'content-type: application/json' -d "{\"machineSlug\":\"local\",\"path\":\"$REPO2\"}")
R2ID=$(echo "$R2" | python3 -c 'import sys,json;print(json.load(sys.stdin)["repo"]["id"])')
MT=$(curl -sf -X POST "$B/api/tasks" -H 'content-type: application/json' -d "{\"repoId\":$R2ID,\"title\":\"model+guard\",\"prompt\":\"x\"}")
MTID=$(echo "$MT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["task"]["id"])')
expect_code 400 -X POST "$B/api/tasks/$MTID/run" -H 'content-type: application/json' -d '{"model":"bad space"}'
curl -sf -X POST "$B/api/tasks/$MTID/run" -H 'content-type: application/json' -d '{"count":1,"model":"test-model-x"}' | grep -q '"ok":true' || fail "model run launch"
MD=""
for i in $(seq 1 60); do
  MD=$(curl -s "$B/api/tasks/$MTID" | { grep -o '"status":"done"' || true; } | head -1)
  [ -n "$MD" ] && break; sleep 0.5
done
[ -n "$MD" ] || fail "model run did not settle"
curl -s "$B/api/tasks/$MTID" | grep -q '"model":"test-model-x"' || fail "model not stored on run"
pass "per-launch model stored + invalid rejected 400"
# close 가드: 미머지·미export 산출물 있으면 409, force 로 닫힘
expect_code 409 -X POST "$B/api/tasks/$MTID/close" -H 'content-type: application/json' -d '{}'
curl -s -X POST "$B/api/tasks/$MTID/close" -H 'content-type: application/json' -d '{"force":true}' | grep -q '"ok":true' || fail "force close"
pass "close guard: unmerged output 409 -> force closes"

# v4.4 A — 커밋 없는 repo(git init 만) 등록은 400 + NO_COMMITS (엉터리 defaultBranch 저장 금지)
COMMITLESS="$WORK/commitless"
mkdir -p "$COMMITLESS"; git -C "$COMMITLESS" init -qb main
NC=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/repos" -H 'content-type: application/json' -d "{\"machineSlug\":\"local\",\"path\":\"$COMMITLESS\"}")
[ "$NC" = "400" ] || fail "commitless repo register should 400, got $NC"
NCBODY=$(curl -s -X POST "$B/api/repos" -H 'content-type: application/json' -d "{\"machineSlug\":\"local\",\"path\":\"$COMMITLESS\"}")
case "$NCBODY" in *NO_COMMITS*) : ;; *) fail "commitless register missing NO_COMMITS code: $NCBODY";; esac
pass "commitless repo register refused (400 NO_COMMITS)"

# v4.4 B — greenfield /api/repos/new: 미존재 경로 → 201 + defaultBranch main (빈 초기 커밋이 base)
# (전부 동적 ID — 하드코딩 run 1/2 가 다 끝난 뒤라 안전)
NP="$WORK/greenfield"
NPRES=$(curl -s -X POST "$B/api/repos/new" -H 'content-type: application/json' -d "{\"machineSlug\":\"local\",\"path\":\"$NP\"}")
case "$NPRES" in *'"ok":true'*) : ;; *) fail "greenfield new should succeed: $NPRES";; esac
case "$NPRES" in *'"defaultBranch":"main"'*) : ;; *) fail "greenfield defaultBranch should be main: $NPRES";; esac
[ -d "$NP/.git" ] || fail "greenfield did not git init the folder"
NPID=$(echo "$NPRES" | python3 -c 'import sys,json;print(json.load(sys.stdin)["repo"]["id"])')
# 그 repo 에 태스크 + dry run 1개 → 빈 초기 커밋이 worktree base 로 성립함을 증명
NPT=$(curl -sf -X POST "$B/api/tasks" -H 'content-type: application/json' -d "{\"repoId\":$NPID,\"title\":\"greenfield-scaffold\",\"prompt\":\"scaffold\"}")
NPTID=$(echo "$NPT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["task"]["id"])')
curl -sf -X POST "$B/api/tasks/$NPTID/run" -H 'content-type: application/json' -d '{"count":1}' | grep -q '"ok":true' || fail "greenfield run launch"
NPRID=$(curl -s "$B/api/tasks/$NPTID" | python3 -c 'import sys,json;print(json.load(sys.stdin)["runs"][0]["id"])')
NPD=""
for i in $(seq 1 60); do
  NPD=$(curl -s "$B/api/runs/$NPRID" | { grep -oE '"status":"(done|failed|error)"' || true; } | head -1)
  [ -n "$NPD" ] && break; sleep 0.5
done
[ "$NPD" = '"status":"done"' ] || fail "greenfield run did not settle done: $NPD"
curl -s "$B/api/runs/$NPRID/diff" | grep -q 'COXPIT_DRYRUN' || fail "greenfield diff missing dry-run file (empty base commit did not host worktree)"
curl -s -X POST "$B/api/tasks/$NPTID/close" -H 'content-type: application/json' -d '{"force":true}' >/dev/null
pass "greenfield: new project scaffolds on an empty initial commit (dry run settles + diff)"

# Phase 4 backend — verify in-loop: repo.verifyCmd → auto-verify on settle → pass, then re-verify → fail
VREPO="$WORK/verifyrepo"
mkdir -p "$VREPO"; git -C "$VREPO" init -q -b main
printf 'seed\n' > "$VREPO/README.md"; git -C "$VREPO" add -A
git -C "$VREPO" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q -m init
VR=$(curl -sf -X POST "$B/api/repos" -H 'content-type: application/json' -d "{\"machineSlug\":\"local\",\"path\":\"$VREPO\"}")
VRID=$(echo "$VR" | python3 -c 'import sys,json;print(json.load(sys.stdin)["repo"]["id"])')
# PATCH verifyCmd (passing) — dry run creates COXPIT_DRYRUN.txt in the worktree
VPATCH=$(curl -s -X PATCH "$B/api/repos/$VRID" -H 'content-type: application/json' -d '{"verifyCmd":"test -f COXPIT_DRYRUN.txt"}')
case "$VPATCH" in *'"verifyCmd":"test -f COXPIT_DRYRUN.txt"'*) : ;; *) fail "verifyCmd PATCH failed: $VPATCH";; esac
# invalid verifyCmd (embedded control char \u0001, valid JSON) rejected 400 by the guard
expect_code 400 -X PATCH "$B/api/repos/$VRID" -H 'content-type: application/json' -d '{"verifyCmd":"echo\u0001bad"}'
VVT=$(curl -sf -X POST "$B/api/tasks" -H 'content-type: application/json' -d "{\"repoId\":$VRID,\"title\":\"verify\",\"prompt\":\"x\"}")
VVTID=$(echo "$VVT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["task"]["id"])')
curl -sf -X POST "$B/api/tasks/$VVTID/run" -H 'content-type: application/json' -d '{"count":1}' >/dev/null
VVRID=$(curl -s "$B/api/tasks/$VVTID" | python3 -c 'import sys,json;print(json.load(sys.stdin)["runs"][0]["id"])')
VS=""
for i in $(seq 1 80); do
  VS=$(curl -s "$B/api/runs/$VVRID" | python3 -c 'import sys,json;print(json.load(sys.stdin)["run"].get("verifyStatus",""))' 2>/dev/null || true)
  [ "$VS" = "pass" ] || [ "$VS" = "fail" ] && break; sleep 0.5
done
[ "$VS" = "pass" ] || fail "auto-verify should settle pass, got '$VS'"
# manual re-verify with a now-failing cmd → fail + output captured
curl -s -X PATCH "$B/api/repos/$VRID" -H 'content-type: application/json' -d '{"verifyCmd":"echo boom; exit 3"}' >/dev/null
RV=$(curl -s -X POST "$B/api/runs/$VVRID/verify")
case "$RV" in *'"status":"fail"'*) : ;; *) fail "re-verify should fail: $RV";; esac
curl -s "$B/api/runs/$VVRID" | grep -q '"verifyOutput":"boom"' || fail "verify output not captured"
curl -s -X POST "$B/api/tasks/$VVTID/close" -H 'content-type: application/json' -d '{"force":true}' >/dev/null
pass "Phase 4 backend: verifyCmd PATCH(+400 guard) → auto-verify pass → re-verify fail + output"

# v4.4 B 가드 — nonempty 폴더 409 · 커밋 있는 repo 409 · 상대경로 400
NEDIR="$WORK/notempty"; mkdir -p "$NEDIR"; printf 'x\n' > "$NEDIR/file.txt"
expect_code 409 -X POST "$B/api/repos/new" -H 'content-type: application/json' -d "{\"machineSlug\":\"local\",\"path\":\"$NEDIR\"}"
expect_code 409 -X POST "$B/api/repos/new" -H 'content-type: application/json' -d "{\"machineSlug\":\"local\",\"path\":\"$REPO\"}"
expect_code 400 -X POST "$B/api/repos/new" -H 'content-type: application/json' -d '{"machineSlug":"local","path":"relative/path"}'
pass "greenfield guards (nonempty 409, existing repo 409, relative path 400)"

# v4.5 — remote access: /api/remote is well-formed and never 500s. Tailscale can't
# run in CI (bin absent → tailscale:"missing"); on a dev box with Tailscale it may
# report "running" — assert the shape only, never a 500, accept any valid state.
expect_code 200 "$B/api/remote"
RMT=$(curl -s "$B/api/remote")
echo "$RMT" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["tailscale"] in ("missing","stopped","running"),d;assert isinstance(d["serve"],bool) and isinstance(d["funnel"],bool),d' || fail "remote state shape: $RMT"
# Funnel guard: this daemon booted with auth DISABLED → funnel-on must refuse.
RFUN=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/remote/funnel" -H 'content-type: application/json' -d '{"on":true}')
[ "$RFUN" = "409" ] || fail "funnel-on with auth off should 409, got $RFUN"
RFBODY=$(curl -s -X POST "$B/api/remote/funnel" -H 'content-type: application/json' -d '{"on":true}')
case "$RFBODY" in *NO_AUTH*) : ;; *) fail "funnel guard missing NO_AUTH code: $RFBODY";; esac
# Serve has no such guard and Funnel-off is always allowed (both return state, 200).
expect_code 200 -X POST "$B/api/remote/serve" -H 'content-type: application/json' -d '{"on":false}'
expect_code 200 -X POST "$B/api/remote/funnel" -H 'content-type: application/json' -d '{"on":false}'
pass "remote: /api/remote shape (missing OK) · funnel NO_AUTH 409 · serve ungated"

# task close cleans everything (통합 태스크까지 닫아야 브랜치 0)
# r1=merged·r2=exported(둘 다 안전) → task 1 은 force 없이 닫힘. 통합 태스크는 미머지라 force.
curl -sf -X POST "$B/api/tasks/1/close" | grep -q '"ok":true' || fail "close"
curl -sf -X POST "$B/api/tasks/$ITID/close" -H 'content-type: application/json' -d '{"force":true}' | grep -q '"ok":true' || fail "close integration task"
[ -z "$(git -C "$REPO" branch --list 'coxpit/*')" ] || fail "branches not cleaned"
pass "task close cleans worktrees + branches"

# v4.7 P3 (terminal guard) — cleanupRun clears the run's stale worktree/tmux pointers so
# getRunTermInfo returns null and /ws/term/:id gives a clean error (never attaches a dead session).
CLR=$(curl -s "$B/api/fleet?view=all" | python3 -c 'import sys,json
d=json.load(sys.stdin)
r=[r for r in d["runs"] if r["id"]==1][0]
print("CLR_OK" if r.get("worktreePath","")=="" and r.get("tmuxWindow","")=="" else "CLR_BAD "+repr((r.get("worktreePath"),r.get("tmuxWindow"))))')
case "$CLR" in *CLR_OK*) : ;; *) fail "closed run keeps stale term pointers: $CLR";; esac
pass "terminal guard: cleanupRun clears worktreePath/tmuxWindow on close (dead-session attach avoided)"

# v4.3 A/C — 기본 fleet 은 닫힌 태스크 제외, view=all 은 포함, counts + 이벤트 40캡 + 전체 record
V43=$(python3 - "$B" <<'PYEOF'
import sys,json,urllib.request as R
B=sys.argv[1]
active=json.load(R.urlopen(B+"/api/fleet"))
alltasks=json.load(R.urlopen(B+"/api/fleet?view=all"))
atids={t["id"] for t in active["tasks"]}
allids={t["id"] for t in alltasks["tasks"]}
assert 1 not in atids, "closed task 1 must not appear in active fleet"
assert 1 in allids, "closed task 1 must appear in view=all"
assert active.get("counts",{}).get("closedTasks",0) >= 1, ("counts.closedTasks", active.get("counts"))
# 이벤트 캡: 어떤 run 이든 events<=40
for r in alltasks["runs"]:
    assert len(r.get("events",[])) <= 40, ("event cap breached", r["id"], len(r["events"]))
# 전체 record 경로: GET /api/runs/1 이 fleet 이벤트 수 이상
r1_fleet=[r for r in alltasks["runs"] if r["id"]==1][0]
full=json.load(R.urlopen(B+"/api/runs/1"))
assert len(full["events"]) >= len(r1_fleet["events"]), "runs/:id must return full timeline"
print("V43_OK")
PYEOF
) || fail "v4.3 fleet scoping: $V43"
case "$V43" in *V43_OK*) : ;; *) fail "v4.3 fleet: $V43";; esac
pass "fleet view scoping (active omits closed · all includes · counts · event cap · full record)"

# v4.3 B — 아카이브 목록 + 필터
ARCH=$(curl -s "$B/api/archive")
echo "$ARCH" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["total"]>=1 and any(r["taskId"]==1 for r in d["rows"]), d' || fail "archive missing closed task 1"
curl -s "$B/api/archive?q=e2e" | grep -q '"taskId":1' || fail "archive q=e2e should match"
curl -s "$B/api/archive?q=zzznope" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert not d["rows"], d' || fail "archive q=zzznope should miss"
pass "archive list + title filter"

# v4.1 A — 스냅샷이 cleanup(close) 후에도 문서 뷰를 살린다 (run 2 worktree 는 삭제됨)
DOCS2=$(curl -sf "$B/api/runs/2/docs")
echo "$DOCS2" | grep -q '"source":"snapshot"' || fail "docs should fall back to snapshot: $DOCS2"
echo "$DOCS2" | grep -q 'Hello Doc' || fail "snapshot lost the doc content"
pass "doc snapshot survives cleanup (worktree gone, snapshot serves)"

# workbench: worktree+tmux 만들고 에이전트 없음 — 수동 변경 후 merge 레일 동작
WB=$(curl -sf -X POST "$B/api/workbench" -H 'content-type: application/json' -d '{"repoId":1,"title":"wb test"}')
echo "$WB" | grep -q '"ok":true' || fail "workbench open: $WB"
WBRUN=$(echo "$WB" | python3 -c 'import sys,json;print(json.load(sys.stdin)["runId"])')
WBTASK=$(echo "$WB" | python3 -c 'import sys,json;print(json.load(sys.stdin)["taskId"])')
WBS=$(curl -s "$B/api/runs/$WBRUN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["run"]["status"])')
[ "$WBS" = "open" ] || fail "workbench status should be open, got $WBS"
tmux has-session -t "coxpit-r$WBRUN" 2>/dev/null || fail "workbench tmux session missing"
WBWT=$(curl -s "$B/api/runs/$WBRUN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["run"]["worktreePath"])')
printf 'made by hand\n' > "$WBWT/HANDMADE.txt"
curl -sf -X POST "$B/api/runs/$WBRUN/merge" | grep -q '"ok":true' || fail "workbench merge"
[ -f "$REPO/HANDMADE.txt" ] || fail "workbench merge did not land on base"
curl -s -X POST "$B/api/tasks/$WBTASK/close" >/dev/null
tmux has-session -t "coxpit-r$WBRUN" 2>/dev/null && fail "workbench tmux not cleaned" || true
pass "workbench: open -> hand edit -> merge -> close"

# root session (root:true) — tmux at the repo's real checkout (not an isolated worktree); close preserves checkout
RS=$(curl -sf -X POST "$B/api/workbench" -H 'content-type: application/json' -d '{"repoId":1,"title":"Session","root":true}')
echo "$RS" | grep -q '"ok":true' || fail "root session open: $RS"
RSRUN=$(echo "$RS" | python3 -c 'import sys,json;print(json.load(sys.stdin)["runId"])')
RSAGENT=$(curl -s "$B/api/runs/$RSRUN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["run"]["agent"])')
RSBRANCH=$(curl -s "$B/api/runs/$RSRUN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["run"]["branch"])')
RSWT=$(curl -s "$B/api/runs/$RSRUN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["run"]["worktreePath"])')
[ "$RSAGENT" = "session" ] || fail "root session agent should be 'session', got '$RSAGENT'"
[ -z "$RSBRANCH" ] || fail "root session branch should be empty, got '$RSBRANCH'"
[ "$RSWT" = "$REPO" ] || fail "root session worktreePath should be the repo checkout ($REPO), got '$RSWT'"
tmux has-session -t "coxpit-r$RSRUN" 2>/dev/null || fail "root session tmux missing"
# merge must refuse (no branch — already base)
curl -s -X POST "$B/api/runs/$RSRUN/merge" | grep -q '"ok":false' || fail "root session merge should be refused"
# close preserves the real checkout (must NOT git worktree remove the main tree)
curl -s -X POST "$B/api/runs/$RSRUN/cleanup" | grep -q '"ok":true' || fail "root session cleanup"
[ -f "$REPO/README.md" ] && [ -d "$REPO/.git" ] || fail "root session close destroyed the checkout"
tmux has-session -t "coxpit-r$RSRUN" 2>/dev/null && fail "root session tmux not cleaned" || true
pass "root session: opens at repo checkout, no worktree, merge refused, close preserves checkout"

# free session at an arbitrary folder — NOT filed under any project (virtual 'sessions' bucket); close preserves folder
SESSDIR="$WORK/free session dir"
mkdir -p "$SESSDIR"; printf 'keep\n' > "$SESSDIR/keep.txt"
FS=$(curl -sf -X POST "$B/api/session" -H 'content-type: application/json' -d "{\"machineSlug\":\"local\",\"path\":\"$SESSDIR\"}")
echo "$FS" | grep -q '"ok":true' || fail "free session open: $FS"
FSRUN=$(echo "$FS" | python3 -c 'import sys,json;print(json.load(sys.stdin)["runId"])')
# the session's run lives under a repo with kind='sessions' (not the real repo 1)
FLEET=$(curl -s "$B/api/fleet?view=all")
echo "$FLEET" | FSRUN="$FSRUN" SESSDIR="$SESSDIR" python3 -c '
import sys,json,os
j=json.load(sys.stdin); rid=int(os.environ["FSRUN"])
run=[r for r in j["runs"] if r["id"]==rid][0]
task=[t for t in j["tasks"] if t["id"]==run["taskId"]][0]
repo=[x for x in j["repos"] if x["id"]==task["repoId"]][0]
assert run["agent"]=="session", "agent="+run["agent"]
assert repo.get("kind")=="sessions", "bucket kind="+str(repo.get("kind"))
assert repo["id"]!=1, "session must not be filed under the real project repo"
assert run["worktreePath"]==os.environ["SESSDIR"], "wt="+run["worktreePath"]
print("free-session bucket ok")
' || fail "free session not isolated into sessions bucket"
tmux has-session -t "coxpit-r$FSRUN" 2>/dev/null || fail "free session tmux missing"
curl -s -X POST "$B/api/session" -H 'content-type: application/json' -d '{"machineSlug":"local"}' -o /dev/null -w '%{http_code}' | grep -q 400 || fail "session without path should 400"
curl -s -X POST "$B/api/runs/$FSRUN/cleanup" | grep -q '"ok":true' || fail "free session cleanup"
[ -f "$SESSDIR/keep.txt" ] || fail "free session close destroyed the folder"
pass "free session: arbitrary folder, isolated from projects (sessions bucket), close preserves folder"

# task/session rename — PATCH /api/tasks/:id { title }
RNT=$(curl -sf -X POST "$B/api/tasks" -H 'content-type: application/json' -d '{"repoId":1,"title":"before","prompt":"x"}')
RNTID=$(echo "$RNT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["task"]["id"])')
curl -s -X PATCH "$B/api/tasks/$RNTID" -H 'content-type: application/json' -d '{"title":"after name"}' | grep -q '"title":"after name"' || fail "task rename PATCH failed"
curl -s "$B/api/tasks/$RNTID" | grep -q '"title":"after name"' || fail "task rename not persisted"
expect_code 400 -X PATCH "$B/api/tasks/$RNTID" -H 'content-type: application/json' -d '{"title":""}'
curl -s -X POST "$B/api/tasks/$RNTID/close" -H 'content-type: application/json' -d '{"force":true}' >/dev/null
pass "task/session rename: PATCH title (empty→400, persisted)"

# scrollback capture — mobile "read what scrolled above" (history overlay backend)
SBSESS="$WORK/sbsess"; mkdir -p "$SBSESS"
SB=$(curl -sf -X POST "$B/api/session" -H 'content-type: application/json' -d "{\"machineSlug\":\"local\",\"path\":\"$SBSESS\",\"title\":\"sb\"}")
SBRUN=$(echo "$SB" | python3 -c 'import sys,json;print(json.load(sys.stdin)["runId"])')
sleep 1
tmux send-keys -t "coxpit-r$SBRUN" 'for i in $(seq 1 40); do echo "SBLINE_$i"; done' Enter 2>/dev/null
sleep 1
SBTEXT=$(curl -s "$B/api/runs/$SBRUN/scrollback?lines=3000")
case "$SBTEXT" in *'"ok":true'*'SBLINE_1'*'SBLINE_40'*) : ;; *) fail "scrollback did not capture pane history: $(echo "$SBTEXT" | head -c 120)";; esac
# chat/viewer: endpoint responds ok with a turns array (turns may be empty where there is no Claude transcript, e.g. CI)
CHATRESP=$(curl -s "$B/api/runs/$SBRUN/chat")
case "$CHATRESP" in *'"ok":true'*'"turns"'*) : ;; *) fail "chat endpoint should return ok + turns: $(echo "$CHATRESP" | head -c 120)";; esac
curl -s -X POST "$B/api/runs/$SBRUN/cleanup" >/dev/null
pass "scrollback + chat(JSONL) viewer endpoints (history overlay backend)"

# secrets vault — store once, inject into session tmux as env (no interactive prompt)
curl -s -X POST "$B/api/secrets" -H 'content-type: application/json' -d '{"name":"E2E_KEY","value":"sekret_val_9"}' | grep -q '"ok":true' || fail "secret POST failed"
expect_code 400 -X POST "$B/api/secrets" -H 'content-type: application/json' -d '{"name":"bad name","value":"x"}'
# GET must NOT leak the value (hint only)
SECGET=$(curl -s "$B/api/secrets")
case "$SECGET" in *'sekret_val_9'*) fail "secrets GET leaked the value";; *'E2E_KEY'*) : ;; *) fail "secret not listed";; esac
# open a session → the secret is injected into its tmux env
SECSESS="$WORK/secsess"; mkdir -p "$SECSESS"
SSS=$(curl -sf -X POST "$B/api/session" -H 'content-type: application/json' -d "{\"machineSlug\":\"local\",\"path\":\"$SECSESS\",\"title\":\"sec\"}")
SSSRUN=$(echo "$SSS" | python3 -c 'import sys,json;print(json.load(sys.stdin)["runId"])')
sleep 1
tmux show-environment -t "coxpit-r$SSSRUN" E2E_KEY 2>/dev/null | grep -q 'E2E_KEY=sekret_val_9' || fail "secret not injected into session tmux env"
curl -s -X POST "$B/api/runs/$SSSRUN/cleanup" >/dev/null
curl -s -X DELETE "$B/api/secrets/E2E_KEY" | grep -q '"ok":true' || fail "secret DELETE failed"
curl -s "$B/api/secrets" | grep -q 'E2E_KEY' && fail "secret not deleted" || true
pass "secrets vault: store (value never leaked) → injected as tmux env → delete"

# cockpit secrets UI (A) + send-to-pane (B)
case "$CKPT" in *'id="secretsBtn"'*'id="secretsModal"'*'function openSecrets'*'/api/secrets'*) : ;; *) fail "cockpit secrets vault UI missing";; esac
case "$CKPT" in *'function startSecretSend'*'data-lock'*) : ;; *) fail "cockpit send-secret-to-pane missing";; esac
pass "cockpit secrets vault UI + send-secret-to-pane"

# mobile-responsive cockpit (drawer tree + single terminal + IME input bar; split is desktop-only)
case "$CKPT" in *'function setDrawer'*'function termSendLine'*'isComposing'*) : ;; *) fail "cockpit mobile drawer / IME send wiring missing";; esac
case "$CKPT" in *'창분할은 데스크톱 전용'*) : ;; *) fail "cockpit should guard split on mobile";; esac
case "$CKPT" in *'body.touch .term-ibar'*'@media (max-width:860px)'*) : ;; *) fail "cockpit mobile media query / touch input bar missing";; esac
# touch input bar has full nav keys (arrows + ctrl combos) + is 2-row so nothing is clipped
case "$CKPT" in *'class="tkeys"'*'data-k="left"'*'data-k="right"'*'data-k="cd"'*) : ;; *) fail "cockpit terminal nav keys (← → ^D) missing";; esac
# board keeps a visible Cockpit link on mobile (only entry to the terminal workspace)
case "$BOARD_HTML" in *'.cockpit-link{display:inline-flex'*) : ;; *) fail "board should show Cockpit link on mobile";; esac
pass "cockpit mobile fixes: full nav keys + touch input bar (no clip) + board→Cockpit link"

# mobile app-lock: viewport zoom lock + overscroll-behavior; icon-only header (labels hidden); smaller fonts
case "$CKPT" in *'user-scalable=no'*'overscroll-behavior:none'*) : ;; *) fail "cockpit mobile app-lock (viewport + overscroll) missing";; esac
case "$CKPT" in *'.b-txt{display:none}'*'class="b-txt"'*) : ;; *) fail "cockpit mobile icon-only (b-txt hide) missing";; esac
pass "cockpit mobile app-lock (no zoom/bounce) + icon-only header + small fonts"

# mobile terminal scrolling: tmux copy-mode key (A) + read-only history overlay (C)
case "$CKPT" in *'data-k="copymode"'*'data-k="pgup"'*'copymode:'*) : ;; *) fail "cockpit tmux copy-mode / PgUp keys missing";; esac
case "$CKPT" in *'id="histBtn"'*'id="histModal"'*'function openHistory'*'/scrollback'*) : ;; *) fail "cockpit history overlay (scrollback reader) missing";; esac
pass "cockpit mobile scroll: copy-mode key (A) + read-only history overlay (C)"

# viewer: renamed to 뷰어 + conversational mode (Claude Code JSONL → chat bubbles) alongside terminal(raw)
case "$CKPT" in *'>📜 뷰어<'*'id="hmChat"'*'function renderTurn'*"/chat'"*) : ;; *) fail "cockpit conversational viewer (대화 mode) missing";; esac
case "$CKPT" in *'ch-turn'*'ch-bubble'*) : ;; *) fail "cockpit chat bubble styles missing";; esac
pass "cockpit viewer: 뷰어 rename + conversational (chat) view over Claude Code transcript"

# board (the landing screen) gets the mobile app-lock; Cockpit link is a ghost icon button (matches bell/remote)
case "$BOARD_HTML" in *'user-scalable=no'*) : ;; *) fail "board mobile viewport zoom-lock missing";; esac
case "$BOARD_HTML" in *'class="btn-ghost sm cockpit-link"'*'#i-terminal'*) : ;; *) fail "board Cockpit link should be a ghost icon button (design-system consistent)";; esac
pass "board mobile: viewport zoom-lock + Cockpit entry consistent with header ghost buttons"

# prompt injection proof (dump agent argv via COXPIT_AGENT_BIN in a fresh daemon)
kill "$DPID" 2>/dev/null || true; sleep 0.5
cat > "$WORK/dump-agent.sh" <<'EOS'
#!/bin/sh
printf '%s\n' "$@" > AGENT_ARGS.txt
printf '%s\n' '{"type":"result","subtype":"success","result":"dumped"}'
EOS
chmod +x "$WORK/dump-agent.sh"
rm -f "$DB"*
COXPIT_AUTH_DISABLED=1 COXPIT_AGENT_BIN="$WORK/dump-agent.sh" COXPIT_DB="$DB" COXPIT_PORT="$PORT" \
  node --import tsx "$ROOT/src/index.ts" >>"$WORK/daemon.log" 2>&1 &
DPID=$!
for i in $(seq 1 40); do curl -sf "$B/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf -X POST "$B/api/repos" -H 'content-type: application/json' -d "{\"machineSlug\":\"local\",\"path\":\"$REPO\"}" >/dev/null
curl -sf -X POST "$B/api/design/capture" -H 'content-type: application/json' -d '{"selector":"nav.bar"}' >/dev/null
curl -sf -X POST "$B/api/tasks" -H 'content-type: application/json' -d '{"repoId":1,"title":"inj","prompt":"user words","designCaptureId":1}' >/dev/null
curl -sf -X POST "$B/api/tasks/1/run" -H 'content-type: application/json' -d '{"count":1,"real":true}' >/dev/null
S=''
for i in $(seq 1 40); do
  S=$(curl -s "$B/api/runs/1" | { grep -oE '"status":"[a-z]+"' || true; } | head -1)
  [ "$S" = '"status":"done"' ] && break; sleep 0.5
done
WT=$(curl -s "$B/api/runs/1" | grep -oE '"worktreePath":"[^"]+"' | sed 's/.*:"//;s/"//')
grep -q 'DESIGN CONTEXT' "$WT/AGENT_ARGS.txt" && grep -q 'nav.bar' "$WT/AGENT_ARGS.txt" && grep -q 'user words' "$WT/AGENT_ARGS.txt" \
  || fail "prompt injection missing"
curl -s -X POST "$B/api/tasks/1/close" -H 'content-type: application/json' -d '{"force":true}' >/dev/null
pass "design context injected into agent argv"

# plan fan-out (mock planner): 목표 1 → 태스크 2 자동 생성·발사
PLAN=$(curl -sf -X POST "$B/api/plan" -H 'content-type: application/json' -d '{"repoId":1,"goal":"improve the docs","real":false}')
echo "$PLAN" | grep -q '"ok":true' || fail "plan fan-out: $PLAN"
NPLAN=$(echo "$PLAN" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["tasks"]))')
[ "$NPLAN" = "2" ] || fail "mock plan should create 2 tasks, got $NPLAN"
PR1=$(echo "$PLAN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["tasks"][0]["runId"])')
S=''
for i in $(seq 1 40); do
  S=$(curl -s "$B/api/runs/$PR1" | { grep -oE '"status":"(done|failed|error)"' || true; } | head -1)
  [ -n "$S" ] && break; sleep 0.5
done
[ "$S" = '"status":"done"' ] || fail "planned run did not settle: $S"
expect_code 400 -X POST "$B/api/plan" -H 'content-type: application/json' -d '{"repoId":1}'
pass "plan fan-out launches planned tasks (mock planner) — dry Goal via the New sheet endpoint settles"

# v4.2 A — plan 형제들이 한 goal 그룹을 공유, fleet.groups 에 goal 행, 수동 태스크는 ungrouped
GTIDS=$(echo "$PLAN" | python3 -c 'import sys,json;print(" ".join(str(t["id"]) for t in json.load(sys.stdin)["tasks"]))')
GOUT=$(python3 - "$B" $GTIDS <<'PYEOF'
import sys,json,urllib.request as R
B=sys.argv[1]; tids=[int(x) for x in sys.argv[2:]]
fleet=json.load(R.urlopen(B+"/api/fleet"))
tasks={t["id"]:t for t in fleet["tasks"]}
gids={tasks[t]["groupId"] for t in tids}
assert len(gids)==1 and None not in gids, ("plan siblings must share one group", gids)
groups={g["id"]:g for g in fleet.get("groups",[])}
assert groups.get(gids.pop(),{}).get("kind")=="goal", "group kind should be goal"
req=R.Request(B+"/api/tasks",data=json.dumps({"repoId":1,"title":"solo","prompt":"x"}).encode(),headers={"content-type":"application/json"},method="POST")
assert json.load(R.urlopen(req))["task"]["groupId"] is None, "manual task must be ungrouped"
print("GROUPS_OK")
PYEOF
) || fail "group model check: $GOUT"
case "$GOUT" in *GROUPS_OK*) : ;; *) fail "group model: $GOUT";; esac
for TID in $(echo "$PLAN" | python3 -c 'import sys,json;[print(t["id"]) for t in json.load(sys.stdin)["tasks"]]'); do
  curl -s -X POST "$B/api/tasks/$TID/close" -H 'content-type: application/json' -d '{"force":true}' >/dev/null
done
pass "group model: plan siblings share a goal group; manual task ungrouped"

# v4.6 L1 — Goal workroom: aggregate view · spawn · broadcast (honest skips) + UI contract
# 새 dry plan 으로 방을 만든다(기존 태스크 ID 가정과 격리).
WPLAN=$(curl -sf -X POST "$B/api/plan" -H 'content-type: application/json' -d '{"repoId":1,"goal":"workroom goal","real":false}')
echo "$WPLAN" | grep -q '"ok":true' || fail "workroom plan: $WPLAN"
WGID=$(python3 - "$B" <<'PYEOF'
import sys,json,urllib.request as R
B=sys.argv[1]
fleet=json.load(R.urlopen(B+"/api/fleet"))
goals=[g for g in fleet.get("groups",[]) if g["kind"]=="goal"]
assert goals, "expected a goal group"
print(max(g["id"] for g in goals))  # newest goal = the workroom plan
PYEOF
)
[ -n "$WGID" ] || fail "could not resolve workroom group id"
# 방의 두 run 이 정착할 때까지 대기(드라이 → done, 세션 없음)
for i in $(seq 1 60); do
  DN=$(curl -s "$B/api/groups/$WGID" | { grep -o '"status":"done"' || true; } | wc -l | tr -d ' ')
  [ "$DN" -ge 2 ] && break; sleep 0.5
done
# B1 aggregate — group + runs(>=2, steerable boolean) + events array
AGG=$(curl -sf "$B/api/groups/$WGID")
echo "$AGG" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["group"]["id"] and len(d["runs"])>=2, d;assert all(isinstance(r["steerable"],bool) and isinstance(r["live"],bool) for r in d["runs"]), d;assert isinstance(d["events"],list), d' || fail "aggregate shape: $AGG"
expect_code 404 "$B/api/groups/999999"
pass "workroom aggregate (group + runs with steerable/live + events, 404 for missing)"

# B2 spawn — 새 attempt 가 그룹에 합류(groupId 일치), run 정착 done
SPAWN=$(curl -sf -X POST "$B/api/groups/$WGID/spawn" -H 'content-type: application/json' -d '{"prompt":"another attempt","real":false}')
echo "$SPAWN" | grep -q '"ok":true' || fail "spawn: $SPAWN"
STID=$(echo "$SPAWN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["tasks"][0]["id"])')
SRID=$(echo "$SPAWN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["tasks"][0]["runId"])')
curl -s "$B/api/tasks/$STID" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["task"]["groupId"]=='"$WGID"', d' || fail "spawned task not in group"
SS=''
for i in $(seq 1 60); do
  SS=$(curl -s "$B/api/runs/$SRID" | { grep -oE '"status":"(done|failed|error)"' || true; } | head -1)
  [ -n "$SS" ] && break; sleep 0.5
done
[ "$SS" = '"status":"done"' ] || fail "spawned run did not settle done: $SS"
expect_code 400 -X POST "$B/api/groups/$WGID/spawn" -H 'content-type: application/json' -d '{}'
pass "workroom spawn: new attempt joins group + settles done (empty prompt 400)"

# B3 broadcast — dry runs have no session → honest skip (steered 0, skipped lists no-session)
BC=$(curl -sf -X POST "$B/api/groups/$WGID/steer" -H 'content-type: application/json' -d '{"message":"follow up"}')
echo "$BC" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["ok"] and d["steered"]==0, d;assert len(d["skipped"])>=2, d;assert any("no agent session" in s["reason"] for s in d["skipped"]), d;assert "no session" in d["detail"], d' || fail "broadcast honest-skip shape: $BC"
expect_code 400 -X POST "$B/api/groups/$WGID/steer" -H 'content-type: application/json' -d '{}'
expect_code 404 -X POST "$B/api/groups/999999/steer" -H 'content-type: application/json' -d '{"message":"x"}'
pass "workroom broadcast: dry/no-session runs skipped honestly (empty 400, missing 404)"

# B4 (L2) ask — 읽기 전용 코디네이터(dry): ok+비어있지 않은 answer, 2회차가 coord_session_id 지속/재사용
ASK1=$(curl -sf -X POST "$B/api/groups/$WGID/ask" -H 'content-type: application/json' -d '{"message":"what are these attempts doing?","real":false}')
echo "$ASK1" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["ok"] is True, d;assert isinstance(d["answer"],str) and d["answer"].strip(), d' || fail "ask1 shape: $ASK1"
# 첫 호출 후 그룹에 coord_session_id 각인(aggregate 로 노출)
CS1=$(curl -sf "$B/api/groups/$WGID" | python3 -c 'import sys,json;print(json.load(sys.stdin)["group"]["coordSessionId"])')
[ -n "$CS1" ] || fail "coord_session_id not persisted after first ask: '$CS1'"
# 2회차 — 여전히 ok+answer, 세션은 재사용(동일값 유지, dry 는 합성 세션 고정)
ASK2=$(curl -sf -X POST "$B/api/groups/$WGID/ask" -H 'content-type: application/json' -d '{"message":"any risks?","real":false}')
echo "$ASK2" | python3 -c 'import sys,json;d=json.load(sys.stdin);assert d["ok"] is True, d;assert isinstance(d["answer"],str) and d["answer"].strip(), d' || fail "ask2 shape: $ASK2"
CS2=$(curl -sf "$B/api/groups/$WGID" | python3 -c 'import sys,json;print(json.load(sys.stdin)["group"]["coordSessionId"])')
[ "$CS2" = "$CS1" ] || fail "coord_session_id not reused across calls: '$CS1' vs '$CS2'"
expect_code 400 -X POST "$B/api/groups/$WGID/ask" -H 'content-type: application/json' -d '{}'
expect_code 404 -X POST "$B/api/groups/999999/ask" -H 'content-type: application/json' -d '{"message":"x"}'
pass "workroom ask (L2): read-only coordinator answers + persists/reuses coord_session_id (empty 400, missing 404)"

# UI contract — workroom overlay + seg toggle + Open workroom control in the band
case "$BOARD_HTML" in *'id="groupRoomOverlay"'*) : ;; *) fail "workroom overlay missing";; esac
case "$BOARD_HTML" in *'id="roomSeg"'*) : ;; *) fail "workroom Work|Ask seg missing";; esac
case "$BOARD_HTML" in *'id="roomConv"'*) : ;; *) fail "workroom Ask conversation missing";; esac
case "$BOARD_HTML" in *'id="roomAsk"'*) : ;; *) fail "workroom Ask send button missing";; esac
case "$BOARD_HTML" in *'data-groom='*) : ;; *) fail "Open workroom control missing";; esac
case "$BOARD_HTML" in *'Open workroom'*) : ;; *) fail "Open workroom label missing";; esac
pass "board serves goal workroom (#groupRoomOverlay + seg + Open workroom entry)"

# v4.7 P3 — converge cockpit UI contract: group action bar + per-run decision rows + reuse hooks
case "$BOARD_HTML" in *'id="roomGbar"'*) : ;; *) fail "converge group action bar missing";; esac
case "$BOARD_HTML" in *'id="roomIntegrateSel"'*) : ;; *) fail "Integrate 선택 button missing";; esac
case "$BOARD_HTML" in *'id="roomReviewAll"'*) : ;; *) fail "전체 리뷰 button missing";; esac
case "$BOARD_HTML" in *'id="roomGroupClose"'*) : ;; *) fail "그룹 클로즈 button missing";; esac
case "$BOARD_HTML" in *'id="roomRuns"'*) : ;; *) fail "per-run decision list container missing";; esac
case "$BOARD_HTML" in *'function roomRunRowHTML'*) : ;; *) fail "run decision row renderer missing";; esac
case "$BOARD_HTML" in *'function roomRunAction'*) : ;; *) fail "run action dispatch (merge/steer/review/close) missing";; esac
case "$BOARD_HTML" in *'data-ract="merge"'*) : ;; *) fail "inline 머지 action missing";; esac
case "$BOARD_HTML" in *'data-ract="close"'*) : ;; *) fail "inline 클로즈 action missing";; esac
case "$BOARD_HTML" in *'function roomLoadRunOutputs'*) : ;; *) fail "expand peek reuse of /outputs cards missing";; esac
case "$BOARD_HTML" in *'function renderOutCardInto'*) : ;; *) fail "shared P2 output-card viewer (expand reuse) missing";; esac
case "$BOARD_HTML" in *'function termUnavailReason'*) : ;; *) fail "terminal-guard reason helper missing";; esac
pass "board serves converge cockpit (group bar + per-run decision rows + P2 card reuse + terminal guard)"
# 방 태스크 정리
for TID in $(curl -s "$B/api/fleet" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(" ".join(str(t["id"]) for t in d["tasks"] if t.get("groupId")=='"$WGID"'))'); do
  curl -s -X POST "$B/api/tasks/$TID/close" -H 'content-type: application/json' -d '{"force":true}' >/dev/null
done

# provider seam — codex 파서 정규화 + 커맨드 시임 (unit, codex CLI 불필요)
cat > "$WORK/prov.test.ts" <<EOF
import { getProvider } from '$ROOT/src/providers.ts';
const p = getProvider('codex');
const a = p.parseLine(JSON.stringify({ type: 'thread.started', thread_id: 'th_123' }));
if (!a || a.sessionId !== 'th_123') throw new Error('thread_id not captured');
const b = p.parseLine(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hi there' } }));
if (!b || b.resultText !== 'hi there' || !b.stored.includes('assistant')) throw new Error('agent_message not normalized');
const c = p.parseLine(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'ls -la' } }));
if (!c || !c.stored.includes('tool_use')) throw new Error('command_execution not normalized');
if (p.parseLine(JSON.stringify({ type: 'turn.completed' })) !== null) throw new Error('noise not dropped');
const lc = p.launchCmd('do it');
if (!lc.includes('exec --json') || !lc.includes('--sandbox')) throw new Error('launchCmd: ' + lc);
// --sandbox 는 resume 서브커맨드 앞(exec 플래그) — 실 CLI(0.146) 실측 순서
const rc = p.resumeCmd('th_123', 'next');
if (!/exec --json --sandbox \S+ resume /.test(rc)) throw new Error('resumeCmd: ' + rc);
if (getProvider('nope').id !== 'claude-code') throw new Error('unknown agent should fall back to claude');
// v4.1 model 관통 — claude --model, codex -m (resume 은 -m 이 resume 앞)
const cl = getProvider('claude-code');
if (!cl.launchCmd('p', 'opus-x').includes("--model 'opus-x'")) throw new Error('claude model flag missing');
if (cl.launchCmd('p').includes('--model')) throw new Error('empty model must not add flag');
if (!/exec --json --sandbox \S+ -m 'gpt-x' resume /.test(p.resumeCmd('id', 'm', 'gpt-x'))) throw new Error('codex -m order');
// v4.4 C — claude system 이벤트의 model 에서 ANSI 이스케이프 소독(저장 시점)
const sysEv = cl.parseLine(JSON.stringify({ type: 'system', subtype: 'init', model: 'm[1mx' }));
if (!sysEv) throw new Error('system event dropped');
if (sysEv.stored.includes('')) throw new Error('ANSI not stripped from stored model: ' + JSON.stringify(sysEv.stored));
if (!sysEv.stored.includes('m') || !sysEv.stored.includes('x')) throw new Error('model text lost during strip: ' + sysEv.stored);
console.log('PROVIDER_OK');
EOF
PROV_OUT=$(node --import tsx "$WORK/prov.test.ts" 2>&1) || fail "codex provider seam: $PROV_OUT"
case "$PROV_OUT" in *PROVIDER_OK*) : ;; *) fail "codex provider seam: $PROV_OUT";; esac
pass "provider seam: codex normalizes to board events + cmd shape"

# codex run through the API (dry pipeline — agent recorded, run settles)
CT=$(curl -sf -X POST "$B/api/tasks" -H 'content-type: application/json' \
  -d '{"repoId":1,"title":"codex-e2e","prompt":"provider pipeline"}')
CTID=$(printf '%s' "$CT" | { grep -o '"id":[0-9]*' || true; } | head -1 | cut -d: -f2)
[ -n "$CTID" ] || fail "codex task create: $CT"
curl -sf -X POST "$B/api/tasks/$CTID/run" -H 'content-type: application/json' \
  -d '{"count":1,"agent":"codex"}' | grep -q '"ok":true' || fail "codex run launch"
CD=""
for i in $(seq 1 60); do
  CD=$(curl -s "$B/api/tasks/$CTID" | { grep -o '"status":"done"' || true; } | head -1)
  [ -n "$CD" ] && break; sleep 0.5
done
[ -n "$CD" ] || fail "codex run did not settle: $(curl -s "$B/api/tasks/$CTID")"
curl -s "$B/api/tasks/$CTID" | grep -q '"agent":"codex"' || fail "run agent should be codex"
curl -s -X POST "$B/api/tasks/$CTID/close" -H 'content-type: application/json' -d '{"force":true}' >/dev/null
pass "codex run via API settles with agent recorded (dry rehearsal)"

# v4.7 P1 — 산출물 계약(deliverable contract): 선언 → /outputs 카드(required/present) · /file 가드
# 신선 repo(DRYRUN 미머지)라 dry run 이 실제 COXPIT_DRYRUN.txt 변경을 낸다 → code 카드 present.
DREPO="$WORK/drepo"
mkdir -p "$DREPO"; git -C "$DREPO" init -q -b main
printf 'seed\n' > "$DREPO/README.md"; git -C "$DREPO" add -A
git -C "$DREPO" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q -m init
DR=$(curl -sf -X POST "$B/api/repos" -H 'content-type: application/json' -d "{\"machineSlug\":\"local\",\"path\":\"$DREPO\"}")
DRID=$(echo "$DR" | python3 -c 'import sys,json;print(json.load(sys.stdin)["repo"]["id"])')
# 계약 선언: code(생성됨) + doc(미생성) → code present:true·required, doc present:false·required
DT=$(curl -sf -X POST "$B/api/tasks" -H 'content-type: application/json' \
  -d "{\"repoId\":$DRID,\"title\":\"contract\",\"prompt\":\"do work\",\"outputs\":[\"code\",\"doc\"]}")
DTID=$(echo "$DT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["task"]["id"])')
echo "$DT" | python3 -c 'import sys,json;t=json.load(sys.stdin)["task"];assert json.loads(t["outputs"])==["code","doc"],t' || fail "task outputs not stored: $DT"
curl -sf -X POST "$B/api/tasks/$DTID/run" -H 'content-type: application/json' -d '{"count":1}' | grep -q '"ok":true' || fail "contract run launch"
DRID_RUN=$(curl -s "$B/api/tasks/$DTID" | python3 -c 'import sys,json;print(json.load(sys.stdin)["runs"][0]["id"])')
DS=''
for i in $(seq 1 60); do
  DS=$(curl -s "$B/api/runs/$DRID_RUN" | { grep -oE '"status":"(done|failed|error)"' || true; } | head -1)
  [ -n "$DS" ] && break; sleep 0.5
done
[ "$DS" = '"status":"done"' ] || fail "contract run did not settle done: $DS"
# /outputs — code present:true·required:true · doc present:false·required:true (soft policy)
OUTS=$(curl -sf "$B/api/runs/$DRID_RUN/outputs")
echo "$OUTS" | python3 -c 'import sys,json
d=json.load(sys.stdin)["outputs"]
byt={c["type"]:c for c in d}
assert "code" in byt and byt["code"]["required"] is True and byt["code"]["present"] is True, ("code card", d)
assert "doc" in byt and byt["doc"]["required"] is True and byt["doc"]["present"] is False, ("doc placeholder", d)
' || fail "outputs cards wrong required/present: $OUTS"
pass "outputs contract: code present+required, missing doc -> present:false placeholder"
# /file 가드 — .. 트래버설 거부(non-200) + worktree 내부 파일 서빙(200)
FTRAV=$(curl -s -o /dev/null -w '%{http_code}' "$B/api/runs/$DRID_RUN/file?path=../../../../../../etc/passwd")
case "$FTRAV" in 200) fail "file .. traversal must NOT return 200 (got $FTRAV)";; *) : ;; esac
FIN=$(curl -s -o /dev/null -w '%{http_code}' "$B/api/runs/$DRID_RUN/file?path=COXPIT_DRYRUN.txt")
[ "$FIN" = "200" ] || fail "in-worktree file should serve 200, got $FIN"
pass "file guard: .. traversal rejected (non-200), in-worktree file served (200)"
# /output — P2 뷰어가 소비하는 콘텐츠: answer→{kind:md}, code→{kind:diff,diffUrl}
OANS=$(curl -sf "$B/api/runs/$DRID_RUN/output?type=answer")
echo "$OANS" | python3 -c 'import sys,json;o=json.load(sys.stdin);assert o["kind"]=="md" and "content" in o,o' || fail "answer viewer content wrong: $OANS"
OCODE=$(curl -sf "$B/api/runs/$DRID_RUN/output?type=code")
echo "$OCODE" | python3 -c 'import sys,json;o=json.load(sys.stdin);assert o["kind"]=="diff" and o["diffUrl"].endswith("/diff"),o' || fail "code viewer diffUrl wrong: $OCODE"
pass "output viewers: answer->md content, code->diff url (P2 renderers)"
curl -s -X POST "$B/api/tasks/$DTID/close" -H 'content-type: application/json' -d '{"force":true}' >/dev/null

# v4.1 E — repo 기본 브랜치 override (fixture 에 wip-side-branch 존재)
curl -sf -X PATCH "$B/api/repos/1" -H 'content-type: application/json' -d '{"defaultBranch":"wip-side-branch"}' | grep -q '"defaultBranch":"wip-side-branch"' || fail "branch patch to existing failed"
curl -s "$B/api/repos" | grep -q '"defaultBranch":"wip-side-branch"' || fail "branch patch not reflected"
expect_code 400 -X PATCH "$B/api/repos/1" -H 'content-type: application/json' -d '{"defaultBranch":"no-such-branch"}'
curl -sf -X PATCH "$B/api/repos/1" -H 'content-type: application/json' -d '{"defaultBranch":"main"}' >/dev/null
pass "per-repo base branch override (existing 200, missing 400)"

# reclaim orphaned worktrees — closed-task / failed·error·stopped run worktrees are
# reclaimable; running/done are NOT. Produce a deterministic reclaimable state by
# orphaning a live run via a daemon restart on the SAME DB (reconcileOrphanRuns
# settles it 'failed' and PRESERVES the worktree — exactly the accumulation case).
# Restart the daemon with a STALLING agent bin so a real run stays 'running'.
STALL="$WORK/stall-agent.sh"
cat > "$STALL" <<'EOS'
#!/bin/sh
printf '%s\n' '{"type":"system","subtype":"init","session":"stall"}'
sleep 60
EOS
chmod +x "$STALL"
kill "$DPID" 2>/dev/null || true; sleep 1
COXPIT_AUTH_DISABLED=1 COXPIT_AGENT_BIN="$STALL" COXPIT_DB="$DB" COXPIT_PORT="$PORT" COXPIT_WEBHOOK_URL="http://127.0.0.1:$HOOKPORT/" \
  COXPIT_PUBLIC_URL="http://board.example:9999/" \
  node --import tsx "$ROOT/src/index.ts" >>"$WORK/daemon.log" 2>&1 &
DPID=$!
for i in $(seq 1 40); do curl -sf "$B/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
RCT=$(curl -sf -X POST "$B/api/tasks" -H 'content-type: application/json' \
  -d "{\"repoId\":$DRID,\"title\":\"reclaim-victim\",\"prompt\":\"do work\"}")
RCTID=$(echo "$RCT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["task"]["id"])')
curl -sf -X POST "$B/api/tasks/$RCTID/run" -H 'content-type: application/json' -d '{"count":1,"real":true}' | grep -q '"ok":true' || fail "reclaim victim run launch"
RCRUN=$(curl -s "$B/api/tasks/$RCTID" | python3 -c 'import sys,json;print(json.load(sys.stdin)["runs"][0]["id"])')
# wait until it's running (worktree created + agent stalling), then yank the daemon
RS=''
for i in $(seq 1 60); do
  RS=$(curl -s "$B/api/runs/$RCRUN" | { grep -oE '"status":"running"' || true; } | head -1)
  [ -n "$RS" ] && break; sleep 0.5
done
[ "$RS" = '"status":"running"' ] || fail "reclaim victim never reached running: $(curl -s "$B/api/runs/$RCRUN")"
kill "$DPID" 2>/dev/null || true; sleep 1
COXPIT_AUTH_DISABLED=1 COXPIT_AGENT_BIN="$STALL" COXPIT_DB="$DB" COXPIT_PORT="$PORT" COXPIT_WEBHOOK_URL="http://127.0.0.1:$HOOKPORT/" \
  COXPIT_PUBLIC_URL="http://board.example:9999/" \
  node --import tsx "$ROOT/src/index.ts" >>"$WORK/daemon.log" 2>&1 &
DPID=$!
for i in $(seq 1 40); do curl -sf "$B/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
# Phase 1 re-adopt: the agent was spawned DETACHED, so killing the daemon left it alive.
# On restart reconcileOrphanRuns must RE-ADOPT it (still 'running'), not orphan it to failed.
RS2=''
for i in $(seq 1 20); do
  RS2=$(curl -s "$B/api/runs/$RCRUN" | { grep -oE '"status":"[a-z]+"' || true; } | head -1)
  [ "$RS2" = '"status":"running"' ] && break; sleep 0.5
done
[ "$RS2" = '"status":"running"' ] || fail "re-adopt: live agent should stay running across restart, got: $RS2"
pass "Phase 1 re-adopt: a live agent survives a daemon restart (running, not orphaned)"

# now kill the orphaned agent → the re-adopt tailer settles it (failed), worktree preserved (reclaimable).
pkill -f stall-agent.sh 2>/dev/null || true; sleep 1
RCS=''
for i in $(seq 1 30); do
  RCS=$(curl -s "$B/api/runs/$RCRUN" | { grep -oE '"status":"(failed|error|stopped|done|running)"' || true; } | head -1)
  case "$RCS" in '"status":"failed"'|'"status":"error"'|'"status":"stopped"') break;; esac; sleep 0.5
done
case "$RCS" in '"status":"failed"'|'"status":"error"'|'"status":"stopped"') : ;; *) fail "reclaim victim not settled after agent kill: $RCS";; esac

# an OPEN task with a settled 'done' run — it must NOT be reclaimable (dry run settles done)
SAFET=$(curl -sf -X POST "$B/api/tasks" -H 'content-type: application/json' \
  -d "{\"repoId\":$DRID,\"title\":\"reclaim-safe-open\",\"prompt\":\"do work\"}")
SAFETID=$(echo "$SAFET" | python3 -c 'import sys,json;print(json.load(sys.stdin)["task"]["id"])')
curl -sf -X POST "$B/api/tasks/$SAFETID/run" -H 'content-type: application/json' -d '{"count":1}' | grep -q '"ok":true' || fail "safe run launch"
SAFERUN=$(curl -s "$B/api/tasks/$SAFETID" | python3 -c 'import sys,json;print(json.load(sys.stdin)["runs"][0]["id"])')
SAFES=''
for i in $(seq 1 60); do
  SAFES=$(curl -s "$B/api/runs/$SAFERUN" | { grep -oE '"status":"(done|failed|error)"' || true; } | head -1)
  [ -n "$SAFES" ] && break; sleep 0.5
done
[ "$SAFES" = '"status":"done"' ] || fail "safe open run did not settle done: $SAFES"

# GET /api/worktrees — shape {items:[{runId,path,branch,taskId,reason,exists}],totalKb}
WT=$(curl -sf "$B/api/worktrees")
RCRUN="$RCRUN" SAFERUN="$SAFERUN" python3 -c 'import sys,json,os
d=json.loads(sys.stdin.read())
assert isinstance(d["items"],list) and isinstance(d["totalKb"],int),d
ids=[w["runId"] for w in d["items"]]
victim=int(os.environ["RCRUN"]); safe=int(os.environ["SAFERUN"])
assert victim in ids, ("stopped/failed run must be reclaimable", ids, victim)
assert safe not in ids, ("open done run must NOT be reclaimable", ids, safe)
w=[x for x in d["items"] if x["runId"]==victim][0]
assert w["path"] and w["branch"] and "reason" in w and "exists" in w, ("item shape", w)
' <<<"$WT" || fail "worktrees shape/filter wrong: $WT"
pass "worktrees list: stopped/failed reclaimable, open+done run NOT listed"

# POST /api/worktrees/prune — reclaims the victim; its worktreePath must be cleared,
# and the safe (open/done) run's worktree must remain untouched.
PR=$(curl -sf -X POST "$B/api/worktrees/prune" -H 'content-type: application/json' -d '{}')
RCRUN="$RCRUN" python3 -c 'import sys,json,os
d=json.loads(sys.stdin.read())
assert d["count"]>=1 and isinstance(d["removed"],list),d
assert int(os.environ["RCRUN"]) in [r["runId"] for r in d["removed"]],("victim removed",d)
' <<<"$PR" || fail "prune result wrong: $PR"
# victim worktreePath now blank
VWT=$(curl -s "$B/api/runs/$RCRUN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["run"]["worktreePath"])')
[ -z "$VWT" ] || fail "victim worktreePath not cleared after prune: '$VWT'"
# safe run's worktree still present (never touched)
SWT=$(curl -s "$B/api/runs/$SAFERUN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["run"]["worktreePath"])')
[ -n "$SWT" ] || fail "safe open run's worktree was wrongly cleared"
# idempotent — re-prune finds nothing (victim gone, safe not eligible)
WT2=$(curl -sf "$B/api/worktrees")
RCRUN="$RCRUN" SAFERUN="$SAFERUN" python3 -c 'import sys,json,os
ids=[w["runId"] for w in json.loads(sys.stdin.read())["items"]]
assert int(os.environ["RCRUN"]) not in ids,("victim still reclaimable",ids)
assert int(os.environ["SAFERUN"]) not in ids,("safe leaked into reclaimable",ids)
' <<<"$WT2" || fail "post-prune list wrong: $WT2"
pass "prune: reclaimable removed + pointer cleared, open/done run untouched, idempotent"
# cleanup the safe task so branch check downstream stays clean
curl -s -X POST "$B/api/tasks/$SAFETID/close" -H 'content-type: application/json' -d '{"force":true}' >/dev/null
curl -s -X POST "$B/api/tasks/$RCTID/close" -H 'content-type: application/json' -d '{"force":true}' >/dev/null

# board serves the reclaim affordance
case "$BOARD_HTML" in *'id="reclaimBtn"'*) : ;; *) fail "reclaim worktrees button missing";; esac
pass "board serves reclaim worktrees affordance (#reclaimBtn)"

# v4.8 — access-key auth. Auth applies ONLY on an EXPOSED bind (0.0.0.0); a
# loopback bind (127.0.0.1, the default) is trusted-local and stays open.
# Boot exposed (COXPIT_HOST=0.0.0.0) with env key pw-e2e (COXPIT_AUTH_PASS
# back-compat, key-only). curl still reaches it via 127.0.0.1 ($B).
kill "$DPID" 2>/dev/null || true; sleep 0.5
rm -f "$DB"*
COXPIT_HOST=0.0.0.0 COXPIT_AUTH_PASS=pw-e2e COXPIT_DB="$DB" COXPIT_PORT="$PORT" \
  node --import tsx "$ROOT/src/index.ts" >>"$WORK/daemon.log" 2>&1 &
DPID=$!
for i in $(seq 1 40); do curl -sf "$B/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
expect_code 401 "$B/api/machines"
expect_code 401 "$B/api/browse"
# Basic back-compat: any user, key in the password slot (no username in the UX)
expect_code 200 -u x:pw-e2e "$B/api/machines"
expect_code 200 -u admin:pw-e2e "$B/api/machines"
expect_code 200 "$B/design/bookmarklet.js"
# v5.2 — brand assets are public even on an exposed bind: the UNLOCK page (shown to
# unauthenticated visitors) must be able to load the logo mark, mascot, wordmark font.
expect_code 200 "$B/brand/mark.png"
expect_code 200 "$B/brand/wave.png"
expect_code 200 "$B/brand/pixelify.woff2"
expect_code 200 "$B/favicon.ico"
# and the served unlock page references them (mascot welcome + Pixelify wordmark)
UNLOCK_HTML=$(curl -s -H 'Accept: text/html' "$B/")
case "$UNLOCK_HTML" in *'/brand/wave.png'*) : ;; *) fail "unlock page missing welcome mascot";; esac
case "$UNLOCK_HTML" in *"font-family:'Pixelify'"*) : ;; *) fail "unlock page missing Pixelify wordmark";; esac
# /share/* 는 무인증 예외(없는 토큰이라도 401 이 아니라 404 여야 함)
expect_code 404 "$B/share/no-such-token"
expect_code 201 -X POST "$B/api/design/capture?k=pw-e2e" -H 'content-type: application/json' -d '{"selector":"x"}'
expect_code 401 -X POST "$B/api/design/capture?k=nope" -H 'content-type: application/json' -d '{}'
pass "auth gate + capture key (exposed bind, env key, Basic back-compat)"

# v4.8 — API 401 carries NO WWW-Authenticate header (no native browser popup)
WWWH=$(curl -s -D - -o /dev/null "$B/api/machines")
case "$WWWH" in *[Ww][Ww][Ww]-[Aa]uthenticate*) fail "401 must not send WWW-Authenticate (would pop native dialog)";; *) : ;; esac
pass "unauthorized API sends no WWW-Authenticate (no basic popup)"

# v4.8 — HTML GET without auth serves the branded unlock PAGE (200), not a 401 popup
LOGIN=$(curl -s -H 'accept: text/html' "$B/")
LCODE=$(curl -s -o /dev/null -w '%{http_code}' -H 'accept: text/html' "$B/")
[ "$LCODE" = "200" ] || fail "unauth HTML GET should serve login page 200, got $LCODE"
case "$LOGIN" in *'Unlock this coxpit'*) : ;; *) fail "login page not served on unauth HTML GET";; esac
# no username INPUT field (the copy may say "no username" as a feature — that's fine)
case "$LOGIN" in *'type="text"'*|*'name="user"'*|*'id="user"'*|*'autocomplete="username"'*) fail "login page must not have a username input";; *) : ;; esac
case "$LOGIN" in *'access key'*) : ;; *) fail "login page missing access-key field";; esac
# v4.8 Part B — login page uses the Lucide sprite (lock/unlock), no OS emoji
case "$LOGIN" in *'id="i-lock"'*) : ;; *) fail "login page missing #i-lock sprite symbol";; esac
case "$LOGIN" in *'id="i-unlock"'*) : ;; *) fail "login page missing #i-unlock sprite symbol";; esac
case "$LOGIN" in *'class="ic"'*) : ;; *) fail "login page missing .ic icon usage";; esac
case "$LOGIN" in *'🔒'*|*'🔓'*|*'🔐'*) fail "login page still uses OS lock emoji";; *) : ;; esac
# v5.0 Part C — Safari-safe: real form navigation POST (not fetch-then-replace)
case "$LOGIN" in *'method="post" action="/api/auth/unlock"'*) : ;; *) fail "login page must POST-navigate to /api/auth/unlock (Safari cookie race)";; esac
case "$LOGIN" in *'name="nav" value="1"'*) : ;; *) fail "login form missing nav=1 flag (form-nav branch)";; esac
# v5.0 Part C — iOS input hygiene on the key field(s)
case "$LOGIN" in *'autocapitalize="none" autocorrect="off" spellcheck="false"'*) : ;; *) fail "key input missing autocapitalize/autocorrect/spellcheck hardening";; esac
pass "unauth HTML GET serves branded unlock page (key-only, no username, Lucide, form-nav + input hygiene)"

# v4.8 — /api/auth/unlock: right key → 200 + Set-Cookie coxpit_sess; wrong key → 401
UNLOCK=$(curl -s -D - -o /dev/null -X POST "$B/api/auth/unlock" -H 'content-type: application/json' -d '{"key":"pw-e2e","remember":true}')
case "$UNLOCK" in *'HTTP/1.1 200'*|*' 200 '*) : ;; *) fail "unlock with right key should 200: $UNLOCK";; esac
case "$UNLOCK" in *[Ss]et-[Cc]ookie:*coxpit_sess=*) : ;; *) fail "unlock should Set-Cookie coxpit_sess: $UNLOCK";; esac
UBAD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/auth/unlock" -H 'content-type: application/json' -d '{"key":"nope-wrong"}')
[ "$UBAD" != "200" ] || fail "unlock with wrong key must not 200 (got $UBAD)"
pass "unlock: right key 200+Set-Cookie · wrong key non-200 (JSON API intact)"

# v5.0 Part C — real form navigation POST(urlencoded + nav=1): right key → 303 → / + Set-Cookie;
# wrong key → re-renders the login page (200 HTML) with the error (Safari-safe cookie commit).
FNAV=$(curl -s -D - -o /dev/null -X POST "$B/api/auth/unlock" \
  -H 'content-type: application/x-www-form-urlencoded' --data 'nav=1&key=pw-e2e&remember=on')
case "$FNAV" in *'303'*) : ;; *) fail "form-nav unlock (right key) should 303: $FNAV";; esac
case "$FNAV" in *[Ll]ocation:*/*) : ;; *) fail "form-nav unlock should redirect to /: $FNAV";; esac
case "$FNAV" in *[Ss]et-[Cc]ookie:*coxpit_sess=*) : ;; *) fail "form-nav unlock should Set-Cookie: $FNAV";; esac
FBAD=$(curl -s -X POST "$B/api/auth/unlock" \
  -H 'content-type: application/x-www-form-urlencoded' --data 'nav=1&key=wrong-nope')
case "$FBAD" in *'Unlock this coxpit'*) : ;; *) fail "form-nav unlock (wrong key) should re-render login page";; esac
case "$FBAD" in *'wrong key'*) : ;; *) fail "form-nav unlock (wrong key) should surface the error inline";; esac
pass "form-nav unlock: right key 303→/ +Set-Cookie · wrong key re-renders login with error"

# v4.8 — cookie round-trip: the minted session cookie is accepted by the gate
CJAR="$WORK/cookies.txt"
curl -s -c "$CJAR" -X POST "$B/api/auth/unlock" -H 'content-type: application/json' -d '{"key":"pw-e2e","remember":true}' >/dev/null
expect_code 200 -b "$CJAR" "$B/api/machines"
pass "session cookie unlocks the gate (cookie round-trip)"

# v4.8 — setup is single-shot: env/stored key already configured → 409
expect_code 409 -X POST "$B/api/auth/setup" -H 'content-type: application/json' -d '{"key":"whatever123","token":"x"}'
pass "setup single-shot: 409 when a key already exists"

# v4.5 — remote endpoints are behind the auth gate; with a key set the Funnel
# guard does NOT trip (guard is open-auth only). Test funnel-OFF (ungated).
expect_code 401 "$B/api/remote"
expect_code 200 -u x:pw-e2e "$B/api/remote"
expect_code 200 -u x:pw-e2e -X POST "$B/api/remote/funnel" -H 'content-type: application/json' -d '{"on":false}'
pass "remote endpoints auth-gated; funnel guard is open-auth only"

# v4.8 — first-run setup anti-claim (fresh daemon, exposed, NO key configured).
# A forwarded/tunneled request (x-forwarded-for present) with a bogus token → 403.
# A genuinely-local request (loopback, no fwd headers) → 201 + Set-Cookie.
kill "$DPID" 2>/dev/null || true; sleep 0.5
rm -f "$DB"* "$WORK/.coxpit-auth" 2>/dev/null || true
AUTHDIR="$(dirname "$DB")"
rm -f "$AUTHDIR/auth.json" 2>/dev/null || true
COXPIT_HOST=0.0.0.0 COXPIT_DB="$DB" COXPIT_PORT="$PORT" \
  node --import tsx "$ROOT/src/index.ts" >>"$WORK/daemon.log" 2>&1 &
DPID=$!
for i in $(seq 1 40); do curl -sf "$B/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
# setup mode: HTML GET serves the SETUP page
SETPAGE=$(curl -s -H 'accept: text/html' "$B/")
case "$SETPAGE" in *'Protect this coxpit'*) : ;; *) fail "no-key daemon should serve setup page";; esac
# forwarded request with bad token → 403 (must not be claimable by a stranger)
expect_code 403 -X POST "$B/api/auth/setup" -H 'content-type: application/json' \
  -H 'x-forwarded-for: 8.8.8.8' -d '{"key":"claimattempt","token":"bogus"}'
# genuinely-local (no forwarding headers) → allowed 201 + cookie
SUP=$(curl -s -D - -o /dev/null -X POST "$B/api/auth/setup" -H 'content-type: application/json' -d '{"key":"owner-set-key","remember":true}')
case "$SUP" in *' 201 '*|*'HTTP/1.1 201'*) : ;; *) fail "local setup should 201: $SUP";; esac
case "$SUP" in *[Ss]et-[Cc]ookie:*coxpit_sess=*) : ;; *) fail "setup should Set-Cookie: $SUP";; esac
# now that a key exists, the stored key unlocks and setup is closed (409)
expect_code 200 -u x:owner-set-key "$B/api/machines"
expect_code 409 -X POST "$B/api/auth/setup" -H 'content-type: application/json' -d '{"key":"second","token":"x"}'
pass "first-run setup anti-claim: forwarded+bad-token 403 · local 201+cookie · then stored key unlocks · 409"

# v4.8 — loopback bind is trusted-local: board served WITHOUT auth (no login page)
kill "$DPID" 2>/dev/null || true; sleep 0.5
rm -f "$DB"*; rm -f "$AUTHDIR/auth.json" 2>/dev/null || true
COXPIT_HOST=127.0.0.1 COXPIT_DB="$DB" COXPIT_PORT="$PORT" \
  node --import tsx "$ROOT/src/index.ts" >>"$WORK/daemon.log" 2>&1 &
DPID=$!
for i in $(seq 1 40); do curl -sf "$B/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
expect_code 200 "$B/api/machines"
LB=$(curl -s -H 'accept: text/html' "$B/")
case "$LB" in *'<title>coxpit'*) : ;; *) fail "loopback bind should serve the board";; esac
case "$LB" in *'Unlock this coxpit'*|*'Protect this coxpit'*) fail "loopback bind must not gate with a login page";; *) : ;; esac
pass "loopback bind = trusted local, board open (no login, zero-friction npx)"

echo "---"
echo "E2E PASS ($PASS_COUNT checks)"
