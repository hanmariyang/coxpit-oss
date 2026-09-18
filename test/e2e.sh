#!/usr/bin/env bash
# Coxpit E2E — boots the daemon against a throwaway repo and exercises the full
# dry-run pipeline: registry, fleet run, events, diff, compare, merge (+guards),
# stop semantics, task close, design capture -> prompt injection, auth gate.
# No credits spent (dry-run agent). Exits non-zero on first failure.
set -euo pipefail

# coxpit 터미널(tmux) 안에서 e2e 를 돌려도 테스트 데몬의 tmux 가 그 소켓을 상속해
# 실데몬 세션을 건드리지 않도록 — 항상 기본 서버를 쓴다.
unset TMUX

# 상주 데몬의 COXPIT_* env 가 셸에 새어들어와 있으면(launchd/프로필) 테스트 데몬이 상속해
# host/port 를 env-lock 하거나 실데몬 DB 를 가리킨다 → 헤르메틱하게: 이 스위트가 쓰는 값만 인라인 지정하고 나머지는 제거.
unset COXPIT_HOST COXPIT_PORT COXPIT_DB COXPIT_DATA_DIR COXPIT_AUTH_PASS COXPIT_AUTH_DISABLED \
      COXPIT_PORT_STRICT COXPIT_PUBLIC_URL COXPIT_WEBHOOK_URL COXPIT_AGENT_REAL COXPIT_AGENT_BIN 2>/dev/null || true

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
  # v5.28 B 의 일회용 리스너 — 중간에 죽어도 포트를 물고 남지 않게
  [ -n "${TPID:-}" ] && kill "$TPID" 2>/dev/null || true
  # T6 수거 테스트가 지어낸 고아 tmux 이름 — 중간에 죽어도 개발 기계에 남기지 않는다('=' 정확 일치)
  tmux kill-session -t '=coxpit-r98765' 2>/dev/null || true
  tmux kill-session -t '=coxpit-r987654' 2>/dev/null || true
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
case "$CKPT" in *'/vendor/xterm.js'*'/vendor/addon-fit.js'*'/vendor/addon-unicode11.js'*'/vendor/addon-web-links.js'*) : ;; *) fail "cockpit xterm vendor scripts missing";; esac
expect_code 200 "$B/vendor/addon-web-links.js"
case "$CKPT" in *'WebLinksAddon'*) : ;; *) fail "cockpit should register WebLinksAddon (clickable URLs)";; esac
# copy wiring: xterm has user-select:none → selection must be pushed to clipboard explicitly
case "$CKPT" in *'getSelection'*'attachCustomKeyEventHandler'*) : ;; *) fail "cockpit should wire terminal copy (select-to-copy + Cmd/Ctrl+C)";; esac
# copy must be robust off the desktop app (PWA/browser): clipboard API + execCommand fallback + toast feedback
case "$CKPT" in *'copyFallback'*'navigator.clipboard.writeText'*'복사됨'*) : ;; *) fail "cockpit copy needs a fallback + feedback (PWA/browser clipboard)";; esac
# OSC 52 clipboard: an in-terminal app (claude) that "copies" must reach the system clipboard
expect_code 200 "$B/vendor/addon-clipboard.js"
case "$CKPT" in *'/vendor/addon-clipboard.js'*'ClipboardAddon'*) : ;; *) fail "cockpit should load ClipboardAddon (OSC 52 → system clipboard)";; esac
# ⌥+drag local selection even inside a mouse-mode app (claude); visible attach button; version badge (cache check)
case "$CKPT" in *'macOptionClickForcesSelection'*) : ;; *) fail "cockpit should allow ⌥+drag selection inside mouse-mode apps";; esac
case "$CKPT" in *'id="attachBtn"'*'id="attachInput"'*) : ;; *) fail "cockpit should have a visible file-attach button";; esac
# toolbar consistency (2026-09-18): every tabctl label lives in .b-txt (uniform icon-only on mobile), and the labels are English
case "$CKPT" in *'id="attachBtn"'*'<span class="b-txt"> Attach</span>'*) : ;; *) fail "attach button label should be English 'Attach' in a .b-txt span (was 첨부, not wrapped uniformly)";; esac
case "$CKPT" in *'첨부</span>'*) fail "toolbar 'Attach' must not be Korean 첨부 (rest of the toolbar is English)";; *) : ;; esac
case "$CKPT" in *'id="splitRow"'*'<span class="b-txt"> Split</span>'*) : ;; *) fail "split labels must be wrapped in .b-txt like the rest (were bare text, stayed visible on mobile)";; esac
# terminal readability: minimumContrastRatio lifts black-on-black (ANSI black on the dark bg)
case "$CKPT" in *'minimumContrastRatio'*) : ;; *) fail "terminal should set minimumContrastRatio so black-on-black text stays readable";; esac
case "$CKPT" in *'__COXPIT_VER__'*) fail "cockpit version placeholder must be substituted at serve time";; *) : ;; esac
case "$CKPT" in *'id="ver"'*) : ;; *) fail "cockpit should show a version badge (cache diagnosis)";; esac
# design system: no colorful emoji in the cockpit (mono glyphs only)
if printf '%s' "$CKPT" | perl -CSD -ne 'exit 1 if /[\x{1F000}-\x{1FAFF}\x{2699}\x{26A0}\x{2B50}]/'; then : ; else fail "cockpit contains emoji — use monochrome glyphs (design system)"; fi
case "$CKPT" in *'function renderTree'*'function openRunPane'*) : ;; *) fail "cockpit tree/pane logic missing";; esac
case "$CKPT" in *'/api/fleet?view=all'*'/ws/term/'*) : ;; *) fail "cockpit fleet/term wiring missing";; esac
pass "Phase 2 cockpit workspace tree + pane-grid terminal (xterm attach, auto-tile)"

# No white native scrollbars anywhere: global dark scrollbar theme + tab strip bar hidden
case "$CKPT" in *'::-webkit-scrollbar-thumb{background:var(--line-hi)'*'.tabs::-webkit-scrollbar'*) : ;; *) fail "cockpit should theme scrollbars globally + hide the tab-strip bar (no white scrollbars)";; esac
pass "no white scrollbars: global themed scrollbar + tab strip bar hidden (scroll kept)"

# Orca-inspired batch: ⌘K palette, ⌘F terminal search, live per-run status, diff whitespace toggle
expect_code 200 "$B/vendor/addon-search.js"
case "$CKPT" in *'/vendor/addon-search.js'*'SearchAddon'*) : ;; *) fail "cockpit terminal search (SearchAddon) missing";; esac
case "$CKPT" in *'id="termFind"'*'function focusedTermTab'*'function openFind'*) : ;; *) fail "cockpit ⌘F terminal find bar missing";; esac
case "$CKPT" in *'id="palette"'*'function paletteItems'*'function openPalette'*) : ;; *) fail "cockpit ⌘K command palette missing";; esac
case "$CKPT" in *'function latestActivity'*'data-role="act"'*) : ;; *) fail "cockpit live per-run activity status missing";; esac
case "$CKPT" in *'id="rvWs"'*'function revealWs'*) : ;; *) fail "cockpit Review whitespace toggle missing";; esac
pass "Orca-inspired: ⌘K palette + ⌘F terminal search + live run status + diff whitespace toggle"

# Pane power: zoom/maximize (⌘⏎ + header ⤢) + keyboard pane focus (⌘1..9); image viewer load-fail fallback
case "$CKPT" in *'data-zoom'*'function toggleZoom'*'zoomLeaf'*) : ;; *) fail "cockpit pane zoom (toggleZoom/zoomLeaf) missing";; esac
case "$CKPT" in *'function leafOrder'*'function typingInField'*) : ;; *) fail "cockpit keyboard pane focus (⌘1..9) missing";; esac
case "$CKPT" in *'im.onerror'*'HEIC'*) : ;; *) fail "image viewer should show a fallback when the image can't render";; esac
pass "pane zoom (⌘⏎/⤢) + keyboard pane focus (⌘1..9) + image load-fail fallback"

# Focus mode (hide tree+reqbar, ⌘. / ◱) + find bar must honor [hidden] (was always showing)
case "$CKPT" in *'.layout.focusmode'*'id="focusBtn"'*'function toggleFocus'*) : ;; *) fail "cockpit focus mode (toggleFocus/.focusmode) missing";; esac
case "$CKPT" in *'.term-find[hidden]{display:none}'*) : ;; *) fail "term-find must honor [hidden] (find bar was always visible)";; esac
pass "focus mode (⌘. hides tree+reqbar) + terminal find bar hidden by default"

# Layout save/restore (localStorage, via palette) — serialize split tree + per-pane tab (run id / viewer path)
case "$CKPT" in *'function serializeNode'*'function rebuildNode'*'coxpit.layouts'*) : ;; *) fail "cockpit layout save/restore missing";; esac
case "$CKPT" in *'function saveLayout'*'function restoreLayout'*'function deleteLayout'*) : ;; *) fail "cockpit layout save/restore/delete fns missing";; esac
pass "layout save/restore (palette; split tree + pane tabs serialized to localStorage)"

# Pane header actions: open this run's diff (Review) + history (viewer); diff hidden for sessions
case "$CKPT" in *'function runIsSession'*'function openReviewForRun'*) : ;; *) fail "cockpit pane-header run actions (openReviewForRun) missing";; esac
case "$CKPT" in *'data-diff='*'data-hist='*) : ;; *) fail "cockpit pane-header diff/history buttons missing";; esac
pass "pane header actions: open this run's diff (Review) + history (viewer)"

# Selective broadcast: pick target panes (◯/◉), send only to them; none selected = all (back-compat)
case "$CKPT" in *'bcastSel'*'data-bcast='*'function bcastCount'*) : ;; *) fail "cockpit selective broadcast (bcastSel) missing";; esac
case "$CKPT" in *'body.bcastmode .leaf-h .bsel'*) : ;; *) fail "cockpit broadcast-target toggle should show only in broadcast mode";; esac
pass "selective broadcast: choose target panes, else all (back-compatible)"

# File viewer (md/html/pdf/image/text) as a non-terminal pane + .env text edit
case "$CKPT" in *'/vendor/marked.js'*) : ;; *) fail "cockpit should load marked (md render)";; esac
expect_code 200 "$B/vendor/marked.js"
case "$CKPT" in *'view-host'*'function openViewer'*) : ;; *) fail "cockpit viewer pane (view-host/openViewer) missing";; esac
case "$CKPT" in *'id="fileBtn"'*) : ;; *) fail "cockpit file-open affordance (#fileBtn) missing";; esac
# file picker recursive search + terminal path→viewer link provider
case "$CKPT" in *'id="fpSearch"'*'function fpFind'*) : ;; *) fail "cockpit file picker search (fpSearch/fpFind) missing";; esac
case "$CKPT" in *'registerLinkProvider'*'function openPathFromTerm'*) : ;; *) fail "cockpit terminal path→viewer link provider missing";; esac
# v5.28 D-fix — 링크는 **에이전트가 말한 그 파일**을 열어야 한다. 파일 순서대로:
# 토스트 액션 스타일 → 액션을 받는 toast → 줄바꿈 이음(isWrapped) → 페인 pwd 질의 → worktree 폴백 → 없으면 안 연다.
case "$CKPT" in *'.toast .tgo{pointer-events:auto'*'function toast(msg, act)'*) : ;; *) fail "toast must accept one clickable action (the jail toast needs a real way out)";; esac
case "$CKPT" in *'if(ln.isWrapped)'*'nx.isWrapped'*'var joined=head+s+tail;'*) : ;; *) fail "the link provider must stitch wrapped continuation rows before matching (half-paths opened the wrong file)";; esac
D_PWDFETCH="fetch('/api/runs/'+runId+'/pwd')"
case "$CKPT" in *'var pwdCache'*"$D_PWDFETCH"*) : ;; *) fail "relative paths must resolve against the pane's live pwd (GET /api/runs/:id/pwd)";; esac
D_WTFALL="if(wt && wt!==pwd) bases.push(wt);"
case "$CKPT" in *'function openPathFromTerm'*"$D_WTFALL"*'function openResolved'*) : ;; *) fail "worktreePath must stay the fallback base behind the live pwd";; esac
case "$CKPT" in *'function pathMiss'*'그 경로를 찾지 못했습니다'*) : ;; *) fail "a path that exists under neither base must be reported — never opened on a guess";; esac
D_JAILGO="toast(err, { label:'설정 → 파일 뷰어 루트', run:function(){ gotoBoard('settings'); } })"
case "$CKPT" in *"$D_JAILGO"*) : ;; *) fail "the jail toast's 설정 → 파일 뷰어 루트 must be an actual action (opens the existing board settings view)";; esac
pass "v5.28 D-fix cockpit: relative paths resolve against the pane's pwd (worktree fallback) · wrapped rows stitched · jail toast is a click target"
FSD=$(mktemp -d "$HOME/.coxpit-e2e-XXXXXX")
printf '# Hi\n\nbody\n' > "$FSD/doc.md"; printf 'K=v\n' > "$FSD/.env"
mkdir -p "$FSD/sub/deep"; printf 'x\n' > "$FSD/sub/deep/report-final.md"
FSL=$(curl -s -G "$B/api/fs/list" --data-urlencode "path=$FSD")
case "$FSL" in *'"doc.md"'*'"kind":"md"'*) : ;; *) fail "fs/list should list files with kind: $FSL";; esac
FSF=$(curl -s -G "$B/api/fs/find" --data-urlencode "path=$FSD" --data-urlencode "q=report")
case "$FSF" in *'sub/deep/report-final.md'*) : ;; *) fail "fs/find should recurse and match by name: $FSF";; esac
FSF2=$(curl -s -G "$B/api/fs/find" --data-urlencode "path=$FSD" --data-urlencode "q=x")
case "$FSF2" in *'too short'*) : ;; *) fail "fs/find should reject <2 char query: $FSF2";; esac
FSR=$(curl -s -G "$B/api/fs/read" --data-urlencode "path=$FSD/doc.md")
case "$FSR" in *'"kind":"md"'*'"editable":true'*) : ;; *) fail "fs/read md shape wrong: $FSR";; esac
FSJ=$(curl -s -G "$B/api/fs/read" --data-urlencode "path=/etc/hosts")
case "$FSJ" in *'홈 폴더 밖'*) : ;; *) fail "fs jail should reject outside-home read: $FSJ";; esac
# missing file → friendly message, not a raw node ENOENT dump
FSM=$(curl -s -G "$B/api/fs/read" --data-urlencode "path=$HOME/__coxpit_nope__/turtle.png")
case "$FSM" in *'찾을 수 없습니다'*) : ;; *) fail "fs/read should give a friendly not-found message: $FSM";; esac
FSRAW=$(curl -s -o /dev/null -D - -G "$B/api/fs/raw" --data-urlencode "path=$FSD/doc.md" | tr -d '\r')
case "$FSRAW" in *'content-disposition: inline'*) : ;; *) fail "fs/raw should serve inline (renders in-browser)";; esac
FSW=$(curl -s -X POST "$B/api/fs/write" -H 'content-type: application/json' --data "{\"path\":\"$FSD/.env\",\"content\":\"K=v2\\n\"}")
case "$FSW" in *'"size"'*) : ;; *) fail "fs/write (.env edit) failed: $FSW";; esac
case "$(cat "$FSD/.env")" in "K=v2") : ;; *) fail "fs/write did not persist";; esac
# file attach: upload (base64) into a dir, dedup, jail
FUP=$(curl -s -X POST "$B/api/fs/upload" -H 'content-type: application/json' --data "{\"path\":\"$FSD\",\"name\":\"att.txt\",\"dataB64\":\"$(printf hiattach | base64)\"}")
case "$FUP" in *'"name":"att.txt"'*) : ;; *) fail "fs/upload failed: $FUP";; esac
[ "$(cat "$FSD/att.txt" 2>/dev/null)" = "hiattach" ] || fail "fs/upload did not write file"
FUP2=$(curl -s -X POST "$B/api/fs/upload" -H 'content-type: application/json' --data "{\"path\":\"$FSD\",\"name\":\"att.txt\",\"dataB64\":\"$(printf hiattach | base64)\"}")
case "$FUP2" in *'att-1.txt'*) : ;; *) fail "fs/upload should dedup names: $FUP2";; esac
case "$(curl -s -X POST "$B/api/fs/upload" -H 'content-type: application/json' --data "{\"path\":\"/etc\",\"name\":\"x\",\"dataB64\":\"eA==\"}")" in *'root'*) : ;; *) fail "fs/upload must jail outside root";; esac
case "$CKPT" in *'function uploadToTab'*'/api/fs/upload'*) : ;; *) fail "cockpit file-attach (uploadToTab drop) missing";; esac
rm -rf "$FSD"
pass "file viewer: marked + viewer pane + fs list/read/find/jail/raw-inline/write(.env edit) + upload/attach + terminal path links"

# issue #7 — Funnel must be discriminated by AllowFunnel, not by port (serve/funnel share one ServeConfig)
grep -q 'funnelActiveForPort' src/remote.ts || fail "remote.ts: funnel AllowFunnel discrimination missing (issue #7)"
grep -q 'AllowFunnel' src/remote.ts || fail "remote.ts: AllowFunnel check missing (issue #7)"
grep -q 'tailnet only' src/remote.ts || fail "remote.ts: funnel text-fallback guard missing (issue #7)"
# session tree row: name-first (path capped + full path on hover via title)
case "$CKPT" in *'.tnode.session .p{flex:0 1 auto;max-width:'*) : ;; *) fail "session row: path should be capped so the name stays visible";; esac
case "$CKPT" in *'<span class="p" title="'*) : ;; *) fail "session row: full path should be on hover (title attr)";; esac
pass "issue #7 funnel discrimination + session row name-first layout (path capped, full path on hover)"

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
case "$CKPT" in *"kind!=='sessions'"*'>Scratch<'*) : ;; *) fail "cockpit scratch tree section / project split missing";; esac
case "$CKPT" in *'.panes{flex:1;display:none'*) : ;; *) fail "cockpit empty panes should default to display:none (grey-box fix)";; esac
# folder/file pickers show a loading state + surface HTTP errors (empty list must never be silent)
case "$CKPT" in *'불러오는 중…'*'인증이 만료'*) : ;; *) fail "pickers should show loading + auth/HTTP error instead of a blank list";; esac
pass "cockpit free session (workbench) opener + empty-state grey-box fix + picker loading/error surfacing"

# Tabs + split-tree panes: open=tab, manual split, drag tab→slot, fan-out auto-tiles, rename
case "$CKPT" in *'id="tabs"'*'id="splitRow"'*'function buildNode'*'function splitFocused'*) : ;; *) fail "cockpit tab bar / split-tree missing";; esac
case "$CKPT" in *'function tileTabs'*'tileTabs(ids)'*) : ;; *) fail "cockpit fan-out should auto-tile into tabs (tileTabs)";; esac
case "$CKPT" in *'function startRename'*'function renameTask'*"'/api/tasks/'"*) : ;; *) fail "cockpit tab rename wiring missing";; esac
case "$CKPT" in *'id="pickName"'*'title:nm'*) : ;; *) fail "cockpit session-name input missing";; esac
pass "cockpit tabs + split-tree panes + session naming/rename"

# v6.0 Part T — 작업 트리(Scratch 섹션이 먼저, 그 다음 프로젝트 섹션 ▸ 작업 ▸ 세션) + 생성 어포던스.
# 파일 순서 그대로 매칭: Scratch 마크업이 repo 섹션의 ＋새 작업 보다 앞에 있어야 한다.
case "$CKPT" in *'>Scratch<'*'data-newwork='*'data-newagent='*) : ;; *) fail "cockpit work tree order/affordances missing (Scratch → repo ＋새 작업 → work ＋에이전트)";; esac
case "$CKPT" in *'>＋ 새 작업</button>'*'>＋ 에이전트</button>'*) : ;; *) fail "cockpit tree create affordances (＋ 새 작업 / ＋ 에이전트) missing";; esac
case "$CKPT" in *'id="workModal"'*'id="workName"'*'id="agentModal"'*'id="agentRole"'*'id="agentProv"'*'id="agentModel"'*) : ;; *) fail "cockpit new-work / add-agent sheets missing";; esac
case "$CKPT" in *'function runLabel'*'function renameRun'*'function openNewWork'*'function openAddAgent'*) : ;; *) fail "cockpit work-tree logic (runLabel/renameRun/openNewWork/openAddAgent) missing";; esac
# 이름 규칙: 프로젝트 아래 root 세션은 main, 역할은 run.title, 그 외는 프로바이더 이름
case "$CKPT" in *"r.agent==='session') return 'main'"*) : ;; *) fail "cockpit root-session tab/tree name should fall back to main";; esac
# 새 작업 = /api/workbench root:true · 에이전트 = /api/tasks/:id/run count:1 + title
case "$CKPT" in *"'/api/workbench'"*'root:true'*"'/api/tasks/'+agentTaskId+'/run'"*'count:1'*) : ;; *) fail "cockpit work/agent creation should reuse the existing endpoints";; esac
pass "v6.0 T1–T4 cockpit: Scratch→project▸work▸session tree + ＋새 작업/＋에이전트 sheets + run role naming"

# v6.0 Part S — Scratch(리프레임) · 정리(S1b) · 승격(S2). 파일 순서대로 매칭:
# CSS → 시트 마크업 → 트리 라벨/행 → 정리 로직 → 승격 로직.
case "$CKPT" in *'.scrub-row{'*'.scrub-fold{'*) : ;; *) fail "cockpit Scratch styles (scrub-row/scrub-fold) missing";; esac
# 정리 판은 **폴더는 보존된다**고 말하고, 접힌 오래된 세션은 선택도 삭제도 되지 않는다고 말한다
case "$CKPT" in *'id="scrubModal"'*'폴더와 파일은 언제나 그대로 보존'*'선택되지도 지워지지도 않습니다'*'id="scrubList"'*'id="scrubGo"'*) : ;; *) fail "cockpit Scratch cleanup sheet must state the folder is preserved and that folded sessions are untouched";; esac
# 승격 메뉴 — 등록 / 이동 두 길
case "$CKPT" in *'id="promoModal"'*'data-promo="register"'*'>프로젝트로 등록<'*'data-promo="move"'*'>프로젝트로 이동<'*) : ;; *) fail "cockpit promotion menu (프로젝트로 등록 / 프로젝트로 이동) missing";; esac
# 라벨 = Scratch + 섹션 ⋯(v5.28 G2 — Tidy… 는 그 메뉴 안이다) + 행마다 ⇧ 승격
case "$CKPT" in *'<span>Scratch</span>'*'data-menu="scratch"'*'data-promote='*"{ act:'scrub', label:'Tidy…' }"*) : ;; *) fail "cockpit Scratch section needs the reframe label + the ⋯ carrying Tidy… + per-session promote";; esac
# 오래된 세션은 접기만 한다 — 접는 것은 훑기 위한 장치이지 지우는 장치가 아니다
case "$CKPT" in *'SCRUB_STALE_DAYS = 14'*'data-scrubold="1"'*'오래된 세션 '*'접힌 것은 지워지지 않습니다'*) : ;; *) fail "cockpit Scratch cleanup must fold >14d-quiet sessions without deleting anything";; esac
# 지우는 길은 기존 세션 삭제 하나 — 한 건이든 정리 판이든 같은 DELETE /api/runs/:id 를 지난다
case "$CKPT" in *'function delSessionReq'*"'/api/runs/'+runId,{method:'DELETE'}"*'function deleteSession'*'function runScrub'*) : ;; *) fail "cockpit cleanup must reuse the existing deleteSession path (DELETE /api/runs/:id)";; esac
# 승격 = 기존 등록 흐름(POST /api/repos) + 재부모화(PATCH /api/tasks/:id {repoId}), 밖이면 경고하되 막지 않는다
case "$CKPT" in *"'/api/repos'"*"'/api/tasks/'+promoTaskId"*'repoId:repoId'*) : ;; *) fail "cockpit promotion must reuse POST /api/repos + PATCH /api/tasks/:id {repoId}";; esac
case "$CKPT" in *'function paintPromoWarn'*'밖입니다'*'터미널은 이 폴더에서 그대로 돕니다'*) : ;; *) fail "cockpit promotion must warn (not hide) when the session folder lies outside the chosen repo";; esac
pass "v6.0 S1/S1b/S2 cockpit: Scratch reframe + cleanup sheet (folder preserved · stale fold) + promotion menu (등록/이동)"

