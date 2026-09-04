// Remote access detection — read the LOCAL machine's Tailscale state and whether
// Serve/Funnel already point at our port. This is the whole v4.5 backend surface.
//
// GUARDRAIL (non-negotiable): coxpit never hosts a relay and never issues a
// coxpit-branded public URL. It DETECTS the user's own Tailscale and DRIVES it
// (serve/funnel), or hands a copy-paste recipe. We never bundle tailscale or
// cloudflared — absent tools degrade to `missing` + a recipe, never to a coxpit
// tunnel. All truth is read live from the CLI; nothing is persisted in the DB.

import { runShellOn, shq, type MachineTarget } from './exec';

export interface RemoteState {
  tailscale: 'missing' | 'stopped' | 'running';
  dnsName?: string;        // trailing dot stripped (e.g. host.tailnet.ts.net)
  tailnetSuffix?: string;  // MagicDNS suffix (e.g. tailnet.ts.net)
  serve: boolean;          // is serve active for OUR port?
  funnel: boolean;         // is funnel active for OUR port?
  binPath?: string;        // resolved tailscale bin
}

// Serve/Funnel are always driven against the local machine (the daemon host) —
// we cannot reach into a remote node's Tailscale from here.
const LOCAL: MachineTarget = { slug: 'local', kind: 'local', address: '', sshUser: '' };

// mac app bundles the CLI here; Linux/most installs put `tailscale` on PATH.
const MAC_APP_BIN = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

/** Resolve the tailscale binary: PATH first, else the macOS app bundle. '' = none. */
async function resolveBin(): Promise<string> {
  const onPath = await runShellOn(LOCAL, 'command -v tailscale 2>/dev/null || true', 6000);
  const p = onPath.stdout.trim().split('\n').pop()?.trim() ?? '';
  if (p) return p;
  const app = await runShellOn(LOCAL, `test -x ${shq(MAC_APP_BIN)} && echo yes || true`, 6000);
  if (app.stdout.includes('yes')) return MAC_APP_BIN;
  return '';
}

/** Does a serve/funnel status JSON (shape varies by version) target http://…:<port>? */
function jsonTargetsPort(raw: string, port: number): boolean {
  // Rather than chase the (version-dependent) nested shape, look for any proxy
  // target string that names our loopback port. `serve status --json` embeds
  // upstreams as `http://127.0.0.1:<port>` / `http://localhost:<port>`.
  try {
    JSON.parse(raw); // ensure it IS json (caller falls back to text grep otherwise)
  } catch {
    throw new Error('not json');
  }
  return textTargetsPort(raw, port);
}

/**
 * Funnel is active only if `AllowFunnel` has a truthy entry AND our port is targeted.
 * serve and funnel read the SAME ServeConfig, so `funnel status` prints the Serve
 * config verbatim when Funnel is off — port-matching alone false-positives Funnel
 * (issue #7). `AllowFunnel` is the only field that differs; it is absent when off.
 */
function funnelActiveForPort(raw: string, port: number): boolean {
  let cfg: { AllowFunnel?: Record<string, unknown> };
  try { cfg = JSON.parse(raw) as { AllowFunnel?: Record<string, unknown> }; } catch { throw new Error('not json'); }
  const allow = cfg?.AllowFunnel;
  if (!allow || typeof allow !== 'object') return false;
  if (!Object.values(allow).some(Boolean)) return false;
  return textTargetsPort(raw, port);   // still confirm it is *our* port
}

/** Plain-text fallback: any `:<port>` upstream mention (defensive across versions). */
function textTargetsPort(raw: string, port: number): boolean {
  const p = String(port);
  return raw.includes('127.0.0.1:' + p)
    || raw.includes('localhost:' + p)
    || raw.includes('0.0.0.0:' + p)
    || raw.includes('[::1]:' + p);
}

/** Is serve/funnel active for our port? Try `<sub> status --json`, else `<sub> status`. */
async function subStateForPort(bin: string, sub: 'serve' | 'funnel', port: number): Promise<boolean> {
  const j = await runShellOn(LOCAL, `${shq(bin)} ${sub} status --json 2>/dev/null || true`, 8000);
  const jout = j.stdout.trim();
  if (jout) {
    try {
      return sub === 'funnel' ? funnelActiveForPort(jout, port) : jsonTargetsPort(jout, port);
    } catch { /* not json — fall through to text grep */ }
  }
  const t = await runShellOn(LOCAL, `${shq(bin)} ${sub} status 2>/dev/null || true`, 8000);
  // `funnel status` prints "(tailnet only)" when Funnel is off — a cheap, version-tolerant guard.
  if (sub === 'funnel' && /\(tailnet only\)/i.test(t.stdout)) return false;
  return textTargetsPort(t.stdout, port);
}

/**
 * Live Tailscale state for `port`, best-effort. Any failure downgrades to
 * missing/stopped — this must never throw into the request handler.
 */
export async function remoteState(port: number): Promise<RemoteState> {
  const off: RemoteState = { tailscale: 'missing', serve: false, funnel: false };
  try {
    const bin = await resolveBin();
    if (!bin) return off;

    const st = await runShellOn(LOCAL, `${shq(bin)} status --json 2>/dev/null || true`, 8000);
    const out = st.stdout.trim();
    if (!out) return { tailscale: 'stopped', serve: false, funnel: false, binPath: bin };

    let self: { DNSName?: string } | undefined;
    let magic = '';
    let backendState = '';
    try {
      const j = JSON.parse(out) as {
        Self?: { DNSName?: string };
        MagicDNSSuffix?: string;
        BackendState?: string;
      };
      self = j.Self;
      magic = String(j.MagicDNSSuffix ?? '');
      backendState = String(j.BackendState ?? '');
    } catch {
      // Non-JSON (e.g. "Logged out." / "stopped") — treat as not running.
      return { tailscale: 'stopped', serve: false, funnel: false, binPath: bin };
    }

    // Logged out / stopped backends have no usable name.
    if (/stopped|NoState|NeedsLogin|Logged out/i.test(backendState) || !self?.DNSName) {
      return { tailscale: 'stopped', serve: false, funnel: false, binPath: bin };
    }

    const dnsName = String(self.DNSName).replace(/\.$/, ''); // strip trailing dot
    const tailnetSuffix = magic.replace(/\.$/, '') || undefined;

    const [serve, funnel] = await Promise.all([
      subStateForPort(bin, 'serve', port),
      subStateForPort(bin, 'funnel', port),
    ]);

    return { tailscale: 'running', dnsName, tailnetSuffix, serve, funnel, binPath: bin };
  } catch {
    return off;
  }
}

/** Turn Serve on/off for our port (tailnet-only, HTTPS — safe by default). */
export async function setServe(port: number, on: boolean): Promise<RemoteState> {
  const bin = await resolveBin();
  if (bin) {
    const cmd = on
      ? `${shq(bin)} serve --bg ${String(port)}`
      : `${shq(bin)} serve reset`;
    await runShellOn(LOCAL, cmd, 20000);
  }
  return remoteState(port);
}

/**
 * Turn Funnel on/off for our port (PUBLIC internet). The NO_AUTH guard lives in
 * the route (Funnel with no basic auth = open shells); this just drives the CLI.
 */
export async function setFunnel(port: number, on: boolean): Promise<RemoteState> {
  const bin = await resolveBin();
  if (bin) {
    const cmd = on
      ? `${shq(bin)} funnel --bg ${String(port)}`
      : `${shq(bin)} funnel reset`;
    await runShellOn(LOCAL, cmd, 20000);
  }
  return remoteState(port);
}
