# `@coxpit/core` — the terminal cockpit kernel

The part of this daemon that is **not** a product: PTY lifecycle, the names a run's
worktree/branch/tmux session get, and the pure run-state machine with its merge guards.

It exists because a second cockpit product (private, different UI, different brand)
needs exactly these pieces, and because these are the pieces nobody wants to debug
twice. The macOS `posix_spawn` pty-master leak and the `spawn-helper` exec bit cost
days to find once; they must not be found again in a copy.

## The one rule

**Nothing under `src/core/` imports anything above it.** No `config`, no `db`, no
`exec`, no `hub`, no Fastify, no HTML. Settings arrive as parameters
(`openTerm(..., { lang, sshKey })`), never by importing the product's config module.

`test/unit/core-boundary.test.ts` fails the moment that rule breaks. That test is the
boundary — not this paragraph.

## What is here

| file | what | purity |
|---|---|---|
| `types.ts` | `MachineTarget`, `isLocalMachine` | pure |
| `shell.ts` | `shq` POSIX quoting, `samePath` (/private, trailing slash) | pure |
| `tmux.ts` | `tmuxNewSession` (born in `$HOME`, history limit) | pure string builder |
| `naming.ts` | `makeNaming(prefix)` → worktree parent/path, branch, session, state dir, pid file | pure |
| `runstate.ts` | settled statuses, steer/PR/merge guards, merge-output classification | pure |
| `term.ts` | `spawnPty` (fd-leak fix, spawn-helper chmod), `openTerm` (tmux attach / ssh -tt) | touches node-pty + process |

## Why `naming.ts` matters more than it looks

The worktree folder, the branch, the tmux session and the in-worktree state folder all
carry the product's name: `.coxpit-worktrees`, `coxpit/r22`, `coxpit-r22`, `.coxpit/`.
Two cockpit products on one machine with the same strings would attach to each other's
tmux sessions and reclaim each other's worktrees. Injecting the prefix makes that
collision structurally impossible instead of a thing to remember.

Still product-named, on purpose, and not yet parameterized:

- `runstate.ts`'s `MERGE_FAIL_MARK = 'COXPIT_MERGE_FAILED'` — an internal marker inside
  one shell command, never shown to a user. Parameterize it when the second product
  lands, and change `classifyMergeResult` to take the mark.
- The daemon's data dir (`~/.coxpit/`) and its `COXPIT_*` env names live in the
  product's `config.ts`, which is where they belong. A second product must choose its
  own, or the two daemons will fight over one `daemon.lock.json`.

## Consuming it

In this repo, import from `./core` — that is all the product does.

In another product, take this directory only, in **one direction**: kernel changes are
made here and pulled there, never the other way. A fix made downstream and not
upstreamed is how one of the two products ends up with the pty leak again.

The path is stable so the directory can be lifted out later with
`git subtree split -P src/core`. It is not an npm workspace today for a concrete
reason: the desktop bundler (`desktop/package.json` → `extraResources`) copies only
`src/**`, `bin/**` and `node_modules/**`, so a workspace package would reach the app as
a symlink into a folder that was never copied, and the daemon would fail to start in a
signed build that nothing in CI checks.

## Contributions

An outside change to these files, accepted under the AGPL alone, ends the dual
licensing in `LICENSE` — option (b) requires that one party hold the copyright. Take
kernel contributions only with a CLA, or reimplement the idea. Everything above
`src/core/` is unaffected and takes contributions normally.
