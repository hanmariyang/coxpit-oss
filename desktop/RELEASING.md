# Releasing the desktop app

Installers are built by CI on every `v*` tag (or manual dispatch) and uploaded to the GitHub Release — see `.github/workflows/release.yml`. Auto-update is wired via electron-updater (GitHub provider); packaged apps check on launch and every 6h, installing silently on quit.

## Cutting a release

```bash
# bump "version" in package.json AND desktop/package.json (keep them equal)
git tag vX.Y.Z && git push origin main vX.Y.Z
gh release create vX.Y.Z --draft --title "Coxpit X.Y.Z" --notes "..."
# CI uploads all installers to the DRAFT, then the publish-release job flips it live.
```

Releases must be created as **drafts**: electron-updater reads the *latest published* release, so publishing before assets exist opens a ~15-min window where update checks 404 on `latest-mac.yml`. The `publish-release` CI job publishes the draft only after every desktop job finished.

Re-running a dispatch against an already-published release? electron-builder skips uploads to published releases — flip it back first: `gh release edit vX.Y.Z --draft=true`, dispatch, and let the publish job re-publish it.

## macOS code signing + notarization

**Current state: builds are UNSIGNED by default.** Signing is gated behind the repo
**variable `MAC_SIGN`** (see `release.yml`): unless `MAC_SIGN=1`, the macOS job clears
the signing env and builds unsigned (`CSC_IDENTITY_AUTO_DISCOVERY=false`).

Why the gate exists: a *wrong* signing password fails the whole macOS build, which
leaves the GitHub Release a draft with no installers — and electron-updater reads the
*latest published* release, so the desktop auto-updater gets stranded on the last good
one. That happened: v5.24.0–v5.27.1 all stayed drafts because `CSC_KEY_PASSWORD` didn't
match the cert (CI error: `SecKeychainUnlock: … passphrase … not correct`), so the app
kept offering 5.23.0. Unsigned builds always publish, so the updater never gets stuck;
Windows/Linux auto-update normally. On macOS, unsigned means a Gatekeeper prompt
(right-click → Open) on first launch and limited auto-*apply* until signed.

`desktop/package.json` build already sets `mac.hardenedRuntime: true` and
`mac.notarize: true`, so signing **and** notarization turn on automatically once valid
credentials are present **and** `MAC_SIGN=1`.

### One-time setup (owner) — restore signed auto-update

Prereq: Apple Developer Program membership.

1. **Certificate** — create a **Developer ID Application** certificate (Xcode →
   Settings → Accounts → Manage Certificates → **+** → *Developer ID Application*, or
   the Apple Developer portal). It must be **Developer ID Application** (for
   distribution outside the App Store) — *not* "Apple Development".
2. **Export `.p12`** — Keychain Access → right-click the cert (expand it so its private
   key is included) → Export → `.p12`, and set an export password. **Remember this
   exact password** — mismatching it is the failure above.
3. **Set repo Secrets** (Settings → Secrets and variables → Actions → **Secrets**):
   ```bash
   base64 < DeveloperID.p12 | tr -d '\n' | pbcopy   # one line — paste as CSC_LINK
   ```
   - `CSC_LINK` — the one-line base64 from above (line breaks will break decoding)
   - `CSC_KEY_PASSWORD` — the `.p12` export password from step 2
   - `APPLE_ID` — your Apple ID email
   - `APPLE_APP_SPECIFIC_PASSWORD` — an **app-specific** password
     (appleid.apple.com → Sign-In and Security → App-Specific Passwords), *not* your
     account password
   - `APPLE_TEAM_ID` — 10-char Team ID (Apple Developer → Membership)
4. **Enable the gate** (Settings → Secrets and variables → Actions → **Variables**):
   add `MAC_SIGN` = `1`.
5. **Cut a release** (tag `vX.Y.Z`). electron-builder now signs + notarizes the macOS
   build automatically.

### Verify

Download the dmg from the release and open the app once, then:
```bash
codesign -dv --verbose=4 /Applications/Coxpit.app   # Authority: Developer ID Application: …
spctl -a -t exec -vvv    /Applications/Coxpit.app   # accepted · source=Notarized Developer ID
```
The release must include `latest-mac.yml` **and** the `*-mac.zip` — electron-updater
applies from the zip, not the dmg.

### Troubleshooting

- `SecKeychainUnlock: … passphrase … not correct` → `CSC_KEY_PASSWORD` ≠ the `.p12`
  export password. Re-export the cert or fix the secret.
- cert not found / `CSC_LINK` decode error → wrong cert type (must be *Developer ID
  Application*), or the base64 has line breaks (re-encode with `tr -d '\n'`).
- notarization fails → verify `APPLE_APP_SPECIFIC_PASSWORD` (app-specific, not the
  account password) and `APPLE_TEAM_ID`.

### Rollback

Set `MAC_SIGN` to `0` (or delete the variable). The next release builds unsigned and
still publishes — the pipeline never blocks on a bad cert again.

## Windows

nsis installer is unsigned (SmartScreen warning on first runs). Optional later: Azure Trusted Signing or an OV/EV cert via `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`.
