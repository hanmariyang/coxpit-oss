// Design Mode 북마클릿 인스펙터 — 사용자의 개발 중 웹앱에 주입되어
// 요소 호버 하이라이트 → 클릭 캡처(selector·HTML·computed CSS) → 데몬으로 POST.
// 자신의 <script src> 에서 엔드포인트와 캡처 키를 읽는다.
export const BOOKMARKLET_JS = `(function(){
  if (window.__coxpitInspector) { window.__coxpitInspector.stop(); return; }
  var script = document.currentScript || Array.from(document.scripts).find(function(s){return s.src.indexOf('/design/bookmarklet.js')>-1;});
  if (!script) { alert('coxpit: cannot locate script origin'); return; }
  var u = new URL(script.src);
  var endpoint = u.origin + '/api/design/capture' + (u.search || '');

  var box = document.createElement('div');
  box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #4ec9b0;background:rgba(78,201,176,.08);border-radius:3px;transition:all .06s;display:none';
  var tag = document.createElement('div');
  tag.style.cssText = 'position:fixed;z-index:2147483647;background:#0b0d12;color:#4ec9b0;font:11px ui-monospace,monospace;padding:3px 8px;border-radius:4px;pointer-events:none;display:none;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid #4ec9b0';
  document.documentElement.appendChild(box); document.documentElement.appendChild(tag);

  function cssPath(el){
    var parts = [];
    while (el && el.nodeType === 1 && parts.length < 6) {
      var p = el.tagName.toLowerCase();
      if (el.id) { parts.unshift(p + '#' + el.id); break; }
      var cls = (el.className && typeof el.className === 'string') ? el.className.trim().split(/\\s+/).slice(0,2).join('.') : '';
      if (cls) p += '.' + cls;
      var parent = el.parentElement;
      if (parent) {
        var sibs = Array.from(parent.children).filter(function(c){return c.tagName===el.tagName;});
        if (sibs.length > 1) p += ':nth-of-type(' + (sibs.indexOf(el)+1) + ')';
      }
      parts.unshift(p); el = parent;
    }
    return parts.join(' > ');
  }
  var CSS_PROPS = ['display','position','width','height','margin','padding','color','background-color','font-family','font-size','font-weight','line-height','border','border-radius','box-shadow','flex-direction','justify-content','align-items','gap','grid-template-columns','text-align','opacity','overflow','z-index'];
  function styleOf(el){
    var cs = getComputedStyle(el), out = {};
    CSS_PROPS.forEach(function(k){ var v = cs.getPropertyValue(k); if (v) out[k]=v; });
    return out;
  }
  function toast(msg, ok){
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;background:#0b0d12;color:'+(ok?'#4ec9b0':'#e25b67')+';font:12px ui-monospace,monospace;padding:9px 14px;border-radius:7px;border:1px solid '+(ok?'#4ec9b0':'#e25b67');
    document.documentElement.appendChild(t);
    setTimeout(function(){ t.remove(); }, 2200);
  }

  var current = null;
  function onMove(e){
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el===box || el===tag || el===document.documentElement || el===document.body) return;
    current = el;
    var r = el.getBoundingClientRect();
    box.style.display='block';
    box.style.left=r.left+'px'; box.style.top=r.top+'px'; box.style.width=r.width+'px'; box.style.height=r.height+'px';
    tag.style.display='block';
    tag.style.left=Math.max(4,r.left)+'px'; tag.style.top=Math.max(4,r.top-26)+'px';
    tag.textContent = cssPath(el) + '  ·  ' + Math.round(r.width)+'×'+Math.round(r.height);
  }
  function onClick(e){
    if (!current) return;
    e.preventDefault(); e.stopPropagation();
    var el = current;
    var body = {
      url: location.href,
      selector: cssPath(el),
      html: (el.outerHTML||'').slice(0, 4000),
      css: JSON.stringify(styleOf(el), null, 1).slice(0, 3000),
      note: document.title,
    };
    fetch(endpoint, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) })
      .then(function(r){ if(!r.ok) throw new Error(r.status); toast('coxpit: captured ' + body.selector, true); })
      .catch(function(err){ toast('coxpit: capture failed ('+err.message+')', false); });
    stop();
  }
  function onKey(e){ if (e.key==='Escape') stop(); }
  function stop(){
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    box.remove(); tag.remove();
    window.__coxpitInspector = null;
  }
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  window.__coxpitInspector = { stop: stop };
  toast('coxpit: click an element to capture · Esc to exit', true);
})();
`;
