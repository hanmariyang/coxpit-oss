// "지금 뭐 하고 있나" — 서빙되는 페이지들이 **같은 한 벌**을 쓴다(사본 금지, humanize.ts 전례).
// 코크핏 활동 페인(v5.28 E)의 Now 줄이 쓰는 규칙이라, 클라이언트 JS 를 여기 한 곳에 두고
// 페이지의 <script> 에 그대로 끼워 넣는다.
// 전제: 끼워 넣는 쪽이 runById(맵)를 들고 있다 — 이 함수는 그것만 읽는다.
// 문자열 안의 이스케이프는 **클라이언트 기준**이다: \\n 은 클라이언트의 \n 이 된다.
export const ACTIVITY_JS = `/* 라이브 상태 — run 의 최신 이벤트에서 "지금 뭐 하는지"(도구명/사고)를 뽑는다. 실행 중일 때만. */
  function latestActivity(runId){
    var r=runById[runId]; if(!r) return '';
    if(r.status!=='running' && r.status!=='pending') return '';
    var evs=r.events||[];
    for(var i=evs.length-1;i>=0;i--){
      var e=evs[i], k=e.kind;
      if(k==='steer') return 'steer'; if(k==='ask') return 'asking';
      if(k!=='assistant') continue;
      try{ var o=JSON.parse(e.payload);
        var c=o&&o.message&&o.message.content;
        if(c&&c.length){ for(var j=c.length-1;j>=0;j--){ if(c[j].type==='tool_use') return c[j].name||'tool'; if(c[j].type==='text'&&(c[j].text||'').trim()) return 'thinking'; } }
        else if(o&&o.text) return 'thinking';
      }catch(_){}
    }
    return r.status==='pending' ? 'starting' : 'working';
  }
  /* "지금" 한 줄 — 파싱된 스트림에서 온 것만. 아직 아무 이벤트도 없으면 지어내지 않고 starting… 이라 말한다. */
  function actNowText(runId){
    var r=runById[runId]; if(!r) return '';
    var live=(r.status==='running'||r.status==='pending'||r.status==='preparing');
    if(!(r.events||[]).length) return live ? 'starting…' : String(r.status||'');
    return latestActivity(runId) || String(r.status||'');
  }`;
