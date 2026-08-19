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

> Detailed, implementation-ready specs for v4.1–v4.3 live in [`design/`](design/README.md).

## Next

### v3.5 — the provider seam *(shipped)*
The architectural milestone: Coxpit orchestrates *agents*, not *an agent*.

- [x] Provider interface: launch command, resume command, stream normalization —
      a seam (`src/providers.ts`), not a plugin marketplace
- [x] Second provider: Codex CLI end to end (run, stream, stop, steer/resume)
- [x] Mixed fleets: same task fanned across both providers, compared side by side
- [x] Per-launch provider choice in the launcher; the card badge is the agent name

### v3.6 — the pocket pass *(shipped)*
Steer the fleet from a phone, for real. No native app — the board itself earns it.

- [x] Mobile layout pass: the launcher becomes an off-canvas drawer, cards go
      single-column, modals go full-bleed with Timeline stacked over Diff
- [x] Steer + Ask from mobile; deep links — `/?run=N` opens that run, browser
      notifications land on it, and `COXPIT_PUBLIC_URL` puts a tappable link
      in the settle webhook
- [x] Terminal opens full-screen on a phone (view/scroll); a dedicated mobile
      input pass remains below

### v3.7 — richer review *(shipped)*
- [x] Doc mode: a Rendered toggle on the run view and compare columns shows
      changed Markdown (inline) and HTML (sandboxed) instead of the diff
- [x] Diff comments: click any changed line and it lands in the steer input,
      quoted with its file — annotate, add your instruction, Send
- [ ] Design Mode captures with screenshots (element crop, not just HTML/CSS)
- [x] Mobile terminal input pass — an IME-safe input bar (composes 한글/かな natively,
      sends whole lines) plus esc·tab·^C·arrow keys, shown on touch/narrow screens

### v4.0 — reach *(code shipped)*
- [x] Start a task from a GitHub issue/PR URL — fetched into the form, human reviews, Run fleet
- [x] Agent self-orchestration: a run spawns sub-runs by writing `.coxpit/spawn.json`
      in its worktree (file protocol — works under default permissions, both providers);
      the daemon maintains `.coxpit/subtasks.json` with live status
- [x] Read-only share views — one click mints an unauthenticated snapshot link
      (timeline + diff, zero actions, revocable)
- [ ] Public write-up + demo video: the "one person, one daemon" build story

### v4.1 — the library *(shipped)*
What a run produced should outlive its worktree, and you should choose who produces it.

- [x] Document snapshots: capture changed docs (md/html) when a run settles, so the
      Rendered view survives merge + Close task — a run's output is part of its record
- [x] Share pages gain a Rendered section (the snapshot), making a share link a
      complete read-only document viewer
- [x] Per-launch model choice: pick the model next to the provider (claude `--model`,
      codex `-m`) — cheap models for exploration fleets, a strong one for the final run
- [x] Close-task guard: warn when closing a task whose runs have unmerged, unexported
      changes (done-but-not-merged output is deleted with the worktree)
- [x] Per-repo base branch override: repos on a develop-flow reject main-targeted
      merges today — let the repo say where Merge this / Sync base / PR mode point
- [x] Closed cards read as closed: dim + desaturate, diagonal hatching over the
      timeline area with a CLOSED stamp — status chips stay (history at a glance)

### v4.2 — the board knows its groups *(shipped)*
Five runs born from one goal look like five strangers today. Grouping is recorded
for agent-spawned subtasks (`parentRunId`) but not for plan fan-out — and the board
shows neither.

- [x] Group model: stamp plan-fan-out tasks with a shared group (goal) id;
      agent-spawned subtasks join their parent's group
- [x] Group bands on the board: cards stay first-class, but siblings cluster under
      a thin header ("⌁ Goal: … · 5 tasks · 3 done") with a shared accent tint —
      not nested cards (single-run tasks are the common case; the fleet view stays flat)
- [x] Attempt counter on multi-run tasks: "run 2/3" chip so same-title cards
      read as attempts, not duplicates
- [x] Group actions on the band: select-all → Integrate, review the group,
      close the group — the whole goal wrap-up in one place

### v4.3 — the logbook *(shipped)*
The board is a cockpit for live work, not a museum. At hundreds of runs the answer
is separation, not scrolling.

- [x] Active-first board: default view shows open/running/unsettled work only;
      closed tasks leave the grid
- [x] Archive: closed work becomes compact list rows (title · status · date · repo)
      with repo/status/provider/text filters — search beats scrolling past ~100 cards
- [x] Fleet payload diet: /api/fleet ships events for active runs only; archive rows
      carry summaries and lazy-load detail on open (the full-history payload is the
      real scaling wall, before the UI is)
- [x] Closed = archived immediately (design supersedes the earlier N-day timer —
      simpler, and v4.1 hatching already covers the "just closed" glance)

## Non-goals

- Vendoring or wrapping agent CLIs — external tools stay external (`git`, `tmux`, the agent)
- Accounts, telemetry, cloud relay — the daemon is yours; front it with your own access layer
- A bundler for the board — one self-contained HTML string is a feature, not a debt

Suggestions and PRs welcome — file an issue.