# v6.0 Part P — 격리는 선택이다. 시트에 둘 곳 세그(worktree 기본 │ in-place) + 대가를 말하는 한 줄.
# 파일 순서대로: 세그 → 정직한 한 줄 → 인라인 에러 자리.
case "$CKPT" in *'id="agentPlace"'*'data-place="worktree"'*'data-place="inplace"'*) : ;; *) fail "cockpit add-agent place chooser (worktree│in-place) missing";; esac
case "$CKPT" in *'sheet-tradeoff'*'in-place = 체크아웃 공유, 순차 · worktree = 병렬, 나중에 머지'*) : ;; *) fail "cockpit place chooser must state the tradeoff in one honest line (P4)";; esac
case "$CKPT" in *'id="agentErr"'*'function agentErr'*'res.status===409'*) : ;; *) fail "cockpit IN_PLACE_BUSY 409 should surface inline in the sheet, not as a vanishing toast";; esac
# 기본은 worktree(지금까지의 손버릇 그대로), 발사는 inPlace 를 실어 보낸다
case "$CKPT" in *"agentPlace='worktree'"*"inPlace:(agentPlace==='inplace')"*) : ;; *) fail "cockpit add-agent should default to worktree and post inPlace";; esac
# in-place 는 브랜치가 없으니 브랜치 칩도 없다 — 트리는 in-place 라고만 적고, 머지 버튼은 왜 꺼졌는지 말한다
case "$CKPT" in *"' · in-place'"*"noIso ? 'in-place'"*) : ;; *) fail "cockpit in-place marker (tree meta + compare merge label) missing";; esac
pass "v6.0 P4 cockpit: place chooser (worktree default │ in-place) + honest tradeoff line + inline 409 + in-place marker"

# v6.0 Part W — WORK.md 는 작업의 공유 컨텍스트다. 작업 행에서 열고, 저장은 **다음 발사·steer** 부터 닿는다.
# 파일 순서대로: 작업 행 어포던스(약속 문구 포함) → 클릭 배선 → 뷰어 배관 → 여는 함수.
case "$CKPT" in *'data-workmd='*'다음 발사·steer 부터'*'▤ WORK.md</button>'*) : ;; *) fail "cockpit work node needs a WORK.md affordance saying saves reach the NEXT launch/steer";; esac
case "$CKPT" in *'[data-workmd]'*'openWorkDoc(+wm.dataset.workmd)'*) : ;; *) fail "cockpit WORK.md affordance is not wired";; esac
# 이모지 금지 — 스펙의 📝 는 약칭이고, 코크핏은 모노 글리프로 그린다
case "$CKPT" in *'📝'*) fail "the cockpit forbids emoji — WORK.md gets a mono glyph";; *) : ;; esac
# 새 파일 창구를 만들지 않는다: 기본은 기존 /api/fs 뷰어, md 도 편집 가능해진다(WORK.md 가 사는 곳)
case "$CKPT" in *"'/api/fs/read?path='"*"d.kind==='md' && d.editable"*) : ;; *) fail "md viewer panes must keep reading via /api/fs and offer 편집";; esac
case "$CKPT" in *"'/api/tasks/'+taskId+'/work'"*'ensureViewer(j.path'*'edit:true'*) : ;; *) fail "WORK.md must open in the existing file-viewer pane in edit mode";; esac
pass "v6.0 W2 cockpit: WORK.md on the work node (mono ▤) → existing viewer pane in edit mode + the next-launch/steer promise"

# v6.0 Part B — 보드는 물러난다. 코크핏이 집이고, 보드는 ⌘K 한 번 거리의 읽는 방이다.
# 파일 순서대로: gotoBoard 헬퍼 → 팔레트의 세 항목(Board · Archive · Workrooms).
case "$CKPT" in *'function gotoBoard(view)'*"location.href = view ? ('/?view='"*) : ;; *) fail "cockpit gotoBoard(view) helper missing (⌘K → board views)";; esac
case "$CKPT" in *"label:'Board — 보드 (리뷰·기록실)'"*"label:'Archive — 닫힌 작업 보관함'"*"label:'Workrooms — 골 워크룸'"*) : ;; *) fail "cockpit ⌘K palette must offer Board / Archive / Workrooms";; esac
case "$CKPT" in *"gotoBoard('')"*"gotoBoard('archive')"*"gotoBoard('goals')"*) : ;; *) fail "the ⌘K board entries must be wired to the board's own views";; esac
# 헤더의 ← Board 는 그대로다 — 팔레트는 더한 것이지 옮긴 것이 아니다
case "$CKPT" in *'class="toggle" href="/"'*) : ;; *) fail "the header ← Board toggle must survive Part B (nothing is removed)";; esac
# 보드 쪽: 새 진입 경로가 아니라 이미 있는 setView 를 기존 /?run= 딥링크 블록에서 깨운다
case "$BOARD_HTML" in *'function setView(v)'*'const DEEP_VIEWS'*'function openFromURL'*"sp.get('view')"*'setView(v)'*) : ;; *) fail "board ?view= deep link must reuse setView inside the existing openFromURL block";; esac
# 보드는 아무것도 잃지 않았다 — 뷰 nav 다섯 자리와 아카이브/워크룸 실물이 그대로 선다
case "$BOARD_HTML" in *'data-view="active"'*'data-view="goals"'*'data-view="documents"'*'data-view="archive"'*'data-view="settings"'*) : ;; *) fail "board view nav entries lost (Part B removes nothing)";; esac
case "$BOARD_HTML" in *'id="archive"'*'gband-open'*'async function openRoom'*) : ;; *) fail "board archive list / workroom entry lost (Part B removes nothing)";; esac
expect_code 200 "$B/?view=archive"
expect_code 200 "$B/?view=goals"
case "$CKPT" in *'id="vtDocs"'*) : ;; *) fail "Docs vtab must be enabled and wired to the board (not disabled)";; esac
pass "v6.0 Part B: ⌘K reaches Board/Archive/Workrooms (board's own setView via ?view=) — header toggle + every board view intact"

# v6.0 T6 — 어질러지는 자리에서 치운다. 프로젝트 노드의 등록 해제·묵은 작업 정리 + 고아 터미널 수거.
# 파일 순서대로: 행 스타일 → 레일의 ↻ 링크 → 세 판 → repo 행 어포던스 → 로직.
case "$CKPT" in *'.scrub-row .swarn{'*'.scrub-row.risky .snm{'*) : ;; *) fail "cockpit T6 hygiene row styles (.swarn flag / .risky row) missing";; esac
# 수거는 보드의 Reclaim 과 같은 유지보수 가족 — 코크핏엔 아이콘 스프라이트가 없으니 모노 ↻ 로 선다.
# v5.28 F 이후 그 ↻ 는 Workspace 헤더의 ⋯ 메뉴 항목이다(라벨은 영어, 하는 일은 그대로).
case "$CKPT" in *"label:'↻ Orphans'"*) : ;; *) fail "cockpit orphan-tmux reaper entry (mono ↻ in the Workspace ⋯ menu) missing";; esac
# 정리 판: 정착한 작업만 · worktree 는 걷히고 repo 체크아웃은 남는다 · 미머지는 미리 체크하지 않는다
case "$CKPT" in *'id="tidyModal"'*'묵은 작업 정리'*'터미널이 살아 있는 작업은 목록에 없습니다'*'repo 체크아웃과 그 파일은 그대로'*'미머지 표시가 붙은 것은 미리 체크하지 않습니다'*'id="tidyList"'*'id="tidyGo"'*) : ;; *) fail "cockpit stale-work cleanup sheet must state what it closes, what survives on disk, and that risky rows are not preselected";; esac
# 등록 해제 판: 등록만 뺀다 — 디스크의 폴더는 그대로, 다시 등록은 클릭 한 번 + 열린 작업의 close 가드 합산
case "$CKPT" in *'id="unregModal"'*'목록에서만 뺍니다 — 디스크의 폴더와 파일은 손대지 않습니다'*'다시 등록하는 데는 클릭 한 번'*'id="unregRisk"'*'id="unregGo"'*) : ;; *) fail "cockpit unregister sheet must say registration-only (folder untouched, one click to re-register) and aggregate the close risk";; esac
# 수거 판: 살아 있는 run 의 세션은 오르지도 않고, 돌고 있는 것은 표시만 한다
case "$CKPT" in *'id="reapModal"'*'살아 있는 run 의 세션은 여기 오르지 않습니다'*'표시만 하고 절대 미리 고르지 않습니다'*'id="reapList"'*'id="reapGo"'*) : ;; *) fail "cockpit orphan-reaper panel must exclude live runs and never preselect a busy pane";; esac
# 둘 다 살아 있다 — v5.28 D-rail 에서 repo 행의 상시 버튼이 아니라 ⋯ 메뉴 항목이 됐을 뿐이다.
T6_TIDY="act:'tidy'"
T6_UNREG="act:'unreg'"
case "$CKPT" in *"$T6_TIDY"*"label:'정리…'"*"$T6_UNREG"*"label:'등록 해제'"*'openTidy(id)'*'openUnreg(id)'*) : ;; *) fail "project node needs both hygiene affordances (묵은 작업 정리… / 등록 해제), reachable from the ⋯ menu";; esac
# 기존 창구 재사용 — 진짜 새 서버 표면은 고아 tmux 둘뿐이다
case "$CKPT" in *"'/api/tasks/'+taskId+'/close'"*"'/api/repos/'+unregRepoId,{method:'DELETE'}"*"'/api/tmux/orphans'"*"'/api/tmux/orphans/kill'"*) : ;; *) fail "T6 must reuse close/repo-delete and add only the two orphan endpoints";; esac
# 409 는 작업 수만큼 창을 띄우지 않는다 — 표는 한 번, 확인도 한 번("그래도 닫기")
case "$CKPT" in *'function closeRiskOf'*'그래도 닫기 ('*'r.status===409'*) : ;; *) fail "close-risk must be aggregated once (table + one 그래도 닫기), never N dialogs";; esac
# 빈 셸만 미리 체크 — 보여주지 않은 것을 지우는 판은 빗자루가 아니라 함정이다
case "$CKPT" in *'if(x.idle) reapSel[x.name]=true;'*) : ;; *) fail "the reaper must preselect idle shells only";; esac
pass "v6.0 T6 cockpit: 등록 해제 (folder preserved · close-risk aggregated) · 묵은 작업 정리 (one table, one pass) · orphan-tmux reaper (idle preselected, busy flagged)"

# v5.28 D-rail — 레일의 폭은 이름 것이다. T6 가 repo 행에 버튼 셋을 세우자 프로젝트 이름이 밀렸다.
# 파일 순서대로: 자리까지 비우는 hover 규칙 → 작은 자체 메뉴 스타일 → 메뉴 판 → repo 행(이름 먼저, ⋯ 하나) → 여는 함수.
case "$CKPT" in *'.tnode.repo .tact{display:none;margin-left:2px}'*) : ;; *) fail "the repo row must reveal actions with display, not opacity — opacity:0 keeps the width and eats the name";; esac
case "$CKPT" in *'.rmenu{position:fixed'*'.rmenu button{'*) : ;; *) fail "cockpit needs its own small overflow menu (never cross-import the board's .dd)";; esac
case "$CKPT" in *'<div class="rmenu" id="rowMenu"'*) : ;; *) fail "the ⋯ overflow menu panel is missing";; esac
# 행 순서: 이름(.n) 이 먼저 폭을 갖고, 액션은 그 뒤 — T6 버튼 둘은 더 이상 이름 앞을 막지 않는다
case "$CKPT" in *'class="tnode repo"'*'class="n"'*'class="meta"'*'data-newwork='*'class="tact tmore" data-more='*) : ;; *) fail "repo row order must be name → meta → ＋ 새 작업 → ⋯ (the name is never preceded by the actions)";; esac
case "$CKPT" in *'<button class="tact" data-tidy='*) fail "정리… must live in the ⋯ menu, not as an always-present flex:none button on the repo row";; *) : ;; esac
case "$CKPT" in *'<button class="tact" data-unreg='*) fail "등록 해제 must live in the ⋯ menu, not as an always-present flex:none button on the repo row";; *) : ;; esac
# 메뉴는 클릭으로 열린다(hover 가 없는 모바일도 닿는다)·Escape/바깥클릭이 닫는다·키보드로 잡힌다
# (Part F extracted a shared menu helper, so these 4 no longer sit in a fixed order — assert presence, not sequence.)
case "$CKPT" in *'function openRowMenu'*) : ;; *) fail "the ⋯ menu opener (openRowMenu) is missing";; esac
case "$CKPT" in *'function closeRowMenu'*) : ;; *) fail "the ⋯ menu closer (closeRowMenu) is missing";; esac
case "$CKPT" in *'role="menuitem"'*) : ;; *) fail "the ⋯ menu items must be role=menuitem";; esac
case "$CKPT" in *'first.focus()'*) : ;; *) fail "the ⋯ menu must be keyboard-focusable on open (first.focus())";; esac
D_MENUESC="if(e.key==='Escape' && !\$('rowMenu').hidden){ e.preventDefault(); var o=rowMenuOwner; closeRowMenu(); if(o) o.focus(); }"
case "$CKPT" in *"$D_MENUESC"*) : ;; *) fail "Escape must close the ⋯ menu and hand focus back to the ⋯ button";; esac
pass "v5.28 D-rail: repo row keeps the name's width — 정리…/등록 해제 collapse into one always-visible ⋯ menu (click-opened, Escape-closed)"

# v6.0 T6b — 디스크 빚을 보이게 하고, 되찾을 수 있게 하되, 유일한 사본은 놀라서 사라지지 않게.
# 파일 순서대로: 레일의 ▤ 링크 → 회수 판(한 줄 판독 + 규칙) → 로직(미리 체크 규칙 · 언제나 runIds).
case "$CKPT" in *"label:'▤ Worktrees'"*) : ;; *) fail "cockpit worktree-reclaim entry (mono ▤ in the Workspace ⋯ menu) missing";; esac
# 판이 열리면 **먼저 숫자**(개수·총량), 그 다음 빗자루 — 볼 수 없는 것은 관리할 수 없다
case "$CKPT" in *'id="wtModal"'*'id="wtTotal"'*'돌고 있는 run 은 여기 오르지 않습니다'*'표시만 하고 절대 미리 고르지 않습니다'*'유일한 사본'*'id="wtList"'*'id="wtGo"'*) : ;; *) fail "cockpit worktree sheet must lead with the disk readout and state the sole-copy rule";; esac
case "$CKPT" in *'function wtRowHTML'*'if(!x.reclaimRisk) wtSel[x.runId]=true;'*'body:JSON.stringify({runIds:ids})'*) : ;; *) fail "the worktree sheet must preselect only non-risky rows and always post explicit runIds";; esac
pass "v6.0 T6b cockpit: ▤ worktree sheet (disk readout first · risky flagged, never preselected · explicit runIds)"

# 마지막 세션 자동 기억/복원: 첫 hydrate 뒤 restoreSession, render 말미 persistSession (파일 순서대로 매칭).
case "$CKPT" in *'restoreSession();'*'persistSession();'*"'coxpit.session'"*'function persistSession'*'function restoreSession'*) : ;; *) fail "cockpit last-session persist/restore missing or unwired";; esac
pass "cockpit remembers + auto-restores the last open session tabs (localStorage snapshot, dead runs pruned)"

# Session delete affordance present in the cockpit (endpoint flow is tested at the end — it consumes ids)
case "$CKPT" in *'data-delsession'*'function deleteSession'*) : ;; *) fail "cockpit session delete affordance/handler missing";; esac

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

# 코크핏도 같은 덫에 걸린다 — 한 줄 문법 오류면 터미널 셸 전체가 빈 화면이 된다.
CKFILE="$WORK/cockpit.html"
printf '%s' "$CKPT" > "$CKFILE"
node -e '
  const fs=require("fs");
  const html=fs.readFileSync(process.argv[1],"utf8");
  const m=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x=>x[1]);
  const js=m[m.length-1];
  if(!js||js.length<1000){console.error("cockpit script extract failed");process.exit(2);}
  fs.writeFileSync(process.argv[2],js);
' "$CKFILE" "$WORK/cockpit-client.js" || fail "could not extract cockpit client script"
node --check "$WORK/cockpit-client.js" || fail "cockpit client JS has a syntax error (cockpit would blank)"
pass "served cockpit client JS parses (node --check)"

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
# v5.28 D-fix — 페인이 지금 서 있는 폴더. 터미널이 찍은 상대경로는 worktree 루트가 아니라 이걸 기준으로 푼다.
# 정확한 경로는 tmux/플랫폼에 따라 심링크 해소가 갈리니 값은 눈감고, **모양과 정직함**만 못박는다.
FPWD=$(curl -sf "$B/api/runs/$FSRUN/pwd") || fail "GET /api/runs/:id/pwd failed"
echo "$FPWD" | node -e '
let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{
  const j=JSON.parse(b);
  if(!("pwd" in j)) throw new Error("the pwd payload must always carry a pwd key: "+b);
  if(typeof j.pwd!=="string") throw new Error("pwd must be a string: "+b);
  if(j.ok && !j.pwd) throw new Error("ok:true with an empty pwd would be a fabricated answer: "+b);
  if(!j.ok && j.pwd) throw new Error("ok:false must come with an empty pwd: "+b);
  console.log("pwd shape ok");
})' || fail "pwd payload shape wrong: $FPWD"
expect_code 404 "$B/api/runs/999999/pwd"
pass "v5.28 D-fix: GET /api/runs/:id/pwd reports the pane's current dir (unknown run 404s; never a guessed path)"
curl -s -X POST "$B/api/session" -H 'content-type: application/json' -d '{"machineSlug":"local"}' -o /dev/null -w '%{http_code}' | grep -q 400 || fail "session without path should 400"
curl -s -X POST "$B/api/runs/$FSRUN/cleanup" | grep -q '"ok":true' || fail "free session cleanup"
[ -f "$SESSDIR/keep.txt" ] || fail "free session close destroyed the folder"
pass "free session: arbitrary folder, isolated from projects (sessions bucket), close preserves folder"

# v6.0 Part T — Project ▸ Work ▸ Session 이 데이터로 그대로 선다.
# ① 새 작업 = /api/workbench root:true → repo 아래 task + root 세션 run(agent='session')
NW=$(curl -sf -X POST "$B/api/workbench" -H 'content-type: application/json' -d '{"repoId":1,"title":"기능 업데이트 6.0","root":true}')
NWTASK=$(echo "$NW" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).taskId))')
NWRUN=$(echo "$NW" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).runId))')
[ -n "$NWTASK" ] && [ -n "$NWRUN" ] || fail "new work did not return task/run: $NW"
curl -s "$B/api/fleet?view=all" | NWTASK="$NWTASK" NWRUN="$NWRUN" node -e '
let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{
  const j=JSON.parse(b), tid=Number(process.env.NWTASK), rid=Number(process.env.NWRUN);
  const t=(j.tasks||[]).find(x=>x.id===tid);
  if(!t) throw new Error("work missing from fleet");
  if(t.title!=="기능 업데이트 6.0") throw new Error("work title: "+t.title);
  const repo=(j.repos||[]).find(x=>x.id===t.repoId);
  if(!repo || repo.kind==="sessions") throw new Error("a work must sit under a real repo section, got "+JSON.stringify(repo));
  const r=(j.runs||[]).find(x=>x.id===rid);
  if(!r) throw new Error("root run missing from fleet");
  if(r.taskId!==tid) throw new Error("root run is not under the work");
  if(r.agent!=="session") throw new Error("root run agent should be session, got "+r.agent);
  if(r.branch!=="") throw new Error("root run must have no branch, got "+r.branch);
  console.log("work tree ok");
})' || fail "new work not visible as repo▸work▸session in /api/fleet"

# ② 에이전트 추가 = /api/tasks/:id/run { count:1, title } → 만들어진 run 이 역할 이름을 갖는다
AG=$(curl -sf -X POST "$B/api/tasks/$NWTASK/run" -H 'content-type: application/json' -d '{"agent":"claude-code","count":1,"title":"구현","model":"opus"}')
AGRUN=$(echo "$AG" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).runs[0].id))')
[ -n "$AGRUN" ] || fail "add agent did not return a run: $AG"
curl -s "$B/api/fleet?view=all" | AGRUN="$AGRUN" NWTASK="$NWTASK" node -e '
let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{
  const j=JSON.parse(b), rid=Number(process.env.AGRUN);
  const r=(j.runs||[]).find(x=>x.id===rid);
  if(!r) throw new Error("agent run missing from fleet");
  if(r.taskId!==Number(process.env.NWTASK)) throw new Error("agent run is not under the work");
  if(r.title!=="구현") throw new Error("agent run title: "+JSON.stringify(r.title));
  if(r.model!=="opus") throw new Error("agent run model: "+JSON.stringify(r.model));
  console.log("role title ok");
})' || fail "run role title not carried into /api/fleet"

# ③ 역할 이름 변경 = PATCH /api/runs/:id { title } (빈값·과길이는 400, 없는 run 은 404)
RNR=$(curl -s -X PATCH "$B/api/runs/$AGRUN" -H 'content-type: application/json' -d '{"title":"기타"}')
case "$RNR" in *'"title":"기타"'*) : ;; *) fail "run rename PATCH failed: $RNR";; esac
RNG=$(curl -s "$B/api/runs/$AGRUN")
case "$RNG" in *'"title":"기타"'*) : ;; *) fail "run rename not persisted";; esac
expect_code 400 -X PATCH "$B/api/runs/$AGRUN" -H 'content-type: application/json' -d '{"title":"   "}'
LONGT=$(node -e 'console.log("가".repeat(61))')
expect_code 400 -X PATCH "$B/api/runs/$AGRUN" -H 'content-type: application/json' -d "{\"title\":\"$LONGT\"}"
expect_code 404 -X PATCH "$B/api/runs/999999" -H 'content-type: application/json' -d '{"title":"x"}'
# 이 작업이 남긴 worktree·브랜치는 여기서 정리(뒤 테스트의 브랜치 검사를 깨끗하게)
for i in $(seq 1 40); do
  AS=$(curl -s "$B/api/runs/$AGRUN" | { grep -oE '"status":"(done|failed|error)"' || true; } | head -1)
  [ -n "$AS" ] && break; sleep 0.5
done
curl -s -X POST "$B/api/tasks/$NWTASK/close" -H 'content-type: application/json' -d '{"force":true}' >/dev/null
[ -f "$REPO/README.md" ] && [ -d "$REPO/.git" ] || fail "closing the work destroyed the repo checkout"
pass "v6.0 Part T: work(root:true) under a repo + agent run carries a role title + PATCH run rename (400/404 guarded)"

# v6.0 Part P — 격리는 선택이다. in-place run = worktree 도 브랜치도 없이 repo 체크아웃에서 그대로.
# 남는 자국은 **루트 세션 마커 그대로**(branch='' · worktreePath=repo.path) — 새 개념이 아니다.
# 전용 fixture repo 를 쓴다: in-place 는 체크아웃에 직접 쓰므로 다른 테스트의 repo 를 더럽히면 안 된다.
IPREPO="$WORK/repo-inplace"
mkdir -p "$IPREPO"; git -C "$IPREPO" init -q -b main
printf 'seed\n' > "$IPREPO/README.md"; git -C "$IPREPO" add -A
git -C "$IPREPO" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q -m init
IPR=$(curl -sf -X POST "$B/api/repos" -H 'content-type: application/json' -d "{\"machineSlug\":\"local\",\"path\":\"$IPREPO\"}")
IPRID=$(echo "$IPR" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).repo.id))')
IPT=$(curl -sf -X POST "$B/api/tasks" -H 'content-type: application/json' -d "{\"repoId\":$IPRID,\"title\":\"in-place 작업\",\"prompt\":\"do work\"}")
IPTID=$(echo "$IPT" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).task.id))')
# ① in-place 발사 → ② 곧바로 두 번째 in-place. 두 요청을 **한 curl 안에서**(--next) 붙여 쏜다 —
# 드라이런은 1초 안에 정착하므로, 별도 프로세스로 쏘면 "살아있는 동안"이라는 전제가 흔들린다.
IPPAIR=$(curl -s -w '\nHTTP%{http_code}\n' -X POST "$B/api/tasks/$IPTID/run" -H 'content-type: application/json' \
  -d '{"agent":"claude-code","count":1,"title":"구현","inPlace":true}' \
  --next -s -w '\nHTTP%{http_code}\n' -X POST "$B/api/tasks/$IPTID/run" -H 'content-type: application/json' \
  -d '{"count":1,"inPlace":true}')
