// Файл обновления для программы Windows: latest.json прикладывается к каждому выпуску на GitHub.
// Запуск после `npm run desktop:build` с ключом подписи обновлений:
//   node scripts/latest-json.mjs > latest.json
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const conf = JSON.parse(readFileSync('apps/desktop/src-tauri/tauri.conf.json', 'utf8'));
const version = conf.version;
const target = process.env.CARGO_TARGET_DIR ?? join(homedir(), 'dev', 'cargo-target', 'dela');
// В workflow выпуска установщик и подпись лежат в папке скачанных артефактов.
const bundle = process.env.DELA_BUNDLE_DIR ?? join(target, 'release', 'bundle', 'nsis');
const exe = `Dela_${version}_x64-setup.exe`;
const signature = readFileSync(join(bundle, `${exe}.sig`), 'utf8').trim();
const notes = readFileSync('CHANGELOG.md', 'utf8').split(`## ${version}`)[1]?.split('\n## ')[0]?.trim() ?? '';
process.stdout.write(
  JSON.stringify(
    {
      version,
      notes,
      pub_date: new Date().toISOString(),
      platforms: {
        'windows-x86_64': { signature, url: `https://github.com/olerast67/dela/releases/download/v${version}/${exe}` },
      },
    },
    null,
    2,
  ) + '\n',
);
