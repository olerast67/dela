# Releasing

1. Bump the version in `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/tauri.conf.json`, `apps/mobile/package.json`, `apps/mobile/android/app/build.gradle` (`versionName` and `versionCode`), and `apps/server/src/app.ts` (`VERSION`). Rename `## Unreleased` in `CHANGELOG.md`.
2. `npm run check` and `npm run test:e2e`, commit, push.
3. Build:
   - web: `npm run build:web`;
   - Android: `npx cap sync android` in `apps/mobile`, then `gradlew assembleRelease` in `apps/mobile/android` (signing keys from `~/dev/keys/dela-release.properties`);
   - Windows: `npx tauri build` in `apps/desktop` with `TAURI_SIGNING_PRIVATE_KEY` (path to the update key) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` set. The build writes `Dela_<version>_x64-setup.exe` and its `.sig`.
4. `node scripts/latest-json.mjs > latest.json`: the update manifest for the Windows app.
5. Update the server before publishing the apps.
6. `gh release create v<version>` with the installer, the APK, `SHA256SUMS.txt` and `latest.json`. The tag also builds the Docker image in CI and moves `latest` to it; pushes to main publish `edge`.

Code signing for Windows through SignPath: docs/code-signing.md and the Windows release workflow.

The update signing key and the Android keystore live outside the repository. Losing the update key means the installed Windows apps cannot update themselves any more; keep a backup.
