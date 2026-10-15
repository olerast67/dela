// Список файлов веб-клиента с хешами SHA-256 для расширения Dela Verify.
//   node scripts/web-manifest.mjs <папка dist> <версия> > web-manifest.json
// С переменной DELA_WEB_SIGNING_KEY (закрытый ключ Ed25519 в PEM) рядом пишется web-manifest.json.sig:
//   DELA_WEB_SIGNING_KEY="$(cat key.pem)" node scripts/web-manifest.mjs dist 0.6.0 --sign web-manifest.json
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const [dir, version, flag, out] = process.argv.slice(2);
if (!dir || !version) {
  console.error('usage: node scripts/web-manifest.mjs <dist> <version> [--sign <file>]');
  process.exit(2);
}

function files(root) {
  return readdirSync(root).flatMap((name) => {
    const p = join(root, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

const entries = files(dir)
  .map((p) => [relative(dir, p).split(sep).join('/'), `sha256-${createHash('sha256').update(readFileSync(p)).digest('base64')}`])
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const manifest = JSON.stringify({ v: 1, app: 'dela-web', version, files: Object.fromEntries(entries) }, null, 1) + '\n';

if (flag === '--sign') {
  const pem = process.env.DELA_WEB_SIGNING_KEY;
  if (!pem || !out) {
    console.error('--sign needs DELA_WEB_SIGNING_KEY and an output file');
    process.exit(2);
  }
  writeFileSync(out, manifest);
  writeFileSync(`${out}.sig`, sign(null, Buffer.from(manifest), createPrivateKey(pem)).toString('base64') + '\n');
} else {
  process.stdout.write(manifest);
}
