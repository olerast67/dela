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
const { app, injectWebSocket, pushTick, sweepUploads } = createApp(db, config);
// Брошенные загрузки файлов по частям удаляются через сутки; проверка раз в час.
sweepUploads();
setInterval(() => {
  try {
    sweepUploads();
  } catch (err) {
    console.error('upload sweep failed', err);
  }
}, 3600_000).unref();
let pushing = false;
setInterval(() => {
  if (pushing) return;
  pushing = true;
  pushTick()
    .catch((err) => console.error('push failed', err))
    .finally(() => (pushing = false));
}, 15_000).unref();
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