case "$IPPAIR" in *'HTTP202'*'IN_PLACE_BUSY'*'HTTP409'*) : ;; *) fail "a second in-place agent on a live checkout must be refused 409 IN_PLACE_BUSY: $IPPAIR";; esac
case "$IPPAIR" in *'steer it, or launch in a worktree'*) : ;; *) fail "IN_PLACE_BUSY must say what to do instead: $IPPAIR";; esac
# ③ 한 체크아웃 = 한 에이전트. 팬아웃은 말이 안 되므로 살아있든 아니든 400.
IPFAN=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/tasks/$IPTID/run" -H 'content-type: application/json' -d '{"count":2,"inPlace":true}')
[ "$IPFAN" = "400" ] || fail "in-place fan-out (count>1) should 400, got $IPFAN"
# ④ worktree run 은 영향 없음 — 같은 repo 에서도 자기 브랜치를 받는다
IPW=$(curl -sf -X POST "$B/api/tasks/$IPTID/run" -H 'content-type: application/json' -d '{"count":1,"title":"기타"}')
IPRUN=$(printf '%s' "$IPPAIR" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b.split("\n")[0]).runs[0].id))')
IPWRUN=$(echo "$IPW" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).runs[0].id))')
[ -n "$IPRUN" ] || fail "in-place launch did not return a run: $IPPAIR"
[ -n "$IPWRUN" ] || fail "worktree run alongside an in-place run was refused: $IPW"
for r in "$IPRUN" "$IPWRUN"; do
  IPS=''
  for i in $(seq 1 60); do
    IPS=$(curl -s "$B/api/runs/$r" | { grep -oE '"status":"(done|failed|error)"' || true; } | head -1)
    [ -n "$IPS" ] && break; sleep 0.5
  done
  [ -n "$IPS" ] || fail "run r$r did not settle"
done
# 마커 검증: in-place 는 브랜치 없음 + worktreePath = 체크아웃 · worktree run 은 지금까지 그대로
curl -s "$B/api/fleet?view=all" | IPRUN="$IPRUN" IPWRUN="$IPWRUN" IPREPO="$IPREPO" node -e '
let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{
  const j=JSON.parse(b), find=(id)=>(j.runs||[]).find(x=>x.id===Number(id));
  const ip=find(process.env.IPRUN), wt=find(process.env.IPWRUN);
  if(!ip||!wt) throw new Error("runs missing from fleet");
  if(ip.inPlace!==true) throw new Error("in-place run should carry inPlace=true");
  if(ip.branch!=="") throw new Error("in-place run must have no branch, got "+JSON.stringify(ip.branch));
  if(ip.worktreePath!==process.env.IPREPO) throw new Error("in-place worktreePath should be the checkout, got "+ip.worktreePath);
  if(wt.inPlace!==false) throw new Error("worktree run should not be in-place");
  if(wt.branch!=="coxpit/r"+wt.id) throw new Error("worktree run lost its branch: "+wt.branch);
  if(wt.worktreePath===process.env.IPREPO) throw new Error("worktree run must not live in the checkout");
  console.log("in-place marker ok");
})' || fail "in-place / worktree markers wrong in /api/fleet"
[ ! -d "$WORK/.coxpit-worktrees/r$IPRUN" ] || fail "in-place run must not create a worktree dir"
[ -z "$(git -C "$IPREPO" branch --list "coxpit/r$IPRUN")" ] || fail "in-place run must not create a branch"
[ -d "$WORK/.coxpit-worktrees/r$IPWRUN" ] || fail "the worktree run lost its isolated worktree"
# 에이전트의 편집은 체크아웃에 바로 있다 — main 터미널에서 그대로 보이는 그 파일이다
[ -f "$IPREPO/COXPIT_DRYRUN.txt" ] || fail "in-place agent edits should land in the checkout"
# diff 는 체크아웃의 커밋 안 한 변경(정직하게) · merge 는 마커 때문에 자동 거부
curl -s "$B/api/runs/$IPRUN/diff" | grep -q 'COXPIT_DRYRUN' || fail "in-place diff should show the checkout's uncommitted changes"
expect_code 409 -X POST "$B/api/runs/$IPRUN/merge"
# 닫아도 체크아웃은 남는다(격리 worktree 가 아니니 지울 것이 없다)
curl -s -X POST "$B/api/tasks/$IPTID/close" -H 'content-type: application/json' -d '{"force":true}' >/dev/null
[ -f "$IPREPO/README.md" ] && [ -d "$IPREPO/.git" ] || fail "closing an in-place work destroyed the repo checkout"
# 정착한 뒤에는 그 체크아웃이 비므로 다음 in-place 는 다시 허용된다(가드는 '지금 일하는 중'만 막는다)
IPT2=$(curl -sf -X POST "$B/api/tasks" -H 'content-type: application/json' -d "{\"repoId\":$IPRID,\"title\":\"in-place 다음\",\"prompt\":\"more\"}")
IPT2ID=$(echo "$IPT2" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).task.id))')
curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/tasks/$IPT2ID/run" -H 'content-type: application/json' -d '{"count":1,"inPlace":true}' | grep -q 202 || fail "in-place should be allowed again once the checkout is free"
IPR2=$(curl -s "$B/api/tasks/$IPT2ID" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).runs[0].id))')
for i in $(seq 1 60); do
  IPS2=$(curl -s "$B/api/runs/$IPR2" | { grep -oE '"status":"(done|failed|error)"' || true; } | head -1)
  [ -n "$IPS2" ] && break; sleep 0.5
done
curl -s -X POST "$B/api/tasks/$IPT2ID/close" -H 'content-type: application/json' -d '{"force":true}' >/dev/null
pass "v6.0 Part P: in-place run = root-session marker (no worktree/branch, edits in the checkout) · second live in-place 409 · count>1 400 · worktree run unaffected"

# task/session rename — PATCH /api/tasks/:id { title }
RNT=$(curl -sf -X POST "$B/api/tasks" -H 'content-type: application/json' -d '{"repoId":1,"title":"before","prompt":"x"}')
RNTID=$(echo "$RNT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["task"]["id"])')
curl -s -X PATCH "$B/api/tasks/$RNTID" -H 'content-type: application/json' -d '{"title":"after name"}' | grep -q '"title":"after name"' || fail "task rename PATCH failed"
curl -s "$B/api/tasks/$RNTID" | grep -q '"title":"after name"' || fail "task rename not persisted"
expect_code 400 -X PATCH "$B/api/tasks/$RNTID" -H 'content-type: application/json' -d '{"title":""}'
curl -s -X POST "$B/api/tasks/$RNTID/close" -H 'content-type: application/json' -d '{"force":true}' >/dev/null
pass "task/session rename: PATCH title (empty→400, persisted)"

# v6.0 Part S — 승격. Scratch 의 생각 하나가 프로젝트가 된다 — 터미널을 잃지 않고.
# ① 자유 세션(= sessions 버킷)을 하나 열고 그 작업을 실제 repo 아래로 재부모화
PRSESS="$WORK/scratch idea"
mkdir -p "$PRSESS"; printf 'idea\n' > "$PRSESS/note.txt"
PRS=$(curl -sf -X POST "$B/api/session" -H 'content-type: application/json' -d "{\"machineSlug\":\"local\",\"path\":\"$PRSESS\",\"title\":\"떠오른 것\"}")
PRRUN=$(echo "$PRS" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).runId))')
[ -n "$PRRUN" ] || fail "scratch session did not open: $PRS"
PRIDS=$(curl -s "$B/api/fleet?view=all" | PRRUN="$PRRUN" node -e '
let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{
  const j=JSON.parse(b), run=(j.runs||[]).find(r=>r.id===Number(process.env.PRRUN));
  const task=(j.tasks||[]).find(t=>t.id===run.taskId);
  const bucket=(j.repos||[]).find(r=>r.id===task.repoId);
  if(bucket.kind!=="sessions") throw new Error("a fresh session must start in the scratch bucket");
  console.log(task.id+" "+bucket.id);
})') || fail "scratch session not in the sessions bucket"
set -- $PRIDS; PRTASK="$1"; PRBUCKET="$2"
# title-only PATCH 는 지금까지 그대로 동작한다(repoId 를 안 보내면 소속은 안 건드린다)
curl -s -X PATCH "$B/api/tasks/$PRTASK" -H 'content-type: application/json' -d '{"title":"떠오른 것 2"}' | grep -q '"title":"떠오른 것 2"' || fail "title-only PATCH broke when repoId became optional"
# Scratch 버킷으로 미는 길은 없다(승격은 한 방향) · 없는 repo 는 404
expect_code 400 -X PATCH "$B/api/tasks/$PRTASK" -H 'content-type: application/json' -d "{\"repoId\":$PRBUCKET}"
expect_code 404 -X PATCH "$B/api/tasks/$PRTASK" -H 'content-type: application/json' -d '{"repoId":999999}'
# ② 이동 — 이미 등록된 프로젝트(repo 1) 아래로. run 은 손대지 않는다: 터미널은 제 폴더 그대로.
MV=$(curl -s -X PATCH "$B/api/tasks/$PRTASK" -H 'content-type: application/json' -d '{"repoId":1}')
case "$MV" in *'"repoId":1'*) : ;; *) fail "re-parent PATCH failed: $MV";; esac
curl -s "$B/api/fleet?view=all" | PRTASK="$PRTASK" PRRUN="$PRRUN" PRSESS="$PRSESS" node -e '
let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{
  const j=JSON.parse(b), t=(j.tasks||[]).find(x=>x.id===Number(process.env.PRTASK));
  if(t.repoId!==1) throw new Error("task did not move, repoId="+t.repoId);
  if(t.title!=="떠오른 것 2") throw new Error("re-parent must not touch the title: "+t.title);
  const repo=(j.repos||[]).find(x=>x.id===t.repoId);
  if(repo.kind==="sessions") throw new Error("task still under the scratch bucket");
  const r=(j.runs||[]).find(x=>x.id===Number(process.env.PRRUN));
  if(r.worktreePath!==process.env.PRSESS) throw new Error("promotion must not move the terminal: "+r.worktreePath);
  console.log("promotion ok");
})' || fail "re-parent not visible in /api/fleet"
curl -s -X POST "$B/api/runs/$PRRUN/cleanup" >/dev/null
[ -f "$PRSESS/note.txt" ] || fail "promotion destroyed the scratch folder"
pass "v6.0 S2: PATCH /api/tasks/:id {repoId} re-parents (title untouched, terminal keeps its folder) · scratch bucket 400 · unknown repo 404 · title-only still works"

# ③ 등록 + 재부모화 왕복 — "이 폴더가 자랐다": 세션 폴더를 repo 로 등록하고 그 작업을 그 아래로.
GROWN="$WORK/grown-up"
mkdir -p "$GROWN"; git -C "$GROWN" init -q -b main
printf 'grown\n' > "$GROWN/README.md"; git -C "$GROWN" add -A
git -C "$GROWN" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q -m init
GRS=$(curl -sf -X POST "$B/api/session" -H 'content-type: application/json' -d "{\"machineSlug\":\"local\",\"path\":\"$GROWN\",\"title\":\"자란 생각\"}")
GRRUN=$(echo "$GRS" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).runId))')
GRTASK=$(curl -s "$B/api/fleet?view=all" | GRRUN="$GRRUN" node -e '
let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{
  const j=JSON.parse(b), run=(j.runs||[]).find(r=>r.id===Number(process.env.GRRUN));
  console.log(run.taskId);
})')
GRREPO=$(curl -sf -X POST "$B/api/repos" -H 'content-type: application/json' -d "{\"machineSlug\":\"local\",\"path\":\"$GROWN\"}" \
  | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).repo.id))')
[ -n "$GRREPO" ] || fail "registering the grown scratch folder failed"
curl -s -X PATCH "$B/api/tasks/$GRTASK" -H 'content-type: application/json' -d "{\"repoId\":$GRREPO}" | grep -q "\"repoId\":$GRREPO" || fail "register-and-reparent PATCH failed"
curl -s "$B/api/fleet?view=all" | GRTASK="$GRTASK" GRREPO="$GRREPO" GRRUN="$GRRUN" GROWN="$GROWN" node -e '
let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{
  const j=JSON.parse(b), t=(j.tasks||[]).find(x=>x.id===Number(process.env.GRTASK));
  if(t.repoId!==Number(process.env.GRREPO)) throw new Error("task not under the newly registered repo");
  const repo=(j.repos||[]).find(x=>x.id===t.repoId);
  if(repo.path!==process.env.GROWN) throw new Error("registered repo path wrong: "+repo.path);
  const r=(j.runs||[]).find(x=>x.id===Number(process.env.GRRUN));
  if(r.worktreePath!==process.env.GROWN) throw new Error("the promoted session lost its terminal folder");
  console.log("register+reparent ok");
})' || fail "register-and-reparent round trip did not land"
curl -s -X POST "$B/api/runs/$GRRUN/cleanup" >/dev/null
pass "v6.0 S2: register-and-reparent round trip (scratch folder → repo → the work lives under it, terminal intact)"

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
# v5.28 G4 이후 시크릿의 입구는 상단바 ⋯ 메뉴다(인라인 버튼 아님) — 판과 창구는 그대로.
case "$CKPT" in *'id="secretsModal"'*"label:'∗ Secrets'"*'function openSecrets'*'/api/secrets'*) : ;; *) fail "cockpit secrets vault UI missing";; esac
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

# v5.28 D-io: the mobile single-line input drops newlines → a paste handler must bracketed-paste
# multi-line clipboard content (200~/201~) WITHOUT auto-submitting (human presses Enter), CRLF-normalized.
# (case-glob, not `printf | grep -q`: -q closes the pipe early and SIGPIPEs printf on a 200KB var.)
case "$CKPT" in
  *"addEventListener('paste'"*'clipboardData'*'200~'*'201~'*'여러 줄 붙여넣음'*) : ;;
  *) fail "cockpit v5.28 D-io: mobile bracketed multi-line paste handler missing";;
esac
# no auto-submit: the bracketed send must NOT be followed by a carriage return
case "$CKPT" in *"201~'+'"*) fail "cockpit D-io: multi-line paste must not auto-submit (no CR after 201~)";; *) : ;; esac
pass "cockpit v5.28 D-io: mobile multi-line paste = bracketed (200~/201~), CRLF-normalized, no auto-submit"

# mobile app-lock: viewport zoom lock + overscroll-behavior; icon-only header (labels hidden); smaller fonts
case "$CKPT" in *'user-scalable=no'*'overscroll-behavior:none'*) : ;; *) fail "cockpit mobile app-lock (viewport + overscroll) missing";; esac
case "$CKPT" in *'.b-txt{display:none}'*'class="b-txt"'*) : ;; *) fail "cockpit mobile icon-only (b-txt hide) missing";; esac
pass "cockpit mobile app-lock (no zoom/bounce) + icon-only header + small fonts"

# mobile terminal scrolling: tmux copy-mode key (A) + read-only history overlay (C)
case "$CKPT" in *'data-k="copymode"'*'data-k="pgup"'*'copymode:'*) : ;; *) fail "cockpit tmux copy-mode / PgUp keys missing";; esac
case "$CKPT" in *'id="histBtn"'*'id="histModal"'*'function openHistory'*'/scrollback'*) : ;; *) fail "cockpit history overlay (scrollback reader) missing";; esac
pass "cockpit mobile scroll: copy-mode key (A) + read-only history overlay (C)"

# viewer: renamed to 뷰어 + conversational mode (Claude Code JSONL → chat bubbles) alongside terminal(raw)
case "$CKPT" in *'id="histBtn"'*'>뷰어<'*'id="hmChat"'*'function renderTurn'*"/chat'"*) : ;; *) fail "cockpit conversational viewer (대화 mode) missing";; esac
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
# v6.0 W3 — WORK.md 없는 작업은 **블록 자체가 없다**. 없음은 깔끔해야지, 빈 블록이 흘러선 안 된다.
AA1=$(cat "$WT/AGENT_ARGS.txt")
case "$AA1" in *'WORK CONTEXT'*) fail "a task with no WORK.md must not get a WORK CONTEXT block (absence is clean, not an empty block)";; *) : ;; esac
curl -s -X POST "$B/api/tasks/1/close" -H 'content-type: application/json' -d '{"force":true}' >/dev/null
pass "design context injected into agent argv (and no WORK CONTEXT block without a WORK.md)"

# v6.0 Part W — 격리된 run 은 과거에서 갈라져 나오지만, WORK.md 에 적힌 결정은 이 작업의 모든 세션을 따라간다.
# 정본은 git 트리 밖(데몬 데이터 디렉터리)에 산다 — 어떤 worktree 의 diff 에도 뜨지 않는다.
# (W4 harvest — 살아있는 run 이 적은 줄을 watcher 가 모아오는 일 — 은 이번 단계 범위 밖이다.)
WDATA="$(dirname "$DB")/work"
WKT=$(curl -sf -X POST "$B/api/tasks" -H 'content-type: application/json' -d '{"repoId":1,"title":"work ctx","prompt":"second words"}')
WKTID=$(echo "$WKT" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).task.id))')
[ -n "$WKTID" ] || fail "work-context task not created: $WKT"
# ① 처음 열면 빈 파일이 생긴다 — 뷰어가 "없는 파일"에 걸려 넘어지지 않도록. 빈 파일은 주입되지 않는다.
WMK=$(curl -sf -X POST "$B/api/tasks/$WKTID/work")
# ⚠️ 이 스위트의 데이터 디렉터리는 mktemp(홈 밖)이라 기본 뷰어 루트가 못 덮는다 → 여기서 도는 것은
# **대체 경로**다(어포던스가 깨지지 않는다는 바로 그 경우). 평소 배치(~/.coxpit ⊂ 홈)의 일반 경로는
# 아래 COXPIT_FILES_ROOT 절에서 /api/fs 창구로 따로 증명한다.
case "$WMK" in *'"inRoot":false'*) : ;; *) fail "the suite's temp data dir should fall outside the viewer root (fallback path): $WMK";; esac
WPATH="$WDATA/$WKTID.md"
[ -f "$WPATH" ] || fail "POST work should create the canonical file at $WPATH"
# ② 쓰기·읽기 — 뷰어 루트가 좁혀졌을 때 쓰는 전용 창구로 한 번 왕복(같은 페인, 같은 렌더러)
curl -sf -X PUT "$B/api/tasks/$WKTID/work" -H 'content-type: application/json' \
  -d '{"content":"# 결정\n- 토큰만 쓴다 (새 hex 금지)\n"}' >/dev/null || fail "PUT work doc failed"
WGET=$(curl -s "$B/api/tasks/$WKTID/work")
case "$WGET" in *'"kind":"md"'*'"editable":true'*'새 hex 금지'*) : ;; *) fail "GET work doc should return an editable md body: $WGET";; esac
# ③ 다음 발사의 프롬프트에 실린다 — 요청 문장은 그대로 앞서고, 결정이 뒤에 붙는다
WRUN=$(curl -sf -X POST "$B/api/tasks/$WKTID/run" -H 'content-type: application/json' -d '{"count":1,"real":true}')
WRID=$(echo "$WRUN" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).runs[0].id))')
[ -n "$WRID" ] || fail "work-context run not created: $WRUN"
for i in $(seq 1 40); do
  WS=$(curl -s "$B/api/runs/$WRID" | { grep -oE '"status":"(done|failed|error)"' || true; } | head -1)
  [ -n "$WS" ] && break; sleep 0.5
done
WWT=$(curl -s "$B/api/runs/$WRID" | grep -oE '"worktreePath":"[^"]+"' | sed 's/.*:"//;s/"//')
[ -n "$WWT" ] || fail "work-context run has no worktree"
grep -q 'WORK CONTEXT' "$WWT/AGENT_ARGS.txt" || fail "WORK.md was not injected into the launched prompt"
grep -q 'decisions recorded here bind you' "$WWT/AGENT_ARGS.txt" || fail "WORK CONTEXT header line missing"
grep -q '새 hex 금지' "$WWT/AGENT_ARGS.txt" || fail "the work doc's own text is missing from the prompt"
grep -q 'second words' "$WWT/AGENT_ARGS.txt" || fail "the task's own prompt should still lead the launch"
# ④ 그런데 그 파일은 어떤 git status 에도 없다 — 정본은 데이터 디렉터리에 산다(diff 오염 0)
WGS=$(git -C "$WWT" status --porcelain)
case "$WGS" in *WORK.md*) fail "WORK.md leaked into the run worktree's git status: $WGS";; *) : ;; esac
WGS2=$(git -C "$REPO" status --porcelain)
case "$WGS2" in *WORK.md*) fail "WORK.md leaked into the repo checkout's git status: $WGS2";; *) : ;; esac
[ -f "$WPATH" ] || fail "the canonical work doc must be the data-dir file"
# ⑤ 작업이 닫히면 공유 컨텍스트도 같이 사라진다(작업의 수명을 산다)
curl -s -X POST "$B/api/tasks/$WKTID/close" -H 'content-type: application/json' -d '{"force":true}' >/dev/null
[ ! -f "$WPATH" ] || fail "closing the work should remove its WORK.md"
expect_code 404 -X POST "$B/api/tasks/999999/work"
pass "v6.0 Part W: WORK.md (data-dir canonical, never in a git status) rides the next launch; removed with the task"

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

# Session delete flow (placed late — it creates+deletes ids, so it can't shift the hardcoded task-1 tests)
runInFleet(){ curl -s "$B/api/fleet?view=all" | node -e "let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>{const j=JSON.parse(b);process.exit((j.runs||[]).some(r=>r.id==$1)?0:1)})"; }
SDIR=$(mktemp -d "$HOME/.coxpit-e2e-sess-XXXXXX"); echo keep > "$SDIR/keep.txt"
SCR=$(curl -s -X POST "$B/api/session" -H 'content-type: application/json' --data "{\"machineSlug\":\"local\",\"path\":\"$SDIR\",\"title\":\"e2esess\"}")
SRID=$(printf '%s' "$SCR" | sed -n 's/.*"runId":\([0-9]*\).*/\1/p')
[ -n "$SRID" ] || fail "session create failed: $SCR"
runInFleet "$SRID" || fail "session run $SRID not in fleet after create"
SDEL=$(curl -s -X DELETE "$B/api/runs/$SRID")
case "$SDEL" in *'"ok":true'*) : ;; *) fail "session delete failed: $SDEL";; esac
runInFleet "$SRID" && fail "session run $SRID still in fleet after delete" || :
[ -f "$SDIR/keep.txt" ] || fail "session delete must preserve the folder (keep.txt gone)"
expect_code 404 -X DELETE "$B/api/runs/999999"
rm -rf "$SDIR"
pass "session delete: endpoint kills tmux + removes record, folder preserved, missing→404"

# coxpit CLI — dispatch orchestration from the terminal to a named project (reads the daemon lock)
CLI="$ROOT/bin/coxpit.js"
COXPIT_DB="$DB" node "$CLI" ls | grep -q 'repo' || fail "coxpit ls should list the registered project"
FANOUT=$(COXPIT_DB="$DB" node "$CLI" fan repo "e2e cli dispatch" -n 1)
case "$FANOUT" in *'repo'*'run'*'dry'*) : ;; *) fail "coxpit fan should dispatch a dry run: $FANOUT";; esac
COXPIT_DB="$DB" node "$CLI" ps >/dev/null || fail "coxpit ps should exit 0"
UNK=$(COXPIT_DB="$DB" node "$CLI" fan __nope__ "x" 2>&1 || true)   # die exits 1 → capture (pipefail-safe)
case "$UNK" in *'no project matches'*) : ;; *) fail "coxpit fan should reject an unknown project: $UNK";; esac
pass "coxpit CLI: ls / fan(dry) / ps + unknown-project guard (terminal→orchestration dispatch)"

# file viewer root is settings-driven (in-app Settings, no env edit, applies immediately)
curl -sf -X PATCH "$B/api/settings" -H 'content-type: application/json' -d '{"filesRoot":"/"}' | grep -q '"ok":true' || fail "settings should accept filesRoot"
FRS=$(curl -s -G "$B/api/fs/read" --data-urlencode "path=/etc/hosts")
case "$FRS" in *'"kind":"text"'*) : ;; *) fail "filesRoot=/ (via settings) should open /etc/hosts: $FRS";; esac
curl -sf -X PATCH "$B/api/settings" -H 'content-type: application/json' -d '{"filesRoot":""}' >/dev/null
FRS2=$(curl -s -G "$B/api/fs/read" --data-urlencode "path=/etc/hosts")
case "$FRS2" in *'홈 폴더 밖'*) : ;; *) fail "filesRoot='' should re-jail to home: $FRS2";; esac
expect_code 400 -X PATCH "$B/api/settings" -H 'content-type: application/json' -d '{"filesRoot":"relative/nope"}'
GS=$(curl -s "$B/api/settings"); case "$GS" in *'"filesRoot"'*) : ;; *) fail "GET /api/settings should expose filesRoot";; esac
pass "file viewer root is settings-driven (home↔/ applies immediately, relative rejected, exposed in GET)"

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

# v6.0 T6b — an OPEN task with a settled 'done' run whose change set is UNMERGED and
# UN-EXPORTED. It IS listed now (that was the invisible debt), but flagged reclaimRisk:true
# and never swept by a bare prune-all: its worktree is the only copy of that work.
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
SAFEFC=$(curl -s "$B/api/runs/$SAFERUN" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).run.filesChanged))')
[ "${SAFEFC:-0}" -gt 0 ] || fail "the dry run must change a file for the at-risk case to exist (filesChanged=$SAFEFC)"

# ...and its twin whose output ESCAPED (an export event) — merged/exported work is safe to
# reclaim, so this one preselects and a bare prune-all takes it.
EXPT=$(curl -sf -X POST "$B/api/tasks" -H 'content-type: application/json' \
  -d "{\"repoId\":$DRID,\"title\":\"reclaim-exported\",\"prompt\":\"do work\"}")
