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
case "$BOARD_HTML" in *'id="mDocsTgl"'*) : ;; *) fail "doc-mode toggle missing";; esac
case "$BOARD_HTML" in *'dl-line'*) : ;; *) fail "clickable diff lines missing";; esac
case "$BOARD_HTML" in *'id="termIbar"'*) : ;; *) fail "terminal input bar missing";; esac
case "$BOARD_HTML" in *'id="taskModel"'*) : ;; *) fail "model input missing";; esac
case "$BOARD_HTML" in *'id="repoBranch"'*) : ;; *) fail "base branch button missing";; esac
case "$BOARD_HTML" in *'card.closed .log::before'*) : ;; *) fail "closed-card hatching missing";; esac
case "$BOARD_HTML" in *'gband-h'*) : ;; *) fail "group band markup missing";; esac
case "$BOARD_HTML" in *'attemptHTML'*) : ;; *) fail "attempt counter missing";; esac
case "$BOARD_HTML" in *'id="viewSeg"'*) : ;; *) fail "active/archive view seg missing";; esac
case "$BOARD_HTML" in *'arch-row'*) : ;; *) fail "archive row styles missing";; esac
pass "board served (v4.1..v4.3 UI assets present)"

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
pass "plan fan-out launches planned tasks (mock planner)"

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

# v4.1 E — repo 기본 브랜치 override (fixture 에 wip-side-branch 존재)
curl -sf -X PATCH "$B/api/repos/1" -H 'content-type: application/json' -d '{"defaultBranch":"wip-side-branch"}' | grep -q '"defaultBranch":"wip-side-branch"' || fail "branch patch to existing failed"
curl -s "$B/api/repos" | grep -q '"defaultBranch":"wip-side-branch"' || fail "branch patch not reflected"
expect_code 400 -X PATCH "$B/api/repos/1" -H 'content-type: application/json' -d '{"defaultBranch":"no-such-branch"}'
curl -sf -X PATCH "$B/api/repos/1" -H 'content-type: application/json' -d '{"defaultBranch":"main"}' >/dev/null
pass "per-repo base branch override (existing 200, missing 400)"

# auth gate (fresh daemon with pass)
kill "$DPID" 2>/dev/null || true; sleep 0.5
rm -f "$DB"*
COXPIT_AUTH_USER=admin COXPIT_AUTH_PASS=pw-e2e COXPIT_DB="$DB" COXPIT_PORT="$PORT" \
  node --import tsx "$ROOT/src/index.ts" >>"$WORK/daemon.log" 2>&1 &
DPID=$!
for i in $(seq 1 40); do curl -sf "$B/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
expect_code 401 "$B/api/machines"
expect_code 401 "$B/api/browse"
expect_code 200 -u admin:pw-e2e "$B/api/machines"
expect_code 200 "$B/design/bookmarklet.js"
# /share/* 는 무인증 예외(없는 토큰이라도 401 이 아니라 404 여야 함)
expect_code 404 "$B/share/no-such-token"
expect_code 201 -X POST "$B/api/design/capture?k=pw-e2e" -H 'content-type: application/json' -d '{"selector":"x"}'
expect_code 401 -X POST "$B/api/design/capture?k=nope" -H 'content-type: application/json' -d '{}'
pass "auth gate + capture key"

# v4.5 — remote endpoints are behind the auth gate; with a real password set the
# Funnel guard does NOT trip (guard is empty-pass only). Test funnel-OFF (always
# ungated, never invokes the CLI's funnel-on) so we don't touch a dev tailnet.
expect_code 401 "$B/api/remote"
expect_code 200 -u admin:pw-e2e "$B/api/remote"
expect_code 200 -u admin:pw-e2e -X POST "$B/api/remote/funnel" -H 'content-type: application/json' -d '{"on":false}'
pass "remote endpoints auth-gated; funnel guard is empty-pass only"

echo "---"
echo "E2E PASS ($PASS_COUNT checks)"
