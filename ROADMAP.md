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

> **v4.4 + v4.5 ship together as one release (4.5.0).** Both are spec'd in
> `design/`; they're developed as separate e2e-green commits on main, then cut as
> a single tag (npm goes 4.3.x → 4.5.0, skipping a standalone 4.4.0 — batch rule).

### v4.5 — remote access *(spec ready — [design/v4.5-remote-access.md](design/v4.5-remote-access.md))*
Today every URL is an IP:port. Make reaching the daemon from elsewhere easy
*without* coxpit running a relay — always the user's own Tailscale/Cloudflare.
Guardrail: coxpit never hosts a tunnel; it detects the tool and drives it.

- [x] Onboarding "Remote access" card: detect Tailscale; one-click **Serve**
      (`https://<machine>.<tailnet>.ts.net`, tailnet-only, HTTPS, no port — safe
      by default), show + copy the URL
- [x] **Funnel** (public) behind an explicit toggle + a warning that it exposes
      shells, so basic auth must be on
- [x] Copy-paste recipes for non-Tailscale users (Cloudflare Tunnel, Caddy
      reverse proxy) with the daemon's port pre-filled — guidance, not magic
- [x] The limit is honest: coxpit can hand you a `*.ts.net` name easily; a
      *custom* domain (`coxpit.yourbrand.com`) stays a Cloudflare/proxy recipe

**URL shapes by method** (examples):

| method | URL example | who reaches it | custom name | TLS | setup |
|---|---|---|---|---|---|
| local | `http://127.0.0.1:8210` | same machine | ✕ | ✕ | none |
| LAN | `http://192.168.0.12:8210` | home network | ✕ | ✕ | none |
| Tailscale IP | `http://100.x.y.z:8210` | your tailnet | ✕ | ✕ | none |
| Tailscale MagicDNS | `http://<machine>.<tailnet>.ts.net:8210` | your tailnet | machine name only | ✕ | none (already on) |
| **Tailscale Serve** ⭐ | `https://<machine>.<tailnet>.ts.net` | your tailnet | machine name only | ✓ auto | one command |
| Tailscale Funnel | `https://<machine>.<tailnet>.ts.net` | **public** | machine name only | ✓ auto | command + admin enable |
| Cloudflare Tunnel | `https://coxpit.yourdomain.com` | public (+ CF Access) | ✓ full | ✓ | CF acct + domain + config |
| reverse proxy (Caddy) | `https://coxpit.yourdomain.com` | public | ✓ full | ✓ auto | public IP + DNS + proxy |

