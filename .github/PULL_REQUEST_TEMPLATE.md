<!-- Thanks for the PR! Keep it focused — one concern reviews faster. -->

## What & why

<!-- What does this change, and what problem does it solve? Link the issue it closes. -->

Closes #

## Checklist

- [ ] `npm run typecheck` is clean
- [ ] `bash test/e2e.sh` passes, and I added/extended a check if behavior changed
- [ ] No secrets, tokens, or user-specific paths — configuration stays env-only
- [ ] No GPL/AGPL/LGPL deps added, and no code copied from AGPL projects
- [ ] If I touched `src/board.ts`, the single-HTML-string still renders (no stray `` ` `` / `${`)
- [ ] Docs/README updated if the change is user-visible

## Notes for reviewers

<!-- Anything worth calling out: trade-offs, follow-ups, screenshots/GIFs for UI changes. -->
