# Подпись установщика для Windows

Без подписи кода Windows SmartScreen предупреждает при запуске установщика. Для открытых проектов подпись бесплатно даёт SignPath Foundation: сертификат выпускается на SignPath Foundation, установщик собирается в GitHub Actions из исходников тега, подписывается там же. Сборка и подпись описаны в `.github/workflows/release-windows.yml`.

## Что сделать автору

1. Подать заявку на https://signpath.org/apply с аккаунта GitHub, которому принадлежит репозиторий. Текст для формы ниже.
2. После одобрения SignPath создаёт организацию и проект. Проект назвать `dela`, политику подписи `release-signing`, источник артефактов GitHub Actions этого репозитория.
3. Добавить секреты репозитория (Settings → Secrets and variables → Actions):
   - `SIGNPATH_API_TOKEN` и `SIGNPATH_ORGANIZATION_ID` из кабинета SignPath;
   - `TAURI_SIGNING_PRIVATE_KEY`: содержимое `~/dev/keys/dela-updater.key`;
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: содержимое `~/dev/keys/dela-updater.password`.

   Команды для терминала, ключ не попадает в историю команд и в чат:

   ```bash
   gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/dev/keys/dela-updater.key
   gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD < ~/dev/keys/dela-updater.password
   ```

4. Выпуск: после `gh release create` запустить Actions → Windows release с тегом. Workflow соберёт установщик, отправит его в SignPath, дождётся подписи, заново подпишет файл обновления и приложит к выпуску установщик, `latest.json` и контрольные суммы.

До одобрения заявки workflow собирает неподписанный установщик. Выпуск по `RELEASING.md` работает как раньше.

## Текст заявки

Project name: Dela

Repository: https://github.com/olerast67/dela

License: AGPL-3.0

Description: Dela is an open-source task manager with end-to-end encryption that people run on their own server. The Windows app (Tauri 2) keeps a full encrypted copy of the tasks, works offline and syncs through the user's server. Releases are built from tagged commits in GitHub Actions; the installer is an NSIS package produced by `tauri build`.

What will be signed: `Dela_<version>_x64-setup.exe` from `.github/workflows/release-windows.yml`, built from the tagged source with no binaries added outside the build.

Maintainer: olerast67 (https://olerast.com)
