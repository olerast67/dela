# Changelog

## 0.5.0

- English interface. The app follows the system language; Settings → Language switches between English and Russian. New accounts get welcome tasks and built-in templates in the chosen language. The Android widget, notifications and the Windows tray menu are translated too.
- Task card: the time field is no longer cut off in the 12-hour format.
- Server install in one command: settings in `.env`, `--profile https` starts a bundled Caddy that gets the certificate itself. The `latest` image is the latest release, `edge` follows the main branch.

## 0.4.2

Fixes found while testing on a phone:

- Android: the home screen widget stayed empty or showed "Loading..." forever. The app could not pass tasks to it, and the row layout used a view type widgets do not allow.
- Android: a reminder could be cancelled by the app at the moment it was due, so it never showed. The app no longer opens the system "Alarms & reminders" screen on its own; Settings has a button for exact reminder times instead.
- Android: reminders and the widget are cleared on sign out.
- Android: widget settings follow the dark theme and return to the home screen after "Done".
- Pop-up messages can be swiped away or closed with ×; they stay 2.5 s, or 4 s when they have a button.
- A screenshot can be pasted into a comment with Ctrl+V or dropped onto it.
- Phone: dragging a task makes it a subtask only after holding it over the middle of another task.
- Phone: the tab bar and the + button hide while the on-screen keyboard is open.
- The device list names the apps "Dela app" instead of the browser engine.
- Key rotation started by hand and by a member leaving no longer race each other; deleting the account no longer races with sign out.

## 0.4.1

Security fixes after an audit:

- Project keys are confirmed by the owner, and members pin the owner's key; owners pin members' keys and confirm fingerprints before a key change. A server can no longer hand out its own project key.
- A member could make the owner's app delete another member through a crafted file id in a comment.
- Adding a passkey and turning TOTP on need the password; recovery removes passkeys; a password change disconnects other devices.
- Key rotation no longer loses edits that arrive during it, works for projects of any size, and members whose app saw new data before the new key no longer miss it. The owner rotates the key again when a member leaves on their own.
- Push: only the push services themselves are allowed, no redirects, 10 s timeout; long titles no longer block the schedule.
- Android: the widget's command receiver is private, app backup is off, reminders hide the task title on the lock screen.
- Limits: shared projects per user (`DELA_MAX_SHARED_SPACES`), used invites stay used after an account is deleted, failed logins from other addresses do not lock the owner out as fast.
- Images in comments now show in the Windows app; SVG files are not previewed.

## 0.4.0

- Sign in with a passkey (Windows Hello, fingerprint, Google Password Manager, iCloud Keychain, FIDO2 keys) in the browser. The PRF extension opens the account key on the device, so end-to-end encryption stays without a password. The server needs `DELA_PUBLIC_URL`.
- Android push without Google services: reminders arrive through a UnifiedPush distributor such as ntfy. The reminder text is encrypted with a key only the phone knows. `DELA_PUSH_HOSTS` allows your own distributor.
- Try Dela without a server: tasks stay encrypted in the browser only. The demo at https://olerast67.github.io/dela/demo/ runs this way.
- Project site: https://olerast67.github.io/dela/
- The Android build no longer includes the Google Services Gradle plugin; F-Droid metadata in fastlane/.
- History of actions: created, completed and deleted tasks and comments by day, with the author in shared projects.
- Project templates: save a project as a template, create a project from it, three ready templates, import and export as a file. Due dates are kept relative to the day of creation.

## 0.3.0

- Phone: hold a task to drag it with a finger to another place in the list, into another task or onto another day.
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
