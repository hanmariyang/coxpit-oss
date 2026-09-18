// 이벤트 인간화 — 보드와 코크핏이 **같은 한 벌**을 쓴다(사본 금지).
// 보드 모달의 타임라인과 코크핏 활동 페인(v5.28 E)이 같은 줄을 같은 규칙으로 보여야 하므로,
// 클라이언트 JS 를 여기 한 곳에 두고 두 페이지의 <script> 에 그대로 끼워 넣는다(icons.ts 전례).
// 문자열 안의 이스케이프는 **클라이언트 기준**이다: \\n 은 클라이언트의 \n 이 된다.
export const HUMANIZE_JS = `/* 이벤트 인간화 — JSON 원문 대신 사람이 읽는 한 줄로. null = 표시 생략(노이즈). */
function humanize(e){
  const kind = e.kind, payload = e.payload;
  if (kind === 'rate_limit_event') return null;
  if (kind === 'steer') return { k:'steer', t:'→ '+payload };
  if (kind === 'ask') return { k:'ask', t:'? '+payload };
  if (kind === 'sync') return { k:'sync', t:payload };
  if (kind === 'export'){ try{ const o=JSON.parse(payload); return { k:'export', t:o.copied+' file(s) → '+o.dest }; }catch{ return { k:'export', t:payload }; } }
  if (kind === 'pr') return { k:'pr', t:payload };
  if (kind === 'stderr') return { k:'stderr', t:payload };
  try{
    const o = JSON.parse(payload);
    if (o.type === 'system'){
      if (o.subtype === 'init' || !o.subtype) return { k:'session',
        t:'started'+(o.model?' · '+String(o.model).replace(/\\u001b\\[[0-9;]*m/g,'')
                                                  .replace(/\\x1b\\[[0-9;]*m/g,'') : '') };
      if (o.subtype === 'permission_denied') return { k:'denied', t:'⛔ '+(o.tool_name||o.tool||'tool use')+' blocked — attach the Terminal to approve, or widen COXPIT_AGENT_PERM' };
      return null; // thinking_tokens 등 스트림 잡음
    }
    if (o.type === 'user') return null; // tool 결과 회신 — 노이즈
    if (o.type === 'assistant' && o.message){
      const parts = [];
      for (const x of (o.message.content||[])){
        if (x.type === 'text' && x.text) parts.push({ k:'said', t:x.text });
        else if (x.type === 'tool_use'){
          const i = x.input || {};
          const arg = i.file_path || i.command || i.path || i.pattern || '';
          parts.push({ k:'tool', t:'▸ '+x.name+(arg?' — '+String(arg).split('/').slice(-2).join('/').slice(0,60):'') });
        }
      }
      return parts.length ? parts : null;
    }
    if (o.type === 'assistant' && o.text) return { k:'said', t:o.text };
    if (o.type === 'result') return { k:'done', t:o.result || 'finished' };
    if (kind === 'meta' && o.subtask) return { k:'swarm', t:'↳ spawned task #'+o.subtask+' — '+String(o.title||'').slice(0,60)+' ('+((o.runs||[]).map(x=>'r'+x).join(' '))+')' };
    if (kind === 'meta') return { k:'start', t:'worktree '+String(o.worktree||'').split('/').slice(-2).join('/') };
    return { k:kind, t:payload.slice(0,140) };
  }catch{
    // 파싱 실패(과거에 잘려 저장된 이벤트 등) — JSON 잔해를 그대로 보여주지 않는다:
    // text 조각만 구제하고, 없으면 생략.
    if (payload.trim().startsWith('{')){
      const texts = [];
      const re = /"text":"((?:[^"\\\\]|\\\\.)*)"/g; let m;
      while ((m = re.exec(payload)) && texts.length < 2) texts.push(m[1].replace(/\\\\n/g,' ').slice(0,140));
      return texts.length ? { k:'said', t:texts.join(' · ') } : null;
    }
    return { k:kind, t:payload };
  }
}
function humanLines(events){
  const out = [];
  for (const e of (events||[])){
    const h = humanize(e);
    if (!h) continue;
    if (Array.isArray(h)) out.push(...h); else out.push(h);
  }
  return out;
}`;
