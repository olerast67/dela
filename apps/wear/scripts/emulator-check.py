#!/usr/bin/env python3
"""
Проверка часов в эмуляторе Wear OS (.github/workflows/wear-emulator.yml).
Сервер Dela уже запущен на компьютере (из эмулятора он 10.0.2.2), эмулятор загружен, adb подключён.
Шаги: аккаунт и задачи (dev-seed), установка отладочной сборки, вход, «Сегодня», отметка задачи,
проверка на сервере, будильник напоминания, плитка, уведомление напоминания. Снимки и логи — в OUT.
Любая неудача — код выхода 1.
"""
import json
import os
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

PKG = 'io.github.olerast67.dela.wear.debug'
ACTIVITY = f'{PKG}/io.github.olerast67.dela.wear.MainActivity'
TILE = f'{PKG}/io.github.olerast67.dela.wear.TodayTileService'
APK = os.environ.get('APK', 'apps/wear/app/build/outputs/apk/debug/app-debug.apk')
OUT = os.environ.get('OUT', 'emulator-out')
HOST_SERVER = os.environ.get('HOST_SERVER', 'http://127.0.0.1:8795')
WATCH_SERVER = os.environ.get('WATCH_SERVER', 'http://10.0.2.2:8795')
EMAIL = os.environ.get('EMAIL', 'watch@example.com')
# Без пробелов и кириллицы: значение проходит через оболочку на устройстве.
PASSWORD = os.environ.get('PASSWORD', 'watch-pass-123')
# Напоминание у задачи «Созвон с командой» через столько минут после засева.
REMINDER_MIN = int(os.environ.get('REMINDER_MIN', '5'))

DONE_TITLE = 'Позвонить маме'
EXPECTED = ['Оплатить интернет', 'Позвонить маме', 'Полить цветы', 'Созвон с командой']
NOT_TODAY = 'Через неделю'

os.makedirs(OUT, exist_ok=True)
failures: list[str] = []


def log(msg: str) -> None:
    print(f'[{time.strftime("%H:%M:%S")}] {msg}', flush=True)


def adb(*args: str, check: bool = True, timeout: int = 120) -> str:
    r = subprocess.run(['adb', *args], capture_output=True, timeout=timeout)
    out = r.stdout.decode('utf-8', 'replace')
    if check and r.returncode != 0:
        raise RuntimeError(f'adb {" ".join(args)}: {r.returncode} {out} {r.stderr.decode("utf-8", "replace")}')
    return out


def shell(cmd: str, check: bool = True) -> str:
    return adb('shell', cmd, check=check)


