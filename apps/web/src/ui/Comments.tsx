/**
 * Комментарии к задаче и файлы. Файл шифруется на устройстве своим ключом и уходит на сервер
 * шифротекстом; ключ файла лежит в записи комментария, которая зашифрована ключом пространства.
 */
import { useEffect, useRef, useState } from 'react';
import { extractLinks, openFile, sealFile, uuidv7, type Attachment, type Comment } from '#core';
import { controller } from '../controller.ts';
import { useDoc } from '../hooks.ts';
import { openExternal } from '../platform.ts';
import { IconX } from './icons.tsx';
import { LOCALE, tr } from '../i18n.ts';

/** Шифротекст файла не больше 7 МиБ: столько принимает сервер. */
const MAX_FILE = 7 * 1024 * 1024 - 1024;
/** SVG не показывается: в нём бывают скрипты и внешние ссылки. */
const RASTER = /^image\/(png|jpeg|gif|webp|avif)$/;

function sizeLabel(n: number): string {
  if (n < 1024) return tr('{n} Б', { n: n });
  if (n < 1024 * 1024) return tr('{n} КБ', { n: Math.round(n / 1024) });
  return tr('{n} МБ', { n: (n / 1024 / 1024).toFixed(1) });
}

async function decrypt(spaceId: string, file: Attachment): Promise<Blob> {
  const blob = await controller.api.downloadFile(spaceId, file.id);
  // Тип файла задаёт автор комментария: показываем только растровые картинки, остальное как двоичный файл.
  return new Blob([openFile(blob, file.key, spaceId, file.id) as BlobPart], { type: RASTER.test(file.type) ? file.type : 'application/octet-stream' });
}

function FileView({ spaceId, file }: { spaceId: string; file: Attachment }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const image = RASTER.test(file.type);
  useEffect(() => {
    if (!image) return;
    let alive = true;
    let made: string | null = null;
    decrypt(spaceId, file)
      .then((b) => {
        made = URL.createObjectURL(b);
        if (alive) setUrl(made);
      })
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [spaceId, file.id]);
  const download = async () => {
    try {
      const b = await decrypt(spaceId, file);
      const href = URL.createObjectURL(b);
      const a = document.createElement('a');
      a.href = href;
      a.download = file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } catch {
      setError(true);
    }
  };
  return (
    <div className="comment-file">
      {image && url && <img src={url} alt={file.name} onClick={() => void download()} />}
      <button className="file-chip" onClick={() => void download()} title={tr('Скачать')}>
        {file.name} <span className="muted">· {sizeLabel(file.size)}</span>
      </button>
      {error && <span className="error">{tr('Не удалось открыть файл')}</span>}
    </div>
  );
}

function CommentItem({ c, spaceId }: { c: Comment; spaceId: string }) {
  const doc = useDoc();
  const mine = c.author !== null && c.author === controller.userId;
  const status = controller.commentStatus(spaceId, c);
  const name = mine ? tr('Вы') : c.author ? (controller.memberEmail(spaceId, c.author) ?? tr('Участник')) : tr('Участник');
  const who = status === 'bad' ? tr('Подпись не сходится') : name;
  const links = extractLinks(c.text);
  return (
    <div className="comment">
      <div className="comment-head">
        <span className="avatar" aria-hidden="true">
          {who[0]!.toUpperCase()}
        </span>
        <b className={status === 'bad' ? 'comment-bad' : undefined} title={status === 'bad' ? tr('Комментарий изменён или написан не тем, кто указан автором.') : undefined}>
          {who}
        </b>
        {status === 'unsigned' && !mine && c.author && <span className="muted">{tr('без подписи')}</span>}
        <span className="muted">{new Date(c.createdAt).toLocaleString(LOCALE, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
        {mine && (
          <button
            className="icon small comment-del"
            aria-label={tr('Удалить комментарий')}
            onClick={() => {
              if (!confirm(tr('Удалить комментарий? Отменить это нельзя.'))) return;
              const file = doc.deleteComment(c.id);
              if (file) void controller.api.deleteFile(spaceId, file.id).catch(() => undefined);
            }}
          >
            <IconX width={14} height={14} />
          </button>
        )}
      </div>
      {c.text && <div className="comment-text">{c.text}</div>}
      {links.length > 0 && (
        <div className="links">
          {links.map((url) => (
            <a
              key={url}
              href={url}
              onClick={(e) => {
                e.preventDefault();
                void openExternal(url);
              }}
            >
              {url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
            </a>
          ))}
        </div>
      )}
      {c.file && <FileView spaceId={spaceId} file={c.file} />}
    </div>
  );
}

export function Comments({ taskId }: { taskId: string }) {
  const doc = useDoc();
  const spaceId = doc.spaceOfTask(taskId);
  const list = doc.comments(taskId);
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const submit = async () => {
    if (!text.trim() && !file) return;
    setBusy(true);
    setMsg(null);
    try {
      let attachment: Attachment | null = null;
      if (file) {
        if (file.size > MAX_FILE) {
          setMsg(tr('Файл больше 7 МБ. Такие файлы пока не помещаются.'));
          return;
        }
        const id = uuidv7();
        const sealed = sealFile(new Uint8Array(await file.arrayBuffer()), spaceId, id);
        await controller.api.uploadFile(spaceId, id, sealed.blob);
        attachment = { id, name: file.name, size: file.size, type: file.type, key: sealed.key };
      }
      doc.addComment(taskId, { text, author: controller.userId, file: attachment, sign: controller.commentSigner() });
      setText('');
      setFile(null);
      if (picker.current) picker.current.value = '';
    } catch {
      setMsg(tr('Файл не загрузился. Нужна связь с сервером.'));
    } finally {
      setBusy(false);
    }
  };

  // Снимок экрана из буфера (Ctrl+V) или файл, брошенный на поле, прикрепляются так же, как через кнопку.
  const take = (f: File | undefined) => {
    if (!f) return false;
    const pasted = f.name === '' || /^image\.\w+$/.test(f.name);
    const stamp = new Date().toLocaleString('sv-SE').replace(/:/g, '-').slice(0, 16);
    setFile(pasted ? new File([f], tr('Снимок {stamp}.{n}', { stamp: stamp, n: f.type.split('/')[1] || 'png' }), { type: f.type }) : f);
    setMsg(null);
    return true;
  };

  return (
    <section className="comments">
      <h3>{tr('Комментарии')}{list.length ? ` · ${list.length}` : ''}</h3>
      {list.map((c) => (
        <CommentItem key={c.id} c={c} spaceId={spaceId} />
      ))}
      <div
        className="comment-new"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) e.preventDefault();
        }}
        onDrop={(e) => {
          if (take(e.dataTransfer.files[0])) e.preventDefault();
        }}
      >
        <textarea
          rows={2}
          placeholder={tr('Комментарий')}
          aria-label={tr('Новый комментарий')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            if (take(e.clipboardData.files[0])) e.preventDefault();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="row">
          <input ref={picker} type="file" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label={tr('Файл')} />
          <button type="button" onClick={() => picker.current?.click()}>
            {file ? `${file.name} · ${sizeLabel(file.size)}` : tr('Прикрепить файл или снимок')}
          </button>
          <button type="button" className="primary" disabled={busy || (!text.trim() && !file)} onClick={() => void submit()}>
            {busy ? tr('Отправка...') : tr('Отправить')}
          </button>
        </div>
        {msg && (
          <p className="error" role="alert">
            {msg}
          </p>
        )}
      </div>
    </section>
  );
}
