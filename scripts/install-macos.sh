#!/bin/zsh
# coxpit 데몬(대화 기능 판)을 이 맥에 깐다. 폰 · 아이패드 · 맥의 Coxpit 앱이 이 맥의 claude 세션을 본다.
#
#   curl -fsSL https://raw.githubusercontent.com/hanmariyang/coxpit-oss/feat/chat-sessions/scripts/install-macos.sh | zsh
#
# 하는 일
#   1. Homebrew 로 node · tmux · qrencode (없을 때만), claude 가 없으면 npm 으로
#   2. 코드: ~/services/coxpit-oss-chat (feat/chat-sessions), 데이터: ~/services/coxpit-oss-data
#   3. 접속 키를 새로 만든다(데이터 폴더 AUTH.txt, 600). 다시 돌리면 있는 키를 그대로 쓴다
#   4. LaunchAgent com.coxpit.oss 로 늘 켜 둔다. 테일스케일 주소에만 연다(회사 망 등 바깥 LAN 에는 안 연다)
#   5. claude 상태줄로 구독 한도를 남긴다(앱의 사용량 줄). 원래 settings.json 은 .bak 로
#   6. 끝에 QR: 앱 설정 → 「다른 기기에 맥 넣기」 와 같은 링크. 폰 카메라로 찍으면 이 맥이 앱에 들어간다
#
# 선택: 폰 푸시(앱이 꺼져 있어도 알림)를 쓰려면 APNs 키 AuthKey_<ID>.p8 를 ~/Downloads 에 두고
#       COXPIT_APNS_TEAM=<팀 ID> 를 붙여 다시 돌린다.
# 되돌리기: launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.coxpit.oss.plist
set -euo pipefail

BRANCH=${COXPIT_BRANCH:-feat/chat-sessions}
REPO=${COXPIT_REPO:-https://github.com/hanmariyang/coxpit-oss.git}
CODE=~/services/coxpit-oss-chat
DATA=~/services/coxpit-oss-data
PORT=${COXPIT_PORT:-8210}
NAME=${COXPIT_NAME:-$(scutil --get ComputerName 2>/dev/null || hostname -s)}
PLIST=~/Library/LaunchAgents/com.coxpit.oss.plist
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale

say() { print -P "%F{cyan}==%f $*"; }
die() { print -P "%F{red}!!%f $*" >&2; exit 1; }

# ── 0. 테일스케일 ──
command -v tailscale >/dev/null && TS=$(command -v tailscale)
[[ -x $TS ]] || die "테일스케일이 없어요. https://tailscale.com/download/mac 에서 깔고 로그인한 뒤 다시 돌려 주세요."
TSJSON=$($TS status --json 2>/dev/null) || die "테일스케일에 로그인해 주세요(메뉴 막대 아이콘 → Log in)."
TSIP=$(print -r -- $TSJSON | /usr/bin/python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("Self") or {}).get("TailscaleIPs",[""])[0])')
TSDNS=$(print -r -- $TSJSON | /usr/bin/python3 -c 'import json,sys; d=json.load(sys.stdin); print(((d.get("Self") or {}).get("DNSName") or "").rstrip("."))')
[[ -n $TSIP ]] || die "테일스케일 주소를 못 읽었어요. 테일스케일이 켜져 있는지 봐 주세요."
say "테일스케일: $TSDNS ($TSIP)"

# ── 1. 도구 ──
if ! command -v brew >/dev/null; then
  [[ -x /opt/homebrew/bin/brew ]] && eval "$(/opt/homebrew/bin/brew shellenv)" || die "Homebrew 가 없어요. https://brew.sh 의 한 줄로 깔고 다시 돌려 주세요."
fi
BREW_PREFIX=$(brew --prefix)
for t in node tmux qrencode; do
  command -v $t >/dev/null || { say "$t 깔기"; brew install $t >/dev/null; }
done
NODE=$(command -v node)
if ! command -v claude >/dev/null; then
  say "claude 깔기"; npm install -g @anthropic-ai/claude-code >/dev/null
  print "   claude 를 처음 깔았어요. 터미널에서 claude 를 한 번 켜서 로그인해 두세요."
fi

# ── 2. 코드 ──
mkdir -p ~/services $DATA $DATA/bin ~/Library/Logs/coxpit-oss
if [[ -d $CODE/.git ]]; then
  say "코드 받기(갱신)"; git -C $CODE fetch -q origin $BRANCH && git -C $CODE checkout -q $BRANCH && git -C $CODE pull -q --ff-only
else
  say "코드 받기"; git clone -q -b $BRANCH $REPO $CODE
fi
say "npm 패키지"; (cd $CODE && npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null)
ln -sf "$(command -v tmux)" $DATA/bin/tmux
# claude 가 nvm 같은 데 있어도 데몬이 찾게
CLAUDE_DIR=$(dirname "$(command -v claude)")

