# dela-mcp

An [MCP](https://modelcontextprotocol.io) server for [Dela](https://github.com/olerast67/dela), the self-hosted task manager with end-to-end encryption. It lets Claude Desktop and other MCP clients find, add, change and complete your tasks.

dela-mcp runs on your computer. It signs in to your own Dela server as a new device of your account, decrypts tasks locally and talks to the MCP client over stdio. The server still sees only ciphertext, and no service from the Dela author is involved. The assistant you connect does see the decrypted tasks it asks for, so connect only assistants you trust with them.

Requires Node.js 22.18 or newer. The package is not published to npm: each [release](https://github.com/olerast67/dela/releases/latest) has the ready archive `dela-mcp.tgz`, and `npx` runs it from the link, installing the dependencies from npm. The link `https://github.com/olerast67/dela/releases/latest/download/dela-mcp.tgz` always points to the latest release; to pin a version, use `https://github.com/olerast67/dela/releases/download/v<version>/dela-mcp.tgz`.

## Sign in

```sh
npx -y https://github.com/olerast67/dela/releases/latest/download/dela-mcp.tgz login
```

It asks for the server address, your email and password (typed without echo) and, if two-factor authentication is on, the code from your authenticator app. Passkeys are not supported here: use your password.

The computer appears in Dela under **Settings → Devices** as "Dela MCP · Windows · your-computer-name". Revoking it there cuts dela-mcp off at its next call, and it deletes its local session file. Signing in again on the same computer revokes the previous dela-mcp session first, so the device list keeps one entry.

```sh
npx -y https://github.com/olerast67/dela/releases/latest/download/dela-mcp.tgz status   # who is signed in and whether the server is reachable
npx -y https://github.com/olerast67/dela/releases/latest/download/dela-mcp.tgz logout   # revoke this device and delete the local session file
```

## Connect to Claude Desktop

Open Settings → Developer → Edit Config and add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dela": {
      "command": "npx",
      "args": ["-y", "https://github.com/olerast67/dela/releases/latest/download/dela-mcp.tgz"]
    }
  }
}
```

Restart Claude Desktop. Other MCP clients take the same command: `npx -y https://github.com/olerast67/dela/releases/latest/download/dela-mcp.tgz`.

## Tools

| Tool | What it does |
|---|---|
| `search_tasks` | Find tasks by text, project, label and due date (`today`, `overdue`, `week`, `no_date`), open, completed or all. Returns id, title, due, project, labels and priority |
| `list_projects` | Projects with the inbox and open task counts, shared projects with your role, and labels |
| `add_task` | Add a task from a quick-add phrase in English or Russian, parsed like in the app: `Call mom tomorrow 7pm #Home @phone p1`, `Купить хлеб завтра в 10 каждую неделю`. Fields (project by name, due, priority, labels, description, parent task) override the phrase |
| `update_task` | Change the title, description, due date (a phrase, `YYYY-MM-DD [HH:MM]` or `none`), priority, project or labels |
| `complete_task` | Mark a task done with its subtasks. A repeating task moves to its next date, as in the app |
| `today` | Tasks due today and overdue tasks |

Before every call dela-mcp pulls changes from the server, and after a change it pushes right away, with the same sync engine and merge rules as the apps. If the server is unreachable, reads come from the local cache and changes wait in a queue until the next call; the answer says so.

Shared projects are available when this account can see them; a project shared with you read-only cannot be changed. Labels are personal, so they are not set on tasks in shared projects.

**There are no delete tools.** An assistant can misread a request or act on text inside a task, and deleting is the one mistake that is hard to notice and undo. Delete tasks and projects in the Dela app. Moving a task between a personal and a shared project is the one case where Dela makes a copy and puts the original in the trash, as the app does; the answer gives the new id.

## Where the keys are kept

The session (server address, token of this device, account keys, keys of shared projects) and a cache of your tasks are stored in one file:

- Windows: `%APPDATA%\dela-mcp\session.json`
- macOS and Linux: `~/.config/dela-mcp/session.json` (or `$XDG_CONFIG_HOME/dela-mcp`)

The file is encrypted with AES-256-GCM. The key of that file is kept by the operating system when possible:

- **Windows:** DPAPI, tied to your Windows account. A copy of the file opens only under your Windows user on this computer (or your roaming profile).
- **macOS:** the login Keychain (`security` command).
- **Linux:** the Secret Service keyring through `secret-tool` (GNOME Keyring, KWallet), if it is installed and unlocked.
- **Otherwise** (no keyring, headless Linux, or `DELA_MCP_KEYSTORE=file`): a `key` file next to the session with permissions 600 in a 700 folder. Then the protection is only the file permissions: anyone who can read your home folder, or a backup of it, can read your tasks and use the session. `dela-mcp login` and `status` print which store is used.

dela-mcp uses no native modules: it calls the system tools and passes the key on stdin, not on the command line.

What this protects against: the session file copied off the computer, synced to a cloud folder or left in a backup. What it does not protect against: another program running under your account, which can ask the same keystore for the key, just as it could read the browser's storage. If the computer is lost, revoke the device in Dela under **Settings → Devices**.

Passwords are never stored or logged. Nothing but MCP messages is written to stdout; diagnostics go to stderr without keys or task contents.

## Development

The source is in the Dela repository under `packages/mcp`. Tests run with the rest of the project (`npm test` at the repository root). `npm pack` in `packages/mcp` builds `dist/cli.js`, one file with the Dela core inside. The release workflow sets the package version to the release version, packs it and attaches the archive as `dela-mcp.tgz`.

## License

AGPL-3.0-only, like Dela.
