# Changelog

## Unreleased

- Phone: the bottom bar of the task card (creation date, Delete) is no longer hidden under the Android navigation bar.
- The glow of the add button is centred around it.
- Quick add understands times spoken as words, as voice input writes them: "завтра в десять утра", "в два часа дня", "в половине восьмого", "в полночь", "at seven thirty pm", "at half past seven", "at noon", and in reminders ("напомни в девять"). Numbers without "в"/"at" stay in the title ("купить десять яиц"). "в 11 ночи" now means 23:00.
- Today and Upcoming: drag a task above or below another to set your own order for that day, with the mouse or a long press. The order in the project stays as it was, and a task dropped on a task of another day moves to that day next to it. New tasks for the day slot in by time and priority as before.

## 1.0.2

- The arrow that folds subtasks stays inside the task card instead of covering its left border (reported in #9).
- Windows: dragging tasks with the mouse works, including onto a project in the sidebar to move the task there. The Tauri drag handler caught the drag before the page did; it is off now, and files dropped into a comment go through the page as well.
- Voice input without the cloud, the same on the phone and the computer: the microphone button in quick add (and in the Windows quick add bar) records the phrase and recognizes it on the device with the sherpa-onnx speech models from Settings (Russian 27 MB, English 70 MB, the same pinned files and SHA-256 checks as for voice messages); the audio is not sent or saved. A pulsing dot shows the level and the text appears as you speak; a pause after the words, a second press or 30 seconds end the recording, Esc cancels it. The model follows the interface language, or whichever one is downloaded. Android asks for the microphone permission on the first press; without a model it offers to download one or, if you choose it, the Android system recognizer, which is labeled as possibly sending audio to Google or the phone maker (before, the system recognizer was always used and on Samsung went to the cloud). Windows records with WASAPI in the app itself (no WebView permission prompts) and gets Settings → Voice input with download, progress and delete; the installer now carries `sherpa-onnx-c-api.dll` and `onnxruntime.dll` from the sherpa-onnx v1.13.8 release, pinned by SHA-256 in `build.rs` and loaded on first use, so the app still starts without them. The browser version has no voice input: the model is too large for a web page.
- Android: the APK from GitHub releases updates itself. At launch, at most once a day, Dela reads `latest.json` of the latest release and shows "Version X is out" with an Update button, like the Windows app; the APK is downloaded only from the Dela releases on GitHub, checked against the SHA-256 in `latest.json` (or `SHA256SUMS.txt` for older releases) and handed to the system installer, which accepts it only with the same signing key. Settings → Updates has a "Check for updates at launch" switch and a button. The F-Droid build (`-PdelaFdroid`) leaves updates to F-Droid. Long notifications at the bottom of the screen now wrap instead of running off the edge.
- Dependencies: Tauri 2.12.4 and its plugins, the npm development tools.

## 1.0.1

- Windows: Ctrl+Shift+Space and "New task" in the tray open a small quick add bar on top of all programs, centered near the top of the screen with the mouse, instead of bringing up the whole Dela window. It parses the phrase, highlights dates, projects and labels and takes pasted lists like the usual quick add; Enter adds the task and hides the bar, so you are back in the program you were typing in; Esc, a click elsewhere or the shortcut again hide it. The task is saved to the local database and the main window, which keeps syncing while hidden in the tray, sends it to the server. With a PIN lock the bar shows that Dela is locked and offers to open the main window. A task opened in its own window now fills the window: no list behind it, no sheet handle, and closing the card closes the window; a task card in a project window also opens full-window.
- Android: "Show events from the phone calendars" works again. Ticking it did nothing because the web code returned the Capacitor plugin proxy from an async function, so `await` called the plugin's nonexistent `then()` and never finished; events also never loaded, since the plugin read the date range with `getDouble()`, which returns nothing for millisecond times. The "Download" buttons of on-device recognition were always disabled: the plugin dropped `downloading: null` from its status, and recognizing a shared file had the same proxy hang. Not related to R8: release builds are not minified.
- Quick add: the text no longer touches the edge of the field on a phone.

## 1.0.0

- Wear OS watch app (`apps/wear`, package `io.github.olerast67.dela.wear`, Wear OS 3 or newer): a standalone app that signs in to your Dela server by itself with email and password (and a TOTP code if it is on) as a separate device, revocable in Settings → Devices; it needs neither the phone nor Google services. It shows Today (overdue and due today), checks a task off (a repeating task moves to its next date, as in the app), syncs when opened and every 30 minutes, and shows reminders from its own exact alarms for the next two days, with a "Done" button in the notification. The "Dela: today" tile lists the first tasks. The watch runs the same core code as the other apps (`packages/core` and the dela-mcp client, built for the QuickJS engine) with libsodium for the cryptography; the keys and the task cache are kept in a file encrypted with a key from Android Keystore.
- dela-mcp comes with every release as `dela-mcp.tgz` and runs without npm: `npx -y https://github.com/olerast67/dela/releases/latest/download/dela-mcp.tgz login`.
- Calendar events in Today and in the calendar are styled again (a missing brace in the stylesheet left them plain in 0.9.0).
- docker-compose.yml passes `DELA_MAX_FILE_MB`, `DELA_CALENDAR_HOSTS` and the other new settings to the server.
- New screenshots, README and site.

## 0.9.0

- Tasks from a picture or a voice message on Android: share an image (a photo of a list, a screenshot) or an audio file (voice messages in ogg/opus, m4a, mp3, wav) to Dela, and the text is recognized on the phone and opens in quick add for editing; nothing is created until you confirm. Text in a picture is read by Tesseract (Russian and English, tessdata_fast) and opens one task per line in an editable text field; a voice message is transcribed by sherpa-onnx with the same streaming Zipformer models as Suflyor and becomes one phrase. Recognition runs in the background with a progress bar at the top of the screen and can be cancelled. The models are not in the APK: Settings → On-device recognition downloads them on request (text 8 MB, Russian speech 27 MB, English speech 70 MB) from pinned GitHub and Hugging Face URLs, checks every file by SHA-256 and deletes them with one button; without a model Dela says which one is needed, opens Settings, and recognizes the waiting file as soon as it is downloaded. The picture or recording is never sent anywhere. Speech recognition needs a 64-bit ARM phone; the APK now holds Tesseract for arm64-v8a and armeabi-v7a and sherpa-onnx for arm64-v8a, compressed (about 17 MB larger). A pasted or shared list can now also be edited as text before adding ("Edit").
- Attachments larger than 7 MB: a file is uploaded in 4 MiB parts, and each part is encrypted on the device on its own (XChaCha20-Poly1305, one random key per file). Each part is bound to the file, its number, the number of parts and the file size, so the server cannot reorder, swap, drop, cut or add parts without the download failing. Upload and download show a progress bar in the comment and can be cancelled; after a dropped connection, sending the same file again uploads only the missing parts. The server checks the per-file limit (`DELA_MAX_FILE_MB`, 100 MB by default) and the space quota before it accepts any data, and deletes uploads left unfinished for a day. Old attachments open as before; new files of any size use the new format, which older apps cannot open.
- dela-mcp, an MCP server for AI assistants (`packages/mcp`, `npx dela-mcp`): it runs on your computer, signs in to your Dela server as a new device (revocable in Settings → Devices) and gives Claude Desktop and other MCP clients the tools `search_tasks`, `list_projects`, `add_task` (quick-add phrases in English or Russian), `update_task`, `complete_task` (a repeating task moves to its next date) and `today`. Keys and the task cache stay on the computer in a file encrypted with a key held by Windows DPAPI, the macOS Keychain or the Linux Secret Service, or in a 600 file where there is none. It syncs before every call and pushes after a change with the apps' sync engine; shared projects work as in the app. There are no delete tools.
- Location reminders on Android: "Location" in the task card sets a place from your saved places or "Where I am now", a radius of 100, 200 or 500 m, on arrival or on leaving, and a place name; a named place can be saved to the list (Home, Work) for other tasks. The phone watches the zones with the system LocationManager, without Google Play services, in a foreground service with a quiet "Dela is watching your places" notification that has a "Turn off" button; the service runs only while there are open tasks with a place. Far from all zones it takes rare network fixes, near a zone border it uses GPS every 20 seconds. A reminder fires once per entry or exit (with a margin at the border, so GPS jitter does not repeat it) as a regular task notification, or as an alarm for an urgent task. Location access is asked when the first location reminder is set, with an explanation first; "Allow all the time" lets tracking resume after a reboot. There are no maps and no address search: coordinates stay on the phone and reach the server only inside the encrypted task. In the browser and the Windows program the place is shown in the card, with a note that it fires on an Android phone. Completed and deleted tasks stop being watched.
- Calendar events on top of tasks, read-only: Settings → Calendars subscribes to an iCal link (an `https://` or `webcal://` link to an `.ics` file, such as the secret iCal address of a Google calendar) with a name, a color and a show switch. Events of the day are listed at the top of Today with their time and calendar color; in the calendar they are muted blocks with a calendar icon in the grid, the "All day" row and the month, without a completion circle and without dragging. A click shows the time, place and description as plain text. Repeats (RRULE with EXDATE, RDATE and moved or cancelled occurrences), all-day and multi-day events, time zones by IANA name or from the file's VTIMEZONE, and daylight saving changes are handled by ical.js, which loads as a separate chunk only when there are subscriptions. The link is a secret: it is stored in an encrypted record of the personal space and syncs between your devices, while each device downloads the calendar itself, straight from the calendar server, every 30 minutes and with "Refresh calendars", and keeps a copy on the device until sign-out. In a browser a subscription works only if the calendar server allows requests from other sites (CORS), otherwise Settings says so and the subscription works in the Windows and Android apps, which download without this limit. On Android, "Show events from the phone calendars" asks for the calendar permission and reads the chosen calendars through CalendarContract, with repeats expanded by Android; these events stay on the phone and are never synced. Events are not counted in tasks, statistics, filters or search.

## 0.8.0

- Alarm for an urgent task on Android: the "Alarm" switch under Reminders in the task card makes the task's reminders ring as a full-screen alarm over the lock screen, with the task title and "Done", "Snooze for 10 minutes" and "Turn off". The sound plays through the alarm stream, so it rings in silent mode and with Do Not Disturb (which lets alarms through by default), with vibration; after 5 minutes without an answer it stops and leaves a "Missed alarm" notification. "Done" completes the task through the same queue as the widget, even when the app is closed. Alarms are exact (AlarmManager alarm clock, works in Doze) and are restored after a reboot. Permissions are asked when the alarm is first turned on; on Android 14+ without the full-screen permission the settings screen opens, and the alarm comes as a notification with sound. An urgent reminder rings once: no local notification is scheduled for it, and a push of the same reminder is not shown; if the task was added on another device while the app was closed, the push starts the alarm. The flag syncs to all devices; in the browser and the Windows program it is a regular reminder.
- Windows program: "Start when I sign in to Windows" in Settings starts Dela minimized to the tray, so reminders arrive without an open window. A project ("In a separate window" in the project header) or a task (the button next to the link in the task card) opens in its own compact window without the sidebar; opening the same project or task again brings its window to the front. Separate windows use the same local data as the main window: no second sign-in, and changes appear in all windows at once. With a PIN lock, each new window asks for the PIN.
- Habits: a repeating task can be marked as a habit in the task card ("Track the streak" next to the repeat; a task without a repeat becomes a daily habit). The row shows a flame with the current streak; the card shows the current and best streak, the last five weeks (done, skipped, allowed skip, missed) and a "Skip today" button. A streak counts scheduled occurrences done in a row, so a weekday habit goes from Friday to Monday; today's occurrence does not break it until the day ends in your time zone. A habit can allow up to 6 missed occurrences a week that neither break nor grow the streak; "Skip today" (for a sick day or a holiday) is not limited and also keeps the streak. Repeats "after completion" have no schedule, so the switch is offered only for scheduled repeats (if one is changed later, its streak counts days with a completion). Each skip is its own synced record per occurrence, so skips from two devices merge. Statistics lists habits with their streaks. The habit and its history move with the task into a shared project; templates and the JSON and Markdown export keep the habit mark.
- Pomodoro timer on a task: the Pomodoro button in the task card starts a 25-minute work timer, then offers a 5-minute break (both lengths in Settings, per device). One timer per device; starting it on another task saves the time worked on the previous one and switches. The time left is shown in the card and in a small timer at the bottom of the sidebar or above the tabs on a phone; a click opens the task, with pause, resume and stop. The timer keeps its end time, so it survives a reload or a closed app; the end notification is scheduled like reminders (an Android local notification even with the app closed; in the browser and the Windows program while Dela is open) and is removed on pause or stop. Time worked (not breaks) adds up in the task as "Time spent", can be edited or reset, and is shown in Statistics for today, this week and the chosen period. Each work interval is its own synced record, so time added on two devices at once is never lost.
- Statistics screen (sidebar, "More" on a phone, command palette, `#/stats`): tasks completed today and this week, the current and best day streak, bars per day for 4 weeks and per week for 12 weeks (Monday first), and completed tasks per project for 7, 30 or 90 days. Every completion of a repeating task counts. Tasks in the trash are not counted, as in "Completed". It is calculated on the device from existing data; nothing new is synced or sent to the server.
- Markdown in task descriptions and comments: headings, bold and italic, lists, links and bare URLs, code, quotes, tables and checklists. A checklist item in the description is checked with a click and saved with the task; in comments checklists are shown only. The description is shown formatted, a click on its text opens the editor. Raw HTML is shown as text, only http(s) and mailto links open, images from links are not loaded.
- Project and section descriptions: a Markdown note under the project title and under a section heading, added with the "Description" button in the project header or next to the section. A click on the text opens the editor, Esc or leaving the field saves it; an empty description takes no space. In a shared project the description syncs to members like the name; it is kept in the JSON and Markdown export, in project templates, and the project description is imported from Todoist.
- Subtasks in Today, Upcoming, filters and label views: a task with open subtasks gets the same expand arrow as in a project, and its subtasks are shown indented under it. A subtask that is itself in the list is shown under its parent instead of twice. Subtasks start collapsed in these lists, unless one of them is in the list too. A recurring task checked off today stays in Today as a checked row until the end of the day and counts in the progress ring; clicking its check returns the task to that occurrence, as long as its date has not been changed since.
- Links to a screen or a task: Ctrl+Shift+C (Cmd+Shift+C on a Mac), the link button in the task card or "Copy link" in the command palette copies a link like `https://your-server/#/task/<id>`. It holds only the server address and the id. The link opens the task in its project with the card open, after sign-in if needed. The Android app and the Windows program open `dela://open#/…` links; a browser on Android that opens a task link offers to open it in the app. Without a server the link opens only in the same browser.

## 0.7.0

- Calendar: a "3 days" mode; task color by priority or by project; an option to hide future repeats of recurring tasks; an "Unscheduled" side panel with overdue tasks and tasks without a date, which can be dragged onto a day, the all-day row or an hour of the grid. On a narrow screen the panel opens from a button. On a phone, tasks in the calendar and in the panel are dragged with a finger: hold a task, then move it to a day, the all-day row or an hour. Color, repeats and the panel are remembered per device.
- Grouping and sorting in lists: the "Order" button in Inbox, projects, labels, filters, Today and Upcoming groups tasks by date, priority, project or label and sorts them by date, priority or name. The choice is kept per screen on the device; subtasks stay under their parents. With another order on, dragging no longer reorders tasks, but a task dropped on a group heading takes that group's priority, date, project or label. Today can also be shown as a board with a column per priority; moving a card to another column changes its priority.
- Android: a reminder no longer shows twice on a phone with push on. The push and the local notification of the same reminder now share one notification.
- Repeat by buttons in the task card: frequency, "every N", days of the week, day of the month, end date and the after-completion mode. The text field stays; the buttons write the same repeat and a readable phrase in the interface language.
- Morning summary (Settings → Reminders): one notification a day at the chosen time with the number of tasks due today and overdue, for example "Today: 5 tasks, 2 overdue". Counted on the device, set per device, no notification on days without tasks; tapping it opens Today. Works in the app, through push and in the phone's local notifications.

## 0.6.0

- Reminders in the quick add phrase: "напомни за час и за 10 минут", "напомни в 9", "без напоминания", "remind me an hour before", "remind me at 9am", "no reminder". A reminder time on a task without a time gives the task that time.
- Select several tasks and act on all of them: complete, today, tomorrow, no date, priority, project, label, delete. Ctrl or Cmd click on a computer, a long press without dragging on a phone; while something is selected, a click adds or removes a task. One "Undo" reverts the whole action, Esc clears the selection.
- Settings → Start screen: Today, Inbox, Upcoming, Calendar, a project or a filter. A link to a specific screen still opens that screen.
- Quick add: paste a list and get a task per line. Markers like "-", "1." and "[ ]" are removed, checked "[x]" items are skipped, an indented line becomes a subtask. Each line is read as a phrase, with its own date, project and labels. A multi-line text shared to Dela on Android works the same way.
- Reminders on the phone for tasks added on another device while Dela on the phone is closed. Before, the phone's push schedule only had the tasks the phone had seen, so such a task stayed silent. Now any device of the account updates the phone's schedule; the text is encrypted with a key the server does not have. Phones with push already on switch to the new key at the next start.
- Dela Verify, a browser extension that checks the web app served by your server against the signed release on GitHub. The sign-in screen in a browser points to it and to the apps.
- Comments are signed by their authors. A comment whose signature does not match shows a warning instead of the author name.
- Two-factor sign-in can also be required for the recovery key (Settings → Two-factor sign-in). Off by default.
- English interface shows time in the 12-hour format (7:30 PM): lists, calendar, the Android widget.
- The Android widget and its settings follow the app language, not the phone language.
- The widget picker shows a preview with sample tasks (Android 12 and newer).
- Server: WebSocket through the `ws` library directly, `@hono/node-server` 2.x.
- Quick add: a repeating task with a time that has already passed today starts tomorrow, the same way a task without a repeat does. "every weekday at 10" typed at noon no longer lands overdue.

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
