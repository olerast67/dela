/**
 * Файлы в комментариях: загрузка и скачивание по частям с прогрессом и отменой.
 * Новые файлы любого размера пишутся в формате v2 (каждая часть шифруется отдельно),
 * старые (v1, одним шифротекстом) читаются как раньше.
 */
import {
  ApiError,
  DecryptError,
  FILE_PART_BYTES,
  NetworkError,
  filePartCount,
  fileSealedSize,
  newFileKey,
  openFile,
  openFilePart,
  sealFile,
  sealFilePart,
  uuidv7,
  type Attachment,
} from '#core';
import { controller } from './controller.ts';

/** SVG не показывается: в нём бывают скрипты и внешние ссылки. */
export const RASTER = /^image\/(png|jpeg|gif|webp|avif)$/;
/** Старый сервер принимает файл одним запросом до 7 МиБ шифротекста. */
const MAX_V1 = 7 * 1024 * 1024 - 1024;

/** Загрузка, которую можно продолжить: тот же файл, id и ключ. Ключ живёт только в памяти до записи комментария. */
export interface PendingUpload {
  readonly file: File;
  readonly id: string;
  readonly key: string;
}

export function newUpload(file: File): PendingUpload {
  return { file, id: uuidv7(), key: newFileKey() };
}

/** Повтор при обрыве связи или ошибке сервера: 3 попытки с паузой. Отказы 4xx не повторяются. */
async function retry<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    try {
      return await fn();
    } catch (err) {
      signal.throwIfAborted();
      const transient = err instanceof NetworkError || (err instanceof ApiError && err.status >= 500);
      if (!transient || attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
}

/**
 * Зашифровать и загрузить файл. В памяти одновременно одна часть (4 МиБ) открытым текстом и одна шифротекстом.
 * Повторный вызов с тем же PendingUpload докачивает только недостающие части.
 */
export async function uploadAttachment(spaceId: string, up: PendingUpload, onProgress: (share: number) => void, signal: AbortSignal): Promise<Attachment> {
  const { file, id, key } = up;
  const size = file.size;
  const parts = filePartCount(size);
  const api = controller.api;
  let have: number[];
  try {
    ({ have } = await retry(() => api.startUpload(spaceId, id, { size: fileSealedSize(size), parts }), signal));
  } catch (err) {
    // Старый сервер не знает загрузки по частям: небольшой файл уходит к нему по-старому.
    if (err instanceof ApiError && err.status === 404 && err.code === 'not_found' && size <= MAX_V1) {
      const sealed = sealFile(new Uint8Array(await file.arrayBuffer()), spaceId, id);
      await api.uploadFile(spaceId, id, sealed.blob);
      onProgress(1);
      return { id, name: file.name, size, type: file.type, key: sealed.key };
    }
    throw err;
  }
  const got = new Set(have);
  let done = got.size;
  onProgress(done / (parts + 1));
  for (let i = 0; i < parts; i++) {
    if (got.has(i)) continue;
    signal.throwIfAborted();
    const plain = new Uint8Array(await file.slice(i * FILE_PART_BYTES, Math.min(size, (i + 1) * FILE_PART_BYTES)).arrayBuffer());
    const sealed = sealFilePart(plain, key, spaceId, id, size, i);
    await retry(() => api.uploadPart(spaceId, id, i, sealed, signal), signal);
    onProgress(++done / (parts + 1));
  }
  await retry(() => api.completeUpload(spaceId, id), signal);
  onProgress(1);
  return { id, name: file.name, size, type: file.type, key, v: 2, parts };
}

/**
 * Скачать и расшифровать файл. Каждая часть сразу становится отдельным Blob, а итоговый Blob
 * только ссылается на них: большой файл не лежит в памяти JS в нескольких копиях.
 */
export async function downloadAttachment(spaceId: string, file: Attachment, onProgress: (share: number) => void, signal: AbortSignal): Promise<Blob> {
  // Тип файла задаёт автор комментария: показываем только растровые картинки, остальное как двоичный файл.
  const type = RASTER.test(file.type) ? file.type : 'application/octet-stream';
  const api = controller.api;
  if (file.v !== 2) {
    const blob = await retry(() => api.downloadFile(spaceId, file.id), signal);
    onProgress(1);
    return new Blob([openFile(blob, file.key, spaceId, file.id) as BlobPart], { type });
  }
  const parts = filePartCount(file.size);
  // Число частей следует из подписанного размера; несовпадение значит, что запись испорчена.
  if (file.parts !== parts) throw new DecryptError('part count mismatch');
  const blobs: Blob[] = [];
  for (let i = 0; i < parts; i++) {
    const sealed = await retry(() => api.downloadPart(spaceId, file.id, i, signal), signal);
    blobs.push(new Blob([openFilePart(sealed, file.key, spaceId, file.id, file.size, i) as BlobPart]));
    onProgress((i + 1) / parts);
  }
  return new Blob(blobs, { type });
}

/** Чем кончилась неудачная загрузка или скачивание. */
export function uploadErrorCode(err: unknown): 'cancelled' | 'too_large' | 'space_full' | 'user_full' | 'offline' | 'failed' {
  if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
  if (err instanceof NetworkError && err.cause instanceof DOMException && err.cause.name === 'AbortError') return 'cancelled';
  if (err instanceof ApiError && err.code === 'file_too_large') return 'too_large';
  if (err instanceof ApiError && err.code === 'space_full') return 'space_full';
  if (err instanceof ApiError && err.code === 'user_full') return 'user_full';
  if (err instanceof NetworkError) return 'offline';
  return 'failed';
}
