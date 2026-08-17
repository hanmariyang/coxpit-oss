# Releasing the desktop app

Installers are built by CI on every `v*` tag (or manual dispatch) and uploaded to the GitHub Release — see `.github/workflows/release.yml`. Auto-update is wired via electron-updater (GitHub provider); packaged apps check on launch and every 6h, installing silently on quit.

## Cutting a release

```bash
# bump "version" in package.json AND desktop/package.json (keep them equal)
git tag vX.Y.Z && git push origin main vX.Y.Z
gh release create vX.Y.Z --title "Coxpit X.Y.Z" --notes "..."
# CI attaches: .dmg (arm64+x64) / .exe (nsis) / .AppImage + update metadata (latest*.yml)
```

`releaseType: "release"` in `desktop/package.json` lets electron-builder upload to the published release directly.

## macOS code signing + notarization (pending)

Unsigned dmg works but shows a Gatekeeper warning (right-click → Open). To sign:

1. In the Apple Developer account, create a **Developer ID Application** certificate; export as `.p12` with a password.
2. Add repo secrets: `CSC_LINK` (base64 of the .p12), `CSC_KEY_PASSWORD`, and for notarization `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
3. Pass them to the macOS job env in `release.yml`; add to `desktop/package.json`:
   ```json
   "mac": { "hardenedRuntime": true, "notarize": true }
   ```
4. Re-tag. electron-builder signs + notarizes automatically when the env vars are present.

## Windows

nsis installer is unsigned (SmartScreen warning on first runs). Optional later: Azure Trusted Signing or an OV/EV cert via `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`.
