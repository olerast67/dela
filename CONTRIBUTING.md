# Contributing

Bug reports, testing on your devices and code are all welcome. You can write in English or Russian.

## Reporting bugs

Open an issue using the **Bug report** form. Say on which platform it happened (web browser, Windows app, Android app) and which version. For sync problems, describe what you did on each device and in what order.

## Building

You need Node.js 22.18 or newer.

```bash
npm install
npm run check        # type check and unit tests
npm run test:e2e     # Playwright scenarios (run `npx playwright install chromium` once)
npm run dev:web      # web client with hot reload
npm run server       # server on http://localhost:8080
```

The Windows app needs Rust and the Tauri prerequisites (`npm run desktop:build`). The Android app needs JDK 21 and the Android SDK (platform 36): build the web client, run `npx cap sync android` in `apps/mobile`, then `gradlew assembleRelease` in `apps/mobile/android`.

## Code

- **Where logic lives.** Sync, encryption, the task model, the quick add parser, recurrence and filters live in `packages/core` and use no browser or Node APIs. Cover changes there with unit tests in `packages/core/test`; property tests use fast-check.
- **Encryption.** Anything that reaches the server must be encrypted or listed in the Security section of the README. A change to the wire format needs a migration plan and a test.
- **TypeScript.** Node runs the server sources directly (type stripping), so use only erasable syntax: no enums, no parameter properties, imports with the `.ts` extension.
- **Style.** Match the surrounding code; comments explain *why*, not *what*.
- **No emojis** in the app's text, the docs, commit messages or release notes.
- **Pull requests.** One topic per pull request. Describe how you tested it and on which platforms.

## Contributor license agreement

Dela is licensed under the AGPL-3.0. A hosted version may come later, so the author asks contributors to agree that the author may also distribute their contribution under other licenses. To agree, tick the CLA checkbox in the pull request description; a check blocks the pull request until it is ticked. By ticking it you confirm that you wrote the code and agree to this. Your contribution stays available under the AGPL-3.0 in this repository.