EXPTID=$(echo "$EXPT" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).task.id))')
curl -sf -X POST "$B/api/tasks/$EXPTID/run" -H 'content-type: application/json' -d '{"count":1}' | grep -q '"ok":true' || fail "exported-case run launch"
EXPRUN=$(curl -s "$B/api/tasks/$EXPTID" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).runs[0].id))')
EXPS=''
for i in $(seq 1 60); do
  EXPS=$(curl -s "$B/api/runs/$EXPRUN" | { grep -oE '"status":"(done|failed|error)"' || true; } | head -1)
  [ -n "$EXPS" ] && break; sleep 0.5
done
[ "$EXPS" = '"status":"done"' ] || fail "exported-case run did not settle done: $EXPS"
EXPO=$(curl -sf -X POST "$B/api/runs/$EXPRUN/export" -H 'content-type: application/json' -d "{\"dest\":\"$WORK/t6b-export\"}")
case "$EXPO" in *'"ok":true'*) : ;; *) fail "export (escaped-work case) failed: $EXPO";; esac

# ...and one that is still RUNNING (the stalling agent bin) — never listed, never reclaimed.
LIVT=$(curl -sf -X POST "$B/api/tasks" -H 'content-type: application/json' \
  -d "{\"repoId\":$DRID,\"title\":\"reclaim-live\",\"prompt\":\"do work\"}")
LIVTID=$(echo "$LIVT" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).task.id))')
curl -sf -X POST "$B/api/tasks/$LIVTID/run" -H 'content-type: application/json' -d '{"count":1,"real":true}' | grep -q '"ok":true' || fail "live run launch"
LIVRUN=$(curl -s "$B/api/tasks/$LIVTID" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).runs[0].id))')
LIVS=''
for i in $(seq 1 60); do
  LIVS=$(curl -s "$B/api/runs/$LIVRUN" | { grep -oE '"status":"running"' || true; } | head -1)
  [ -n "$LIVS" ] && break; sleep 0.5
done
[ "$LIVS" = '"status":"running"' ] || fail "live run never reached running: $(curl -s "$B/api/runs/$LIVRUN")"

# v6.0 T6b — the disk readout rides /api/health for anything watching from outside.
# The value is CACHED (du runs in the background), so poll: the first stale call kicks the
# refresh, the next carries it. Numbers are whatever the disk says — assert the shape.
WTH=''
for i in $(seq 1 40); do
  WTH=$(curl -sf "$B/api/health" || true)
  case "$WTH" in *'"worktrees"'*) break;; esac
  sleep 0.5
done
node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{
  const w=JSON.parse(b).worktrees;
  if(!w) throw new Error("health must carry worktrees:{count,sizeKb} while worktrees exist: "+b);
  if(typeof w.count!=="number"||typeof w.sizeKb!=="number") throw new Error("worktrees field types wrong: "+b);
  if(!(w.count>0)) throw new Error("count must be positive when worktrees exist: "+b);
  if(!(w.sizeKb>0)) throw new Error("sizeKb must be positive when worktrees exist: "+b);
  console.log("health disk readout ok");
})' <<<"$WTH" || fail "health worktrees readout wrong: $WTH"
pass "T6b: /api/health carries the worktree disk readout { count, sizeKb } (cached du)"

# GET /api/worktrees — {items:[{runId,path,branch,taskId,reason,exists,reclaimRisk}],totalKb}
WT=$(curl -sf "$B/api/worktrees")
RCRUN="$RCRUN" SAFERUN="$SAFERUN" EXPRUN="$EXPRUN" LIVRUN="$LIVRUN" node -e '
let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{
  const d=JSON.parse(b);
  if(!Array.isArray(d.items)||typeof d.totalKb!=="number") throw new Error("payload shape: "+b);
  const by=id=>d.items.find(x=>x.runId===Number(process.env[id]));
  const victim=by("RCRUN"), risky=by("SAFERUN"), escaped=by("EXPRUN");
  if(!victim) throw new Error("a failed run must stay reclaimable: "+b);
  for (const k of ["path","branch","reason","exists","reclaimRisk"]) if(!(k in victim)) throw new Error("item missing "+k);
  if(victim.reclaimRisk!==false) throw new Error("a failed run with no changed files is not at risk: "+JSON.stringify(victim));
  if(!risky) throw new Error("a settled done run must now be listed (that was the invisible debt): "+b);
  if(risky.reclaimRisk!==true) throw new Error("done + changes + no export/pr must be flagged: "+JSON.stringify(risky));
  if(!escaped) throw new Error("the exported done run must be listed: "+b);
  if(escaped.reclaimRisk!==false) throw new Error("exported work is not the only copy: "+JSON.stringify(escaped));
  if(by("LIVRUN")) throw new Error("a running run must NEVER be listed: "+b);
  console.log("worktrees listing ok");
})' <<<"$WT" || fail "worktrees shape/risk wrong: $WT"
pass "T6b worktrees list: done listed with reclaimRisk, exported/failed safe, running never listed"

# POST /api/worktrees/prune with no runIds = "reclaim all" and all means all NON-risky:
# the failed victim and the exported run go; the unmerged one and the live one stay.
PR=$(curl -sf -X POST "$B/api/worktrees/prune" -H 'content-type: application/json' -d '{}')
RCRUN="$RCRUN" SAFERUN="$SAFERUN" EXPRUN="$EXPRUN" LIVRUN="$LIVRUN" node -e '
let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{
  const d=JSON.parse(b);
  if(!(d.count>=1)||!Array.isArray(d.removed)) throw new Error("prune payload: "+b);
  const ids=d.removed.map(r=>r.runId), has=k=>ids.includes(Number(process.env[k]));
  if(!has("RCRUN")) throw new Error("the failed victim should have been reclaimed: "+b);
  if(!has("EXPRUN")) throw new Error("the exported run should have been reclaimed: "+b);
  if(has("SAFERUN")) throw new Error("prune-all must never delete the sole copy of unmerged work: "+b);
  if(has("LIVRUN")) throw new Error("prune-all must never touch a running run: "+b);
  console.log("prune-all ok");
})' <<<"$PR" || fail "prune result wrong: $PR"
# victim worktreePath now blank
VWT=$(curl -s "$B/api/runs/$RCRUN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["run"]["worktreePath"])')
[ -z "$VWT" ] || fail "victim worktreePath not cleared after prune: '$VWT'"
# the at-risk run's worktree is still there (flagged, not preselected, not swept)
SWT=$(curl -s "$B/api/runs/$SAFERUN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["run"]["worktreePath"])')
[ -n "$SWT" ] || fail "prune-all wrongly reclaimed the sole copy of unmerged work"
# the live run's worktree is untouched too
LWT=$(curl -s "$B/api/runs/$LIVRUN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["run"]["worktreePath"])')
[ -n "$LWT" ] || fail "prune-all wrongly reclaimed a running run's worktree"
pass "T6b prune-all reclaims the non-risky only — unmerged and running worktrees survive"

# ...but the human may still tick it: an explicit runIds honors the choice.
PR2=$(curl -sf -X POST "$B/api/worktrees/prune" -H 'content-type: application/json' -d "{\"runIds\":[$SAFERUN]}")
SAFERUN="$SAFERUN" node -e '
let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{
  const ids=JSON.parse(b).removed.map(r=>r.runId);
  if(!ids.includes(Number(process.env.SAFERUN))) throw new Error("an explicitly chosen at-risk run must be reclaimed: "+b);
  console.log("explicit prune ok");
})' <<<"$PR2" || fail "explicit prune wrong: $PR2"
SWT2=$(curl -s "$B/api/runs/$SAFERUN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["run"]["worktreePath"])')
[ -z "$SWT2" ] || fail "explicitly chosen worktreePath not cleared: '$SWT2'"
# idempotent — re-prune finds nothing (both gone, the live one still never offered)
WT2=$(curl -sf "$B/api/worktrees")
RCRUN="$RCRUN" SAFERUN="$SAFERUN" LIVRUN="$LIVRUN" python3 -c 'import sys,json,os
ids=[w["runId"] for w in json.loads(sys.stdin.read())["items"]]
assert int(os.environ["RCRUN"]) not in ids,("victim still reclaimable",ids)
assert int(os.environ["SAFERUN"]) not in ids,("explicitly reclaimed run still listed",ids)
assert int(os.environ["LIVRUN"]) not in ids,("a running run leaked into reclaimable",ids)
' <<<"$WT2" || fail "post-prune list wrong: $WT2"
pass "T6b explicit runIds reclaims the flagged one (human chose), pointer cleared, idempotent"
# stop the live run and cleanup the tasks so the branch check downstream stays clean
curl -s -X POST "$B/api/runs/$LIVRUN/stop" >/dev/null
pkill -f stall-agent.sh 2>/dev/null || true
curl -s -X POST "$B/api/tasks/$LIVTID/close" -H 'content-type: application/json' -d '{"force":true}' >/dev/null
curl -s -X POST "$B/api/tasks/$EXPTID/close" -H 'content-type: application/json' -d '{"force":true}' >/dev/null
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
expect_code 200 -u x:pw-e2e "$B/api/machines"
pass "auth gate (exposed bind, env key, Basic back-compat)"

# issue #13: Design Mode uses a scoped capture key, NOT the master access key.
# capture-key readout is behind the gate; the master key must not authorize captures; rotation retires the old key.
expect_code 401 "$B/api/design/capture-key"   # 캡처 키 조회는 게이트 뒤(인증된 보드만)
CAPK=$(curl -s -u x:pw-e2e "$B/api/design/capture-key" | grep -oE '"key":"[^"]*"' | sed 's/.*"key":"//;s/"//')
case "$CAPK" in cap_*) : ;; *) fail "capture-key endpoint should return a scoped key (got: $CAPK)";; esac
expect_code 201 -X POST "$B/api/design/capture?k=$CAPK" -H 'content-type: application/json' -d '{"selector":"x"}'
expect_code 401 -X POST "$B/api/design/capture?k=pw-e2e" -H 'content-type: application/json' -d '{}'  # ← 마스터 키는 캡처 불가(#13)
expect_code 401 -X POST "$B/api/design/capture?k=nope" -H 'content-type: application/json' -d '{}'
pass "design capture uses a scoped capture key; master access key rejected (#13)"
NCAPK=$(curl -s -u x:pw-e2e -X POST "$B/api/design/capture-key/rotate" | grep -oE '"key":"[^"]*"' | sed 's/.*"key":"//;s/"//')
case "$NCAPK" in cap_*) [ "$NCAPK" != "$CAPK" ] || fail "rotate should mint a different capture key";; *) fail "rotate should return a key";; esac
expect_code 401 -X POST "$B/api/design/capture?k=$CAPK" -H 'content-type: application/json' -d '{}'   # 회전 후 구키 폐기
expect_code 201 -X POST "$B/api/design/capture?k=$NCAPK" -H 'content-type: application/json' -d '{"selector":"y"}'
pass "capture key rotates: old key 401, new key 201 (#13)"

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

# issue #11: on the SAME loopback+no-key daemon, a proxied request (forwarding header) must NOT be
# trusted as local — otherwise a reverse-proxy/tunnel in front serves everything unauthenticated.
expect_code 401 -H 'X-Forwarded-For: 203.0.113.9' "$B/api/machines"
expect_code 401 -H 'CF-Connecting-IP: 203.0.113.9' "$B/api/machines"
pass "issue #11: proxied request (fwd header) on a loopback daemon is NOT trusted-local (401)"

# issue #11: an explicitly set COXPIT_AUTH_PASS must be enforced even on a loopback bind
# (the key wins over the bind — a loopback daemon behind a proxy stays protected).
kill "$DPID" 2>/dev/null || true; sleep 0.5
rm -f "$DB"*; rm -f "$AUTHDIR/auth.json" 2>/dev/null || true
COXPIT_HOST=127.0.0.1 COXPIT_AUTH_PASS=loopback-key-e2e COXPIT_DB="$DB" COXPIT_PORT="$PORT" \
  node --import tsx "$ROOT/src/index.ts" >>"$WORK/daemon.log" 2>&1 &
DPID=$!
for i in $(seq 1 40); do curl -sf "$B/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
expect_code 401 "$B/api/machines"                         # no credentials
expect_code 401 -u x:wrong-key "$B/api/machines"          # wrong key never consulted → must fail
expect_code 200 -u x:loopback-key-e2e "$B/api/machines"   # right key unlocks
LBK=$(curl -s -H 'accept: text/html' "$B/")
case "$LBK" in *'Unlock this coxpit'*) : ;; *) fail "loopback+COXPIT_AUTH_PASS must gate the board with the unlock page";; esac
pass "issue #11: explicit COXPIT_AUTH_PASS enforced on loopback (key wins over bind, wrong key 401)"

# COXPIT_FILES_ROOT widens the viewer jail (default home). "/" opens the whole fs.
kill "$DPID" 2>/dev/null || true; sleep 0.5
COXPIT_HOST=127.0.0.1 COXPIT_DB="$DB" COXPIT_PORT="$PORT" COXPIT_FILES_ROOT=/ \
  node --import tsx "$ROOT/src/index.ts" >>"$WORK/daemon.log" 2>&1 &
DPID=$!
for i in $(seq 1 40); do curl -sf "$B/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
FRR=$(curl -s -G "$B/api/fs/read" --data-urlencode "path=/etc/hosts")
case "$FRR" in *'"kind":"text"'*) : ;; *) fail "COXPIT_FILES_ROOT=/ should allow reading /etc/hosts: $FRR";; esac
pass "COXPIT_FILES_ROOT widens the file-viewer root (/ opens the whole filesystem)"

# v6.0 W2 — 루트가 데이터 디렉터리를 품는 평소 배치(~/.coxpit ⊂ 홈)에서는 WORK.md 를
# **기존 파일 뷰어 창구**가 그대로 읽고 쓴다: 새 파일 표면을 만들지 않았다는 증거.
curl -s -X POST "$B/api/repos" -H 'content-type: application/json' -d "{\"machineSlug\":\"local\",\"path\":\"$REPO\"}" >/dev/null || true
FRRID=$(curl -s "$B/api/fleet?view=all" | node -e '
let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{
  const r=(JSON.parse(b).repos||[]).find(x=>x.kind!=="sessions"); console.log(r?r.id:"");
})')
[ -n "$FRRID" ] || fail "no repo registered for the wide-root work doc test"
FRT=$(curl -sf -X POST "$B/api/tasks" -H 'content-type: application/json' -d "{\"repoId\":$FRRID,\"title\":\"root-wide\",\"prompt\":\"x\"}")
FRTID=$(echo "$FRT" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).task.id))')
[ -n "$FRTID" ] || fail "task for the wide-root work doc not created: $FRT"
FRW=$(curl -sf -X POST "$B/api/tasks/$FRTID/work")
case "$FRW" in *'"inRoot":true'*) : ;; *) fail "a root that contains the data dir must make the work doc reachable by the file viewer: $FRW";; esac
FRP="$(dirname "$DB")/work/$FRTID.md"
curl -sf -X POST "$B/api/fs/write" -H 'content-type: application/json' \
  -d "{\"path\":\"$FRP\",\"content\":\"# 결정\\n- 뷰어가 그대로 쓴다\\n\"}" >/dev/null || fail "the generic viewer write should reach the work doc"
FRR2=$(curl -s -G "$B/api/fs/read" --data-urlencode "path=$FRP")
case "$FRR2" in *'"kind":"md"'*'"editable":true'*'뷰어가 그대로 쓴다'*) : ;; *) fail "the generic viewer read should return the work doc: $FRR2";; esac
pass "v6.0 W2: with the data dir inside the viewer root, WORK.md is read/written by the existing /api/fs pane (no new file surface)"

# 디자인 래칫: 하드코딩 hex 색이 늘면 실패 — 맥락 없는 구현(플릿 run 포함)이 토큰 대신
# 새로 그리는 사고를 결정적으로 잡는다. 정당하게 늘 때(=DESIGN.md 토큰 확장)는 같은 커밋에서
# DESIGN.md 갱신과 함께 이 기준선을 의식적으로 올린다. (node 정규식 = BSD/GNU grep 차이 없음)
HEXES=$(node -e "
const fs=require('fs');const rx=/#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z-])/g;
const c=(p)=>((fs.readFileSync(p,'utf8').match(rx)||[]).length);
console.log(c('$ROOT/src/board.ts')+' '+c('$ROOT/src/cockpit.ts')+' '+c('$ROOT/src/login.ts'));
")
set -- $HEXES
[ "$1" -le 60 ] || fail "design ratchet: board.ts hard-coded colors grew ($1 > 60) — use var(--tokens), or extend DESIGN.md and bump this baseline in the same commit"
[ "$2" -le 46 ] || fail "design ratchet: cockpit.ts hard-coded colors grew ($2 > 46) — use var(--tokens), or extend DESIGN.md and bump this baseline in the same commit"
[ "$3" -le 29 ] || fail "design ratchet: login.ts hard-coded colors grew ($3 > 29) — use var(--tokens), or extend DESIGN.md and bump this baseline in the same commit"
pass "design ratchet: no new hard-coded colors (board $1/60 · cockpit $2/46 · login $3/29)"

# pty master fd 누수 회귀(issue #9). darwin 에서 실검증, 리눅스 CI 는 self-skip(성공).
kill "$DPID" 2>/dev/null || true; sleep 0.3
node --import tsx "$ROOT/test/pty-fd.mjs"
pass "pty master fd leak regression (spawnPty wrapper, darwin)"

# v5.28 A2 — 에이전트 상태 감지(unit, pty 불필요). 통조림 tail 로 분류기와 tracker 수명만 본다.
# 정직성 규칙: waiting 은 패턴 적중이 있을 때만, 없으면 idle. 그리고 타이머를 남기지 않는다.
cat > "$WORK/agentstate.test.ts" <<EOF
import { attach, feed, input, detach, classifyIdle, getAgentState, _stats } from '$ROOT/src/agentstate.ts';
const ESC = String.fromCharCode(27);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PERM = [
  'Edit file src/app.ts',
  '',
  'Do you want to proceed?',
  ' 1. Yes',
  ' 2. No, and tell Claude what to do differently',
].join('\n');

// 1) claude 승인 프롬프트 → waiting
if (classifyIdle(PERM) !== 'waiting') throw new Error('permission tail: ' + classifyIdle(PERM));
// 2) 셸 프롬프트 → idle (패턴 없음 = 추측하지 않는다)
const SHELL = 'mini repo % ls\nREADME.md  src\nmini repo % ';
if (classifyIdle(SHELL) !== 'idle') throw new Error('shell tail: ' + classifyIdle(SHELL));
// 3) 'esc to interrupt' 가 더 최근이면 아직 working (위에 남은 옛 프롬프트에 속지 않는다)
const BUSY = PERM + '\nYes\n' + 'Crunching... (12s . esc to interrupt)';
if (classifyIdle(BUSY) !== 'working') throw new Error('busy tail: ' + classifyIdle(BUSY));
// 4) ANSI 이스케이프가 섞인 같은 프롬프트 → 여전히 waiting (분류 시점에 소독)
const ANSI = ESC + ']0;claude' + String.fromCharCode(7) + ESC + '[2J' + ESC + '[H'
  + ESC + '[1mDo you' + ESC + '[0m want to proceed' + ESC + '[K?\n'
  + ESC + '[3;1H' + ESC + '[36m 1.' + ESC + '[0m Yes\n 2. No';
if (ANSI.indexOf(ESC) < 0) throw new Error('fixture lost its escapes');
if (classifyIdle(ANSI) !== 'waiting') throw new Error('ansi tail: ' + classifyIdle(ANSI));

async function main() {
  // 5) 정지 후 waiting → 사람이 입력하면 즉시 해제
  attach(1);
  feed(1, PERM);
  if (getAgentState(1)?.state !== 'working') throw new Error('feed should mark working');
  await sleep(900);
  const w = getAgentState(1);
  if (w?.state !== 'waiting') throw new Error('quiescent permission tail should be waiting: ' + JSON.stringify(w));
  input(1);
  const c = getAgentState(1);
  if (c?.state !== 'working') throw new Error('input must clear waiting: ' + JSON.stringify(c));
  // 6) attach 2 + detach 1 은 상태 유지, 두 번째 detach 에서 tracker/타이머가 비어야 한다
  attach(1);
  detach(1);
  if (!getAgentState(1)) throw new Error('second client still attached — state must survive');
  detach(1);
  if (getAgentState(1)) throw new Error('state must be dropped after the last detach');
  const st = _stats();
  if (st.trackers !== 0 || st.timers !== 0) throw new Error('tracker/timer leak: ' + JSON.stringify(st));
}
main().then(
  () => console.log('AGENTSTATE_OK'),
  (e) => { console.error(String(e)); process.exit(1); },
);
EOF
# ⚠️ 헤르메틱하게: phase 4 부터 agentstate 는 config 를 import 한다(웹훅). COXPIT_DB 를 안 주면
# config 가 ~/.coxpit/settings.json 을 읽어 **상주 데몬의 webhookUrl** 을 물고 들어와,
# 유닛 테스트의 waiting 전이가 진짜 엔드포인트를 때린다. 스크래치 DB + 빈 웹훅으로 못 박는다.
AS_OUT=$(COXPIT_DB="$DB" COXPIT_WEBHOOK_URL= node --import tsx "$WORK/agentstate.test.ts" 2>&1) || fail "agent state detection: $AS_OUT"
case "$AS_OUT" in *AGENTSTATE_OK*) : ;; *) fail "agent state detection: $AS_OUT";; esac
pass "agent state: waiting only on a pattern hit (ANSI-safe), input clears it, no tracker/timer leak"

# v5.28 A3 (phase 2) — transport. unit 이 아니라 데몬에 붙여서 계약을 본다:
# 맵에는 **터미널이 붙어 있는 run 만** 있고, 마지막 detach 에서 빠진다. detail 은 아직 빈 문자열이다
# (꼬리 발췌는 소독 규칙이 생기는 phase 3 전에는 허브에 태우지 않는다).
kill "$DPID" 2>/dev/null || true; sleep 0.5
rm -f "$DB"*; rm -f "$AUTHDIR/auth.json" 2>/dev/null || true
COXPIT_AUTH_DISABLED=1 COXPIT_DB="$DB" COXPIT_PORT="$PORT" \
  node --import tsx "$ROOT/src/index.ts" >>"$WORK/daemon.log" 2>&1 &
DPID=$!
for i in $(seq 1 40); do curl -sf "$B/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
# 붙일 세션 하나 + 절대 붙지 않을 세션 하나(= 맵에 없어야 하는 대조군)
ASDIR="$WORK/as-attached"; mkdir -p "$ASDIR"
ANDIR="$WORK/as-never"; mkdir -p "$ANDIR"
ASS=$(curl -sf -X POST "$B/api/session" -H 'content-type: application/json' -d "{\"machineSlug\":\"local\",\"path\":\"$ASDIR\",\"title\":\"attached\"}")
ASRUN=$(echo "$ASS" | python3 -c 'import sys,json;print(json.load(sys.stdin)["runId"])')
ANS=$(curl -sf -X POST "$B/api/session" -H 'content-type: application/json' -d "{\"machineSlug\":\"local\",\"path\":\"$ANDIR\",\"title\":\"never attached\"}")
ANRUN=$(echo "$ANS" | python3 -c 'import sys,json;print(json.load(sys.stdin)["runId"])')
cat > "$WORK/agentstate.transport.mjs" <<'EOF'
// /ws/term 에 실제로 붙어서 허브 델타와 /api/fleet 의 agentStates 를 함께 본다.
const B = process.argv[2];
const RID = String(process.argv[3]);
const OTHER = String(process.argv[4]);
const WSB = B.replace(/^http/, 'ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fleet = async () => await (await fetch(B + '/api/fleet?view=all')).json();
const die = (m) => { console.error(m); process.exit(1); };
const opened = (ws, what) => new Promise((res, rej) => {
  ws.addEventListener('open', () => res());
  ws.addEventListener('error', () => rej(new Error(what + ' ws failed to open')));
});

// 1) 허브를 먼저 연다 — attach 가 만드는 첫 전이를 놓치지 않도록.
const hub = new WebSocket(WSB + '/ws');
const seen = [];
hub.addEventListener('message', (e) => { try { seen.push(JSON.parse(e.data)); } catch { /* not json */ } });
await opened(hub, 'hub');

// 2) 터미널 attach — tmux 가 pane 을 다시 그리며 바이트가 흐른다(감지기의 먹이).
const term = new WebSocket(WSB + '/ws/term/' + RID + '?cols=80&rows=24');
let out = 0;
term.addEventListener('message', (e) => {
  try { const m = JSON.parse(e.data); if (m.t === 'o') out++; else if (m.t === 'err') die('term: ' + m.d); }
  catch { /* not json */ }
});
await opened(term, 'term');
for (let i = 0; i < 40 && out === 0; i++) await sleep(250);
if (out === 0) die('no terminal output in 10s — nothing to feed the detector');
await sleep(2000);   // ACTIVE_MS/FLAP_MS 를 지나 분류가 안정될 때까지

// 3) /api/fleet 의 agentStates 모양 + 붙지 않은 run 은 없다
const f = await fleet();
const as = f.agentStates;
if (!as || typeof as !== 'object') die('fleet has no agentStates map: ' + JSON.stringify(as));
const me = as[RID];
if (!me) die('attached run missing from agentStates: ' + JSON.stringify(as));
if (!['working', 'idle', 'waiting'].includes(me.state)) die('implausible state: ' + JSON.stringify(me));
if (me.detail !== '') die('detail must be the empty string in phase 2: ' + JSON.stringify(me));
if (!(typeof me.ts === 'number' && me.ts > 0)) die('ts must be a timestamp: ' + JSON.stringify(me));
if (as[OTHER]) die('a run that never attached a terminal must not appear: ' + JSON.stringify(as));

// 4) 허브에 agentstate 델타가 실제로 흘렀고, 꼬리 발췌를 태우지 않았다
const deltas = seen.filter((m) => m && m.type === 'agentstate' && String(m.runId) === RID);
if (!deltas.length) die('no agentstate delta on the hub: ' + JSON.stringify(seen.slice(-5)));
if (deltas.some((d) => d.detail !== '')) die('hub delta carried a detail excerpt: ' + JSON.stringify(deltas));

// 5) 마지막 detach → 맵에서 빠진다(추적기도 같이 사라진다)
term.close();
let gone = false;
for (let i = 0; i < 40 && !gone; i++) { await sleep(250); gone = !(await fleet()).agentStates[RID]; }
if (!gone) die('detach must drop the run from agentStates');
hub.close();
console.log('TRANSPORT_OK');
EOF
TR_OUT=$(node "$WORK/agentstate.transport.mjs" "$B" "$ASRUN" "$ANRUN" 2>&1) || fail "agentstate transport: $TR_OUT"
case "$TR_OUT" in *TRANSPORT_OK*) : ;; *) fail "agentstate transport: $TR_OUT";; esac
curl -s -X POST "$B/api/runs/$ASRUN/cleanup" >/dev/null
curl -s -X POST "$B/api/runs/$ANRUN/cleanup" >/dev/null
pass "agentstate transport: hub delta (detail empty) + /api/fleet agentStates (attached only, cleared on detach)"

