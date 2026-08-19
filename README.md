# Coxpit

**Own your agent fleet. Run parallel AI coding agents across your own machines — steer them from any browser.**

**[Landing & downloads](https://hanmariyang.github.io/coxpit-oss/)** · [Latest release](https://github.com/hanmariyang/coxpit-oss/releases/latest)

![coxpit fleet board — three agents racing the same task](docs/demo.gif)

Coxpit is a self-hosted cockpit for CLI coding agents (Claude Code first). Give it a task and it launches N agents in parallel — each in its own **isolated git worktree**, on its own branch, inside its own tmux session — then streams everything to a live board where you watch, compare diffs side by side, attach a real terminal, and merge the winner.

Your machines. Your auth. Your code never leaves your network.

## What it does

- **Fleet runs** — one task, N agents. Each run = worktree + branch + tmux window. No agent ever touches your checkout.
- **Two providers** — Claude Code and OpenAI Codex CLI, selectable per launch. Fan the same task across both and compare; steering resumes each agent's own session. The provider seam (`src/providers.ts`) is ~100 lines per provider — adding a third is a PR, not a fork.
- **Live board** — WebSocket-driven console: status, event timeline (parsed from the agent's stream-json), per-run diff.
- **Compare & merge** — all runs of a task side by side; pick the winner, merge to the base branch (auto-commits the worktree, guards a clean base, aborts on conflict).
- **Real terminal** — attach to any run's tmux session in the browser (xterm.js over a server-side PTY; resize propagates, `Ctrl-b d` detaches).
- **Multi-machine** — register remote machines over SSH (Tailscale/LAN); probe reachability (git·tmux), run fleets there.
- **Safe stops** — stop kills the whole process group; task close stops and cleans every worktree/branch.
- **Design Mode** — drag the `⌖ coxpit inspect` bookmarklet to your bar, click it on your running app, click any element: its selector, HTML and computed styles are captured and injected into the agents' prompt as design context.
- **Self-orchestrating agents** — every local run can spawn its own sub-agents by writing `.coxpit/spawn.json` in its worktree (works under default permissions — no network, no escalation). The daemon launches each subtask as an isolated sub-run and maintains `.coxpit/subtasks.json` with live status. Orchestration moves inside the agent's own reasoning loop.
- **Start from GitHub** — paste an issue/PR URL and the task form drafts itself from its title and body (gh CLI for private repos, public API otherwise). You review, pick a provider, Run fleet.
- **Share a run** — one click mints a read-only snapshot link (timeline + diff, and the rendered docs, no auth, no actions). Show your fleet's work without opening your cockpit.
- **The library** — a run's changed documents (Markdown/HTML) are snapshotted when it settles, so the Rendered view survives merge and Close task. Pick a model per launch (any name your CLI accepts), and a close guard warns before it deletes unmerged, unexported output.

External tools are spawned, never vendored: `git`, `tmux`, your agent CLI. No editor bundled — terminal-first.

| Fleet board | Compare & merge |
|---|---|
| ![board](docs/shot-board.png) | ![compare](docs/shot-compare.png) |

## Quickstart

Requirements: Node 20+, git, tmux, an agent CLI on PATH (e.g. `claude`).

```bash
# fastest — straight from npm
COXPIT_AUTH_DISABLED=1 npx coxpit    # → http://127.0.0.1:8210

# or from source
npm install
cp .env.example .env        # set COXPIT_AUTH_PASS (or COXPIT_AUTH_DISABLED=1 locally)
npm run dev
```

Open the board, register a repo (absolute path), write a task, hit **Run fleet**.

By default agents run in **dry-run mode** (a mock that exercises the whole pipeline without spending credits). Flip the Dry/Real toggle per launch, or set `COXPIT_AGENT_REAL=1` to default to real.

## First run

Coxpit has no accounts of its own — it drives the agent CLI already on your machine, with that CLI's own login:

1. **Install & sign in to the agent CLI once** (Claude Code by default):
   ```bash
   npm i -g @anthropic-ai/claude-code
   claude        # first run opens browser login
   ```
   For the Codex provider, also: `npm i -g @openai/codex && codex` (sign in once). Other binaries: `COXPIT_AGENT_BIN` / `COXPIT_CODEX_BIN`.
2. **Open the board** — the first-run panel checks this machine (git · tmux · agent CLI) and tells you what's missing.
3. **Rehearse with Dry run**, then flip to Real agent. Real runs spend your CLI account's credits — nothing is billed through coxpit.

Your keys and login never touch coxpit's config or database.

## Configuration

| env | default | what |
|---|---|---|
| `COXPIT_HOST` / `COXPIT_PORT` | `127.0.0.1` / `8210` | daemon bind |
| `COXPIT_DB` | `~/.coxpit/coxpit.db` | SQLite (libSQL) file (a legacy `./coxpit.db` in the cwd is still honored) |
| `COXPIT_AUTH_PASS` / `COXPIT_AUTH_USER` | — / `admin` | basic auth. **Empty pass = all requests rejected** (fail-closed) — set it, or use `COXPIT_AUTH_DISABLED=1` for local dev |
| `COXPIT_AUTH_DISABLED` | — | `1` disables auth (local dev only) |
| `COXPIT_SSH_KEY` | — | private key for remote machines (else ssh defaults/agent) |
| `COXPIT_AGENT_REAL` | — | `1` = real agent CLI by default (credits!) |
| `COXPIT_AGENT_BIN` | `claude` | Claude Code command |
| `COXPIT_AGENT_PERM` | `acceptEdits` | Claude Code headless permission mode |
| `COXPIT_CODEX_BIN` | `codex` | Codex CLI command (optional second provider) |
| `COXPIT_CODEX_SANDBOX` | `workspace-write` | Codex sandbox policy (`danger-full-access` for full autonomy) |
| `COXPIT_AGENT_ORCH` | on | `0` disables agent self-orchestration (the `.coxpit/spawn.json` protocol + prompt note) |
| `COXPIT_WEBHOOK_URL` | — | POSTs `{event:"run.settled",run:{...}}` when a run finishes — wire it to Telegram, Slack, anything |
| `COXPIT_PUBLIC_URL` | — | if set, the webhook payload adds `url: <base>/?run=<id>` — tap it on your phone and the board opens that run |

Running on the open internet? Put it behind your own front door (Tailscale, Cloudflare Access, a reverse proxy with TLS) and keep basic auth on — it exposes shells.

## Platform support

| platform | daemon | agent runs |
|---|---|---|
| macOS / Linux | ✅ first-class | ✅ |
| Windows (WSL2) | ✅ run the daemon inside WSL | ✅ |
| Windows (native) | ⚠️ board + remote machines only | ❌ needs a POSIX shell + tmux |

On Windows, install the daemon inside WSL2 (`npm i -g coxpit`) — WSL2 forwards `localhost`, so the Windows desktop app detects the WSL daemon and attaches to it automatically. A native Windows daemon still serves the board and can drive **remote** (ssh) machines, but the local machine will fail its readiness checks (no tmux).

## Architecture

```
browser (board · xterm)
   │  HTTP + WS
daemon — Node/TS · Fastify · libSQL(Drizzle)
   │  spawn / ssh
machines — git worktrees · tmux sessions · agent CLIs
```

One daemon, one SQLite file, zero external services. Machines are reached over SSH; the local machine is just `sh`.

**One daemon per machine.** Every install method shares `~/.coxpit/` — the daemon takes a lock there (`daemon.lock.json`) and refuses to start if another daemon already owns the database (running two would corrupt each other's live runs). The desktop app checks for a running daemon first and attaches to it (prompting for its basic auth if set); it only spawns its own embedded daemon when none is running. So npm CLI, launchd/systemd service, and the desktop app all see the same machines, tasks, and run history.

## Status

`v4.3` — everything in v4.2 plus **the logbook**: the board is Active-first (closed tasks leave the grid), an Archive view lists them as searchable rows, and `/api/fleet` now scopes to active work and caps events per run so it stays fast at hundreds of runs. Opening an archived task still renders its documents — from the v4.1 snapshot. All shipped and e2e-tested (38 checks). ⚠️ `/api/fleet` defaults to `view=active` now — pass `?view=all` for the previous everything-payload. Roadmap: ROADMAP.md.

## License

MIT
