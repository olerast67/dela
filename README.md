# Dela

Open-source, self-hosted task manager with end-to-end encryption. Works offline on every device and syncs in about a second.

**Status:** early development, nothing to install yet. See [ROADMAP.md](ROADMAP.md).

- Local-first: every device keeps a full copy in SQLite, the UI never waits for the network.
- End-to-end encrypted: the server stores and orders ciphertext and cannot read tasks, field names or record ids.
- One container to self-host, SQLite by default.
- Quick add that understands English and Russian.

Architecture: [docs/architecture.md](docs/architecture.md).

## Development

Requires Node.js 22+.

```bash
npm install
npm run check
```

## License

[AGPL-3.0](LICENSE)
