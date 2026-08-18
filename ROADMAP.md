# Roadmap

Coxpit's goal is simple: prove that a self-hosted, owner-first agent-fleet cockpit can be small, sharp, and genuinely daily-drivable — one daemon, one self-contained board, no build step, no telemetry.

Where the big players (Orca's desktop ADE, Paseo's multi-client daemon) go wide, Coxpit stays narrow and deep: tmux-native terminals, git worktrees as the isolation unit, and a swarm loop (plan → fan-out → integrate) you can read end-to-end in an afternoon.

## Shipped

### v2.x — from prototype to product
- [x] Fleet core: task → N runs, each in an isolated worktree + branch + tmux session
- [x] Compare view + merge the winner (auto-commit, guards, conflict abort)
- [x] Multi-terminal: server-side PTY attach, remote over `ssh -tt` with resize
- [x] Design Mode: bookmarklet element capture → DESIGN CONTEXT in the agent prompt
- [x] npm (`npx coxpit`), Docker/GHCR, desktop app (mac/win/linux) with auto-update
- [x] macOS code signing + notarization; draft-then-publish releases (no 404 window)
- [x] Run destinations: Export, PR mode, merge — plus true default-branch detection
- [x] Swarm: Integrate selected runs; conflicts spawn a resolver agent automatically
- [x] Plan fan-out: one goal → planner splits → auto-launch → converge on one branch
- [x] AI review judge across runs; human-readable timelines
- [x] Steering: follow-up instructions to a settled run (same session + worktree)
- [x] Generic webhook + browser notifications on run settle

### v3.x — sessions and hardening
- [x] Sessions: Work/Ask toggle, sync-base checkpoints, runs as long-lived workrooms
- [x] Workbench: worktree + tmux with no agent — a hand-driven workroom on the same rails
- [x] Terminal hardening: full-screen view, session tabs, initial-size attach, auto-heal,
      reconnect backoff, CJK-safe locale end to end, socket-identity guards
- [x] Unified data dir (`~/.coxpit`) + single-daemon lock; desktop attaches, never forks
- [x] Resumable runs (agent session preserved after settle), orphan-run settlement on boot
- [x] Remote stop hardening (pgid group kill, TERM→KILL escalation)
- [x] Platform support docs (Windows → WSL2 guidance)

## Next

### v3.5 — the provider seam
The architectural milestone: Coxpit should orchestrate *agents*, not *an agent*.

- [ ] Provider interface: launch command, stream parser, resume/steer semantics,
      permission flags — as a seam, not a plugin marketplace
- [ ] Second provider: Codex CLI end to end (run, stream, stop, steer, review)
- [ ] Mixed fleets: same task fanned across different providers, compared and integrated
- [ ] Per-run provider choice in the launcher; provider badge on cards

### v3.6 — the pocket pass
Steer the fleet from a phone, for real. No native app — the board itself earns it.

- [ ] Mobile layout pass on the board (cards, run detail, compare)
- [ ] Steer + Ask from mobile; settle notifications that deep-link back to the run
- [ ] Terminal on mobile: read-only first, then input if it proves usable

### v3.7 — richer review
- [ ] Doc mode: side-by-side rendered output (Markdown/HTML) for non-code runs
- [ ] Diff comments: annotate a diff line, send the annotation back as a steer
- [ ] Design Mode captures with screenshots (element crop, not just HTML/CSS)

### v4.0 — reach
- [ ] Open a run from a GitHub issue/PR reference (paste a URL, get a worktree)
- [ ] Agent-callable orchestration: expose task/run creation so an agent can
      request its own sub-runs through the daemon (orchestration inside the loop)
- [ ] Read-only share views (still owner-first — but a run should be showable)
- [ ] Public write-up + demo video: the "one person, one daemon" build story

## Non-goals

- Vendoring or wrapping agent CLIs — external tools stay external (`git`, `tmux`, the agent)
- Accounts, telemetry, cloud relay — the daemon is yours; front it with your own access layer
- A bundler for the board — one self-contained HTML string is a feature, not a debt

Suggestions and PRs welcome — file an issue.
