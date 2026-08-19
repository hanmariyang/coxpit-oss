import { config } from './config';
import { shq } from './exec';

/**
 * Provider seam — coxpit 은 "에이전트들"을 오케스트레이션한다(특정 에이전트가 아니라).
 * 각 프로바이더는 세 가지만 답하면 된다:
 *   1) 헤드리스 1회 실행 커맨드는 무엇인가 (launchCmd)
 *   2) 정착한 세션을 어떻게 이어가는가 (resumeCmd)
 *   3) stdout 한 줄을 coxpit 이벤트로 어떻게 정규화하는가 (parseLine)
 * 정규화 목표 = 보드가 이미 아는 형태({type:'assistant',text}·tool_use·result)로
 * 수렴시키는 것. 보드는 프로바이더를 모른다.
 */

export interface ParsedEvent {
  kind: string;
  stored: string;
  /** steer(세션 이어가기)용 세션 키 — 이 라인에서 발견되면 채운다 */
  sessionId?: string;
  /** 사람이 읽는 최종 요약 후보 — 마지막 값이 exitSummary 가 된다 */
  resultText?: string;
}

export interface Provider {
  id: string;
  label: string;
  bin: string;
  /** model 비었으면 CLI 기본값 사용(플래그 미첨부). */
  launchCmd(prompt: string, model?: string): string;
  resumeCmd(sessionId: string, message: string, model?: string): string;
  /** null = 저장하지 않는 라인(스트림 잡음) */
  parseLine(raw: string): ParsedEvent | null;
}

/** tool_use input 을 표시용 핵심 필드만 남긴다(이벤트 압축용). */
function compactInput(input?: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  for (const k of ['file_path', 'command', 'path', 'pattern', 'url']) {
    if (typeof input[k] === 'string') out[k] = (input[k] as string).slice(0, 200);
  }
  return out;
}

/** 보드 tool 렌더용 정규화 tool_use 이벤트 */
function toolEvent(name: string, input: Record<string, string>): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
}

// ─── claude-code ────────────────────────────────────────────────
// stream-json: {type:system|assistant|user|result, ...} 라인. 세션 키 = system.session_id.

const claudeProvider: Provider = {
  id: 'claude-code',
  label: 'Claude Code',
  get bin() { return config.agent.bin; },
  launchCmd(prompt: string, model?: string): string {
    return `${config.agent.bin} -p ${shq(prompt)} --output-format stream-json --verbose` +
      ` --permission-mode ${config.agent.perm}` + (model ? ` --model ${shq(model)}` : '');
  },
  resumeCmd(sessionId: string, message: string, model?: string): string {
    return `${config.agent.bin} -p --resume ${shq(sessionId)} ${shq(message)}` +
      ` --output-format stream-json --verbose --permission-mode ${config.agent.perm}` +
      (model ? ` --model ${shq(model)}` : '');
  },
  parseLine(raw: string): ParsedEvent | null {
    const s = raw.trim();
    if (!s) return null;
    let kind = 'log';
    let stored = s;
    const ev: ParsedEvent = { kind, stored };
    try {
      const obj = JSON.parse(s) as {
        type?: string; subtype?: string; model?: string; result?: string; session_id?: string;
        message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: Record<string, unknown> }> };
      };
      if (obj.type) kind = obj.type;
      if (obj.type === 'system' && typeof obj.session_id === 'string') ev.sessionId = obj.session_id;
      if (obj.type === 'result') ev.resultText = typeof obj.result === 'string' ? obj.result : s;
      // system 이벤트는 full fidelity 가 필요 없다 — 길이와 무관하게 항상 컴팩트 재직렬화로
      // 통일하고 그 시점에 model 의 ANSI 이스케이프를 소독한다(예: 'claude-opus-4-8\x1b[1m').
      // session_id 캡처는 위에서 이미 ev 에 담았으므로 stored 축약과 무관.
      // ESC(\x1b) 를 포함해 SGR 시퀀스 전체를 제거 — spec 예시 정규식은 ESC 를 남겨
      //   'm\x1b[1mx' → 'm\x1bx' 로 잔해가 남아 DoD("ESC 부재")를 못 지킨다. ESC 도 소비한다.
      const stripAnsi = (x: string) => x.replace(/\x1b?\[[0-9;]*m/g, '');
      if (obj.type === 'system') {
        stored = JSON.stringify({
          type: 'system', subtype: obj.subtype,
          model: typeof obj.model === 'string' ? stripAnsi(obj.model) : obj.model,
        });
      } else if (s.length > 2000) {
        // 2000자 초과 이벤트는 자르면 JSON 이 깨져 잔해가 화면에 노출된다 —
        // 저장 전에 "요지만 남긴" 유효 JSON 으로 압축한다.
        if (obj.type === 'assistant' && obj.message) {
          const content = (obj.message.content ?? [])
            .filter((c) => c.type === 'text' || c.type === 'tool_use')
            .map((c) => c.type === 'text'
              ? { type: 'text', text: (c.text ?? '').slice(0, 600) }
              : { type: 'tool_use', name: c.name, input: compactInput(c.input) });
          stored = JSON.stringify({ type: 'assistant', message: { content } }).slice(0, 2000);
        } else if (obj.type === 'user') {
          stored = JSON.stringify({ type: 'user' }); // tool 결과 회신 — 표시 안 함
        } else if (obj.type === 'result') {
          stored = JSON.stringify({ type: 'result', result: (obj.result ?? '').slice(0, 1500) });
        } else {
          stored = s.slice(0, 2000);
        }
      }
    } catch { stored = s.slice(0, 2000); /* 비-JSON 로그 라인 */ }
    ev.kind = kind;
    ev.stored = stored.slice(0, 2000);
    return ev;
  },
};

