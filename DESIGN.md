# Coxpit Design System

The board is a single self-contained page (`src/board.ts`), so the design system lives as CSS custom properties plus the component classes below. **Every new piece of UI must be built from these — no native browser UI** (no `alert`/`confirm`/`prompt`, no bare `<select>`, no default buttons).

## Identity

A dark fleet console: an instrument you *operate*, not a document you read. Data is monospaced, chrome is quiet, one teal accent means "coxpit is acting". Semantic status colors are separate from the accent and never used decoratively.

## Tokens (`:root` in board.ts)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0b0d12` | page ground |
| `--surface` / `--surface2` | `#12151c` / `#171b24` | cards, panels / nested panels, chips |
| `--line` / `--line-hi` | `#222835` / `#2f3648` | borders / hover borders |
| `--ink` / `--muted` / `--faint` | `#dee4ec` / `#8792a2` / `#5c6675` | text hierarchy (3 steps, no more) |
| `--brand` / `--brand-ink` / `--brand-dim` | `#4ec9b0` / `#062822` / 13% teal | the one accent; ink-on-brand; washes |
| `--s-*` | pending gray · preparing amber · running blue · done green · failed/error red · stopped violet · merged teal | status only — never decoration |
| `--mono` / `--sans` | ui-monospace stack / system stack | data vs UI text |
| `--r-card` / `--r-ctl` | 10px / 8px | cards / controls |
| `--shadow` | `0 8px 28px rgba(0,0,0,.35)` | floating layers only |

Type: UI text 13–14px sans; data (ids, branches, logs, diffs, versions) always mono; numbers in tables get `tabular-nums`; section labels are 10–11px mono uppercase with wide tracking.

## Components

