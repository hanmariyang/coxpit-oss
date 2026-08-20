// 브랜디드 접근키 언락/셋업 페이지(단일 자가완결 HTML — 빌드 0, 보드 토큰 매치).
// 브라우저 basic-auth 팝업을 대체한다.
// ── Safari 쿠키 레이스 수정(v5.0) ──
// 폼은 real navigation POST(urlencoded, hidden nav=1)로 /api/auth/{unlock,setup} 에 제출한다.
// 서버는 성공 시 303 → GET /(브라우저가 그 응답의 Set-Cookie 를 커밋한 뒤 이동)로 답하므로,
// fetch-then-location.replace 가 겪던 "쿠키 미커밋 → 다시 로그인" 레이스가 사라진다.
// 실패는 서버가 이 페이지를 error 와 함께 다시 렌더한다(JS 없이도 동작). JSON API 는 그대로 유지.
// setup=true → 첫 실행(키 설정, confirm 필드+토큰 힌트), false → 언락(키 1개).
import { ICON_SPRITE, ICON_CSS } from './icons.js';

/** HTML 속성 값 이스케이프(서버 렌더 에러 문자열 안전 주입용). */
function escA(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface LoginOpts { error?: string }

/** login/setup 페이지 HTML. setup 이면 셋업(키+확인), 아니면 언락. opts.error 는 서버가 재렌더 시 주입. */
export function loginPageHTML(setup: boolean, opts: LoginOpts = {}): string {
  const title = setup ? 'set an access key' : 'unlock';
  const initialErr = opts.error ? escA(opts.error) : '';
  const action = setup ? '/api/auth/setup' : '/api/auth/unlock';
  return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>coxpit · ${title}</title>
<link rel="icon" href="/brand/favicon.ico" sizes="any" />
<link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png" />
<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png" />
<style>
  @font-face{font-family:'Pixelify';src:url('/brand/pixelify.woff2') format('woff2');font-weight:400 700;font-display:swap}
  :root{
    --bg:#0b0d12; --surface:#12151c; --surface2:#171b24; --line:#222835; --line-hi:#2f3648;
    --ink:#dee4ec; --muted:#8792a2; --faint:#5c6675;
    --brand:#4ec9b0; --brand-ink:#062822; --brand-dim:rgba(78,201,176,.13);
    --s-failed:#e25b67; --s-preparing:#d6a249;
    --mono:ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,monospace;
    --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,Roboto,sans-serif;
    --r-card:10px; --r-ctl:8px; --shadow:0 8px 28px rgba(0,0,0,.35);
  }
  *{box-sizing:border-box}
  [hidden]{display:none !important}
  html,body{height:100%}
  html{overscroll-behavior:none}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.5;
    -webkit-font-smoothing:antialiased;display:flex;align-items:center;justify-content:center;
    padding:24px;padding:max(24px,env(safe-area-inset-top)) max(24px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(24px,env(safe-area-inset-left));
    overflow-x:hidden}
  ::selection{background:var(--brand-dim)}
  .card{width:100%;max-width:380px;background:var(--surface);border:1px solid var(--line);
    border-radius:var(--r-card);box-shadow:var(--shadow);padding:26px 24px 22px}
  .welcome{width:80px;height:auto;display:block;margin:2px auto 14px;opacity:.97;-webkit-user-drag:none}
  .mark{font-family:var(--mono);font-weight:700;color:var(--brand);font-size:17px;letter-spacing:.02em;
    display:flex;align-items:center;gap:9px}
  .mark .wm{font-family:'Pixelify';font-weight:600;color:var(--ink);font-size:19px;letter-spacing:.01em}
  .glyph{font-size:18px;line-height:1}
  h1{font-size:15px;font-weight:600;margin:16px 0 4px;color:var(--ink)}
  .sub{color:var(--muted);font-size:12.5px;margin:0 0 18px;line-height:1.5}
  .flabel{display:block;font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.12em;
    color:var(--faint);margin:0 0 6px}
  input[type=password]{width:100%;background:#0e1118;border:1px solid var(--line);border-radius:var(--r-ctl);
    color:var(--ink);font-family:var(--mono);font-size:16px;padding:10px 12px;outline:none}
  input[type=password]:focus{border-color:var(--brand)}
  input::placeholder{color:var(--faint)}
  .fld{margin-bottom:14px}
  .row{display:flex;align-items:center;gap:8px;margin:2px 0 16px;color:var(--muted);font-size:12.5px;user-select:none;cursor:pointer}
  .row input{accent-color:var(--brand);width:15px;height:15px}
  .btn{width:100%;background:var(--brand);color:var(--brand-ink);border:0;border-radius:var(--r-ctl);
    font-family:var(--sans);font-weight:600;font-size:14px;padding:11px;cursor:pointer;
    display:flex;align-items:center;justify-content:center;gap:8px}
  .btn:disabled{opacity:.55;cursor:default}
  .err{color:var(--s-failed);font-size:12.5px;min-height:17px;margin:0 0 12px;font-family:var(--mono)}
  .hint{background:var(--surface2);border:1px solid var(--line);border-radius:var(--r-ctl);
    padding:9px 11px;color:var(--muted);font-size:11.5px;line-height:1.55;margin:0 0 16px}
  .hint code{font-family:var(--mono);color:var(--brand);font-size:11px}
  .ft{margin-top:18px;padding-top:14px;border-top:1px solid var(--line);text-align:center}
  .ft a{color:var(--faint);text-decoration:none;font-size:11.5px}
  .ft a:hover{color:var(--muted)}
  ${ICON_CSS}
  .mark .ic{width:18px;height:18px}
  .btn .ic{width:16px;height:16px}
</style>
</head>
<body>
${ICON_SPRITE}
  <form class="card" id="f" method="post" action="${action}" autocomplete="off">
    <input type="hidden" name="nav" value="1">
    <img class="welcome" src="/brand/wave.png" alt="" />
    <div class="mark"><svg class="ic"><use href="#i-lock"/></svg><span class="wm">coxpit</span></div>
    <h1>${setup ? 'Protect this coxpit' : 'Unlock this coxpit'}</h1>
    <p class="sub">${setup
      ? 'Set an access key. You&#39;ll enter it once per device — no accounts, no username.'
      : 'Enter your access key. One key, one owner — no username.'}</p>
    ${setup ? `<div class="hint">To prove you own this machine, this first-time setup needs the one-time
      <code>setup token</code> printed in the daemon log &mdash; unless you&#39;re on
      <code>http://127.0.0.1</code> directly. Paste it below if asked.</div>` : ''}
    <div class="err" id="err">${initialErr}</div>
    ${setup ? `<div class="fld"><label class="flabel" for="tok">setup token (from the daemon log)</label>
      <input id="tok" name="token" type="password" placeholder="paste if not on localhost" autocomplete="off"
        autocapitalize="none" autocorrect="off" spellcheck="false"></div>` : ''}
    <div class="fld"><label class="flabel" for="key">access key</label>
      <input id="key" name="key" type="password" placeholder="&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;"
        autocomplete="${setup ? 'new-password' : 'current-password'}"
        autocapitalize="none" autocorrect="off" spellcheck="false" autofocus></div>
    ${setup ? `<div class="fld"><label class="flabel" for="key2">confirm access key</label>
      <input id="key2" type="password" placeholder="&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;"
        autocomplete="new-password" autocapitalize="none" autocorrect="off" spellcheck="false"></div>` : ''}
    <label class="row"><input id="rem" name="remember" type="checkbox" value="on"${setup ? ' checked' : ''}><span>Remember this device</span></label>
    <button class="btn" id="go" type="submit"><svg class="ic"><use href="#i-${setup ? 'lock' : 'unlock'}"/></svg><span>${setup ? 'Set key &amp; enter' : 'Unlock'}</span></button>
    <div class="ft"><a href="https://github.com/hanmariyang/coxpit-oss#remote-access" target="_blank" rel="noopener">Fronting with Cloudflare Access / Tailscale? &rarr;</a></div>
  </form>
<script>
(function(){
  var SETUP = ${setup ? 'true' : 'false'};
  var f = document.getElementById('f');
  var err = document.getElementById('err');
  var go = document.getElementById('go');
  function show(m){ err.textContent = m || ''; }
  // 폼은 native navigation POST 로 제출된다(Safari 가 응답의 Set-Cookie 를 커밋 → 303 GET /).
  // 여기서는 클라이언트 사전검증만: 비면 막고, setup 이면 confirm/길이 확인. 통과 시 native 제출 진행.
  f.addEventListener('submit', function(ev){
    var key = document.getElementById('key').value;
    if (!key){ ev.preventDefault(); show('access key required'); return; }
    if (SETUP){
      var key2 = document.getElementById('key2').value;
      if (key !== key2){ ev.preventDefault(); show('keys do not match'); return; }
      if (key.length < 6){ ev.preventDefault(); show('use at least 6 characters'); return; }
    }
    show('');
    go.disabled = true;           // 네비게이션 진행 중 중복 제출 방지(네이티브 제출은 계속)
  });
})();
</script>
</body>
</html>`;
}