// ─── codex ──────────────────────────────────────────────────────
// codex exec --json: JSONL 이벤트(thread.started·turn.*·item.completed·error).
// 세션 키 = thread.started.thread_id, resume = `codex exec resume <id>`.
// 이벤트는 보드가 아는 claude 형태로 정규화해 저장한다.

interface CodexItem {
  type?: string; text?: string; command?: string; exit_code?: number;
  changes?: Array<{ path?: string; kind?: string }>;
  server?: string; tool?: string; query?: string;
}

const codexProvider: Provider = {
  id: 'codex',
  label: 'Codex',
  get bin() { return config.codex.bin; },
  launchCmd(prompt: string, model?: string): string {
    return `${config.codex.bin} exec --json --sandbox ${config.codex.sandbox}` +
      (model ? ` -m ${shq(model)}` : '') + ` ${shq(prompt)}`;
  },
  resumeCmd(sessionId: string, message: string, model?: string): string {
    // --sandbox·-m 는 exec 의 플래그(resume 서브커맨드는 안 받음) — 반드시 resume 앞에.
    return `${config.codex.bin} exec --json --sandbox ${config.codex.sandbox}` +
      (model ? ` -m ${shq(model)}` : '') + ` resume ${shq(sessionId)} ${shq(message)}`;
  },
  parseLine(raw: string): ParsedEvent | null {
    const s = raw.trim();
    if (!s) return null;
    let obj: { type?: string; thread_id?: string; message?: string; item?: CodexItem };
    try { obj = JSON.parse(s) as typeof obj; } catch {
      return { kind: 'log', stored: s.slice(0, 2000) }; // 비-JSON 로그 라인
    }
    switch (obj.type) {
      case 'thread.started':
        return {
          kind: 'system',
          stored: JSON.stringify({ type: 'system', subtype: 'init', model: 'codex' }),
          sessionId: typeof obj.thread_id === 'string' ? obj.thread_id : undefined,
        };
      case 'item.completed': {
        const it = obj.item ?? {};
        if (it.type === 'agent_message' && typeof it.text === 'string') {
          return {
            kind: 'assistant',
            stored: JSON.stringify({ type: 'assistant', text: it.text.slice(0, 1500) }),
            resultText: it.text, // 마지막 agent_message = 최종 요약
          };
        }
        if (it.type === 'command_execution') {
          return { kind: 'assistant', stored: toolEvent('shell', { command: (it.command ?? '').slice(0, 200) }) };
        }
        if (it.type === 'file_change') {
          const paths = (it.changes ?? []).map((c) => c.path ?? '').filter(Boolean);
          return { kind: 'assistant', stored: toolEvent('edit', { file_path: paths.join(', ').slice(0, 200) }) };
        }
        if (it.type === 'mcp_tool_call') {
          return { kind: 'assistant', stored: toolEvent(`${it.server ?? 'mcp'}.${it.tool ?? 'tool'}`, {}) };
        }
        if (it.type === 'web_search') {
          return { kind: 'assistant', stored: toolEvent('web_search', { pattern: (it.query ?? '').slice(0, 120) }) };
        }
        return null; // reasoning·plan_update 등 — 표시 잡음
      }
      case 'error':
        return { kind: 'error', stored: (obj.message ?? s).slice(0, 500) };
      default:
        return null; // turn.started/completed·item.started/updated — 잡음
    }
  },
};

// ─── registry ───────────────────────────────────────────────────

const registry: Record<string, Provider> = {
  [claudeProvider.id]: claudeProvider,
  [codexProvider.id]: codexProvider,
};

/** run.agent → Provider. 미지의 값(workbench 포함)은 claude 로 폴백. */
export function getProvider(agentId: string | null | undefined): Provider {
  return registry[agentId ?? ''] ?? claudeProvider;
}

export function listProviders(): Array<{ id: string; label: string; bin: string }> {
  return Object.values(registry).map((p) => ({ id: p.id, label: p.label, bin: p.bin }));
}
