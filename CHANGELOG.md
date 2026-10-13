# Changelog

## Unreleased

- Comments on tasks with files. A file is encrypted on the device with its own key; the server keeps only ciphertext. Images show inline.
- Assignees in shared projects.
- Voice input on Android: a mic button in quick add and on the widget, the system recognizer prefers offline recognition.
- The Windows app updates itself from GitHub releases; updates are signed.
- Android home screen widget: Today, Week or any project; theme, background opacity, font size, compact rows, hiding tasks while the app is locked. Tap the circle to complete a task, tap a row to open it, + adds a task. Quick settings tile for quick add.
- A shared project gets a new key when the owner removes a member: everything is encrypted again, the removed member cannot read later changes. Devices with the old key pick up the new one automatically.

## 0.2.0

- New look: warm paper palette, Manrope font, tasks on cards, a larger Today header with the date and a progress ring, drawings on empty screens.
- Phone: bottom tab bar, larger rows and tap targets, swipe a task right to complete it and left to reschedule it, the task opens as a bottom sheet that closes with a downward drag, short vibration on gestures.
- Smoother motion: completion animation, cards fade in, screens cross-fade.
- Quick add understands "вчера", "позавчера" and "yesterday".
- Account deletion in Settings. It needs the password and the TOTP code if two-factor login is on. The server deletes the account, the personal tasks and the devices; a shared project with other members passes to one of them.
- Trash: delete a task forever or empty the whole trash. Every field of the task is overwritten with an empty value, so the old encrypted text also leaves the server.
- App lock with a PIN of 4-8 digits: at start and after the app was in the background for the chosen time. Pauses grow after the fifth wrong PIN, and after ten wrong PINs in a row the data on the device is erased. On Android the app also unlocks with a fingerprint.
- Calendar with day, week and month views. Tasks move between days by dragging; in the day and week views they are placed into the hour grid and their duration changes by dragging the bottom edge. Clicking an empty hour adds a task at that time. Shortcut: G, then C.
- Quick add understands a time range after a preposition: "call at 9-10", "созвон в 10:00-11:30".

## 0.1.1

- Fixed the "Key saved in a safe place" checkbox on the recovery key screen and two checkboxes in Settings: the label was squeezed into a narrow column.

## 0.1.0

The first public version.

- Local-first sync: each device keeps a full copy and works offline; fields merge one by one with hybrid logical clocks.
- End-to-end encryption: Argon2id, XChaCha20-Poly1305, a recovery key, shared projects with sealed project keys.
- Quick add in English and Russian, recurrence, Todoist filter syntax, Today, Upcoming, board view, labels, search, completed tasks and trash.
- Reminders in the open app, through Web Push and through Android alarms.
- Import from Todoist, export to JSON and Markdown.
- Two-factor login (TOTP), device list with revocation, invite-only registration.
- Windows app with a tray icon and a global shortcut, Android app with "Share to Dela".
- Docker image with daily database snapshots.