| Component | Class | Rules |
|---|---|---|
| Buttons | `.btn` `.btn-ghost` `.btn-danger` (+`.sm`) | one solid teal primary per view; ghost for secondary; danger is outline red, reserved for destructive |
| Status chip | `.chip` (+`.running`) | dot + uppercase mono label, colored by `--s-*`; running pulses (respects reduced-motion) |
| Cards | `.card` | hover = border lighten + 1px lift; whole card is the click target |
| Inputs | `input, textarea` | `#0e1118` well, teal focus border; placeholders in `--faint` |
| Dropdown | `.dd` (wraps a hidden `<select>`) | `dressSelect(id)` enhances; native select stays in DOM as the state holder so `$(id).value` contracts hold; ✓ marks current; Esc/outside closes |
| Segmented | `.seg` / `.seg-opt` | binary/ternary mode choices; the risky option gets brand fill + a mono hint (`spends credits`) |
| Toast | `toast(msg, 'ok'\|'error')` | top-right stack, auto-dismiss ~4s; for outcomes and errors — never questions |
| Confirm | `confirmUI(msg, {sub, danger, okLabel})` | promise-based dialog; every destructive action goes through it with a consequence line in `sub` |
| Modal | `.overlay` + `.modal` (+`.wide`, `.term`) | backdrop blur, Esc/backdrop closes; header = id · title · chip · × |
| Empty state | onboarding `.setup` panel | never a bare "no data" — show machine readiness + next steps |
| Field label | `.flabel` | 10px mono uppercase over every form control — placeholder-only fields are not allowed |
| Repo browser | `.brw` modal + `GET /api/browse` | pick-don't-type: navigate folders, git repos get a badge + inline Register; local machine only (remote = manual path) |
| Export dialog | `#expOverlay` (`.cfm` variant) | one input + consequence line; empty dest falls back to `~/coxpit-exports/r<id>` |
| PR affordance | `Open PR` ghost in compare · `PR ↗` link on cards | once a run has a PR, the button becomes the link — never both |
| Select mode | `Select runs` toolbar toggle + `.selbar` | cards grow a ✓ circle; click toggles instead of opening; the floating bar states the consequence ("merges in selection order · conflicts spawn an integration agent") |
| Plan form | `#planForm` sidebar section | one goal → planner splits → auto-launch; button narrates its long wait ("Planning… (1–3 min)"); follows the global Dry/Real mode |
| AI review panel | `#cmpReview` above compare columns | reviewer digests every diff into approach/pros/cons/recommendation (mdLite-rendered) — the human judges, not reads |
| Timeline lines | `humanize()` | never raw JSON: `said`/`tool ▸ Name — file`/`done`/`steer`/`ask ?`/`sync`; rate-limit and tool-result echoes are dropped as noise. The modal always refetches the full timeline on open (`GET /api/runs/:id`) — the fleet payload caps events at 40/run |
| Session bar | Work/Ask mini-seg + input in run modal | the run IS a session: Work = next instruction, Ask = question only (no file changes); Sync base refreshes a long-lived worktree |
| Notify bell | `#bell` header toggle (🔕/🔔) | browser notification on run settle; server-side twin is `COXPIT_WEBHOOK_URL` (JSON `run.settled` POST) |
| Sidebar layers | Context → Start → Library | ONE machine+repo pair up top (every action uses it); ONE launcher with Task/Goal/Workbench tabs and a shared mode+Start footer; captures live in a collapsed drawer. Never add a fourth parallel section — extend a layer |
| Workbench | launcher tab + `--s-open` status | worktree+tmux, no agent: humans (and their interactive claude) work inside; the card keeps the diff/merge/PR/export rails |
| Terminal | full-screen view, xterm themed with tokens | not a modal — `#termOverlay` fills the viewport (padding 0, no radius); background `--bg`, cursor `--brand`; CJK-safe font stack + unicode11 widths; Esc or × closes |
| Terminal tabs | `.term-tabs` / `.ttab` in the terminal header | every live session (`running`·`open`) is a tab — switch sessions without leaving the terminal; active tab = `--brand` border; re-rendered on every board update |
| Provider seg | `#provSeg` in the Task panel | Claude/Codex per launch (persisted in localStorage); Task tab only — the Goal planner and Workbench are provider-neutral; cards already carry the agent name as the badge |
| Mobile drawer | `.menu-btn` + `aside.open` + `.scrim` (≤860px) | the fleet is the first screen; the launcher slides in from the left and closes itself on launch — never a stacked sidebar above the cards |
| Mobile modals | full-bleed at ≤860px | run modal stacks Timeline over Diff (1fr/1fr rows); compare columns stack vertically; footers wrap; inputs go 16px (iOS focus-zoom guard) |
| Deep link | `/?run=N` + notification `onclick` | any surface (webhook message, browser notification) can land directly on a run modal; the param is consumed then stripped from the URL |
| Doc mode | `#mDocsTgl` / `#cmpDocsTgl` → `docsHTML()` | Rendered ↔ Diff toggle; changed `.md` renders via mdLite, `.html` in a fully sandboxed iframe (no scripts); toggle only appears when the changeset contains docs |
| Diff comments | `.dl-line` (run modal only) | every +/- line is a click target that quotes `file: "line" — ` into the steer input; hover = brand tint; hidden runs (not settled) ignore clicks |
| GitHub import | `#ghOverlay` (`.cfm` variant) + `#ghImport` in Task panel | fetch drafts the form — never auto-launches; the human reviews, picks a provider, runs |
| Share affordance | `Share` ghost in run modal footer | mints/reuses one read-only link per run, copies to clipboard; the share page is server-rendered, script-free, action-free |
| Swarm lineage | `↳ by rN` card meta + `swarm` timeline line | subtask cards carry their parent; the parent's timeline logs each spawn (`↳ spawned task #N`) |
| Terminal input bar | `.term-ibar` + `.tkey` (touch/≤860px) | direct xterm typing breaks IME composition on software keyboards (jamo arrive decomposed) — the bar is a real input that composes natively and sends whole lines; esc·tab·^C·↑·↓ chord keys; safe-area padded |
| Doc provenance | `.doc-src` line above the rendered docs | when the docs come from a snapshot (worktree gone after merge/close), a faint mono line says so — the reader knows they're seeing preserved output, not a live read |
| Model input | `#taskModel` + `#modelHist` datalist (Task panel) | free text (CLI model names churn — no hardcoded list), empty = CLI default; last-5 recalled via localStorage; the card meta shows `⚙ model` when set |
| Base branch dialog | `#brOverlay` (`.cfm` variant) + `#repoBranch` (⎇) in Context | merge · Sync base · PR all target it; validated against the repo (must exist); the repo `<option>` already shows the branch after the name |
| New project | `#npOverlay` (`.cfm` variant) + `New` in Context | the only place coxpit ever runs `git init`; empty/missing/commitless paths only — a populated folder is never initialized; success auto-selects the repo |
| Commitless register | `NO_COMMITS` 400 → confirm offers greenfield | register never silently stores a broken defaultBranch; the confirm (Register form + Browse Register) reuses `#npOverlay`'s POST to seed an empty initial commit |
| Close guard | danger `confirmUI` on 409 from close | closing deletes worktrees — if any run has unmerged, unexported, non-PR changes the server 409s with `atRisk`; the dialog lists them (`rN · M files`) and only `force:true` proceeds |
| Closed card | `.card.closed` (dim + hatched `.log` + CLOSED stamp) | a closed card must read as closed at a glance — desaturated, diagonal hatching over the timeline, a rotated CLOSED stamp; the status chip stays (done/merged history) |
| Group band | `.gband` (`grid-column:1/-1`) around sibling cards | goal (`⌁`) / swarm (`↳`) siblings cluster under a header (title · N tasks · M settled) with fold/Select runs/Close group — a **dashed border**, never a left accent bar or a color fill; cards inside stay first-class, single-run tasks never band |
| Attempt counter | `.attempt` in card meta | any task with >1 run shows `run i/n` so same-title cards read as attempts, not duplicates; brand-tinted, mono |
| Group actions | band header buttons (delegated on `#grid`) | Select runs reuses the existing select mode + selbar (no new merge path); Close group loops the same close endpoint honoring the v4.1 guard, aggregating every `atRisk` into one confirm; fold state persists in localStorage across WS repaints |
| View seg | `#viewSeg` (Active / Archive · N) in header | the board is a cockpit for live work — Active is the default and closed tasks leave it; Archive (`· N` badge = closed count) swaps the grid for a list; WS updates are ignored while Archive is shown (it's a static snapshot) |
| Archive rows | `.arch-row` in `#archive` | closed tasks as compact single-line rows (title · run summary · repo · date), newest first, with a debounced title search and repo filter + load-more paging; a row opens the run modal via `GET /api/tasks/:id` — diff says worktree gone, Rendered falls back to the v4.1 snapshot |

## Interaction rules

- **No native UI.** System dialogs/selects break the instrument feel and can't be themed. (Desktop-shell OS menus are the one exception — they should feel native to the OS.)
- Destructive = `confirmUI` with `danger: true` and an explicit consequence sentence. Never double-confirm.
- Feedback for every mutation: success → `ok` toast, failure → `error` toast carrying the server's `detail`.
- Focus is always visible (`:focus-visible` teal ring). Esc closes the topmost layer.
- Motion is functional only (pulse = running, flash = updated) and disabled under `prefers-reduced-motion`.
- Copy: short, lowercase-leaning, concrete ("worktree missing on machine", not "an error occurred").

## Extending

New UI goes through this file first: reuse a component; if none fits, add the component *here* (tokens + rules) in the same commit that introduces it. If the board ever splits into multiple pages or the Next.js front lands, these tokens move to a shared stylesheet unchanged.
