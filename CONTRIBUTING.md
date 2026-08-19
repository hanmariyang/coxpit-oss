# Contributing to Coxpit

Thanks for taking the time — Coxpit is a small, owner-first project and it stays
that way on purpose. This guide gets you from clone to a mergeable change.

## Ways to help

- **File an issue** — a bug, a rough edge, or a feature idea. Use the templates;
  a good repro or a clear "why" is worth more than a long wishlist.
- **Send a PR** — fixes, docs, and focused features are all welcome. For anything
  large or architectural, **open an issue first** so we can agree on the shape
  before you spend the effort.

## Develop

Requirements: **Node 20+**, `git`, `tmux`, and an agent CLI on your PATH
(`claude` by default). On Windows, develop inside **WSL2** — local agent runs need
a POSIX shell + tmux.

```bash
git clone https://github.com/hanmariyang/coxpit-oss && cd coxpit-oss
npm install
COXPIT_AUTH_DISABLED=1 npm run dev     # → http://127.0.0.1:8210
```

There is **no build step** — `tsx` runs the TypeScript directly, and the web
console is a single self-contained HTML string. Agents default to **dry run** (a
mock stream + a real file change — the whole pipeline, zero credits); flip the
board toggle or set `COXPIT_AGENT_REAL=1` to drive the real CLI.

## Verify before you push

Both must be green — CI runs the same two:

```bash
npm run typecheck        # tsc --noEmit, strict
bash test/e2e.sh         # the full end-to-end suite (spawns real tmux + PTYs)
```

If you change behavior, **add or extend an e2e check** for it. The suite is the
project's real gate.

## Where things live

```
src/index.ts         entry — schema boot, local machine seed, listen
src/server.ts        routes (REST + WS + vendor + board)
src/board.ts         the single-page console — one self-contained HTML string
src/orchestrator.ts  run lifecycle: worktree → tmux → spawn → stream → merge/cleanup
src/providers.ts     the provider seam: launch/resume commands + stream normalization
src/term.ts          PTY attach (local tmux / remote ssh -tt)
```

A new provider is a `src/providers.ts` entry (launch command, resume command, how
a stdout line becomes a board event) — **not** a plugin system. The board knows
nothing about providers; normalize new events into the claude-shaped ones it
already renders.

## House rules (non-negotiable)

These keep the project small and safe — a PR that breaks one won't merge:

- **TypeScript strict.** No new `any` slipping the checker.
- **The board is one HTML string** (`src/board.ts`) — no framework, no bundler.
  It's a feature, not debt. (Heads-up: `board.ts` is one big template literal —
  a stray unescaped `` ` `` or `${` breaks the whole page. Client-side newlines
  are `\n` in the source.)
- **No GPL / AGPL / LGPL dependencies**, and **do not copy code** from AGPL-licensed
  projects. Audit with `npm ls --omit=dev --all`. Coxpit is MIT and stays clean.
- **No secrets, tokens, or user-specific paths in the repo.** Configuration is
  env-only (see the README config table). Coxpit stores no agent keys — it drives
  the CLI's own login.
- **External tools stay external.** `git`, `tmux`, and the agent CLIs are spawned,
  never vendored or wrapped.

See also the [non-goals](ROADMAP.md#non-goals) — accounts, telemetry, a cloud
relay, and a board bundler are out of scope by design.

## Making a change

1. Branch off `main` (`fix/…`, `feat/…`, `docs/…`).
2. Keep it focused — one concern per PR reviews faster than a grab-bag.
3. Run `typecheck` + `e2e`, and fill in the PR template checklist.
4. Reference the issue it closes.

**Releases are batched.** CI only runs on `v*` tags, so merged `main` commits are
free — the maintainer accumulates changes and cuts a tagged release at milestones.
You don't need to bump the version in your PR.

## Reporting security issues

Please **don't** open a public issue for a vulnerability — Coxpit exposes shells,
so treat it carefully. See [SECURITY.md](SECURITY.md).

By contributing, you agree your contributions are licensed under the
[MIT License](LICENSE).