def seed(mode: str) -> dict:
    args = ['node', 'apps/wear/scripts/dev-seed.ts', mode, HOST_SERVER, EMAIL, PASSWORD]
    if mode == 'seed':
        args.append(str(REMINDER_MIN))
    r = subprocess.run(args, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise RuntimeError(f'dev-seed {mode}: {r.stdout} {r.stderr}')
    return json.loads(r.stdout[r.stdout.index('{'):])


def screenshot(name: str) -> None:
    with open(os.path.join(OUT, name), 'wb') as f:
        f.write(subprocess.run(['adb', 'exec-out', 'screencap', '-p'], capture_output=True, timeout=60).stdout)
    log(f'снимок {name}')


def screen_size() -> tuple[int, int]:
    m = re.findall(r'(\d+)x(\d+)', shell('wm size'))
    w, h = m[-1]
    return int(w), int(h)


class Node:
    def __init__(self, e: ET.Element):
        self.text = e.get('text') or e.get('content-desc') or ''
        self.checked = e.get('checked') == 'true'
        x1, y1, x2, y2 = map(int, re.findall(r'\d+', e.get('bounds', '[0,0][0,0]')))
        self.cx, self.cy = (x1 + x2) // 2, (y1 + y2) // 2


def dump() -> list[Node]:
    """Дерево экрана через UI Automator. Пока крутится индикатор, «idle» не наступает — повторяем."""
    out = ''
    for _ in range(10):
        out = shell('uiautomator dump /sdcard/ui.xml', check=False)
        if 'dumped to' in out:
            xml = adb('exec-out', 'cat', '/sdcard/ui.xml')
            try:
                return [Node(e) for e in ET.fromstring(xml).iter('node')]
            except ET.ParseError as e:
                out = f'{e}: {xml[:300]}'
        time.sleep(1)
    log(f'uiautomator dump не удался: {out.strip()}')
    return []


def texts(nodes: list[Node]) -> list[str]:
    return [n.text for n in nodes if n.text]


def find(nodes: list[Node], text: str, exact: bool = False) -> Node | None:
    for n in nodes:
        if (n.text == text) if exact else (text in n.text):
            return n
    return None


def swipe(up: bool) -> None:
    w, h = screen_size()
    a, b = int(h * 0.7), int(h * 0.3)
    if not up:
        a, b = b, a
    shell(f'input swipe {w // 2} {a} {w // 2} {b} 300')
    time.sleep(0.8)


def to_top() -> None:
    for _ in range(4):
        swipe(up=False)


def scan() -> list[str]:
    """Все подписи списка сверху донизу."""
    to_top()
    seen: list[str] = []
    last = None
    for _ in range(10):
        t = texts(dump())
        for s in t:
            if s not in seen:
                seen.append(s)
        if t == last:
            break
        last = t
        swipe(up=True)
    return seen


def scroll_to(text: str, exact: bool = False) -> Node | None:
    """Прокрутить список, пока подпись не окажется в середине круглого экрана."""
    to_top()
    _, h = screen_size()
    for _ in range(10):
        n = find(dump(), text, exact)
        if n and h * 0.25 < n.cy < h * 0.75:
            return n
        if n and n.cy <= h * 0.25:
            swipe(up=False)
            n = find(dump(), text, exact)
            return n
        swipe(up=True)
    return None


def wait_for(text: str | list[str], timeout: int, exact: bool = False) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        nodes = dump()
        if any(find(nodes, t, exact) for t in ([text] if isinstance(text, str) else text)):
            return True
        time.sleep(2)
    log(f'не дождались {text}; на экране: {texts(nodes)}')
    return False


def check(ok: bool, what: str) -> bool:
    log(('OK   ' if ok else 'FAIL ') + what)
    if not ok:
        failures.append(what)
    return ok


def main() -> None:
    log(f'Wear OS {shell("getprop ro.build.version.release").strip()}, API {shell("getprop ro.build.version.sdk").strip()}, '
        f'экран {screen_size()}, пояс {shell("getprop persist.sys.timezone").strip()}')
    shell('svc power stayon true', check=False)
    shell('settings put system screen_off_timeout 1800000', check=False)
    shell('input keyevent KEYCODE_WAKEUP', check=False)
    # Эмулятор «заряжается», и системный экран зарядки закрывает приложение: отключаем питание.
    shell('dumpsys battery unplug', check=False)
    shell('dumpsys battery set status 3', check=False)
    time.sleep(2)
    if 'ChargingActivity' in shell('dumpsys window | grep mCurrentFocus', check=False):
        shell('input keyevent KEYCODE_BACK', check=False)

    seeded = seed('seed')
    log(f'засеяно: {[t["title"] for t in seeded["tasks"]]} на {seeded["date"]} ({seeded["tz"]})')

    adb('install', '-r', '-g', APK, timeout=300)
    adb('logcat', '-c', check=False)
    adb('logcat', '-b', 'crash', '-c', check=False)

    # Вход: форма заполняется из extras (только отладочная сборка), кнопку нажимаем как пользователь.
    shell(f'am start -W -n {ACTIVITY} --es dela.server {WATCH_SERVER} --es dela.email {EMAIL} --es dela.password {PASSWORD}')
    if not check(wait_for('Sign in to Dela', 60), 'экран входа открылся'):
        return
    screenshot('01-sign-in.png')
    button = scroll_to('Sign in', exact=True)
    if not check(button is not None, 'кнопка входа найдена'):
        return
    screenshot('02-sign-in-filled.png')
    shell(f'input tap {button.cx} {button.cy}')

    # Вход с Argon2id идёт несколько секунд, потом синхронизация.
    if not check(wait_for(['Today', 'Overdue'], 120, exact=True), 'после входа открылся список «Сегодня»'):
        screenshot('03-after-sign-in.png')
        return
    time.sleep(3)
    to_top()
    screenshot('03-today.png')

    listed = scan()
    log(f'на экране: {listed}')
    for title in EXPECTED:
        check(any(title in s for s in listed), f'в списке есть «{title}»')
    check(not any(NOT_TODAY in s for s in listed), f'задачи «{NOT_TODAY}» в списке нет')

    # Будильник напоминания ставится сразу после первого снимка.
    alarms = shell('dumpsys alarm')
    mine = [l for l in alarms.splitlines() if PKG in l or 'dela.wear.REMINDER' in l]
    with open(os.path.join(OUT, 'alarms.txt'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(mine))
    check(any('io.github.olerast67.dela.wear.REMINDER' in l for l in mine), 'будильник напоминания стоит (dumpsys alarm)')

    # Отметка «выполнено» нажатием на задачу.
    task = scroll_to(DONE_TITLE)
    if check(task is not None, f'«{DONE_TITLE}» видна для нажатия'):
        screenshot('04-before-complete.png')
        shell(f'input tap {task.cx} {task.cy}')
        time.sleep(1)
        screenshot('05-completing.png')
        end = time.time() + 60
        gone = False
        while time.time() < end and not gone:
            time.sleep(3)
            gone = not any(DONE_TITLE in s for s in scan())
        check(gone, f'«{DONE_TITLE}» ушла из списка после нажатия')
        to_top()
        screenshot('06-after-complete.png')

        status = seed('status')
        with open(os.path.join(OUT, 'server-status.json'), 'w', encoding='utf-8') as f:
            json.dump(status, f, ensure_ascii=False, indent=2)
        done = [t for t in status['tasks'] if t['title'] == DONE_TITLE]
        check(bool(done) and done[0]['completed'], f'на сервере «{DONE_TITLE}» выполнена')
        check(any('Wear OS' in d for d in status['devices']), 'часы видны в списке устройств аккаунта')

    # Плитка: отладочные команды Wear OS добавляют её в карусель и показывают (имена операций разные по версиям).
    shell('input keyevent KEYCODE_HOME', check=False)
    time.sleep(2)
    for op in ('add-tile', 'set-tile'):
        shell(f'am broadcast -a com.google.android.wearable.app.DEBUG_SURFACE --es operation {op} --ecn component {TILE} --ei index 0', check=False)
    time.sleep(2)
    for action in ('DEBUG_SYSUI', 'DEBUG_SURFACE'):
        shell(f'am broadcast -a com.google.android.wearable.app.{action} --es operation show-tile --ei index 0', check=False)
    time.sleep(5)
    screenshot('07-tile.png')
    tile = texts(dump())
    log(f'на плитке: {tile}')
    with open(os.path.join(OUT, 'tile.txt'), 'w', encoding='utf-8') as f:
        f.write('
'.join(tile))
    focus = shell('dumpsys window | grep mCurrentFocus', check=False)
    # Плитка не обязательна для успеха: отладочные команды есть не во всех образах.
    tile_ok = PKG not in focus and any('Оплатить интернет' in t for t in tile)
    log(('OK   ' if tile_ok else 'WARN ') + f'плитка показана ({focus.strip()})')
    shell(f'am start -n {ACTIVITY}', check=False)

    # Напоминание срабатывает в своё время: уведомление от приложения.
    deadline = time.time() + (REMINDER_MIN + 3) * 60
    posted = False
    while time.time() < deadline and not posted:
        notes = shell('dumpsys notification --noredact')
        posted = f'pkg={PKG}' in notes and 'Созвон с командой' in notes
        if not posted:
            time.sleep(10)
    with open(os.path.join(OUT, 'notifications.txt'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(l for l in shell('dumpsys notification --noredact').splitlines() if PKG in l or 'android.title' in l))
    check(posted, 'напоминание «Созвон с командой» пришло уведомлением')
    time.sleep(2)
    screenshot('08-reminder.png')


try:
    main()
except Exception as e:  # noqa: BLE001
    log(f'FAIL исключение: {e}')
    failures.append(str(e))
    try:
        screenshot('99-error.png')
    except Exception:  # noqa: BLE001
        pass
finally:
    try:
        screenshot('zz-last.png')
        log(f'последний экран: {texts(dump())}')
        log(f'окно: {shell("dumpsys window | grep -E mCurrentFocus", check=False).strip()}')
    except Exception:  # noqa: BLE001
        pass
    with open(os.path.join(OUT, 'logcat.txt'), 'w', encoding='utf-8') as f:
        f.write(adb('logcat', '-d', '-v', 'threadtime', check=False))
    crash = adb('logcat', '-b', 'crash', '-d', check=False)
    with open(os.path.join(OUT, 'crash.txt'), 'w', encoding='utf-8') as f:
        f.write(crash)
    if crash.strip():
        log('FAIL в буфере crash есть записи:\n' + crash)
        failures.append('crash')

if failures:
    log(f'не прошло: {failures}')
    sys.exit(1)
log('всё прошло')