# agentstate 델타는 전체 리하이드레이트를 걸지 않는다 — 그 run 자리만 표적으로 칠한다(phase 3).
# (보드는 이미 type 별로 분기해 모르는 종류를 흘려보내므로 손대지 않았다.)
ASMARK="ev.type==='agentstate'"
case "$CKPT" in *'function wsConnect'*"$ASMARK"*'function scheduleHydrate'*) : ;; *) fail "cockpit /ws handler should not rehydrate on agentstate";; esac
case "$CKPT" in *'coxpit · cockpit'*'workspace'*) : ;; *) fail "cockpit shell markers lost";; esac
pass "cockpit /ws: agentstate deltas never trigger the rehydrate path"

# v5.28 A4 (phase 3) — 코크핏 표면. **트리가 곧 rail**이라 별도 Agents rail 은 만들지 않는다:
# 탭 점 + 트리 run 행 점 덮어쓰기 + ◔ N 대기 칩. 색은 전부 기존 토큰(래칫 60/46/29 불변).
case "$CKPT" in *'.as-working{background:var(--running)'*'.as-waiting{background:var(--blocked)'*'.as-idle{background:var(--faint)'*'.as-exited{background:var(--done)'*) : ;; *) fail "agent-state dots must map to the four existing tokens (working/waiting/idle/exited)";; esac
case "$CKPT" in *'@keyframes aspulse'*) : ;; *) fail "waiting dot should pulse (motion, never a new color)";; esac
# 상태가 없는 run 은 점이 안 뜬다(클라이언트가 상태를 지어내지 않는다는 규칙의 표면 쪽 절반)
case "$CKPT" in *'.as-dot{width:6px;height:6px;border-radius:50%;flex:none;display:none}'*) : ;; *) fail "a run without agentstate must show no dot (as-dot defaults to display:none)";; esac
case "$CKPT" in *'id="waitChip"'*'id="waitN"'*'</header>'*) : ;; *) fail "◔ N waiting chip must live in the header (survives focus mode + mobile)";; esac
case "$CKPT" in *'.layout.focusmode .rail{display:none}'*'.layout.focusmode .reqbar{display:none}'*) : ;; *) fail "focus mode must hide only the rail/reqbar (tab dots + chip stay)";; esac
case "$CKPT" in *'function paintAgentState'*'function updateWaitChip'*'function jumpNextWaiting'*) : ;; *) fail "cockpit agentstate paint / chip / cycle handlers missing";; esac
case "$CKPT" in *'d.agentStates'*) : ;; *) fail "hydrate should seed the agent-state map from /api/fleet.agentStates";; esac
case "$CKPT" in *'data-role="asdot"'*'asClass(agentStateOf(runId))'*) : ;; *) fail "terminal tabs should render an agent-state dot";; esac
case "$CKPT" in *'paintAgentState(ev.runId, ev.state)'*) : ;; *) fail "ws agentstate branch must paint (targeted), not skip";; esac
case "$CKPT" in *'function closeTab'*'delete agentState[runId]'*'delete tabs[runId]'*) : ;; *) fail "closeTab should drop this client's agent-state entry";; esac
pass "cockpit v5.28 A4: tab dots + tree run-row override + ◔ N waiting chip (existing tokens only, targeted paint)"

# v5.28 A5 (phase 4) — 주의 환기. 코크핏에 설정 화면은 없다: 세 취향은 헤더 버튼 하나 밑 작은 판에 산다.
# 전부 opt-in·기본 꺼짐이고, **보고 있는 탭은 자신을 울리지 않는다**.
# v5.28 G4 이후 그 버튼은 상단바 ⋯(#topMore) 하나다 — 판(#attnPop)은 같은 자리, 같은 앵커(#apWrap).
case "$CKPT" in *'id="topMore"'*'id="attnPop"'*'</header>'*) : ;; *) fail "attention popover + its header trigger must live in the header";; esac
# 행은 기존 컴포넌트 그대로(새 설정 시스템을 짓지 않는다): .rchk 체크박스 둘 + .modes/.mode 세그 하나
case "$CKPT" in *'id="attnSound"'*'id="attnNotify"'*'id="attnOnWaiting"'*'id="attnOnExited"'*'id="attnOnBoth"'*) : ;; *) fail "attention popover rows (sound · notify · transition seg) missing";; esac
case "$CKPT" in *'coxpit.sound'*'coxpit.notify'*'coxpit.pingOn'*) : ;; *) fail "the three attention prefs must be remembered in localStorage";; esac
# 소리는 코드로 만든 두 음짜리 블립 — 오디오 에셋도 새 파일도 없다
case "$CKPT" in *'function blip'*'AudioContext'*'createOscillator'*) : ;; *) fail "WebAudio two-tone blip missing (no audio asset)";; esac
# 브라우저 알림 — 보드와 같은 권한 흐름. 본문은 세션 이름 + 상태뿐(터미널 내용 금지)
case "$CKPT" in *'new Notification'*'runLabel(runId)'*'Notification.requestPermission'*) : ;; *) fail "browser notification wiring (permission flow + session-name body) missing";; esac
AT_GUARD="var away = document.hidden || String(focusedRunId())!==String(runId);"
case "$CKPT" in *"$AT_GUARD"*) : ;; *) fail "attention must require document.hidden or a non-focused tab — the focused tab never pings itself";; esac
AT_FILTER="if (attn.on!=='both' && attn.on!==next) return;"
case "$CKPT" in *"$AT_FILTER"*) : ;; *) fail "coxpit.pingOn transition filter (waiting / exited / both) missing";; esac
case "$CKPT" in *'raiseAttention(runId, prev, state)'*) : ;; *) fail "paintAgentState must raise attention using the PREVIOUS state (a transition, not a repaint)";; esac
pass "cockpit v5.28 A5: attention popover (sound · notify · transitions), opt-in, focused tab never pings itself"

# v5.28 B3 — 리스너 판. **사실만 보이고 판정하지 않는다**: stale 배지도, 자동 종료도 없다.
# 파일 순서대로 본다: 페인 액션 스타일 → 행 스타일 → 판 마크업 → 페인 입구 → ⌘K 입구 → 판 로직.
case "$CKPT" in *'.leaf-h .pact.ptxt{'*'.port-row .swarn{'*'.port-row .pkill{'*) : ;; *) fail "listener panel styles (:ports pane action + row + kill control) missing";; esac
case "$CKPT" in *'id="portsModal"'*'id="portsWhere"'*'id="portQ"'*'id="portSpot"'*'id="portsList"'*) : ;; *) fail "listener panel markup (pane/machine line + port field + spotted chips + rows) missing";; esac
# 판정하지 않는다는 규칙은 카피에도 있다 — 질문으로만 나오고, 판결로는 나오지 않는다
case "$CKPT" in *'낡았는지는 판단하지 않습니다'*'옛 프로세스일 수 있어요'*) : ;; *) fail "the panel must say it shows facts, not a verdict (never a STALE badge)";; esac
# 페인 입구(:ports) — 헤더 액션 + 그 클릭 배선
case "$CKPT" in *'data-ports="'*':ports</button>'*) : ;; *) fail "per-leaf :ports affordance missing from the pane header";; esac
case "$CKPT" in *"e.target.closest('[data-ports]')"*'openPorts(pl.tab)'*) : ;; *) fail ":ports must open the listener panel for that pane's run";; esac
# ⌘K 입구 — 같은 판, 포트를 사람이 부른다
case "$CKPT" in *'포트에 뭐가 떠 있나'*'run:openPortQuery'*) : ;; *) fail "⌘K 'what's on a port…' command missing";; esac
# 행 = :PORT · command · started <etime> · [여기서 실행] · [종료]
B_ROW="'<span class=\"pp\">:'+esc(x.port)+'</span>'"
case "$CKPT" in *'function portRowHTML'*"$B_ROW"*'· started '*) : ;; *) fail "a listener row must read :PORT · command · started <etime>";; esac
case "$CKPT" in *'<span class="swarn">⌖ 여기서 실행</span>'*) : ;; *) fail "the underPane marker must be a mono glyph + word in the existing caution token (T6b 미머지 treatment)";; esac
case "$CKPT" in *'data-kill="'*'[종료]</button>'*) : ;; *) fail "each row needs its own exact-pid [종료] control";; esac
# 수동 포착은 Part A 의 꼬리를 **재사용**한다 — 탭을 하나 더 달지 않는다(서버가 spotted 로 준다)
case "$CKPT" in *'data-spot='*"fetch('/api/runs/'+portsRun+'/listeners')"*'j.spotted||[]'*) : ;; *) fail "passive port spotting must reuse the Part A tail (server-side spotted list), offered as one-click targets";; esac
case "$CKPT" in *"'/api/machines/'+encodeURIComponent(portsMachine)+'/port/'"*) : ;; *) fail "the by-port entry must hit GET /api/machines/:id/port/:port";; esac
# 종료는 사람이 찍은 행 하나 → kill 엔드포인트 → **다시 훑기**(사라졌는지, 되살아났는지)
B_KILL="'/api/machines/'+encodeURIComponent(row.machineId||portsMachine)+'/kill'"
case "$CKPT" in *'function killListener'*"$B_KILL"*'아직 살아 있습니다'*) : ;; *) fail "[종료] must post the pid to the kill endpoint and re-scan (never a kill-all-on-port)";; esac
pass "cockpit v5.28 B3: :ports leaf affordance + ⌘K port query → one listener panel (evidence rows, underPane marker, exact-pid [종료], tail-reused port spotting)"

# ── v5.28 Part C — 빠른 답 · 시작/이어서 · 안전한 컨텍스트 주입 ──
# 지켜야 할 것은 둘뿐이다:
#   ① 빠른 답은 **사람이 고른 고정 문자열**이다 — 코크핏은 에이전트의 프롬프트를 읽어 답을 고르지 않는다.
#   ② 주입한 글은 **자료**로 울타리 쳐 입력칸에 놓일 뿐, 사람이 전송을 누르기 전에는 나가지 않는다.
# 파일 순서대로 본다: 스트립 스타일 → 작성칸 스타일 → 판 마크업 → 메뉴 → 헤더 → 배선 → ⌘K → 피커 → 로직.
case "$CKPT" in *'.leaf-h .qr{'*'.leaf-h .qr:empty{display:none}'*'.leaf-h .qbtn{'*'.leaf-h .sbtn{'*) : ;; *) fail "C1/C2 strip styles missing — and :empty must erase the slot (draw nothing when there is nothing)";; esac
case "$CKPT" in *'.inj-text{'*) : ;; *) fail "C3 composer style missing (the fence is multi-line — an <input> would strip the newlines)";; esac
case "$CKPT" in *'id="injModal"'*'id="injWhere"'*'id="injText"'*'id="injPathOnly"'*'id="injSend"'*) : ;; *) fail "injection composer markup (target line + textarea + attach-instead + send) missing";; esac
case "$CKPT" in *'id="injMenu"'*) : ;; *) fail "injection entry menu missing (reuse the .rmenu pattern, click-opened so mobile reaches it)";; esac
# 헤더: 상태 스트립 자리 + 주입 어포던스
case "$CKPT" in *'<span data-role="qr" class="qr" data-qrun="'*'paneStripHTML(node.tab)'*) : ;; *) fail "the leaf header must carry the state strip slot rendered by paneStripHTML";; esac
case "$CKPT" in *'data-inject="'*'주입</button>'*) : ;; *) fail "per-pane 주입 affordance missing from the leaf header";; esac
# 배선: 빠른 답 · 시작 · 이어서 · 주입
case "$CKPT" in *"e.target.closest('[data-qr]')"*'quickReplyClick('*"e.target.closest('[data-astart]')"*"e.target.closest('[data-aresume]')"*) : ;; *) fail "strip buttons (quick reply / start / resume) are not wired";; esac
case "$CKPT" in *"e.target.closest('[data-inject]')"*'openInjMenu(injBtn, il.tab)'*) : ;; *) fail "주입 must open the file/selection menu for that pane";; esac
# ⌘K — 같은 판, 다른 입구
case "$CKPT" in *'파일을 참고 자료로 주입…'*'선택 영역을 참고 자료로 주입'*) : ;; *) fail "⌘K injection commands missing";; esac
# 피커는 **이미 있는 것**을 모드만 바꿔 쓴다(새 파일 창구 없음)
case "$CKPT" in *"function openFilePicker(mode){ fpMode=(mode==='inject')?'inject':'view';"*) : ;; *) fail "file injection must reuse the existing picker (mode switch, not a second picker)";; esac
pass "cockpit v5.28 C: strip slot + 주입 affordance + ⌘K entries, all on existing components (:empty strip, .rmenu menu, reused picker)"

# C1 — 고정 문자열. 여기가 정직성의 핵심이라 문자열 자체를 못 박는다.
case "$CKPT" in *"var QR_CR = '\r';"*"{ k:'approve', label:'승인', send:'1' }"*"{ k:'deny',    label:'거절', send:'2' }"*"{ k:'cont',    label:'계속', send:'계속' }"*) : ;; *) fail "quick replies must be fixed human-chosen literals + a trailing CR";; esac
# 뜨는 자리만 waiting 을 탄다 — 항상 떠 있지 않다
case "$CKPT" in *'function paneStripHTML'*"agentStateOf(runId)==='waiting'"*) : ;; *) fail "the quick-reply strip must be gated on the Part A waiting state, never always-shown";; esac
# 전송로는 페인 입력 채널 그대로({t:'i'}) — 새 엔드포인트 없음
case "$CKPT" in *'function paneInputSend'*"JSON.stringify({t:'i', d:data})"*) : ;; *) fail "quick replies must ride the existing pane input channel";; esac
case "$CKPT" in *'function quickReplyClick'*'paneInputSend(runId, q.send+QR_CR)'*) : ;; *) fail "a quick reply sends its own fixed string + CR — nothing derived from the pane";; esac
# 프롬프트를 읽어 답을 고르는 경로는 **존재하지 않는다**
case "$CKPT" in *autoAnswer*|*guessReply*|*parsePrompt*) fail "coxpit must never parse the agent's prompt to auto-pick a reply";; *) : ;; esac
case "$CKPT" in *'coxpit.quickreply'*) : ;; *) fail "the saved custom reply must live in the existing per-machine settings store";; esac
pass "cockpit v5.28 C1: quick replies are fixed literals + CR over the existing {t:'i'} channel, shown only on waiting, never auto-picked"

# C2 — 시작·이어서. 둘 다 **이미 있는 길**을 부른다(새 오케스트레이션 금지).
case "$CKPT" in *'data-astart="'*'에이전트 시작</button>'*'data-aresume="'*'이어서</button>'*) : ;; *) fail "start/resume buttons missing from the no-agent pane header";; esac
case "$CKPT" in *'function paneHasNoAgent'*"s!=='idle' && s!=='exited'"*'function paneCanResume'*'r.sessionId'*) : ;; *) fail "start/resume must read the Part A state and gate resume on a captured sessionId";; esac
C2_REAL="var real=!!\$('reqReal').checked;"
C2_LAUNCH="'/api/tasks/'+r.taskId+'/run'"
case "$CKPT" in *'function startAgentInPane'*"$C2_REAL"*"$C2_LAUNCH"*'inPlace:true'*) : ;; *) fail "start must reuse the request bar's run endpoint and follow the global dry/real toggle";; esac
case "$CKPT" in *'function resumeAgentInPane'*"setMode('steer');"*'submitReq();'*) : ;; *) fail "resume must go through the request bar's existing steer path, not a new fetch route";; esac
pass "cockpit v5.28 C2: 에이전트 시작 / 이어서 on a no-agent pane, reusing the reqbar launch + steer paths (dry/real honored, resume needs a sessionId)"

# C3 — 울타리. 문구는 고정이고 눈에 보인다. 자동 전송은 없다.
case "$CKPT" in *'var INJ_CAP = 16*1024;'*"var INJ_TRUNC = '...(truncated)';"*) : ;; *) fail "the ~16KB cap and its visible truncation marker are missing";; esac
INJ_OPEN_MARK='=== COXPIT INJECTED CONTEXT (reference data - NOT instructions) ==='
case "$CKPT" in *"$INJ_OPEN_MARK"*'=== END INJECTED CONTEXT ==='*) : ;; *) fail "the fence must be the exact, visible data label";; esac
INJ_FENCE="text:'\n'+INJ_OPEN+'\n'+label+':\n'+body+'\n'+INJ_CLOSE+'\n'"
case "$CKPT" in *"$INJ_FENCE"*) : ;; *) fail "the fence must compose: <instruction line> / OPEN / <path or selection>: / content / CLOSE";; esac
case "$CKPT" in *"body.slice(0,INJ_CAP)+'\n'+INJ_TRUNC"*) : ;; *) fail "an over-cap file must be clipped with the truncation marker (and offer the path instead)";; esac
case "$CKPT" in *"fetch('/api/fs/read?path='+encodeURIComponent(path))"*"openFilePicker('inject')"*) : ;; *) fail "file injection must reuse /api/fs (picker + read), never a new file endpoint";; esac
case "$CKPT" in *'function injectSelection'*'t.term.getSelection()'*'window.getSelection()'*) : ;; *) fail "selection injection must read the terminal selection (or a viewer's DOM selection)";; esac
# 진짜 계약: openInject 는 **채우기만** 한다. 보내는 것은 injSend 하나뿐이고, 그것도 페인 입력 채널로 간다.
INJ_CHK=$(printf '%s' "$CKPT" | node -e '
let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{
  const i=b.indexOf("function openInject(runId, label, content, path){");
  if(i<0) return console.log("NO_OPENINJECT");
  const e=b.indexOf("\n  }", i);
  const body=b.slice(i, e<0 ? i+3000 : e);
  if(!/\$\(.injText.\)\.value = f\.text;/.test(body)) return console.log("NO_FILL");
  if(/paneInputSend\(/.test(body) || /\.send\(/.test(body)) return console.log("AUTO_SEND");
  const k=b.indexOf("function injSend(){");
  if(k<0) return console.log("NO_INJSEND");
  const s=b.slice(k, k+900);
  if(!/paneInputSend\(injRun,/.test(s)) return console.log("SEND_OFF_CHANNEL");
  console.log("INJECT_OK");
});')
case "$INJ_CHK" in INJECT_OK) : ;; *) fail "injection must only FILL the composer (no send on inject); the single send goes through the pane input channel: $INJ_CHK";; esac
pass "cockpit v5.28 C3: exact fence + ~16KB cap/truncation + /api/fs reuse; inject fills the input and never auto-sends"

# 손댄 파일은 주석까지 ASCII 여야 한다(위 게이트는 **서빙된 HTML** 만 훑는다 — 백엔드 모듈은 못 잡는다).
# 코크핏에 끼워 넣는 모듈도 같은 규칙이다 — v5.28 E 가 공유 humanize 를 여기로 옮겼으므로 함께 훑는다.
EMJ=$(node -e '
const fs=require("fs");
const rx=/[\u{1F000}-\u{1FAFF}\u{2699}\u{26A0}\u{2B50}]/u;
const files=["src/cockpit.ts","src/humanize.ts"];
let bad=[];
for(const f of files){ const s=fs.readFileSync(process.argv[1]+"/"+f,"utf8").split("\n");
  s.forEach((l,i)=>{ if(rx.test(l)) bad.push(f+":"+(i+1)); }); }
console.log(bad.length?bad.join(" "):"ASCII_OK");
' "$ROOT")
case "$EMJ" in ASCII_OK) : ;; *) fail "emoji in a touched source file (comments included) — mono glyphs only: $EMJ";; esac
pass "v5.28 C: touched sources stay emoji-free at the source level (comments included), not just in the served HTML"

# ── v5.28 Part E — 활동 페인(run activity view) ──
# 한 줄로 줄이면: **돌고 있는 에이전트를 누르면 하고 있는 일이 보여야 한다.**
# 헤드리스 run 의 tmux 는 빈 worktree 셸이라 클릭이 엉뚱한 것을 열었다 — 진짜 작업은 이미 파싱된
# 이벤트 스트림에 있다. 그래서 지켜야 할 것은 셋뿐이다:
#   ① 터미널을 빼앗지 않는다(한 번 눌러 돌아가고, PTY 는 그때 비로소 만들어진다)
#   ② 없는 상태를 지어내지 않는다(비면 starting…, waiting 은 Part A 가 준 것만)
#   ③ 에이전트 run 에만 뜬다(손 세션·워크벤치는 진짜 셸이라 터미널이 옳다)
# 파일 순서대로 본다: 스타일 → 탭 모드 → 헤더 토글 → 붙이기 → 배선 → 페인 로직.

