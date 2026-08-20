# Design specs — v4.1 … v5.0

Implementation-ready specs, written to be executed by a different engineer/model
than the one who designed them. Each spec is self-contained: schema, API contracts,
file-level changes, UI classes, edge cases, e2e additions, and a definition of done.

| Spec | Milestone | Theme | Status |
|---|---|---|---|
| [v4.1-the-library.md](v4.1-the-library.md) | v4.1 | doc snapshots · rendered share pages · model choice · close guard · base branch override · closed-card hatching | shipped |
| [v4.2-groups.md](v4.2-groups.md) | v4.2 | group model · board bands · attempt counters · group actions | shipped |
| [v4.3-logbook.md](v4.3-logbook.md) | v4.3 | active-first board · archive list · fleet payload diet | shipped |
| [v4.4-greenfield.md](v4.4-greenfield.md) | v4.4 | start-a-new-project (git init + empty base → fleet scaffolds) · commitless-repo floor (backlog B1) · ANSI model strip (backlog B2) | spec ready |
| [v4.5-remote-access.md](v4.5-remote-access.md) | v4.5 | detect Tailscale → one-click Serve/Funnel + URL · recipes for Cloudflare/proxy | shipped |
| [v4.6-goal-workroom.md](v4.6-goal-workroom.md) | v4.6 | a room per Goal — aggregate sibling runs · spawn attempts · broadcast steer (settled) · converge · read-only Ask coordinator | shipped |
| [v4.7-deliverables-workroom.md](v4.7-deliverables-workroom.md) | v4.7 | deliverable contract + output cards (real per-type viewers) · converge cockpit (per-run review/fix/merge/close) | shipped |
| [v4.8-auth-and-icons.md](v4.8-auth-and-icons.md) | v4.8 | access-key unlock page + first-run setup (no accounts) · session cookie · Lucide icon system (inlined, replaces emoji) | shipped |
| [v5.0-console-redesign.md](v5.0-console-redesign.md) | v5.0 | navigator rail (repo list + scoping + view nav) · launch as a New sheet (Task/Goal/Workbench) · pocket board · ⌘K · compare-review fix · English sweep | shipped (core; ⌘K/collapse/split-menu trail 5.0.x) |
| [v5.1-close-the-loop.md](v5.1-close-the-loop.md) | v5.1 | landing as a phase — conflict preview · `blocked`/no-op visibility · sibling overlap · integration workroom (resume the run's own agent) · origin-aware land (rebase→push→PR) | shipped (live-validated: real gh + real agent) |

Sequencing: **4.1 → 4.2 → 4.3 were one release each.** **4.4 + 4.5 ship together
as a single tag (4.5.0)** — develop each as its own e2e-green commit on main, then
cut one release (npm 4.3.x → 4.5.0, no standalone 4.4.0). This is the batch rule
(CI runs only on `v*` tags, so main commits are free). Standard train per tag:
e2e → bump both package.json versions → commit → tag → `gh release create --draft`
→ CI auto-publishes → npm publish (owner) → resident upgrade.

## Hand-off notes for the implementer (read before coding)

Hard-won pitfalls of this codebase — every one of these has bitten before:

1. **`src/board.ts` is one TS template literal.** Inside the embedded `<script>`,
   a client-side newline must be written `\\n` in the source, a client-side
   backtick must be escaped, and `${` must not appear unescaped. A single mistake
   is a whole-board SyntaxError (blank page). After any board edit, run the e2e —
   it pattern-matches served HTML and catches this.
2. **esc() does not escape quotes.** Use `escA()` for anything placed in an HTML
   attribute (srcdoc, data-*, title).
3. **tmux targets need exact match**: always `-t '=' + session`. Prefix matching
   once killed the wrong session (`coxpit-r1` matched `coxpit-r11`).
4. **e2e runs under bash 3.2 (macOS)**: no `${var,,}`, quote nesting bugs — capture
   into a var first; `grep -q` on a big pipe causes SIGPIPE+pipefail false failures —
   use `case "$VAR" in *pattern*)` instead. e2e must keep its `unset TMUX` line.
5. **Version SSOT is package.json** (`config.version`); never hard-code versions in
   server strings. Bump `package.json` AND `desktop/package.json` together, then
   `npm i --package-lock-only`.
6. **DB migrations are idempotent ALTERs** in `src/db/index.ts` `ensureSchema()` —
   `try { ALTER TABLE … } catch { /* exists */ }`. Never rename or drop columns.
7. **WebSocket handlers need socket-identity guards** (`sock !== termWS` pattern)
   — close events arrive async; boolean flags alone race.
8. **Dry-run is sacred**: every new pipeline feature must work (or degrade
   explicitly) in dry-run, because e2e is dry-only and spends zero credits.
   Dry mock output is claude-shaped; the parser for dry runs is always the claude
   provider regardless of the selected provider.
9. **DESIGN.md is the UI contract**: any new component/affordance must be added to
   its table in the same commit. No native browser UI (alert/confirm/select).
10. **Landing lives in `docs/`** (GitHub Pages). Specs live here in `design/`.
    Don't mix them. New landing assets get new filenames (browser cache).
11. **Providers are a seam** (`src/providers.ts`): launch command, resume command,
    line parser. Any new per-run execution knob (like model) threads through the
    Provider interface, not through inline command strings.
12. **Codex flag order**: `--json`/`--sandbox`/`-m` are `exec` flags and must come
    *before* the `resume` subcommand.
