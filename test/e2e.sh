#!/usr/bin/env bash
# Coxpit E2E — boots the daemon against a throwaway repo and exercises the full
# dry-run pipeline: registry, fleet run, events, diff, compare, merge (+guards),
# stop semantics, task close, design capture -> prompt injection, auth gate.
# No credits spent (dry-run agent). Exits non-zero on first failure.
set -euo pipefail

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
pass "board served (with mobile drawer + deep-link)"

# machine probe
curl -sf -X POST "$B/api/machines/local/probe" | grep -q '"ready":true' || fail "local probe not ready (git/tmux required)"
pass "local machine probe ready"

# directory browser (repo picker)
curl -sf "$B/api/browse" | grep -q '"dirs"' || fail "browse endpoint"
pass "directory browser lists folders"

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

# task close cleans everything (통합 태스크까지 닫아야 브랜치 0)
curl -sf -X POST "$B/api/tasks/1/close" | grep -q '"ok":true' || fail "close"
curl -sf -X POST "$B/api/tasks/$ITID/close" | grep -q '"ok":true' || fail "close integration task"
[ -z "$(git -C "$REPO" branch --list 'coxpit/*')" ] || fail "branches not cleaned"
pass "task close cleans worktrees + branches"

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
curl -s -X POST "$B/api/tasks/1/close" >/dev/null
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
for TID in $(echo "$PLAN" | python3 -c 'import sys,json;[print(t["id"]) for t in json.load(sys.stdin)["tasks"]]'); do
  curl -s -X POST "$B/api/tasks/$TID/close" >/dev/null
done
pass "plan fan-out launches planned tasks (mock planner)"

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
curl -s -X POST "$B/api/tasks/$CTID/close" >/dev/null
pass "codex run via API settles with agent recorded (dry rehearsal)"

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
expect_code 201 -X POST "$B/api/design/capture?k=pw-e2e" -H 'content-type: application/json' -d '{"selector":"x"}' 
expect_code 401 -X POST "$B/api/design/capture?k=nope" -H 'content-type: application/json' -d '{}' 
pass "auth gate + capture key"

echo "---"
echo "E2E PASS ($PASS_COUNT checks)"