# E1 — 탭은 runId 하나로 키를 잡으니 두 번째 탭이 아니라 **모드**를 갖는다. 기본값은 에이전트 여부가 정한다.
case "$CKPT" in *'function ensureTab(runId)'*'mode:defaultTabMode(runId)'*"if (t.mode==='terminal') ensureTerm(t);"*) : ;; *) fail "the run tab must carry a mode and build the PTY only when that mode is 'terminal'";; esac
case "$CKPT" in *'function ensureTerm(t){'*'if (t.term) return t;'*) : ;; *) fail "the terminal must be built by ensureTerm and reused once built (instant switch back)";; esac
case "$CKPT" in *'function runIsAgent(runId)'*'if(runIsSession(runId)) return false;'*"r.agent!=='session' && r.agent!=='workbench'"*) : ;; *) fail "an agent run = not a hand session (runIsSession) and not a bare workbench";; esac
case "$CKPT" in *"function defaultTabMode(runId){ return runIsAgent(runId) ? 'activity' : 'terminal'; }"*) : ;; *) fail "the default mode must branch on runIsAgent — an agent run opens activity, a session still opens the terminal";; esac
# 날 PTY 는 **늦게** 생긴다: ensureTab 안에 new Terminal 이 있으면 안 된다.
LAZY=$(printf '%s' "$CKPT" | node -e '
let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{
  const i=b.indexOf("function ensureTab(runId){");
  if(i<0) return console.log("NO_ENSURETAB");
  const body=b.slice(i, b.indexOf("\n  }", i));
  if(/new window.Terminal\(/.test(body)) return console.log("EAGER_TERMINAL");
  if(!/if \(t.mode===.terminal.\) ensureTerm\(t\);/.test(body)) return console.log("NO_LAZY_BRANCH");
  const k=b.indexOf("function ensureTerm(t){");
  if(k<0) return console.log("NO_ENSURETERM");
  if(!/if \(t.term\) return t;/.test(b.slice(k, k+300))) return console.log("NOT_RETAINED");
  console.log("LAZY_OK");
});')
case "$LAZY" in LAZY_OK) : ;; *) fail "the PTY must be created lazily (only on terminal mode) and retained afterwards: $LAZY";; esac
# 헤더 토글 — 에이전트 run 에만. 요청바 세그(.modes/.mode)를 페인 크기로 줄여 쓸 뿐, 새 컴포넌트가 아니다.
case "$CKPT" in *'runIsAgent(node.tab)'*'class="modes acttog"'*) : ;; *) fail "the Activity|Terminal toggle is drawn only for agent runs (hand sessions keep the terminal, no toggle)";; esac
case "$CKPT" in *'data-pmode="activity"'*'>Activity</button>'*'data-pmode="terminal"'*'>Terminal</button>'*) : ;; *) fail "the pane header needs an Activity | Terminal toggle";; esac
case "$CKPT" in *".leaf-h .modes{padding:1px"*) : ;; *) fail "the toggle must reuse the existing .modes/.mode seg (sized down), not a new control";; esac
# 붙이기 — 활동 모드의 페인은 PTY 없이 선다
case "$CKPT" in *"if(t.mode==='activity'){ body.appendChild(actHostOf(t)); renderActivity(t); return; }"*'ensureTerm(t); body.appendChild(t.host);'*) : ;; *) fail "attachHosts must render the activity pane without creating a PTY";; esac
# 배선 — 토글과 'Open terminal' 둘 다 그 페인의 모드를 뒤집는다
case "$CKPT" in *"e.target.closest('[data-pmode]')"*"setTabMode(tabKeyOf(pmBtn.getAttribute('data-prun')), pmBtn.getAttribute('data-pmode'))"*) : ;; *) fail "the toggle must flip the focused run pane's mode";; esac
case "$CKPT" in *"e.target.closest('[data-actterm]')"*"setTabMode(tabKeyOf(atBtn.getAttribute('data-actterm')), 'terminal')"*) : ;; *) fail "Open terminal must switch this pane to terminal mode (the terminal is one click away)";; esac
pass "cockpit v5.28 E1: the run tab gains a mode (agent → activity · session → terminal), the PTY is lazy + retained, Activity|Terminal flips it"

# E2 — 다섯 켜. 상태 칩은 Part A 의 네 토큰을 그대로 빌린다(대기 = --blocked, 새 색 없음).
case "$CKPT" in *'.act-chip.as-working{color:var(--running)}'*'.act-chip.as-waiting{color:var(--blocked)}'*'.act-chip.as-idle{color:var(--faint)}'*'.act-chip.as-exited{color:var(--done)}'*) : ;; *) fail "the state chip must reuse Part A's four tokens (waiting = var(--blocked)), never a new color";; esac
case "$CKPT" in *'.act-chip:empty{display:none}'*) : ;; *) fail "no agent state = no chip (the client never fabricates a state)";; esac
# ① 헤더 ② 지금 ③ 타임라인 ④ 변경 요약 ⑤ 액션바 — 위에서 아래로, 한 판에
case "$CKPT" in *'function activityHTML(runId)'*'class="anm"'*'data-role="actchip"'*'data-role="actnow"'*'data-role="acttl"'*'data-role="actfiles"'*'class="act-bar"'*) : ;; *) fail "the activity pane must render header → Now → timeline → change summary → action bar";; esac
case "$CKPT" in *'function actNowText'*"return live ? 'starting…'"*'latestActivity(runId)'*) : ;; *) fail "the Now line is latestActivity, and says starting… while the stream is still empty (never invented)";; esac
# 타임라인 = 공유 humanize 를 r.events 에 그대로. 새 줄은 아래에 잇고, 꼬리에 붙어 있을 때만 따라간다.
case "$CKPT" in *'function actPaintTimeline'*'humanLines((r&&r.events)'*'el.appendChild(d)'*'if(t._tlPinned){ el.scrollTop=el.scrollHeight;'*) : ;; *) fail "the timeline must be the shared humanize over r.events, appended at the bottom, auto-scrolling only while pinned to the tail";; esac
case "$CKPT" in *'data-role="actjump"'*'Latest ↓'*) : ;; *) fail "a scrolled-up timeline needs a jump-to-latest affordance";; esac
# 변경 요약 = filesChanged N + 접힌 diff(이미 있는 창구·렌더러·공백 토글 그대로)
case "$CKPT" in *'function actFilesText(runId)'*"return 'filesChanged '"*'data-role="actfiles"'*) : ;; *) fail "the change summary must state filesChanged N";; esac
case "$CKPT" in *'function actLoadDiff'*"fetch('/api/runs/'+runId+'/diff')"*'diffHTML(d.diff'*) : ;; *) fail "the diff peek must reuse /api/runs/:id/diff + the existing diff renderer";; esac
case "$CKPT" in *'function actToggleWs'*'rvShowWs=!rvShowWs;'*) : ;; *) fail "the peek must share the Review whitespace toggle, not keep a second preference";; esac
# 액션바 = Open terminal · Steer… · (대기면) Part C 빠른 답 · Review
case "$CKPT" in *'data-actterm='*'Open terminal</button>'*'data-actsteer='*'Steer…</button>'*'data-role="qr"'*'data-actreview='*'Review</button>'*) : ;; *) fail "the action bar must carry Open terminal · Steer… · Review (quick replies between them)";; esac
case "$CKPT" in *"(s==='waiting'?paneStripHTML(runId):'')"*) : ;; *) fail "the inline quick replies must be Part C's strip, gated on waiting — never rebuilt here";; esac
case "$CKPT" in *'function actSteer'*"setMode('steer');"*) : ;; *) fail "Steer… must go through the request bar's existing steer path, not a new fetch route";; esac
case "$CKPT" in *"function gotoBoardRun(runId){ location.href='/?run='+encodeURIComponent(runId); }"*) : ;; *) fail "Review must jump to the board run detail through the existing /?run=N deep link";; esac
pass "cockpit v5.28 E2: header + Now + humanized timeline (tail-pinned) + filesChanged/diff peek + action bar, all from data the client already has"

# 인간화는 **한 벌**이다 — 보드 타임라인과 활동 페인이 같은 함수를 쓴다(사본 금지).
case "$BOARD_HTML" in *'function humanize(e){'*'function humanLines(events){'*) : ;; *) fail "the board timeline lost its humanize";; esac
case "$CKPT" in *'function humanize(e){'*'function humanLines(events){'*) : ;; *) fail "the cockpit activity view must embed the same humanize";; esac
HZ=$(node -e '
const fs=require("fs"), root=process.argv[1];
const n=(f)=>(fs.readFileSync(root+"/"+f,"utf8").split("function humanize(e){").length-1);
const b=n("src/board.ts"), c=n("src/cockpit.ts"), s=n("src/humanize.ts");
console.log((b===0&&c===0&&s===1) ? "SHARED_OK" : ("board="+b+" cockpit="+c+" shared="+s));
' "$ROOT")
case "$HZ" in SHARED_OK) : ;; *) fail "humanize must live in exactly one shared module (src/humanize.ts) and be embedded in both pages, never copied: $HZ";; esac
pass "v5.28 E2: one shared humanize (src/humanize.ts) feeds both the board timeline and the activity pane"

# E3 — 라이브. 이미 흐르는 것(agentstate 델타 · fleet 델타)에 얹을 뿐, 새 전송로는 없다.
# 그리고 A4 의 규율 그대로: 그 자리만 칠하고, 절대 리하이드레이트하지 않는다.
case "$CKPT" in *'function paintAgentState'*'paintPaneStrip(runId);'*'paintActivity(runId);'*) : ;; *) fail "an agentstate delta must repaint an open activity pane through the same targeted path";; esac
case "$CKPT" in *'function syncPanes'*'paintActivity(l.tab);'*) : ;; *) fail "an event delta (hydrate → syncPanes) must reach an open activity pane";; esac
case "$CKPT" in *'function paintActivity'*"t.mode!=='activity'"*'data-role=actchip'*'data-role=actnow'*'actPaintTimeline(t);'*) : ;; *) fail "the targeted paint must update the state chip + Now line + timeline of an OPEN activity pane only";; esac
PA_CHK=$(printf '%s' "$CKPT" | node -e '
let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{
  const i=b.indexOf("function paintAgentState(runId, state){");
  if(i<0) return console.log("NO_FN");
  const body=b.slice(i, b.indexOf("\n  }", i));
  if(!/paintActivity\(runId\);/.test(body)) return console.log("NO_ACTIVITY_PAINT");
  if(/hydrate\(|scheduleHydrate\(|renderTree\(/.test(body)) return console.log("REHYDRATES");
  console.log("PAINT_OK");
});')
case "$PA_CHK" in PAINT_OK) : ;; *) fail "paintAgentState must paint the activity pane without any rehydrate (A4 discipline): $PA_CHK";; esac
pass "cockpit v5.28 E3: agentstate/event deltas update an open activity pane by targeted paint — no rehydrate, no new transport"

# E4 — 정직. 터미널은 사라지지 않았다(이 페인은 이벤트 스트림 위의 한 켜일 뿐이다).
case "$CKPT" in *'function connectTab'*"'/ws/term/'+t.runId"*) : ;; *) fail "the raw PTY attach must still exist — activity is a layer, not a removal";; esac
# 상태를 짐작하는 경로는 없다: waiting 은 Part A 가 준 것만 읽고, 여기서 만들지 않는다.
case "$CKPT" in *guessState*|*inferWaiting*|*fakeActivity*) fail "the activity view must never synthesize an agent state";; *) : ;; esac
pass "cockpit v5.28 E4: read-first (terminal one click away), agent runs only, no fabricated state"

# ── v5.28 Part F — 레일 헤더 정리 + 영어 라벨. 순전히 배치와 말이다(동작 불변).
# F1 — Workspace 헤더는 이름과 ⋯ 하나만 든다. 인라인 ▤/↻ 와 기계 이름 사본은 떠났다.
case "$CKPT" in *'<div class="lbl"><span>Workspace</span><span class="lacts"><button type="button" class="tmore" id="wsMore"'*) : ;; *) fail "the Workspace header must be the name + one ⋯ (#wsMore)";; esac
case "$CKPT" in *'id="machName"'*) fail "the duplicated machine name must leave the Workspace header — the top-bar #mach chip already says it";; *) : ;; esac
case "$CKPT" in *'id="wtBtn"'*) fail "the inline ▤ worktree link must leave the Workspace header (it lives behind ⋯)";; *) : ;; esac
case "$CKPT" in *'id="reapBtn"'*) fail "the inline ↻ orphan link must leave the Workspace header (it lives behind ⋯)";; *) : ;; esac
# 기계 이름은 사라진 게 아니라 한 번만 선다 — 위 칩은 그대로고, 갱신도 그 하나만 건드린다
case "$CKPT" in *'<span id="mach">local</span>'*) : ;; *) fail "the top-bar machine chip (#mach) must survive — F1 removes the duplicate, not the name";; esac
F_MACHSET="if (d.machines && d.machines[0]) { \$('mach').textContent = d.machines[0].slug; }"
case "$CKPT" in *"$F_MACHSET"*) : ;; *) fail "the machine updater must touch #mach only (a dangling #machName write would throw)";; esac
pass "v5.28 F1: the Workspace header carries its name and one ⋯ — no inline worktree/orphan link, no second 'local'"

# F1 배선 — 두 번째 메뉴가 아니라 두 번째 **항목 목록**이다: 같은 #rowMenu, 같은 여는 함수, 같은 핸들러.
# 트리 repaint 의 주인 재지정은 repo 행 전용이다 — 트리 밖 정적 ⋯ 를 델타마다 닫아버리면 안 된다
case "$CKPT" in *"if (rowMenuOwner && rowMenuOwner.hasAttribute('data-more')){"*) : ;; *) fail "a tree repaint must re-point only row-owned menus — the static Workspace ⋯ must not be yanked by a WS delta";; esac
# 파일 순서대로: 공통 페인터 → repo 열기 → Workspace 항목 → Workspace 열기 → 정적 배선.
case "$CKPT" in *'function paintRowMenu(btn, html){'*'function openRowMenu(btn, repoId){'*"{ act:'wt',   label:'▤ Worktrees' }"*"{ act:'reap', label:'↻ Orphans' }"*'function openWsMenu(btn){ openMenuAt(btn, WS_MENU_ACTS); }'*) : ;; *) fail "the Workspace ⋯ must reuse the .rmenu opener (one painter, many item lists) — never a second menu system";; esac
F_WSWIRE="\$('wsMore').addEventListener('click', function(e){ e.stopPropagation(); openWsMenu(this); });"
case "$CKPT" in *"$F_WSWIRE"*) : ;; *) fail "#wsMore is static markup — wire it once, like the links it replaced";; esac
# 항목은 기존 핸들러를 그대로 부른다(재구현 금지)
case "$CKPT" in *"if (act==='wt') openWt();"*"else if (act==='reap') openReap();"*) : ;; *) fail "the ⋯ items must call openWt/openReap unchanged";; esac
# 닫기 가드는 두 ⋯ 를 모두 안다 — 여는 버튼을 누른 것은 "바깥"이 아니다
case "$CKPT" in *"var MENU_BTN_SEL = '[data-more],[data-menu]';"*) : ;; *) fail "the outside-click/focusout guards must recognize both ⋯ buttons";; esac
pass "v5.28 F1: the Workspace ⋯ reuses #rowMenu (same painter · Escape/outside close) and opens the same two sheets"

# F2 — 섹션 액션은 툴바와 같은 말을 쓴다. 판 제목도 그 항목과 같은 말을 쓴다.
# (G2 이후 Scratch 의 두 액션은 인라인 링크가 아니라 그 섹션 ⋯ 메뉴의 항목이다 — 말은 그대로 영어다.)
case "$CKPT" in *'<span class="t">↻ Orphans</span>'*'<span class="t">▤ Reclaim worktrees</span>'*"{ act:'newsession', label:'＋ Session' }"*"{ act:'scrub', label:'Tidy…' }"*) : ;; *) fail "the reap/worktree sheet titles and the Scratch actions must read English (↻ Orphans · ▤ Reclaim worktrees · ＋ Session · Tidy…)";; esac
case "$CKPT" in *'↻ 고아 터미널'*) fail "the workspace/reap surfaces must no longer label themselves 고아 터미널";; *) : ;; esac
case "$CKPT" in *'＋ 새 세션'*) fail "the Scratch new-session action must read ＋ Session";; *) : ;; esac
# repo 행 메뉴는 이 패스의 범위 밖이다 — 한국어 그대로 살아 있어야 한다
case "$CKPT" in *"label:'등록 해제'"*) : ;; *) fail "F2 must not touch the repo-row menu copy (out of scope)";; esac
pass "v5.28 F2: section actions + maintenance sheet titles speak English (repo-row menu copy untouched)"

# ── v5.28 Part G — 모든 헤더가 같은 모양이다: 이름 하나와 ⋯ 하나 ──
# 한 줄로 줄이면: **액션은 ⋯ 뒤에 살고, 상태(● live)와 주 이동(← Board)은 열린 자리에 남는다.**
# 그리고 프로젝트는 이제 보드에 가지 않고 코크핏에서 태어난다(같은 창구, 다른 자리).
# 파일 순서대로 본다: 상단바 마크업 → 시트 마크업 → 트리 헤더 → 공유 메뉴 → 항목 배선 → 피커 로직.

# G4(마크업) — 오른쪽은 ● live → ⋯ → ← Board. 인라인 ∗/◎ 는 그 ⋯ 안으로 들어갔다.
case "$CKPT" in *'<span class="ws" id="ws">'*'id="topMore" data-menu="top"'*'id="attnPop"'*'class="toggle" href="/"'*'</header>'*) : ;; *) fail "the top bar must read ● live → ⋯ → ← Board (status and Board stay in the open)";; esac
case "$CKPT" in *'id="secretsBtn"'*) fail "the inline ∗ Secrets button must leave the header — it lives behind the top-bar ⋯";; *) : ;; esac
case "$CKPT" in *'id="attnBtn"'*) fail "the inline ◎ toggle must leave the header — it lives behind the top-bar ⋯";; *) : ;; esac
# 팝오버는 다시 짓지 않았다: 같은 판·같은 앵커(#apWrap)·같은 행들이 그대로 있다
case "$CKPT" in *'id="apWrap"'*'id="attnSound"'*'id="attnNotify"'*'id="attnOnBoth"'*) : ;; *) fail "the attention popover itself must survive G4 — only its trigger moved";; esac
# 사라진 id 로 가는 배선이 하나라도 남으면 코크핏 스크립트가 통째로 죽는다(빈 화면)
case "$CKPT" in *"\$('attnBtn')"*|*"\$('secretsBtn')"*) fail "a dangling listener/updater on a removed header id would throw at load";; *) : ;; esac
case "$CKPT" in *'id="wstext"'*) : ;; *) fail "the ● live status text must stay visible in the top bar";; esac
pass "v5.28 G4: the top bar keeps ● live and ← Board in the open and folds ∗ Secrets · ◎ Notifications behind one ⋯ (popover reused, no dangling ids)"

# G5(마크업+로직) — 프로젝트 추가 시트. 기존 .pick 껍데기 그대로, 경로는 절대 타이핑하지 않는다.
case "$CKPT" in *'id="projModal"'*'＋ Add project'*'id="projPath"'*'id="projList"'*'id="projRegHere"'*) : ;; *) fail "the cockpit add-project sheet (.pick shell) is missing";; esac
case "$CKPT" in *'function openAddProject()'*"fetch('/api/browse'"*'data-projreg='*'data-projnew='*) : ;; *) fail "the picker must navigate with GET /api/browse and offer Register / Start here per row (click, never a typed path)";; esac
case "$CKPT" in *"projPost('/api/repos', full"*"projPost('/api/repos/new', full"*) : ;; *) fail "Register must POST /api/repos and Start here POST /api/repos/new — the board's own endpoints, no new transport";; esac
case "$CKPT" in *'machineSlug:machineSlug()'*) : ;; *) fail "the picker must register on the rail's current machine (machineSlug())";; esac
case "$CKPT" in *'closeAddProject(); await hydrate(); toast('*) : ;; *) fail "a registered project must close the sheet, refresh the tree, and say so";; esac
pass "v5.28 G5: add-project picker (browse → Register / Start here) reuses /api/browse + /api/repos(+/new) and lands the repo in the tree"

# G2/G3(트리 헤더) — Scratch·Projects 도 같은 모양이 됐다: 이름 하나와 ⋯ 하나.
case "$CKPT" in *'<span>Scratch</span><span class="lacts">'*'data-menu="scratch"'*) : ;; *) fail "the Scratch header must be the name + one ⋯";; esac
case "$CKPT" in *'data-scrub="1"'*|*'data-newsession="1"'*) fail "the Scratch actions must live behind its ⋯ — no inline links in the header";; *) : ;; esac
case "$CKPT" in *'열린 세션 없음 — ⋯ 에서 ＋ Session'*) : ;; *) fail "the Scratch empty state must point at the ⋯";; esac
case "$CKPT" in *'<span>Projects</span><span class="lacts">'*'data-menu="projects"'*) : ;; *) fail "the Projects header must be the name + one ⋯";; esac
case "$CKPT" in *'보드에서 추가하세요'*) fail "the Projects empty state must stop deferring to the board — a project can be born here now";; *) : ;; esac
case "$CKPT" in *'등록된 repo 가 없습니다 — ⋯ 에서 ＋ Add project'*) : ;; *) fail "the Projects empty state must point at the ⋯";; esac
# Scratch·Projects 는 델타마다 다시 그려진다 → 정적 리스너가 아니라 위임이고, 열려 있던 메뉴는 새 버튼으로 주인을 옮긴다
G_TREEDLG="var sm = e.target.closest('[data-menu]');"
case "$CKPT" in *"$G_TREEDLG"*'openSecMenu(sm); return;'*) : ;; *) fail "the tree's section ⋯ must be wired by delegation (it is repainted on every delta)";; esac
case "$CKPT" in *"rowMenuOwner.hasAttribute('data-menu') && !document.contains(rowMenuOwner)"*) : ;; *) fail "a tree repaint must re-point an open section ⋯ instead of dropping it (and must not touch the static ones)";; esac
pass "v5.28 G2/G3: Scratch and Projects headers are a name + one ⋯ (delegated, repaint-safe) and both empty states point at it"

# G1/G6(공유 메뉴 + 정직) — ⋯ 는 여럿, 판은 하나. 항목은 전부 **이미 있는 핸들러**를 부른다.
case "$CKPT" in *'function openMenuAt(btn, acts, repoId){'*'function openRowMenu(btn, repoId){ openMenuAt(btn, ROW_MENU_ACTS, repoId); }'*'function openWsMenu(btn){ openMenuAt(btn, WS_MENU_ACTS); }'*'var SEC_MENU_ACTS = {'*'function openSecMenu(btn){'*) : ;; *) fail "every ⋯ must open the one shared menu through openMenuAt — one painter, many item lists";; esac
case "$CKPT" in *"{ act:'newsession', label:'＋ Session' }"*"{ act:'addproject', label:'＋ Add project…' }"*"{ act:'secrets',    label:'∗ Secrets' }"*) : ;; *) fail "the three new item lists (scratch · projects · top) are missing";; esac
case "$CKPT" in *"else if (act==='newsession') openSession();"*"else if (act==='scrub') openScrub();"*"else if (act==='addproject') openAddProject();"*"else if (act==='secrets') openSecrets();"*'setTimeout(function(){ setAttnPop(true); }, 0);'*) : ;; *) fail "every new ⋯ item must call an existing handler (openSession/openScrub/openAddProject/openSecrets/setAttnPop)";; esac
# 정적 ⋯ 둘(#wsMore·#topMore)은 한 번만 배선한다 — 다시 그려지지 않는 마크업이다
case "$CKPT" in *"\$('topMore').addEventListener('click', function(e){ e.stopPropagation(); openSecMenu(this); });"*) : ;; *) fail "#topMore is static markup — wire it once, like the buttons it replaced";; esac
# 닫기·키보드 계약은 Part D-rail 이 세운 그대로다(메뉴가 늘어도 규칙은 하나)
case "$CKPT" in *'role="menuitem"'*) : ;; *) fail "shared ⋯ menu items must stay role=menuitem";; esac
case "$CKPT" in *'first.focus()'*) : ;; *) fail "the shared ⋯ menu must still focus its first item on open";; esac
case "$CKPT" in *"var MENU_BTN_SEL = '[data-more],[data-menu]';"*) : ;; *) fail "the outside-click/focusout guards must keep recognizing every ⋯ button";; esac
pass "v5.28 G1/G6: one menu mechanism behind every ⋯ — existing handlers and endpoints only, no new transport, no new colors"

# v5.28 A5 서버 절반 — 웹훅. 코크핏이 닫혀 있을 때 유일하게 남는 신호다.
# 실제로 터미널을 붙이고 tmux 세션을 죽여 onExit → 'exited' 전이를 만든 뒤, 리스너가 받은 본문을 본다.
# 계약: 상태만 실린다(엔드포인트는 신뢰 경계 밖이라 detail·꼬리 발췌는 절대 안 된다).
kill "$DPID" 2>/dev/null || true; sleep 0.5
rm -f "$DB"*; rm -f "$AUTHDIR/auth.json" 2>/dev/null || true
COXPIT_AUTH_DISABLED=1 COXPIT_DB="$DB" COXPIT_PORT="$PORT" COXPIT_WEBHOOK_URL="http://127.0.0.1:$HOOKPORT/" \
  COXPIT_PUBLIC_URL="http://board.example:9999/" \
  node --import tsx "$ROOT/src/index.ts" >>"$WORK/daemon.log" 2>&1 &
