import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { VERSION, createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { scheduleBackups } from './backup.ts';
import { join } from 'node:path';

const config = loadConfig();
if (config.dbPath !== ':memory:') mkdirSync(config.dataDir, { recursive: true });
const db = openDb(config.dbPath);
const { app, injectWebSocket } = createApp(db, config);
if (config.dbPath !== ':memory:' && config.backupKeep > 0) scheduleBackups(db, join(config.dataDir, 'backups'), config.backupKeep);

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`Dela server ${VERSION} listening on http://${info.address}:${info.port}`);
});
injectWebSocket(server);

function shutdown(): void {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
