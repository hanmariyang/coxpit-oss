# Roadmap

Coxpit's goal is simple: prove that a self-hosted, owner-first agent-fleet cockpit can be small, sharp, and genuinely daily-drivable.

## v2.1 — shipping quality *(current)*

- [x] Public roadmap
- [x] E2E test suite in-repo, running in CI
- [x] GHCR container image published per release
- [x] Desktop auto-update (electron-updater, GitHub provider)
- [x] Real screenshots on README & landing
- [ ] macOS code signing + notarization (cert pending)
- [ ] npm publish (`npx coxpit`)

## v2.2 — daily driver

- Mid-run steering: send follow-up instructions to a running agent (beyond terminal attach)
- PR mode: open a pull request from a winning run instead of direct merge
- Provider interface + a second agent CLI (prove the seam)
- Mobile pass on the board (steer from a phone, for real)
- Generic webhook notifications on run settle

## v3.0 — reach

- Design Mode captures with screenshots
- Multi-user awareness (still owner-first — but shareable read views)
- Public write-up / demo video

Suggestions and PRs welcome — file an issue.