DPID=$!
for i in $(seq 1 40); do curl -sf "$B/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
WHDIR="$WORK/as-hook"; mkdir -p "$WHDIR"
WHS=$(curl -sf -X POST "$B/api/session" -H 'content-type: application/json' -d "{\"machineSlug\":\"local\",\"path\":\"$WHDIR\",\"title\":\"hook\"}")
WHRUN=$(echo "$WHS" | python3 -c 'import sys,json;print(json.load(sys.stdin)["runId"])')
cat > "$WORK/agentstate.hook.mjs" <<'EOF'
// 터미널을 붙여 감지기를 깨우고, tmux 세션을 죽여 onExit('exited') 를 만든다.
import { execSync } from 'node:child_process';
const B = process.argv[2];
const RID = String(process.argv[3]);
const WSB = B.replace(/^http/, 'ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (m) => { console.error(m); process.exit(1); };

const term = new WebSocket(WSB + '/ws/term/' + RID + '?cols=80&rows=24');
let out = 0, exited = false;
term.addEventListener('message', (e) => {
  try { const m = JSON.parse(e.data); if (m.t === 'o') out++; else if (m.t === 'exit') exited = true; else if (m.t === 'err') die('term: ' + m.d); }
  catch { /* not json */ }
});
await new Promise((res, rej) => {
  term.addEventListener('open', () => res());
  term.addEventListener('error', () => rej(new Error('term ws failed to open')));
});
for (let i = 0; i < 40 && out === 0; i++) await sleep(250);
if (out === 0) die('no terminal output in 10s — nothing to feed the detector');
await sleep(1200);   // 분류가 안정될 때까지(여기선 idle — 웹훅을 쏘지 않는 전이)

execSync("tmux kill-session -t '=coxpit-r" + RID + "' 2>/dev/null || true", { shell: '/bin/sh' });
for (let i = 0; i < 40 && !exited; i++) await sleep(250);
if (!exited) die('pane never reported exit after tmux kill-session');
await sleep(1500);   // 웹훅 POST 가 리스너에 닿을 시간
console.log('HOOK_OK');
EOF
HK_OUT=$(node "$WORK/agentstate.hook.mjs" "$B" "$WHRUN" 2>&1) || fail "agentstate webhook: $HK_OUT"
case "$HK_OUT" in *HOOK_OK*) : ;; *) fail "agentstate webhook: $HK_OUT";; esac
HK=$(grep 'agentstate' "$WORK/hooks.log" 2>/dev/null | tail -1 || true)
[ -n "$HK" ] || fail "no agentstate webhook delivered (daemon log: $(tail -5 "$WORK/daemon.log"))"
case "$HK" in *'"state":"exited"'*) : ;; *) fail "agentstate webhook should report the exited transition: $HK";; esac
case "$HK" in *"\"runId\":$WHRUN"*) : ;; *) fail "agentstate webhook missing runId $WHRUN: $HK";; esac
case "$HK" in *'http://board.example:9999/?run='*) : ;; *) fail "agentstate webhook missing deep-link url (COXPIT_PUBLIC_URL): $HK";; esac
# 신뢰 경계 밖이다 — 상태 말고는 아무것도 싣지 않는다
case "$HK" in *detail*) fail "agentstate webhook must never carry a detail field: $HK";; *) : ;; esac
case "$HK" in *tail*) fail "agentstate webhook must never carry terminal tail text: $HK";; *) : ;; esac
curl -s -X POST "$B/api/runs/$WHRUN/cleanup" >/dev/null
pass "agentstate webhook: fires on the exited transition, state only (no detail/tail), 60s per-run cooldown"

# v6.0 T6 — 고아 tmux 수거. 목록은 서버가 판정한다: **DB 에 기록이 없는 coxpit-r* 만**.
# 빈 데몬에서도 모양은 서야 하고(200 + sessions[]), 아는 run 의 세션은 이름을 직접 건네도 죽지 않는다.
ORPH0=$(curl -sf "$B/api/tmux/orphans") || fail "GET /api/tmux/orphans failed"
case "$ORPH0" in *'"sessions"'*) : ;; *) fail "orphans payload must be { sessions: [...] }: $ORPH0";; esac
expect_code 400 -X POST "$B/api/tmux/orphans/kill" -H 'content-type: application/json' -d '{"sessions":"coxpit-r98765"}'
expect_code 400 -X POST "$B/api/tmux/orphans/kill" -H 'content-type: application/json' -d '{}'

# 아는 run 하나(세션 API 가 진짜 tmux 를 띄운다) + 지어낸 고아 둘(접두사 겹침: r98765 ⊂ r987654).
# 페인 명령을 못박아 분류를 결정적으로 만든다: 빈 셸(sh) = idle · 뭔가 도는 것(sleep) = 표시 대상.
ODIR="$WORK/orphan-known"; mkdir -p "$ODIR"
OKS=$(curl -sf -X POST "$B/api/session" -H 'content-type: application/json' -d "{\"machineSlug\":\"local\",\"path\":\"$ODIR\",\"title\":\"known\"}")
OKRUN=$(echo "$OKS" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).runId))')
tmux kill-session -t '=coxpit-r98765' 2>/dev/null || true
tmux kill-session -t '=coxpit-r987654' 2>/dev/null || true
tmux new-session -d -s coxpit-r98765 -c "$WORK" 'sh' || fail "could not fabricate an idle orphan tmux session"
tmux new-session -d -s coxpit-r987654 -c "$WORK" 'sleep 600' || fail "could not fabricate the busy prefix-twin orphan session"

# 모양 { sessions:[{name,runId,command,idle}] } + "아는 run 은 고아가 아니다" 를 한 번에 본다
curl -s "$B/api/tmux/orphans" | KNOWN_RUN="$OKRUN" node -e '
let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{
  const ss=JSON.parse(b).sessions;
  if(!Array.isArray(ss)) throw new Error("sessions must be an array: "+b);
  const fake=ss.find(x=>x.name==="coxpit-r98765");
  if(!fake) throw new Error("the fabricated orphan is not listed: "+b);
  for (const k of ["name","runId","command","idle"]) if(!(k in fake)) throw new Error("orphan entry missing "+k);
  if(typeof fake.runId!=="number"||typeof fake.idle!=="boolean"||typeof fake.command!=="string") throw new Error("orphan field types wrong: "+JSON.stringify(fake));
  if(fake.runId!==98765) throw new Error("runId must be read from the session name: "+JSON.stringify(fake));
  if(fake.idle!==true) throw new Error("a bare shell pane must classify as idle: "+JSON.stringify(fake));
  const twin=ss.find(x=>x.name==="coxpit-r987654");
  if(!twin) throw new Error("the prefix-twin orphan is not listed: "+b);
  // 빈 셸 이상이 돌고 있으면 표시만 한다 — 명령을 실어 보내되 절대 미리 고를 수 없게 idle:false
  if(twin.idle!==false) throw new Error("a pane running more than an idle shell must be flagged: "+JSON.stringify(twin));
  if(!twin.command || twin.command==="sh") throw new Error("the flag must carry the pane command: "+JSON.stringify(twin));
  if(ss.some(x=>x.name==="coxpit-r"+process.env.KNOWN_RUN)) throw new Error("a known run session must never be offered as an orphan: "+b);
  console.log("orphan listing ok");
})' || fail "orphan listing wrong in GET /api/tmux/orphans"

# 죽이기는 '=' 정확 일치 — coxpit-r98765 를 죽여도 coxpit-r987654 는 살아 있어야 한다(전에 이걸로 물렸다)
OKILL=$(curl -sf -X POST "$B/api/tmux/orphans/kill" -H 'content-type: application/json' -d '{"sessions":["coxpit-r98765"]}')
case "$OKILL" in *'"count":1'*) : ;; *) fail "reaper should report one kill: $OKILL";; esac
if tmux has-session -t '=coxpit-r98765' 2>/dev/null; then fail "the selected orphan survived the reaper"; fi
tmux has-session -t '=coxpit-r987654' 2>/dev/null || fail "exact match broken: coxpit-r98765 took its prefix twin coxpit-r987654 down with it"

# 아는 run 의 이름을 직접 건네도 서버가 고아 목록을 다시 떠서 거른다 — 살아 있는 터미널은 죽지 않는다
OSKIP=$(curl -sf -X POST "$B/api/tmux/orphans/kill" -H 'content-type: application/json' -d "{\"sessions\":[\"coxpit-r$OKRUN\"]}")
case "$OSKIP" in *'"count":0'*) : ;; *) fail "a live run's session must never be killed: $OSKIP";; esac
tmux has-session -t "=coxpit-r$OKRUN" 2>/dev/null || fail "the reaper killed a live run's terminal"
# 표시된(돌고 있는) 세션도 사람이 직접 고르면 죽는다 — 규칙은 "미리 고르지 않는다"이지 "못 죽인다"가 아니다
OBUSY=$(curl -sf -X POST "$B/api/tmux/orphans/kill" -H 'content-type: application/json' -d '{"sessions":["coxpit-r987654"]}')
case "$OBUSY" in *'"count":1'*) : ;; *) fail "a flagged orphan must still be killable when explicitly chosen: $OBUSY";; esac
curl -s -X DELETE "$B/api/runs/$OKRUN" >/dev/null
pass "v6.0 T6 reaper: { sessions:[{name,runId,command,idle}] } · busy panes flagged not preselected · known runs never listed/killed · exact '=' match · non-array 400"

# repo 등록 해제는 그대로 열려 있다(라우트는 아무것도 사라지지 않았다) — 열린 작업이 없으면 200.
UREPO="$WORK/unreg-repo"; mkdir -p "$UREPO"
git -C "$UREPO" init -q -b main
printf 'x\n' > "$UREPO/README.md"; git -C "$UREPO" add -A
git -C "$UREPO" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q -m init
UREG=$(curl -sf -X POST "$B/api/repos" -H 'content-type: application/json' -d "{\"machineSlug\":\"local\",\"path\":\"$UREPO\"}")
UREGID=$(echo "$UREG" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).repo.id))')
curl -sf -X DELETE "$B/api/repos/$UREGID" | grep -q '"ok":true' || fail "repo unregister (DELETE /api/repos/:id) broke"
[ -f "$UREPO/README.md" ] || fail "unregister must never touch the folder on disk"
expect_code 404 -X DELETE "$B/api/repos/$UREGID"
pass "v6.0 T6: unregister = registration only (DELETE /api/repos/:id still works, folder on disk intact, second delete 404)"

# v5.28 B2 — 리스너 조사기. 값은 기계마다 다르니 **모양과 정직함**만 못박는다:
# 200 + 배열 + (있다면) 각 항목의 키. lsof 가 없는 기계면 깨끗한 빈 결과 + note 여야 하고,
# 어떤 경우에도 500 으로 터지지 않는다(조사기가 터지면 조사할 수 없다).
PSD="$WORK/ports-sess"; mkdir -p "$PSD"
PSS=$(curl -sf -X POST "$B/api/session" -H 'content-type: application/json' -d "{\"machineSlug\":\"local\",\"path\":\"$PSD\",\"title\":\"ports\"}")
PSRUN=$(echo "$PSS" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).runId))')
PL=$(curl -sf "$B/api/runs/$PSRUN/listeners") || fail "GET /api/runs/:id/listeners failed"
echo "$PL" | node -e '
let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{
  const j=JSON.parse(b);
  if(!Array.isArray(j.listeners)) throw new Error("listeners must be an array: "+b);
  if(typeof j.note!=="string") throw new Error("note must always be a string (the honest-empty reason): "+b);
  if(typeof j.machine!=="string"||typeof j.pwd!=="string") throw new Error("the payload must say which machine/folder it answered for: "+b);
  if(!Array.isArray(j.spotted)) throw new Error("spotted (ports seen in the Part A tail) must be an array: "+b);
  for(const p of j.spotted) if(!Number.isInteger(p)) throw new Error("a spotted port must be a number, never invented text: "+b);
  for(const it of j.listeners){
    for(const k of ["pid","port","etime","underPane","command","args","machineId"]) if(!(k in it)) throw new Error("listener missing "+k+": "+JSON.stringify(it));
    if(typeof it.pid!=="number"||typeof it.port!=="number") throw new Error("pid/port must be numbers: "+JSON.stringify(it));
    if(typeof it.etime!=="string"||typeof it.underPane!=="boolean") throw new Error("etime must be a string and underPane a boolean: "+JSON.stringify(it));
    // 전체 argv 는 절대 표면에 오르지 않는다 — exec + 첫 인자까지만(시크릿 방어)
    if(it.args.trim().split(/\s+/).filter(Boolean).length>2) throw new Error("args must be clipped to exec + first arg: "+JSON.stringify(it));
  }
  console.log("listener shape ok ("+j.listeners.length+")");
})' || fail "listener payload shape wrong: $PL"
expect_code 404 "$B/api/runs/999999/listeners"
pass "v5.28 B2: GET /api/runs/:id/listeners returns facts (pid·port·etime·underPane, args clipped) + honest note; unknown run 404s"

# 포트 겨냥 조회 — 같은 항목 모양. 비어 있어도 200(그 포트를 아무도 안 물고 있을 뿐이다).
PP=$(curl -sf "$B/api/machines/local/port/$PORT") || fail "GET /api/machines/:id/port/:port failed"
echo "$PP" | node -e '
let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{
  const j=JSON.parse(b);
  if(!Array.isArray(j.listeners)) throw new Error("listeners must be an array: "+b);
  if(typeof j.note!=="string"||typeof j.port!=="number") throw new Error("the payload must carry the port it answered for + a note: "+b);
  for(const it of j.listeners){
    for(const k of ["pid","port","etime","underPane","command","args","machineId"]) if(!(k in it)) throw new Error("listener missing "+k+": "+JSON.stringify(it));
  }
  console.log("port scan shape ok ("+j.listeners.length+")");
})' || fail "port scan payload shape wrong: $PP"
expect_code 400 "$B/api/machines/local/port/99999"
expect_code 404 "$B/api/machines/no-such-machine/port/80"
pass "v5.28 B2: GET /api/machines/:id/port/:port answers for one port (same item shape, empty is fine, bad port 400, unknown machine 404)"

# 종료 가드는 **서버 쪽**이다. 셋 다 거절이어야 한다: pid 1 · 데몬 자신 · 지금 목록에 없는 pid.
# ("포트 위 전부 죽이기" 같은 편의 엔드포인트는 아예 없다 — 무관한 프로세스를 데려간다.)
expect_code 403 -X POST "$B/api/machines/local/kill" -H 'content-type: application/json' -d '{"pid":1}'
expect_code 403 -X POST "$B/api/machines/local/kill" -H 'content-type: application/json' -d "{\"pid\":$DPID}"
expect_code 409 -X POST "$B/api/machines/local/kill" -H 'content-type: application/json' -d '{"pid":4000000}'
expect_code 400 -X POST "$B/api/machines/local/kill" -H 'content-type: application/json' -d '{"pid":"nope"}'
expect_code 404 -X POST "$B/api/machines/no-such-machine/kill" -H 'content-type: application/json' -d '{"pid":4000000}'
curl -sf "$B/api/health" >/dev/null || fail "a refused kill must never touch the daemon"
pass "v5.28 B2: kill guards refuse pid 1, the daemon's own pid, and any pid absent from a fresh scan (no arbitrary-pid kill)"

# 내가 띄운 일회용 리스너 하나로 한 바퀴 — lsof 가 없는 기계(최소 리눅스)면 조용히 건너뛴다.
TPORT=$((PORT+7))
node -e 'require("http").createServer((q,s)=>s.end("x")).listen(Number(process.argv[1]),"127.0.0.1")' "$TPORT" &
TPID=$!
for i in $(seq 1 20); do curl -s -o /dev/null "http://127.0.0.1:$TPORT/" && break; sleep 0.25; done
TSCAN=$(curl -sf "$B/api/machines/local/port/$TPORT" || true)
TFOUND=$(echo "$TSCAN" | TPID="$TPID" node -e '
let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{
  let j={}; try{ j=JSON.parse(b); }catch{ return console.log("0"); }
  const hit=(j.listeners||[]).find(x=>String(x.pid)===String(process.env.TPID));
  if(!hit) return console.log("0");
  if(!hit.etime) return console.log("noetime");
  console.log("1");
})')
if [ "$TFOUND" = "1" ]; then
  TK=$(curl -s -X POST "$B/api/machines/local/kill" -H 'content-type: application/json' -d "{\"pid\":$TPID}")
  case "$TK" in *'"gone":true'*) : ;; *) fail "an explicitly chosen listener should die: $TK";; esac
  TAFTER=$(curl -sf "$B/api/machines/local/port/$TPORT" || true)
  case "$TAFTER" in *"\"pid\":$TPID"*) fail "the killed listener is still listed after a re-scan: $TAFTER";; *) : ;; esac
  pass "v5.28 B2: a listed listener is killable by exact pid (TERM→KILL) and the re-scan shows it gone"
else
  case "$TFOUND" in noetime) fail "a listed listener must carry etime — 'since when' is the whole answer";; esac
  pass "v5.28 B2: kill round-trip skipped (no lsof on this machine) — the scan stayed an honest empty"
fi
kill "$TPID" 2>/dev/null || true
curl -s -X POST "$B/api/runs/$PSRUN/cleanup" >/dev/null

# ── v5.28 Part H — dry run 은 run 의 일급 성질이다 ──
# 한 줄로 줄이면: **모의가 진짜 작업으로 오인되면 안 된다.**
# 라이브에서 dry run 하나가 3파전에 끼어 실 후보들과 구분되지 않았다 — diff 를 열어
# COXPIT_DRYRUN.txt 를 봐야 알았다. 원인은 단순했다: dry/real 이 run 에 **저장되지 않았다**.
# 그래서 셋을 못박는다:
#   ① 사실은 run 행에 남는다(real) — 그리고 모든 직렬화·델타에 실린다
#   ② **아는 dry 만** 배지한다(기본 1=real) — 모르는 과거를 모의라고 부르지 않는다
#   ③ 머지·승자 선택 전에 한 번 묻는다 — 네이티브 confirm 이 아니라 기존 확인 대화상자로
# 파일 순서대로 본다: 스키마/마이그레이션 → API → 코크핏 → 보드.

# H1 — 기본값이 곧 정직함이다. 컬럼은 DEFAULT 1(real) 이라, 이 컬럼 이전의 run 은 절대 dry 로 칠해지지 않는다.
H_SCHEMA=$(cat "$ROOT/src/db/schema.ts")
case "$H_SCHEMA" in *"real: integer('real', { mode: 'boolean' }).notNull().default(true)"*) : ;; *) fail "agent_runs needs a real column defaulting to true (badge dry, never guess dry)";; esac
H_DDL=$(cat "$ROOT/src/db/index.ts")
case "$H_DDL" in *"ALTER TABLE agent_runs ADD COLUMN real INTEGER NOT NULL DEFAULT 1"*) : ;; *) fail "the real column needs an idempotent DEFAULT 1 migration beside the other ALTERs";; esac
pass "v5.28 H1: agent_runs.real exists with an idempotent DEFAULT 1 migration (the unknown past stays real)"

# 세션(run 1)은 에이전트 런치가 없어 real=기본(true) — dry 가 아니다(기본값이 곧 정직함).
H_SESS=$(curl -sf "$B/api/runs/1") || fail "GET /api/runs/1 failed"
echo "$H_SESS" | node -e '
let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{
  const r=JSON.parse(b).run;
  if(typeof r.real!=="boolean") throw new Error("run.real must be a boolean: "+JSON.stringify(r.real));
  if(r.agent==="session" && r.real!==true) throw new Error("a session keeps the default real:true (it is not a dry run): "+JSON.stringify(r.real));
  console.log("session carries real:true (not a dry run)");
})' || fail "session run lost real: $H_SESS"
# 진짜 dry 에이전트 run 을 여기서 하나 만든다(그린필드 레시피, 이 데몬은 real 토글이 없어 모의로 돈다) → real:false.
HNP="$WORK/h-dry"
HREPO=$(curl -s -X POST "$B/api/repos/new" -H 'content-type: application/json' -d "{\"machineSlug\":\"local\",\"path\":\"$HNP\"}")
HRID=$(echo "$HREPO" | python3 -c 'import sys,json;print(json.load(sys.stdin)["repo"]["id"])' 2>/dev/null) || fail "h-dry repos/new failed: $HREPO"
HT=$(curl -sf -X POST "$B/api/tasks" -H 'content-type: application/json' -d "{\"repoId\":$HRID,\"title\":\"h-dry\",\"prompt\":\"x\"}")
HTID=$(echo "$HT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["task"]["id"])')
curl -sf -X POST "$B/api/tasks/$HTID/run" -H 'content-type: application/json' -d '{"count":1}' | grep -q '"ok":true' || fail "h-dry run launch"
HRUN=$(curl -s "$B/api/tasks/$HTID" | python3 -c 'import sys,json;print(json.load(sys.stdin)["runs"][0]["id"])')
HD=""
for i in $(seq 1 60); do HD=$(curl -s "$B/api/runs/$HRUN" | { grep -oE '"status":"(done|failed|error)"' || true; } | head -1); [ -n "$HD" ] && break; sleep 0.5; done
H_ONE=$(curl -sf "$B/api/runs/$HRUN")
echo "$H_ONE" | node -e '
let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{
  const r=JSON.parse(b).run;
  if(typeof r.real!=="boolean") throw new Error("run.real must be a boolean: "+JSON.stringify(r.real));
  if(r.agent==="session") throw new Error("expected an agent run, got a session");
  if(r.real!==false) throw new Error("a dry-launched agent run must report real:false, got "+JSON.stringify(r.real));
  console.log("dry agent run carries real:false");
})' || fail "dry agent run lost real:false: $H_ONE"

# 손 세션은 진짜 터미널이다 — 에이전트 발사 경로를 타지 않으니 기본값 그대로 real:true 로 남는다.
HSD="$WORK/h-sess"; mkdir -p "$HSD"
HSS=$(curl -sf -X POST "$B/api/session" -H 'content-type: application/json' -d "{\"machineSlug\":\"local\",\"path\":\"$HSD\",\"title\":\"h-real\"}")
HSRUN=$(echo "$HSS" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).runId))')
H_REAL=$(curl -sf "$B/api/runs/$HSRUN") || fail "GET /api/runs/:id failed for the hand session"
echo "$H_REAL" | node -e '
let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{
  const r=JSON.parse(b).run;
  if(r.real!==true) throw new Error("a run that never ran a mock must report real:true: "+JSON.stringify(r.real));
  console.log("real run carries real:true");
})' || fail "a non-dry run must report real:true: $H_REAL"

# 플릿 — 모든 run 이 불리언 real 을 들고 온다(클라이언트는 real===false 하나만 본다).
H_FLEET=$(curl -sf "$B/api/fleet?view=all") || fail "GET /api/fleet failed"
echo "$H_FLEET" | node -e '
let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{
  const rs=JSON.parse(b).runs||[];
  if(!rs.length) throw new Error("no runs in the fleet payload");
  for(const r of rs) if(typeof r.real!=="boolean") throw new Error("fleet run r"+r.id+" is missing a boolean real");
  if(!rs.some(r=>r.real===false)) throw new Error("the dry runs of this suite must surface as real:false");
  if(!rs.some(r=>r.real===true)) throw new Error("a real run must surface as real:true (default 1)");
  console.log("fleet runs carry real ("+rs.length+")");
})' || fail "fleet payload lost real"
# 비교 뷰도 같은 사실을 들고 온다 — 승자를 고르는 화면이 바로 여기다.
# (파이프 없이 매칭: 큰 페이로드에 grep -q 를 물리면 SIGPIPE+pipefail 오탐이 난다)
# dry run 이 든 방금 그 태스크(HTID)를 본다 — task 1 은 세션이라 real:false 가 없다.
H_CMP=$(curl -s "$B/api/tasks/$HTID/compare")
case "$H_CMP" in *'"real":false'*) : ;; *) fail "compare payload must carry real (the winner is picked here): $H_CMP";; esac
curl -s -X POST "$B/api/tasks/$HTID/close" -H 'content-type: application/json' -d '{"force":true}' >/dev/null
pass "v5.28 H1: real rides every serialized run (/api/runs/:id · /api/fleet · /api/tasks/:id/compare) as a boolean"

# H2 — 코크핏. 칩은 real===false 에만 붙는다(항상 붙는 장식이 아니다).
# bash 3.2 중첩 따옴표 함정 — 따옴표를 품은 패턴은 먼저 변수에 담는다.
H_DRYATTR='data-dry="1"'
H_CFMOPEN="\$('cfmModal').classList.add('on')"
H_CKMERGE="b.getAttribute('data-dry')==='1' && !(await confirmDryMerge(1))"
H_BDMERGE="btn.dataset.dry==='1' && !(await confirmDryMerge(1))"
H_ASK='이 run 은 dry (모의)입니다 — 정말 머지할까요?'
case "$CKPT" in *'.dryc{'*'color:var(--faint)'*'border:1px solid var(--line-hi)'*) : ;; *) fail "the dry chip must be a bordered mono chip on existing tokens (no new color)";; esac
case "$CKPT" in *'id="cfmModal"'*'id="cfmMsg"'*'id="cfmOk"'*) : ;; *) fail "the cockpit needs its own confirm dialog markup (no native confirm)";; esac
case "$CKPT" in *'function confirmUI(message, opts)'*"$H_CFMOPEN"*) : ;; *) fail "the cockpit confirm must be the promise-based confirmUI over the existing .pick shell";; esac
case "$CKPT" in *'function confirmDryMerge(n)'*"$H_ASK"*) : ;; *) fail "the dry merge guard must ask in the existing confirm, with the spec's wording";; esac
# 판정은 한 줄이다 — real===false 만 dry 다. undefined(마이그레이션 이전·미하이드레이트)는 dry 가 아니다.
H_CHIP=$(printf '%s' "$CKPT" | node -e '
let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{
  const q=String.fromCharCode(39);
  const i=b.indexOf("function isDryRun(r){");
  if(i<0) return console.log("NO_ISDRY");
  const decl=b.slice(i, b.indexOf("\n", i));
  if(!/return !!r && r\.real===false;/.test(decl)) return console.log("NOT_STRICT");
  const k=b.indexOf("function dryChip(r){");
  if(k<0) return console.log("NO_DRYCHIP");
  const body=b.slice(k, b.indexOf("\n", k));
  if(!/isDryRun\(r\)/.test(body)) return console.log("CHIP_UNGATED");
  if(body.indexOf(">dry<")<0) return console.log("CHIP_NOT_THE_WORD");
  if(body.indexOf(": "+q+q+";")<0) return console.log("REAL_RUN_GETS_A_CHIP");
  console.log("DRYCHIP_OK");
});')
case "$H_CHIP" in DRYCHIP_OK) : ;; *) fail "the chip must key off real===false and draw nothing for a real run: $H_CHIP";; esac
# 붙는 자리 셋 — 트리 run 행 · 활동 헤더 · (아래 H3) 비교 열
case "$CKPT" in *'<div class="tnode run'*'dryChip(r)'*) : ;; *) fail "the tree run row must carry the dry chip beside its status dot";; esac
case "$CKPT" in *'data-role="actchip"'*'dryChip(runById[runId])'*) : ;; *) fail "the activity-view header must carry the dry chip";; esac
pass "cockpit v5.28 H2: a lowercase mono dry chip on tree run rows + the activity header, gated on real===false (real runs get none)"

