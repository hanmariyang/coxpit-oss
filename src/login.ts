// 브랜디드 접근키 언락/셋업 페이지(단일 자가완결 HTML — 빌드 0, 보드 토큰 매치).
// 브라우저 basic-auth 팝업을 대체한다. fetch 로 A2/A3 엔드포인트 POST → 성공 시 보드로 reload.
// setup=true → 첫 실행(키 설정, confirm 필드+토큰 힌트), false → 언락(키 1개).

/** login/setup 페이지 HTML. setup 이면 셋업(키+확인), 아니면 언락. */
export function loginPageHTML(setup: boolean): string {
  const title = setup ? 'set an access key' : 'unlock';
  return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>coxpit · ${title}</title>
<style>
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
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.5;
    -webkit-font-smoothing:antialiased;display:flex;align-items:center;justify-content:center;padding:24px}
  ::selection{background:var(--brand-dim)}
  .card{width:100%;max-width:380px;background:var(--surface);border:1px solid var(--line);
    border-radius:var(--r-card);box-shadow:var(--shadow);padding:26px 24px 22px}
  .mark{font-family:var(--mono);font-weight:700;color:var(--brand);font-size:17px;letter-spacing:.02em;
    display:flex;align-items:center;gap:9px}
  .glyph{font-size:18px;line-height:1}
  h1{font-size:15px;font-weight:600;margin:16px 0 4px;color:var(--ink)}
  .sub{color:var(--muted);font-size:12.5px;margin:0 0 18px;line-height:1.5}
  .flabel{display:block;font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.12em;
    color:var(--faint);margin:0 0 6px}
  input[type=password]{width:100%;background:#0e1118;border:1px solid var(--line);border-radius:var(--r-ctl);
    color:var(--ink);font-family:var(--mono);font-size:14px;padding:10px 12px;outline:none}
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
</style>
</head>
<body>
  <form class="card" id="f" autocomplete="off">
    <div class="mark"><span class="glyph">${setup ? '&#128272;' : '&#128274;'}</span><span>coxpit</span></div>
    <h1>${setup ? 'Protect this coxpit' : 'Unlock this coxpit'}</h1>
    <p class="sub">${setup
      ? 'Set an access key. You&#39;ll enter it once per device — no accounts, no username.'
      : 'Enter your access key. One key, one owner — no username.'}</p>
    ${setup ? `<div class="hint">To prove you own this machine, this first-time setup needs the one-time
      <code>setup token</code> printed in the daemon log &mdash; unless you&#39;re on
      <code>http://127.0.0.1</code> directly. Paste it below if asked.</div>` : ''}
    <div class="err" id="err"></div>
    ${setup ? `<div class="fld"><label class="flabel" for="tok">setup token (from the daemon log)</label>
      <input id="tok" type="password" placeholder="paste if not on localhost" autocomplete="off"></div>` : ''}
    <div class="fld"><label class="flabel" for="key">access key</label>
      <input id="key" type="password" placeholder="&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;" autocomplete="${setup ? 'new-password' : 'current-password'}" autofocus></div>
    ${setup ? `<div class="fld"><label class="flabel" for="key2">confirm access key</label>
      <input id="key2" type="password" placeholder="&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;" autocomplete="new-password"></div>` : ''}
    <label class="row"><input id="rem" type="checkbox"${setup ? ' checked' : ''}><span>Remember this device</span></label>
    <button class="btn" id="go" type="submit"><span class="glyph">${setup ? '&#128272;' : '&#128275;'}</span><span>${setup ? 'Set key &amp; enter' : 'Unlock'}</span></button>
    <div class="ft"><a href="https://github.com/hanmariyang/coxpit-oss#remote-access" target="_blank" rel="noopener">Fronting with Cloudflare Access / Tailscale? &rarr;</a></div>
  </form>
<script>
(function(){
  var SETUP = ${setup ? 'true' : 'false'};
  var f = document.getElementById('f');
  var err = document.getElementById('err');
  var go = document.getElementById('go');
  function show(m){ err.textContent = m || ''; }
  f.addEventListener('submit', function(ev){
    ev.preventDefault();
    show('');
    var key = document.getElementById('key').value;
    var rem = document.getElementById('rem').checked;
    if (!key){ show('access key required'); return; }
    var body, url;
    if (SETUP){
      var key2 = document.getElementById('key2').value;
      if (key !== key2){ show('keys do not match'); return; }
      if (key.length < 6){ show('use at least 6 characters'); return; }
      url = '/api/auth/setup';
      body = { key: key, token: document.getElementById('tok').value, remember: rem };
    } else {
      url = '/api/auth/unlock';
      body = { key: key, remember: rem };
    }
    go.disabled = true;
    fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) })
      .then(function(r){ return r.json().then(function(j){ return { s:r.status, j:j }; }); })
      .then(function(res){
        if (res.s >= 200 && res.s < 300 && res.j && res.j.ok){ location.replace('/'); return; }
        go.disabled = false;
        var m = (res.j && (res.j.detail || res.j.error)) || ('error ' + res.s);
        show(m);
      })
      .catch(function(){ go.disabled = false; show('network error'); });
  });
})();
</script>
</body>
</html>`;
}