# ── 3. 접속 키 ──
if [[ ! -s $DATA/AUTH.txt ]]; then
  ( umask 077; LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24 > $DATA/AUTH.txt )
  say "접속 키를 새로 만들었어요($DATA/AUTH.txt)"
fi
chmod 600 $DATA/AUTH.txt

# ── 선택: 폰 푸시 ──
P8=$(ls ~/Downloads/AuthKey_*.p8 2>/dev/null | head -1 || true)
if [[ -n ${COXPIT_APNS_TEAM:-} && -n $P8 ]]; then
  mkdir -p $DATA/apns; install -m 600 $P8 $DATA/apns/; print -r -- "{\"teamId\":\"$COXPIT_APNS_TEAM\"}" > $DATA/apns/config.json
  say "폰 푸시 키를 넣었어요($(basename $P8))"
fi

# ── 4. 늘 켜 두기 ──
# 키는 plist 에 적지 않고 켤 때 AUTH.txt 에서 읽는다
cat > $PLIST <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>com.coxpit.oss</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>COXPIT_AUTH_USER</key><string>admin</string>
		<key>COXPIT_DB</key><string>$DATA/coxpit.db</string>
		<key>COXPIT_HOST</key><string>$TSIP</string>
		<key>COXPIT_PORT</key><string>$PORT</string>
		<key>PATH</key><string>$DATA/bin:$CLAUDE_DIR:$(dirname $NODE):$BREW_PREFIX/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
	</dict>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string><string>-c</string>
		<string>COXPIT_AUTH_PASS=\$(cat $DATA/AUTH.txt) exec $NODE $CODE/bin/coxpit.js</string>
	</array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>SoftResourceLimits</key><dict><key>NumberOfFiles</key><integer>1048576</integer></dict>
	<key>StandardOutPath</key><string>$HOME/Library/Logs/coxpit-oss/out.log</string>
	<key>StandardErrorPath</key><string>$HOME/Library/Logs/coxpit-oss/err.log</string>
</dict>
</plist>
PL
U=gui/$(id -u)
launchctl bootout $U $PLIST 2>/dev/null || true
sleep 1
launchctl bootstrap $U $PLIST
say "데몬 켜는 중"
ok=""
for i in {1..60}; do
  c=$(curl -s -o /dev/null -w '%{http_code}' http://$TSIP:$PORT/api/chats || true)
  [[ $c == 401 || $c == 200 ]] && { ok=1; break; }
  sleep 1
done
[[ -n $ok ]] || die "데몬이 안 떴어요. 로그: ~/Library/Logs/coxpit-oss/err.log"

# ── 5. 사용량(상태줄) ──
mkdir -p ~/.claude
install -m 755 $CODE/scripts/claude-statusline.py ~/.claude/coxpit-statusline.py
SET=~/.claude/settings.json
[[ -f $SET ]] || print '{}' > $SET
/usr/bin/python3 - $SET <<'PY'
import json, os, sys, shutil
p = sys.argv[1]
d = json.load(open(p))
want = {"type": "command", "command": "python3 ~/.claude/coxpit-statusline.py"}
if d.get("statusLine") != want:
    if d.get("statusLine"):
        print("   원래 상태줄이 있어서 그대로 둬요(사용량 줄은 상태줄을 바꿔야 나와요): %s" % d["statusLine"])
    else:
        shutil.copy(p, p + ".bak-coxpit")
        d["statusLine"] = want
        t = p + ".tmp"; json.dump(d, open(t, "w"), ensure_ascii=False, indent=2); os.replace(t, p)
PY

# ── 6. 앱에 넣기 ──
URL="http://$TSDNS:$PORT"
LINK=$(NAME="$NAME" URL="$URL" KEYFILE=$DATA/AUTH.txt /usr/bin/python3 -c '
import json, os, base64
e = [{"name": os.environ["NAME"], "url": os.environ["URL"], "key": open(os.environ["KEYFILE"]).read().strip()}]
print("coxpit://add?d=" + base64.urlsafe_b64encode(json.dumps(e, ensure_ascii=False).encode()).decode().rstrip("="))')
print
say "끝났어요. 이 맥: $NAME · $URL"
print "   폰 카메라로 아래 QR 을 찍으면 Coxpit 앱에 이 맥이 들어가요(키를 칠 필요 없어요)."
print
qrencode -t ANSIUTF8 -m 2 "$LINK"
print "   맥 앱에서는: 아래 줄을 복사한 뒤 설정 → 「복사한 링크로 맥 넣기」"
print -r -- "   $LINK"
print "   (이 링크 · QR 에는 접속 키가 들어 있어요. 내 기기에만 쓰세요)"
