# Dela

[Русский](README.ru.md)

Dela is an open-source task manager that runs in the browser and installs on your own server as one Docker container. Tasks are encrypted on the device with a key the server does not have, and they stay available offline.

## Status

Version 0.1.0, early development. The web app installs as a PWA on desktop and mobile. Native apps for Windows, macOS, Linux, Android and iOS do not exist yet; the plan is in [ROADMAP.md](ROADMAP.md).

The code is written by Claude from Anthropic on my instructions. Every step is covered by unit tests and end-to-end tests in Chromium, and GitHub Actions runs them on each commit.

## Features

- Quick add parses English and Russian. The line "call mom tomorrow at 7pm #Home every week p1" becomes a task with a due date, project, recurrence and priority. Recognized parts are highlighted, and each of them can be kept as plain text in the title with one click.
- Tasks live in projects, sections and subtasks. A task has labels, a priority, a due date with time and time zone, a start date, a deadline and a duration.
- Recurrence follows a schedule or counts from the completion date, for example "every 2nd tuesday of the month" or "every! 3 days".
- The Today and Upcoming views list tasks by day, and a project can be shown as a list or a board.
- Filters use Todoist syntax (`(today | overdue) & p1`, `#Work & !@waiting`), with Russian keywords as well.
- Reminders show up in the open app and through Web Push when the app is closed.
- A project can be shared with other users of the same server by email address.
- Import from Todoist works with an API token or an export file. Export writes JSON and Markdown.
- `Ctrl+K` opens the command palette. Keyboard shortcuts are bound to physical keys, so they also work in the Russian layout. Tasks can be dragged with the mouse, and `Ctrl+Z` undoes the last 100 actions.

## Installation

You need a server with Docker and a domain name. Service workers and Web Push require HTTPS, so Dela runs behind a reverse proxy.

```bash
curl -O https://raw.githubusercontent.com/olerast67/dela/main/docker-compose.yml
docker compose up -d
```

The container listens on port 8080 on `127.0.0.1`. A Caddy example that obtains the certificate itself:

```
tasks.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

The first registered user becomes the administrator. After that, registration is closed: the administrator creates an invite in Settings → Invites and sends the link. Set `DELA_OPEN_REGISTRATION=true` to allow registration without an invite.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DELA_PORT` | `8080` | Server port |
| `DELA_HOST` | `0.0.0.0` | Address the server listens on |
| `DELA_DATA_DIR` | `/data` in the image | Folder for the database and backups |
| `DELA_OPEN_REGISTRATION` | `false` | Registration without an invite |
| `DELA_BACKUP_KEEP` | `7` | Number of daily database snapshots to keep, `0` disables them |
| `DELA_SESSION_TTL_DAYS` | `180` | Device session lifetime in days |
| `DELA_MAX_CLOCK_DRIFT_MS` | `60000` | How far ahead of the server a device clock may run, in milliseconds |
| `DELA_VAPID_SUBJECT` | repository URL | Contact for push services, `mailto:` or `https:` |

## Updating

```bash
docker compose pull
docker compose up -d
```

Database migrations run at startup. Before a migration the server saves a copy of the database to `/data/dela.sqlite.before-vN-<time>.bak`.

## Backups

Once a day the server writes a database snapshot to `/data/backups/dela-YYYY-MM-DD.sqlite` and keeps the last seven. Tasks in a snapshot are encrypted and can be restored only with the owner's password or recovery key. A full plaintext export is available in the app under Settings → Export.

## Security

The password never leaves the device. Argon2id derives two keys from it on the device: one proves the login to the server, the other unlocks the account master key. Every change is encrypted with XChaCha20-Poly1305 using the space key (libsodium).

The server sees email addresses, the list of devices, members of shared projects, change times, the size of each change rounded to 64 bytes and the times when reminders are sent. Task text, dates, labels, project names, field names and record IDs are stored on the server only in encrypted form.

At registration the app shows a recovery key. If both the password and the recovery key are lost, the data cannot be decrypted.

Current limitations:

- In the browser, data is stored in IndexedDB in decrypted form. The account keys are encrypted with a WebCrypto key that cannot be extracted from the browser.
- A member removed from a shared project loses access to the server but keeps the project key received earlier. Key rotation after removal is planned.
- There is no two-factor login (TOTP) and no PIN lock for the app yet.

The protocol and key hierarchy are described in [docs/architecture.md](docs/architecture.md). Please report vulnerabilities through a private report on GitHub (Security → Report a vulnerability).

## Development

Requires Node.js 22.18 or newer.

```bash
npm install
npm run check        # type check and unit tests
npm run test:e2e     # build the web client and run Playwright scenarios in Chromium
npm run build:web
npm start            # server on http://localhost:8080 with the web client
```

| Folder | Contents |
|---|---|
| `packages/core` | Shared core: sync, encryption, task model, quick add parser, recurrence, filters |
| `apps/server` | Server on Node.js, Hono and the built-in SQLite |
| `apps/web` | Web client on React and Vite |
| `e2e` | Playwright end-to-end tests |

## License

[AGPL-3.0](LICENSE).
