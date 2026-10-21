// Файл обновления для программы Windows и Android: latest.json прикладывается к каждому выпуску на GitHub.
// Запуск после `npm run desktop:build` с ключом подписи обновлений:
//   node scripts/latest-json.mjs > latest.json
// DELA_APK — путь к APK телефона: тогда в файл попадают его адрес и SHA-256 (поле android).
import { createHash } from 'node:crypto';
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
// Приложение на Android читает только поле android: адрес APK выпуска и его SHA-256.
const apkPath = process.env.DELA_APK;
const android = apkPath
  ? {
      url: `https://github.com/olerast67/dela/releases/download/v${version}/Dela-${version}-android.apk`,
      sha256: createHash('sha256').update(readFileSync(apkPath)).digest('hex'),
    }
  : undefined;
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
      ...(android ? { android } : {}),
    },
    null,
    2,
  ) + '\n',
);
