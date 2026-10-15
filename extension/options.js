// Dela Verify: список серверов Dela, страницы которых проверяет расширение.
const api = globalThis.browser ?? globalThis.chrome;
const ru = /^ru\b/i.test(navigator.language);
const t = {
  intro: ru
    ? 'Добавьте адрес своего сервера Dela. Когда вы открываете его в браузере, расширение сверяет файлы веб-версии с подписанным выпуском на GitHub и показывает значок: зелёный, если всё совпало, красный, если нет.'
    : 'Add the address of your Dela server. When you open it, the extension compares the web app files with the signed release on GitHub and shows a badge: green if they match, red if not.',
  add: ru ? 'Добавить' : 'Add',
  remove: ru ? 'Убрать' : 'Remove',
  denied: ru ? 'Без разрешения на этот адрес проверка не работает.' : 'The check needs permission for this address.',
  bad: ru ? 'Нужен адрес вида https://tasks.example.com' : 'Use an address like https://tasks.example.com',
};
document.getElementById('intro').textContent = t.intro;
document.getElementById('addButton').textContent = t.add;

async function servers() {
  return (await api.storage.local.get('servers')).servers ?? [];
}

async function render() {
  const list = document.getElementById('list');
  list.replaceChildren();
  for (const origin of await servers()) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = origin;
    const del = document.createElement('button');
    del.textContent = t.remove;
    del.onclick = async () => {
      await api.storage.local.set({ servers: (await servers()).filter((s) => s !== origin) });
      await api.permissions.remove({ origins: [`${origin}/*`] }).catch(() => undefined);
      void render();
    };
    li.append(name, del);
    list.append(li);
  }
}

document.getElementById('add').onsubmit = async (e) => {
  e.preventDefault();
  const msg = document.getElementById('msg');
  msg.textContent = '';
  let origin;
  try {
    const raw = document.getElementById('origin').value.trim();
    origin = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`).origin;
  } catch {
    msg.textContent = t.bad;
    return;
  }
  const granted = await api.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) {
    msg.textContent = t.denied;
    return;
  }
  const list = await servers();
  if (!list.includes(origin)) await api.storage.local.set({ servers: [...list, origin] });
  document.getElementById('origin').value = '';
  void render();
};

void render();
