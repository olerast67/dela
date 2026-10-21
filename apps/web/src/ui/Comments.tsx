/**
 * Комментарии к задаче и файлы. Файл шифруется на устройстве своим ключом и уходит на сервер
 * шифротекстом по частям; ключ файла лежит в записи комментария, которая зашифрована ключом пространства.
 */
import { useEffect, useRef, useState } from 'react';
import { ApiError, type Attachment, type Comment } from '#core';
import { controller } from '../controller.ts';
import { RASTER, downloadAttachment, newUpload, uploadAttachment, uploadErrorCode, type PendingUpload } from '../files.ts';
import { useDoc } from '../hooks.ts';
import { IconX } from './icons.tsx';
import { Markdown } from './Markdown.tsx';
import { LOCALE, tr } from '../i18n.ts';

/** Картинку больше 10 МиБ не расшифровываем для показа сами: только по нажатию. */
const PREVIEW_MAX = 10 * 1024 * 1024;

function sizeLabel(n: number): string {
  if (n < 1024) return tr('{n} Б', { n: n });
  if (n < 1024 * 1024) return tr('{n} КБ', { n: Math.round(n / 1024) });
  return tr('{n} МБ', { n: (n / 1024 / 1024).toFixed(1) });
}

/** Полоска прогресса загрузки или скачивания с кнопкой отмены. */
function FileProgress({ share, label, onCancel }: { share: number; label: string; onCancel: () => void }) {
  return (
    <div className="file-progress">
      <progress value={share} max={1} aria-label={label} />
      <span className="muted">{Math.round(share * 100)}%</span>
      <button type="button" className="small" onClick={onCancel}>
        {tr('Отмена')}
      </button>
    </div>
  );
}

function FileView({ spaceId, file }: { spaceId: string; file: Attachment }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  const image = RASTER.test(file.type);
  useEffect(() => {
    if (!image || file.size > PREVIEW_MAX) return;
    const ctrl = new AbortController();
    let made: string | null = null;
    downloadAttachment(spaceId, file, () => undefined, ctrl.signal)
      .then((b) => {
        made = URL.createObjectURL(b);
        if (!ctrl.signal.aborted) setUrl(made);
      })
      .catch(() => !ctrl.signal.aborted && setError(true));
    return () => {
      ctrl.abort();
      if (made) URL.revokeObjectURL(made);
    };
  }, [spaceId, file.id]);
  useEffect(() => () => abort.current?.abort(), []);
  const download = async () => {
    if (abort.current) return;
    const ctrl = new AbortController();
    abort.current = ctrl;
    setError(false);
    setProgress(0);
    try {
      const b = await downloadAttachment(spaceId, file, setProgress, ctrl.signal);
      const href = URL.createObjectURL(b);
      const a = document.createElement('a');
      a.href = href;
      a.download = file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(href), 60_000);
    } catch {
      if (!ctrl.signal.aborted) setError(true);
    } finally {
      abort.current = null;
      setProgress(null);
    }
  };
  return (
    <div className="comment-file">
      {image && url && <img src={url} alt={file.name} onClick={() => void download()} />}
      <button className="file-chip" onClick={() => void download()} title={tr('Скачать')}>
        {file.name} <span className="muted">· {sizeLabel(file.size)}</span>
      </button>
      {progress !== null && <FileProgress share={progress} label={tr('Скачивание файла')} onCancel={() => abort.current?.abort()} />}
      {error && <span className="error">{tr('Не удалось открыть файл')}</span>}
    </div>
  );
}

function CommentItem({ c, spaceId }: { c: Comment; spaceId: string }) {
  const doc = useDoc();
  const status = controller.commentStatus(spaceId, c);
  const mine = c.author !== null && c.author === controller.userId && status === 'ok';
  const name = mine ? tr('Вы') : c.author ? (controller.memberEmail(spaceId, c.author) ?? tr('Участник')) : tr('Участник');
  const who = status === 'bad' ? tr('Подпись не сходится') : name;
  return (
    <div className="comment">
      <div className="comment-head">
        <span className="avatar" aria-hidden="true">
          {who[0]!.toUpperCase()}
        </span>
        <b className={status === 'bad' ? 'comment-bad' : undefined} title={status === 'bad' ? tr('Комментарий изменён или написан не тем, кто указан автором.') : undefined}>
          {who}
        </b>
        {status === 'unsigned' && <span className="muted">{tr('без подписи')}</span>}
        {status === 'unknown' && <span className="muted">{tr('подпись не проверена')}</span>}
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
      {c.text && <Markdown className="comment-text" text={c.text} />}
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
  const [progress, setProgress] = useState<number | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  /** Начатая загрузка: повторная отправка того же файла докачивает недостающие части. */
  const pending = useRef<{ spaceId: string; up: PendingUpload } | null>(null);
  const abort = useRef<AbortController | null>(null);

  /** Брошенную загрузку убираем с сервера сразу, не дожидаясь суточной очистки. */
  const dropPending = () => {
    const p = pending.current;
    pending.current = null;
    if (p) void controller.api.deleteFile(p.spaceId, p.up.id).catch(() => undefined);
  };
  useEffect(() => () => abort.current?.abort(), []);

  const submit = async () => {
    if (!text.trim() && !file) return;
    setBusy(true);
    setMsg(null);
    try {
      let attachment: Attachment | null = null;
      if (file) {
        if (pending.current && (pending.current.up.file !== file || pending.current.spaceId !== spaceId)) dropPending();
        const p = (pending.current ??= { spaceId, up: newUpload(file) });
        const ctrl = new AbortController();
        abort.current = ctrl;
        setProgress(0);
        attachment = await uploadAttachment(spaceId, p.up, setProgress, ctrl.signal);
        pending.current = null;
      }
      doc.addComment(taskId, { text, author: controller.userId, file: attachment, sign: controller.commentSigner() });
      setText('');
      setFile(null);
      if (picker.current) picker.current.value = '';
    } catch (err) {
      const code = uploadErrorCode(err);
      if (code === 'cancelled') dropPending();
      else if (code === 'too_large') {
        pending.current = null;
        const max = err instanceof ApiError && typeof err.body.maxFileBytes === 'number' ? err.body.maxFileBytes : 0;
        setMsg(tr('Файл больше {n} МБ: такой предел на этом сервере.', { n: Math.floor(max / 1024 / 1024) }));
      } else if (code === 'space_full') {
        pending.current = null;
        setMsg(tr('В этом проекте кончилось место для файлов.'));
      } else if (code === 'user_full') {
        pending.current = null;
        setMsg(tr('Кончилось место для ваших файлов на этом сервере. Удалите старые вложения.'));
      } else if (code === 'offline') setMsg(tr('Файл не загрузился. Нужна связь с сервером. Отправьте ещё раз, и загрузка продолжится.'));
      else setMsg(tr('Файл не загрузился.'));
    } finally {
      abort.current = null;
      setProgress(null);
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
          <button type="button" disabled={busy} onClick={() => picker.current?.click()}>
            {file ? `${file.name} · ${sizeLabel(file.size)}` : tr('Прикрепить файл или снимок')}
          </button>
          <button type="button" className="primary" disabled={busy || (!text.trim() && !file)} onClick={() => void submit()}>
            {busy ? tr('Отправка...') : tr('Отправить')}
          </button>
        </div>
        {progress !== null && <FileProgress share={progress} label={tr('Загрузка файла')} onCancel={() => abort.current?.abort()} />}
        {msg && (
          <p className="error" role="alert">
            {msg}
          </p>
        )}
      </div>
    </section>
  );
}