# H3 — 비교/머지 가드. dry 열은 표가 나고, 머지는 말없이 지나가지 않는다.
case "$CKPT" in *'class="rv-col-h"'*'dryChip(r)'*"$H_DRYATTR"*) : ;; *) fail "a dry candidate's compare column must be flagged and its merge button marked";; esac
case "$CKPT" in *"$H_CKMERGE"*) : ;; *) fail "the cockpit merge must stop on a dry run until the confirm says go";; esac
# 보드 — 같은 규칙, 같은 낱말. 카드 · 비교 열 · 방(workroom) · 묶음 통합 넷 다.
case "$BOARD_HTML" in *'.dryc{'*'color:var(--faint)'*'border:1px solid var(--line-hi)'*) : ;; *) fail "the board dry chip must reuse existing tokens (no new color)";; esac
case "$BOARD_HTML" in *'function isDryRun(r){ return !!r && r.real===false; }'*) : ;; *) fail "the board must judge dry by real===false only (never a falsy check)";; esac
case "$BOARD_HTML" in *'function confirmDryMerge(n)'*'confirmUI('*"$H_ASK"*) : ;; *) fail "the board dry guard must go through confirmUI, not native confirm";; esac
case "$BOARD_HTML" in *'chipHTML(r.status)+dryChip(r)'*) : ;; *) fail "the board run card must show the dry chip next to its status chip";; esac
case "$BOARD_HTML" in *'class="cmp-h"'*'dryChip(r)'*"$H_DRYATTR"*) : ;; *) fail "the board compare column must flag a dry candidate";; esac
case "$BOARD_HTML" in *"$H_BDMERGE"*) : ;; *) fail "the board compare merge must raise the dry guard first";; esac
case "$BOARD_HTML" in *'isDryRun(r) && !(await confirmDryMerge(1))'*) : ;; *) fail "the workroom merge must raise the dry guard too";; esac
case "$BOARD_HTML" in *'selOrder.filter(id=>isDryRun(runs.get(id))).length'*'confirmDryMerge(dryN)'*) : ;; *) fail "a bare Integrate-selected must not silently take a dry run";; esac
pass "v5.28 H3: dry candidates are flagged in both compares; every merge/pick path (compare · workroom · integrate) asks first via the custom confirm"

# H4 — 정직함과 범위. 새 색도, 이모지도, 새 전송로도 없다(래칫은 위에서 이미 봤다).
H_EMJ=$(node -e '
const fs=require("fs");
const rx=/[\u{1F000}-\u{1FAFF}\u{2699}\u{26A0}\u{2B50}]/u;
// board.ts·orchestrator.ts 는 제외 — 이전부터 허용된 이모지(⚙ 모델·⚠ 경고·⭐ serve·🤖 PR 본문)가 있다.
// Part H 가 board.ts 에 더한 dry 칩은 '단어'라 안전하고, 서빙 보드 이모지는 별도 체크가 지킨다.
const files=["src/cockpit.ts","src/server.ts","src/db/schema.ts","src/db/index.ts"];
let bad=[];
for(const f of files){ const s=fs.readFileSync(process.argv[1]+"/"+f,"utf8").split("\n");
  s.forEach((l,i)=>{ if(rx.test(l)) bad.push(f+":"+(i+1)); }); }
console.log(bad.length?bad.join(" "):"ASCII_OK");
' "$ROOT")
case "$H_EMJ" in ASCII_OK) : ;; *) fail "emoji in a Part H source file (comments included) — the chip is a word: $H_EMJ";; esac
# 컴포넌트 표는 같은 커밋에서 갱신된다(DESIGN.md 는 강제되는 계약이다).
H_DESIGN=$(cat "$ROOT/DESIGN.md")
case "$H_DESIGN" in *'Dry run badge (v5.28 H)'*'.dryc'*'DEFAULT 1'*) : ;; *) fail "DESIGN.md must document the dry run badge in the same commit";; esac
curl -s -X DELETE "$B/api/runs/$HSRUN" >/dev/null
pass "v5.28 H4: only known-dry runs are badged; no emoji, no new transport, and DESIGN.md carries the component"

# ── v5.28 Part I — 보드는 Scratch 세션을 싣지 않는다 ──
# 한 줄로 줄이면: **보드는 에이전트 작업의 열람실이다.** 자유 터미널 세션은 run 이 아니므로
# 여기 서지 않는다 — 그래도 세션의 집인 코크핏에서는 그대로 산다.
# 서버는 손대지 않았다: /api/fleet 은 세션을 계속 내보내고(두 화면이 같은 페이로드를 읽는다),
# 거르는 일은 오로지 보드 쪽 client 로직이다. 그래서 여기선 둘을 나눠 본다 —
#   ① 서빙된 보드 소스에 규칙이 실제로 박혀 있나(모든 입구에)
#   ② 살아 있는 플릿 페이로드에 그 규칙을 그대로 적용하면 세션만 빠지나
# 파일 순서대로: 판정 기준 → 하이드레이트 → WS 델타 → 단건/아카이브 → 세는 자리 → 행동 → 코크핏.

# I1(판정) — 기준은 repo.kind 하나다. 그 위에 task/run 헬퍼가 선다(델타는 runId, 객체는 id).
I_KIND="allRepos.filter(x => x.kind === 'sessions')"
I_HELP_T="const isSessionTask = (taskId) => sessionTaskIds.has(taskId);"
I_HELP_R="const isSessionRun = (r) => !!r && (sessionRunIds.has(r.runId ?? r.id) || isSessionTask(r.taskId));"
case "$BOARD_HTML" in *"$I_KIND"*) : ;; *) fail "the board must derive its session repos from repo.kind === 'sessions'";; esac
case "$BOARD_HTML" in *"$I_HELP_T"*"$I_HELP_R"*) : ;; *) fail "the board needs isSessionTask/isSessionRun helpers — one rule, used at every door";; esac

# 하이드레이트 — repo 목록·task·run 셋 다 같은 문을 지나고, 기준도 여기서 다시 세워진다.
I_HREPO="repos = allRepos.filter(x => !isSessionRepo(x.id))"
I_HTASK="(r.tasks||[]).forEach(t => { if (!isSessionTask(t.id)) tasks.set(t.id, t); });"
I_HRUN="(r.runs||[]).forEach(rn => { if (!isSessionRun(rn)) runs.set(rn.id, { ...rn, events: rn.events||[] }); });"
case "$BOARD_HTML" in *"$I_HREPO"*"$I_HTASK"*"$I_HRUN"*) : ;; *) fail "hydrate must drop session repos from the repo list and skip session tasks/runs";; esac
# 하이드레이트만 거르면 반쪽이다 — 보드가 열려 있는 사이 난 세션은 델타로 들어온다.
I_WSRUN="if (isSessionRun(ev)) return;"
I_WSTASK="if (isSessionTask(ev.taskId) || isSessionRepo(ev.repoId)) return;"
I_UPS="if (isSessionRun(patch)) return;"
case "$BOARD_HTML" in *"$I_WSRUN"*) : ;; *) fail "the run delta handler must skip a session run (a Scratch session must never pop in)";; esac
case "$BOARD_HTML" in *"$I_WSTASK"*) : ;; *) fail "the task delta handler must skip a session task";; esac
case "$BOARD_HTML" in *"$I_UPS"*) : ;; *) fail "upsertRun is the last door — a session run must not slip through it";; esac
pass "v5.28 I1: the board judges by repo.kind === 'sessions' and guards every ingestion point (hydrate · WS run/task deltas · upsertRun)"

# 단건 fetch 와 아카이브 — 목록만 막으면 뒷문이 열려 있다.
I_ONE="if(d.run && !isSessionRun(d.run))"
I_ARCH="filter(row => !sessionRepoNames.has(row.repoName))"
I_ARCHOPEN="if (isSessionRepo(j.task.repoId)) return;"
case "$BOARD_HTML" in *"$I_ONE"*"$I_ONE"*) : ;; *) fail "both single-run fetches must refuse to seed a session run into the board's map";; esac
case "$BOARD_HTML" in *"$I_ARCH"*) : ;; *) fail "the archive list must omit session-bucket rows (rows carry no repoId — match the bucket name)";; esac
case "$BOARD_HTML" in *"$I_ARCHOPEN"*) : ;; *) fail "opening an archive row must not pull a session task in";; esac
# 세는 자리와 그리는 자리 — 레일 목록은 걸러진 repos 만 읽고, 배지는 세션을 세지 않는다.
I_CNT="if (isSessionRun(r)) continue;"
case "$BOARD_HTML" in *"$I_CNT"*) : ;; *) fail "the rail's active-run counts must never count a session run";; esac
case "$BOARD_HTML" in *'for (const r of repos){'*"\$('repoList').innerHTML = html;"*) : ;; *) fail "#repoList must render from the filtered repos list only";; esac
pass "v5.28 I1: single-run fetches · archive rows · repo list · active-run counts all honor the same session guard"

# I1(행동) — 진짜로 만들어 본다: Scratch 세션 하나 + 보통의 에이전트 run 하나.
ISD="$WORK/i-scratch"; mkdir -p "$ISD"
ISS=$(curl -sf -X POST "$B/api/session" -H 'content-type: application/json' -d "{\"machineSlug\":\"local\",\"path\":\"$ISD\",\"title\":\"i-scratch\"}") || fail "Part I: session create failed"
ISRUN=$(echo "$ISS" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).runId))')
INP="$WORK/i-agent"
IREPO=$(curl -s -X POST "$B/api/repos/new" -H 'content-type: application/json' -d "{\"machineSlug\":\"local\",\"path\":\"$INP\"}")
IRID=$(echo "$IREPO" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).repo.id))') || fail "Part I: repos/new failed: $IREPO"
IT=$(curl -sf -X POST "$B/api/tasks" -H 'content-type: application/json' -d "{\"repoId\":$IRID,\"title\":\"i-agent\",\"prompt\":\"x\"}")
ITID=$(echo "$IT" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).task.id))')
curl -sf -X POST "$B/api/tasks/$ITID/run" -H 'content-type: application/json' -d '{"count":1}' | grep -q '"ok":true' || fail "Part I: agent run launch"
IARUN=$(curl -s "$B/api/tasks/$ITID" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).runs[0].id))')
I_FLEET=$(curl -sf "$B/api/fleet?view=active") || fail "Part I: GET /api/fleet failed"
# 서버는 그대로고(세션은 계속 실린다 — 코크핏이 읽는다), 보드의 규칙만 적용해 본다.
echo "$I_FLEET" | ISRUN="$ISRUN" IARUN="$IARUN" node -e '
let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{
  const f=JSON.parse(b);
  const sess=Number(process.env.ISRUN), agent=Number(process.env.IARUN);
  const bucket=(f.repos||[]).filter(r=>r.kind==="sessions");
  if(!bucket.length) throw new Error("/api/fleet must still carry the sessions bucket — the cockpit lives on it");
  if(!(f.runs||[]).some(r=>r.id===sess)) throw new Error("/api/fleet must be unchanged: the session run r"+sess+" is still served");
  // 여기서부터가 보드가 하는 일 — sessionRepoIds → session tasks → session runs
  const ids=new Set(bucket.map(r=>r.id));
  const stasks=new Set((f.tasks||[]).filter(t=>ids.has(t.repoId)).map(t=>t.id));
  const keptRuns=(f.runs||[]).filter(r=>!stasks.has(r.taskId));
  if(keptRuns.some(r=>r.id===sess)) throw new Error("the board rule must drop the session run r"+sess);
  if(!keptRuns.some(r=>r.id===agent)) throw new Error("the board rule must keep the agent run r"+agent);
  const keptRepos=(f.repos||[]).filter(r=>!ids.has(r.id));
  if(keptRepos.some(r=>r.kind==="sessions")) throw new Error("no sessions bucket may reach the repo list");
  if(!keptRepos.length) throw new Error("the real project must survive the filter (this is a filter, not a blackout)");
  console.log("fleet unchanged · the board rule drops r"+sess+" and keeps r"+agent);
})' || fail "the board session rule does not hold on the live fleet payload: $I_FLEET"
pass "v5.28 I1: /api/fleet still serves the Scratch session (server untouched) while the board rule drops it and keeps the agent run"

# I2(범위) — 잃은 것이 없다. 세션의 집은 코크핏이고, 거기 Scratch 섹션은 그대로다.
I_CKSESS="var sessionRepoIds = {}; repos.forEach(function(r){ if (r.kind==='sessions') sessionRepoIds[r.id]=true; });"
case "$CKPT" in *"$I_CKSESS"*) : ;; *) fail "the cockpit must keep building its Scratch section from the sessions bucket";; esac
case "$CKPT" in *'<span>Scratch</span><span class="lacts">'*'<div class="tnode session'*) : ;; *) fail "the cockpit Scratch section (and its session rows) must be untouched by Part I";; esac
# 컴포넌트 표는 같은 커밋에서 갱신된다(DESIGN.md 는 강제되는 계약이다).
I_DESIGN=$(cat "$ROOT/DESIGN.md")
case "$I_DESIGN" in *'Board session exclusion (v5.28 I)'*"sessionRepoIds"*'zero new colors'*) : ;; *) fail "DESIGN.md must record the board's session exclusion in the same commit";; esac
curl -s -X DELETE "$B/api/runs/$ISRUN" >/dev/null
pass "v5.28 I2: board-only — the cockpit still shows Scratch, /api/fleet is unchanged, and DESIGN.md carries the rule"

# ── v5.28 Part J — 승자는 내려앉은 그 호흡에 검증된다 ─────────────────────────────
# 공용 도구: 새 repo 하나 만들고 등록해 id 를 돌려준다(전부 dry, 크레딧 0).
j_new_repo(){
  local dir="$1"
  mkdir -p "$dir"; git -C "$dir" init -q -b main
  printf 'seed\n' > "$dir/README.md"; git -C "$dir" add -A
  git -C "$dir" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q -m init
  local body
  body=$(curl -sf -X POST "$B/api/repos" -H 'content-type: application/json' -d "{\"machineSlug\":\"local\",\"path\":\"$dir\"}") \
    || fail "Part J: repo register failed for $dir"
  echo "$body" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).repo.id))'
}
# dry run 하나를 발사하고 정착할 때까지 기다린 뒤 run id 를 돌려준다.
j_settled_run(){
  local rid="$1" title="$2" t tid run st
  t=$(curl -sf -X POST "$B/api/tasks" -H 'content-type: application/json' -d "{\"repoId\":$rid,\"title\":\"$title\",\"prompt\":\"x\"}") \
    || fail "Part J: task create failed ($title)"
  tid=$(echo "$t" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).task.id))')
  curl -sf -X POST "$B/api/tasks/$tid/run" -H 'content-type: application/json' -d '{"count":1}' >/dev/null \
    || fail "Part J: run launch failed ($title)"
  run=$(curl -s "$B/api/tasks/$tid" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).runs[0].id))')
  st=""
  for i in $(seq 1 80); do
    st=$(curl -s "$B/api/runs/$run" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).run.status))')
    case "$st" in done|failed|stopped) break;; esac
    sleep 0.5
  done
  [ "$st" = "done" ] || fail "Part J: the run did not settle done ($title, got '$st')"
  echo "$run"
}

# J1(통과) — verifyCmd 가 base 에서 돌았다는 것을 두 겹으로 본다:
#  ① 머지 전에는 base 에 없던 파일을 본다(worktree 가 아니라 머지된 base 여야 통과)
#  ② 실행 위치를 적어두게 해서, 그 자리가 서버가 들고 있는 repo.path 와 같은지 대조한다
JREPO="$WORK/j-verify"
JPWD="$WORK/j-verify-where.txt"
JRID=$(j_new_repo "$JREPO")
JVCMD="test -f COXPIT_DRYRUN.txt && pwd > '$JPWD'"
JVJSON=$(JV="$JVCMD" node -e 'process.stdout.write(JSON.stringify({verifyCmd:process.env.JV}))')
JP=$(curl -s -X PATCH "$B/api/repos/$JRID" -H 'content-type: application/json' -d "$JVJSON")
case "$JP" in *'"ok":true'*) : ;; *) fail "Part J: verifyCmd PATCH failed: $JP";; esac
if [ -f "$JREPO/COXPIT_DRYRUN.txt" ]; then fail "Part J: the base marker must not exist before the merge"; fi
JRUN=$(j_settled_run "$JRID" "j-pass")
# 정착 자동검증(worktree 에서 도는 쪽)이 다 쓸 때까지 기다렸다 지운다 —
# 그래야 이 파일에 다음으로 적히는 자리는 머지 뒤 base 검증이 도는 자리 하나뿐이다.
for i in $(seq 1 40); do [ -f "$JPWD" ] && break; sleep 0.25; done
rm -f "$JPWD"
JM=$(curl -s -X POST "$B/api/runs/$JRUN/merge")
case "$JM" in *'"ok":true'*) : ;; *) fail "Part J: merge should succeed: $JM";; esac
case "$JM" in *'"verify":{"status":"pass"'*) : ;; *) fail "Part J: the merge response must carry verify.status pass (verifyCmd run on the merged base): $JM";; esac
[ -f "$JREPO/COXPIT_DRYRUN.txt" ] || fail "Part J: the merge did not land on the base"
[ -f "$JPWD" ] || fail "Part J: the post-merge verify never ran"
JWHERE=$(cat "$JPWD")
JPATH=$(curl -s "$B/api/repos" | JRID="$JRID" node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{const r=JSON.parse(b).repos.find(x=>String(x.id)===process.env.JRID);if(!r)throw new Error("repo missing");console.log(r.path)})')
[ "$JWHERE" = "$JPATH" ] || fail "Part J: verify ran at '$JWHERE' — it must run on the merged base checkout '$JPATH', never a worktree"
pass "v5.28 J1: merging a winner runs the repo's verifyCmd on the merged base (cwd = repo.path) and reports it in the merge response (pass)"

# J1(실패) — 떨어지는 verifyCmd 는 보고일 뿐이다: 머지는 ok:true 로 서 있고 run 은 merged 그대로,
# 꼬리는 응답에 실려 온다. 되돌리는 경로는 없다(J3).
JFREPO="$WORK/j-verify-fail"
JFRID=$(j_new_repo "$JFREPO")
JFP=$(curl -s -X PATCH "$B/api/repos/$JFRID" -H 'content-type: application/json' -d '{"verifyCmd":"echo boom; exit 3"}')
case "$JFP" in *'"ok":true'*) : ;; *) fail "Part J: failing verifyCmd PATCH failed: $JFP";; esac
JFRUN=$(j_settled_run "$JFRID" "j-fail")
JFM=$(curl -s -X POST "$B/api/runs/$JFRUN/merge")
case "$JFM" in *'"ok":true'*) : ;; *) fail "Part J: a failing verify must not fail the merge: $JFM";; esac
case "$JFM" in *'"verify":{"status":"fail"'*) : ;; *) fail "Part J: verify.status should be fail: $JFM";; esac
case "$JFM" in *boom*) : ;; *) fail "Part J: the verify tail must ride the merge response: $JFM";; esac
JFST=$(curl -s "$B/api/runs/$JFRUN" | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>console.log(JSON.parse(b).run.status))')
[ "$JFST" = "merged" ] || fail "Part J: a failing verify must never un-merge (run status '$JFST')"
[ -f "$JFREPO/COXPIT_DRYRUN.txt" ] || fail "Part J: the merge must stand after a failing verify"
pass "v5.28 J1/J3: a failing verify reports and never un-merges (ok:true · status merged · tail carried)"

# J1(없음) — verifyCmd 가 없으면 아무 명령도 추측하지 않는다: status '' 의 no-op, 그리고 크래시 없음.
JNREPO="$WORK/j-noverify"
JNRID=$(j_new_repo "$JNREPO")
JNRUN=$(j_settled_run "$JNRID" "j-none")
JNM=$(curl -s -X POST "$B/api/runs/$JNRUN/merge")
case "$JNM" in *'"ok":true'*) : ;; *) fail "Part J: merge without a verifyCmd should still succeed: $JNM";; esac
case "$JNM" in *'"verify":{"status":"","output":""}'*) : ;; *) fail "Part J: no verifyCmd must be a no-op (verify.status ''), never a guessed command: $JNM";; esac
pass "v5.28 J1: no verifyCmd → the merge response carries an empty verify block (nothing is guessed, nothing crashes)"

# J2(코크핏 Review) — 머지 응답이 실어 온 판정을 머지를 누른 그 자리에 남기고,
# 명령이 없으면 조용히 넘어가지 않고 기존 setter(#rvVcmd → PATCH /api/repos/:id)로 안내한다.
# 마커는 파일 순서 그대로: 그리는 자리 → 저장하는 자리 → 머지 응답을 받는 자리.
case "$CKPT" in *'var mv = mergeVerifyById[r.id]'*'data-mvout="'*'머지는 됐지만 검증 실패 — 로그 확인'*) : ;; *) fail "cockpit Review must draw the post-merge verify verdict on the merged column";; esac
case "$CKPT" in *'data-vnudge="1"'*'검증 명령이 없어요 — repo 설정에서 verifyCmd 를 지정하면 승자를 자동 검증합니다'*) : ;; *) fail "cockpit Review must nudge toward verifyCmd when the repo has none";; esac
case "$CKPT" in *'var mergeVerifyById = {}'*"\$('rvVcmd').focus()"*'mergeVerifyById[rid] = (j && j.verify)'*) : ;; *) fail "cockpit must store the merge response's verify block and point the nudge at the existing verifyCmd setter";; esac
# 기존 verify 렌더를 그대로 쓴다 — 새 배지도 새 색도 만들지 않는다.
case "$CKPT" in *'(vbadge(mv.status)||'*) : ;; *) fail "the post-merge line must reuse vbadge() — the semantic pass/fail treatment already in the system";; esac
pass "v5.28 J2: cockpit Review shows merged · verify: pass|fail on the merged column (vbadge reused) + the no-verifyCmd nudge"

# J2(보드 compare) — 같은 판정이 보드의 머지 자리에도 남는다. 안내 한 줄은 잘리면 안 되므로
# 유일하게 새로 생긴 규칙 .cmp-mv 만 두고, 색은 기존 상태 토큰(--s-done/--s-failed)을 쓴다.
case "$BOARD_HTML" in *'.cmp-mv{'*'const mergeVerifyByRun = {};'*'function mergeVerifyHTML(rid)'*) : ;; *) fail "board compare must carry the post-merge verify line";; esac
case "$BOARD_HTML" in *'검증 명령이 없어요 — repo 설정에서 verifyCmd 를 지정하면 승자를 자동 검증합니다'*'<a href="/cockpit"'*) : ;; *) fail "the board's no-verifyCmd nudge must link to the existing verifyCmd setter";; esac
case "$BOARD_HTML" in *"statusColor(v.status==='pass' ? 'done' : 'failed')"*'머지는 됐지만 검증 실패 — 로그 확인'*) : ;; *) fail "the board verdict must reuse the existing status tokens (pass=done · fail=failed) — no new color";; esac
case "$BOARD_HTML" in *'+ mergeVerifyHTML(r.id)'*'data-mvout'*'mergeVerifyByRun[rid] = j.verify'*) : ;; *) fail "the board must persist the verdict across repaints and open the tail from the line";; esac
# 컴포넌트 표는 같은 커밋에서 갱신된다(DESIGN.md 는 강제되는 계약이다).
J_DESIGN=$(cat "$ROOT/DESIGN.md")
case "$J_DESIGN" in *'Post-merge verify line (v5.28 J)'*'verifyBase'*'Zero new colors'*) : ;; *) fail "DESIGN.md must record the post-merge verify surfacing in the same commit";; esac
pass "v5.28 J2/J3: board compare carries the same verdict + nudge, reusing existing status tokens, and DESIGN.md carries the rule"

echo "---"
echo "E2E PASS ($PASS_COUNT checks)"
