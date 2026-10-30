#!/usr/bin/env python3
# claude 상태줄 명령: 구독 한도(5시간 · 주간)를 ~/.claude/coxpit-usage.json 에 남기고 한 줄로 보인다.
# coxpit 데몬(/api/usage)이 이 파일을 읽어 폰 앱에 보낸다.
# 쓰는 법: ~/.claude/settings.json 에 "statusLine": {"type": "command", "command": "python3 <이 파일>"}
import json, os, sys, time

try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
rl = d.get('rate_limits') or {}
if rl:
    p = os.path.expanduser('~/.claude/coxpit-usage.json')
    tmp = '%s.%d' % (p, os.getpid())
    try:
        with open(tmp, 'w') as f:
            json.dump({'at': int(time.time()), 'rate_limits': rl}, f)
        os.replace(tmp, p)
    except Exception:
        pass

def part(key, label):
    w = rl.get(key) or {}
    if 'used_percentage' not in w:
        return None
    s = '%s %d%%' % (label, round(w['used_percentage']))
    left = int(w.get('resets_at', 0) - time.time())
    if 0 < left < 6 * 3600:
        s += ' (%d:%02d 뒤)' % (left // 3600, left % 3600 // 60)
    return s

model = (d.get('model') or {}).get('display_name') or ''
bits = [b for b in [model, part('five_hour', '5시간'), part('seven_day', '주')] if b]
print(' · '.join(bits))
