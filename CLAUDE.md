# Coxpit — Repository Guide

> Self-hosted cockpit for running a fleet of AI coding agents across your own machines. Node/TS daemon + single-page web console. MIT.

## 1. Overview

One task → N parallel agent runs. Each run gets an isolated **git worktree + branch + tmux session**; the agent's stream-json output is parsed into events and pushed live over WebSocket to the board, where you compare diffs, attach a terminal, and merge the winner.

## 2. Architecture

- **Daemon** (this repo): Fastify + @fastify/websocket + libSQL (Drizzle). Serves the board at `GET /`, xterm assets at `/vendor/*`, REST under `/api/*`, live streams at `/ws` and `/ws/term/:id`.
- **Machines**: local via `sh`, remote via `ssh` (BatchMode). External tools are spawned, never vendored: `git`, `tmux`, the agent CLI.
- **Terminal**: server-side PTY (node-pty) attaches to the run's tmux session; remote attach wraps `ssh -tt` inside the PTY so resize propagates.

## 3. Source map

```
src/
├── index.ts          entry — schema boot, local machine seed, listen
├── server.ts         routes (REST + WS + vendor + board)
├── board.ts          single-page console (no build step, self-contained)
├── orchestrator.ts   run lifecycle: worktree → tmux → spawn → stream → merge/cleanup
├── term.ts           PTY attach (local tmux / remote ssh -tt)
├── exec.ts           run/spawn helpers (local sh / remote ssh), shell quoting
├── auth.ts           basic-auth gate (pluggable), /api/health exempt
├── hub.ts            WS broadcast fan-out
├── config.ts         env config (see README table)
└── db/               Drizzle schema + libSQL client + idempotent DDL
```

## 4. Development

```bash
npm install
COXPIT_AUTH_DISABLED=1 npm run dev   # http://127.0.0.1:8210
npm run typecheck
```

Agents default to **dry-run** (mock stream-json + a real file change — exercises the full pipeline with zero credits). `COXPIT_AGENT_REAL=1` or the board toggle runs the real CLI.

## 5. Conventions

- TypeScript strict; no native deps beyond node-pty (prebuilds) and libSQL (NAPI prebuilds — chosen over better-sqlite3 which fails node-gyp on new Node majors).
- node-pty's prebuilt `spawn-helper` can lose its exec bit through npm packaging (`posix_spawnp failed`) — `term.ts` chmods it before load; keep that guard.
- Stop semantics: local spawns are `detached` and stopped by killing the **process group** (the sh grandchild agent must die too). Remote stops kill via the worktree's `.coxpit-agent.pid`: pgid lookup → group TERM → KILL escalation (`remoteKillScript` in orchestrator.ts); `cleanupRun` runs it too before removing the worktree.
- One daemon per machine: the default data dir is `~/.coxpit/` and the daemon takes `daemon.lock.json` there (src/lock.ts) — two daemons on one DB would settle each other's live runs as orphans at boot. The desktop app attaches to a running daemon instead of spawning a second one; keep that invariant.
- Merge safety: worktree auto-commit → base repo must be on its default branch and clean → `merge --no-ff`; conflicts abort automatically.
- License hygiene: no GPL/AGPL/LGPL dependencies (audit `npm ls --omit=dev --all`). Do not copy code from AGPL projects.
- No secrets, tokens, or user-specific paths in the repo — configuration is env-only (`.env.example` keys, README table).

## 6. Caveats

- Windows native can serve the board and drive remote (ssh) machines, but local agent runs need a POSIX shell + tmux — point Windows users at WSL2 (README "Platform support").
- The board is intentionally a single self-contained HTML string (`board.ts`) — no bundler; keep it framework-free.
- Exposing the daemon publicly exposes shells: front it with your own access layer (Tailscale/Cloudflare Access/reverse proxy + TLS) and keep auth on.
