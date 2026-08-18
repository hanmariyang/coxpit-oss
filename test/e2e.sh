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
  rm -rf "$WORK"
}
trap cleanup EXIT

# throwaway git repo
mkdir -p "$REPO"
git -C "$REPO" init -q -b main
printf 'hello\n' > "$REPO/README.md"
git -C "$REPO" add -A
git -C "$REPO" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q -m init

# boot daemon (dry-run agent, auth off)
COXPIT_AUTH_DISABLED=1 COXPIT_DB="$DB" COXPIT_PORT="$PORT" \
  node --import tsx "$ROOT/src/index.ts" >"$WORK/daemon.log" 2>&1 &
DPID=$!
for i in $(seq 1 40); do curl -sf "$B/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "$B/api/health" | grep -q '"ok":true' || fail "daemon did not boot: $(tail -5 "$WORK/daemon.log")"
pass "daemon boots, health ok"

curl -s "$B/" | grep -q '<title>coxpit' || fail "board not served"
pass "board served"

# machine probe
curl -sf -X POST "$B/api/machines/local/probe" | grep -q '"ready":true' || fail "local probe not ready (git/tmux required)"
pass "local machine probe ready"

# repo registry + validation
curl -sf -X POST "$B/api/repos" -H 'content-type: application/json' \
  -d "{\"machineSlug\":\"local\",\"path\":\"$REPO\"}" | grep -q '"ok":true' || fail "repo register"
expect_code 400 -X POST "$B/api/repos" -H 'content-type: application/json' -d "{\"machineSlug\":\"local\",\"path\":\"$WORK\"}"
pass "repo registry + work-tree validation"

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

# steer guards: dry-run has no session -> 409; missing message -> 400
expect_code 409 -X POST "$B/api/runs/2/steer" -H 'content-type: application/json' -d '{"message":"do more"}'
expect_code 400 -X POST "$B/api/runs/2/steer" -H 'content-type: application/json' -d '{}'
pass "steer guards (no session 409, empty 400)"

# task close cleans everything
curl -sf -X POST "$B/api/tasks/1/close" | grep -q '"ok":true' || fail "close"
[ -z "$(git -C "$REPO" branch --list 'coxpit/*')" ] || fail "branches not cleaned"
pass "task close cleans worktrees + branches"

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

# auth gate (fresh daemon with pass)
kill "$DPID" 2>/dev/null || true; sleep 0.5
rm -f "$DB"*
COXPIT_AUTH_USER=admin COXPIT_AUTH_PASS=pw-e2e COXPIT_DB="$DB" COXPIT_PORT="$PORT" \
  node --import tsx "$ROOT/src/index.ts" >>"$WORK/daemon.log" 2>&1 &
DPID=$!
for i in $(seq 1 40); do curl -sf "$B/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
expect_code 401 "$B/api/machines"
expect_code 200 -u admin:pw-e2e "$B/api/machines"
expect_code 200 "$B/design/bookmarklet.js"
expect_code 201 -X POST "$B/api/design/capture?k=pw-e2e" -H 'content-type: application/json' -d '{"selector":"x"}' 
expect_code 401 -X POST "$B/api/design/capture?k=nope" -H 'content-type: application/json' -d '{}' 
pass "auth gate + capture key"

echo "---"
echo "E2E PASS ($PASS_COUNT checks)"