Notes: Tailscale names are fixed to `<machine>.<tailnet>.ts.net` (the machine
part is renameable in the Tailscale admin; the tailnet suffix is not). Funnel is
public with no Tailscale-side auth → the daemon's own basic auth is the gate;
it only serves ports 443/8443/10000 on the `.ts.net` name and must be enabled in
the tailnet admin. Serve has none of those limits. A truly custom domain is only
reachable via Cloudflare/reverse-proxy (the user's own domain + account).

### v4.4 — greenfield (start a new project) *(code shipped — [design/v4.4-greenfield.md](design/v4.4-greenfield.md))*
Also folds in two batch fixes: commitless-repo handling (the floor of greenfield)
and stripping an ANSI code that leaks into session model names.
Today coxpit needs a git work-tree with at least one commit — worktrees branch
off a base commit. So a brand-new project (empty folder, or `git init` with no
commits) is unusable. Turn that limit into the feature it wants to be: **scaffold
a new project across N agents and compare the foundation before you commit to one.**

- [x] Commitless-repo floor: Register detects the unborn branch without erroring
      (`symbolic-ref` fallback) and refuses a zero-commit repo with a clear
      `NO_COMMITS` 400 instead of silently storing a broken defaultBranch
- [x] Start a new project: `POST /api/repos/new` runs `git init` (if needed) + an
      **empty initial commit** as the base, only on empty/missing/commitless paths
      — a populated folder is never initialized; the launcher gets a `New` button +
      dialog, and the commitless-Register 400 offers the same greenfield flow
- [x] The empty initial commit hosts the fleet: N agents each scaffold in their own
      worktree off that base; compare → Merge this lands the winner on empty `main`
- [x] ANSI model strip: session model names are sanitized at the source
      (`providers.ts`) with a display belt in the board — no more `…-4-8[1m]`

Guardrails held: greenfield is an **explicit action**, never a side effect of
Register (someone's folder is never turned into a repo by surprise); the empty
initial commit is a clean base so merge stays clean.

### v4.6 — the Goal workroom *(shipped — [design/v4.6-goal-workroom.md](design/v4.6-goal-workroom.md))*
A room per Goal, opened from the group band: aggregate sibling runs, spawn attempts,
broadcast a follow-up to settled runs, and a read-only Ask coordinator (Work/Ask).

### v4.7 — deliverables & the converge workroom *(shipped — [design/v4.7-deliverables-workroom.md](design/v4.7-deliverables-workroom.md))*
Tasks declare required outputs; runs pin them as typed **output cards** with real
per-type viewers (rendered markdown, live sandboxed HTML, colored diff, image). The
Goal workroom becomes a per-run **converge** panel (review / steer / merge / close).
Plus: closed-task terminal fix and a **reclaim orphaned worktrees** maintenance action.

### v4.8 — access-key auth & the icon system *(shipped — [design/v4.8-auth-and-icons.md](design/v4.8-auth-and-icons.md))*
The Basic-Auth popup is replaced by a branded, owner-first **access key** (no accounts,
no username) with first-run setup — and it only engages **when exposed** (localhost is
zero-friction). Signed session cookie, rate-limit, anti-claim. Lucide icon system
(inlined, ISC) replaces system emoji across the board + login.

### v5.0 — the console redesign *(planned — approved 시안, spec TBD)*
The milestone theme: **the left rail stops being a permanent compose form and becomes a
navigator; launching becomes a focused action.** Approved direction (Direction A) —
mockup lives with the maintainer; a `design/v5.0-*.md` spec will precede implementation.

Core redesign:
- [ ] **Navigator rail** — machine switcher + a **repo list** (each row shows its active-run
      count, click to scope the board) + view nav (**Active / Goals / Archive**, moved out of
      the header). The rail is scannable, repo-centric, calm.
- [ ] **Launch is an action** — `＋ New` opens a focused **compose sheet** with
      **Task / Goal / Workbench** tabs; the optional fields (provider is up front; model /
      design capture / **deliverables**) sit under a progressive "Options" reveal. Task →
      Run fleet, Goal → Plan & run, Workbench → Open workbench.
- [ ] **Pocket board** — the mobile drawer becomes just the navigator; a `＋` FAB opens the
      compose sheet. Fixes the "dense form crammed into a drawer" problem.

Adjacent polish (same milestone):
- [ ] **⌘K command palette** — switch repo, New task, jump to a run — keyboard-first (the
      cockpit is repetitive; this is high-leverage).
- [ ] **Active vs Goals boundary** — Active = all active runs (flat); Goals = the group
      bands / converge entry; Archive = closed. Clarify the overlap.
- [ ] **Collapsible rail** (icon-only) for maximum board space (VS Code activity-bar style).
- [ ] **Repo-row status signals** — the active-run badge plus an attention dot when a repo
      has failed/dirty work needing a hand.
- [ ] **Empty-state onboarding** — no repo registered → the rail guides "Add your first
      repository" (wire to the existing readiness panel).
- [ ] Optional: `＋ New ▾` split menu (one-click type shortcut) alongside the sheet tabs.

Fixes folded into 5.0:
- [ ] **Compare AI review has room** — today the review is a squeezed band above the diff
      columns (`.cmp-review` has no dedicated scroll/height), so a long review is hard to
      read. Give it its own full-height, scrollable space (reuse the Answer viewer, or a
      review mode that replaces the diff columns) — no more tiny band.
- [ ] **English sweep** — the deliverables/contract + converge labels leaked Korean from the
      design mocks; normalize to English (Answer/Code/Doc/Page/File · Required/Extra ·
      Review/Steer/Merge/Close) since the product ships in English.

Sequencing: develop as e2e-green commits on main (rail → sheet → mobile → palette → the
polish + fixes), then cut **5.0** once the redesign lands — the major bump signals the new
console. Design-as-Fable / build-as-Opus continues.

## v5.1 — close the loop (landing as a phase)

The run lifecycle stops at `done`, but the real end is *landed on origin*. Today the last mile
— conflict resolution + integration — lives outside coxpit, so you drop to a bare terminal and
a context-less agent to reconcile. v5.1 extends the card lifecycle through **integrating →
landed**, keeps resolution in-app (resume the run's own agent), and lands on origin as a
branch + PR. Full spec: [design/v5.1-close-the-loop.md](design/v5.1-close-the-loop.md).
Owner decisions (2026-08-20): land = **push + PR**; default resolver = **resume the run's agent**.

Part A — visibility gates (cheap, ship first):
- [ ] **Conflict preview** — `git merge-tree --write-tree --name-only` behind
      `GET /api/runs/:id/merge/preview` (+ group roll-up); board shows conflicted files before
      Merge acts. Feature-detect git ≥2.38; degrade to "preview unavailable".
- [ ] **`blocked` / no-op visibility** — a `done` run at `exit 0` with `filesChanged=0` stops
      passing as complete: mark `blocked` when the stream shows approval-required, else a
      "no changes" chip; `taskCloseRisk` surfaces merge/write tasks that changed nothing.
- [ ] **Sibling overlap + land order** — within a group, intersect `diff --name-only base..branch`
      across siblings; show overlapping files + a fewest-overlap-first land order on the band.

Part B — the integration workroom:
- [ ] **Merge becomes a phase** — on conflict, open the integration workroom on the same
      worktree, **resume the run's own agent** (`sessionId`) to `fetch origin` + resolve the
      listed conflicts; status `integrating`, tracked live on the card, terminal attachable;
      re-preview until clean. Fallback: one-click **Open as workbench** (in-app terminal + claude).

Part C — origin-aware landing:
- [ ] **Base-drift detection at worktree creation** — `rev-list --left-right --count base...@{u}`;
      surface ahead/behind on the card, warn when base is behind origin.
- [ ] **Land to origin** — rebase onto `origin/<base>` (or cherry-pick `base..branch` unique
      commits onto a fresh origin-tracking branch) → push → open PR via `gh` (reuse v2.6 PR mode);
      card end state `landed` with the PR link. Never ship through local `main`.

Sequencing: A → B → C, e2e-green commits on main; cut **5.1** once the loop closes.

## Non-goals

- Vendoring or wrapping agent CLIs — external tools stay external (`git`, `tmux`, the agent)
- Accounts, telemetry, cloud relay — the daemon is yours; front it with your own access layer
- A bundler for the board — one self-contained HTML string is a feature, not a debt

Suggestions and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md), then file an issue.
