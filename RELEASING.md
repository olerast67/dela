# Releasing

Releases are built by `.github/workflows/release.yml` from the tagged source: the Android APK, the Windows installer, the Docker image and the signed web file list for the Dela Verify extension. Every file gets a build provenance attestation.

1. Bump the version in `apps/desktop/src-tauri/Cargo.toml` (and `Cargo.lock`), `apps/desktop/src-tauri/tauri.conf.json`, `apps/mobile/package.json`, `apps/mobile/android/app/build.gradle` (`versionName` and `versionCode`) and `apps/server/src/app.ts` (`VERSION`). Rename `## Unreleased` in `CHANGELOG.md` and add `fastlane/metadata/android/*/changelogs/<versionCode>.txt`.
2. `npm run check` and `npm run test:e2e`, commit, push, wait for CI.
3. `git tag v<version> && git push origin v<version>`. The workflow checks that the tag matches the versions in the code, waits for approval (step 4), builds everything, publishes the image as `ghcr.io/olerast67/dela:<version>` and `latest`, and creates the release with the APK, the installer, `latest.json`, `web-manifest.json` with its signature, the extension and `SHA256SUMS.txt`.
4. Approve the run: GitHub sends a notification, open the run and press "Review deployments" → `release` → "Approve and deploy". Until then the jobs that use the signing keys do not start.
5. Update the server: `docker compose pull && docker compose up -d`. The Dela Verify extension compares the server with the official image, so a server should run that image rather than a local build.

## Secrets

The signing keys are secrets of the `release` environment (Settings → Environments → release), not repository secrets. The environment accepts only `v*` tags and requires approval by the author, so a workflow pushed with a stolen token cannot read the keys without that approval.

| Secret | Contents |
|---|---|
| `DELA_KEYSTORE_BASE64` | The Android keystore, base64 |
| `DELA_KEYSTORE_PASSWORD`, `DELA_KEY_ALIAS`, `DELA_KEY_PASSWORD` | Values from `~/dev/keys/dela-release.properties` |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The update signing key of the Windows app and its password |
| `DELA_WEB_SIGNING_KEY` | The Ed25519 key that signs `web-manifest.json` (`~/dev/keys/dela-web-manifest.key`) |
| `SIGNPATH_API_TOKEN`, `SIGNPATH_ORGANIZATION_ID` | Code signing for Windows, after SignPath Foundation approves the project (docs/code-signing.md) |

Set them from a terminal so the values never appear in the shell history or in a chat:

```bash
base64 -w0 ~/dev/keys/dela-release.jks | gh secret set DELA_KEYSTORE_BASE64 --env release
python -c "import re,sys;p=dict(l.strip().split('=',1) for l in open(sys.argv[1]) if '=' in l);print(p[sys.argv[2]],end='')" ~/dev/keys/dela-release.properties storePassword | gh secret set DELA_KEYSTORE_PASSWORD --env release
python -c "import re,sys;p=dict(l.strip().split('=',1) for l in open(sys.argv[1]) if '=' in l);print(p[sys.argv[2]],end='')" ~/dev/keys/dela-release.properties keyAlias | gh secret set DELA_KEY_ALIAS --env release
python -c "import re,sys;p=dict(l.strip().split('=',1) for l in open(sys.argv[1]) if '=' in l);print(p[sys.argv[2]],end='')" ~/dev/keys/dela-release.properties keyPassword | gh secret set DELA_KEY_PASSWORD --env release
gh secret set TAURI_SIGNING_PRIVATE_KEY --env release < ~/dev/keys/dela-updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --env release < ~/dev/keys/dela-updater.password
gh secret set DELA_WEB_SIGNING_KEY --env release < ~/dev/keys/dela-web-manifest.key
```

The keys stay in `~/dev/keys` as well. Losing the update key means the installed Windows apps cannot update themselves any more, losing the Android keystore means the APK cannot be updated in place; keep a backup outside the laptop.

## Building by hand

If GitHub Actions is not available, the same files can be built locally:

- web: `npm run build:web`;
- Android: `npx cap sync android` in `apps/mobile`, then `gradlew assembleRelease` in `apps/mobile/android` (signing keys from `~/dev/keys/dela-release.properties`);
- Windows: `npx tauri build` in `apps/desktop` with `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` set;
- `node scripts/latest-json.mjs > latest.json`.

A release built this way has no provenance attestation and no signed web file list.
