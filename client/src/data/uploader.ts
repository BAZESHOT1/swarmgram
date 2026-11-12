/**
 * Клиентский upload-менеджер: сжатие изображений до шифрования и раскладка
 * байтов по репликам узлов с реальным прогрессом.
 *
 * Важно: сжатие выполняется ДО вызова encryptFileBytes в messaging.ts,
 * поэтому E2EE-контракт не меняется — узлы по-прежнему видят только шифротекст.
 */
import { Image as RNImage, Platform } from 'react-native';
import { ApiError } from './api';
import * as api from './api';
import { beginRequest, endRequest } from './loading';
import { fromB64, sha256Of, toB64 } from '../crypto/core';

export type UploadStage = 'compress' | 'encrypt' | 'upload' | 'register';

function replicaIsHttps(url: string | undefined): boolean {
  return typeof url === 'string' && url.toLowerCase().startsWith('https://');
}

export interface CompressResult {
  bytes: Uint8Array;
  mime: string;
  width?: number;
  height?: number;
  savedBytes: number;
  savedPct: number;
}

export interface CompressOptions {
  maxDim?: number;
  quality?: number;
  avatar?: boolean;
}

/* ------------------------------------------------------------------ сжатие */

/** GIF/видео/аудио и SVG не пережимаем: анимация/вектор могут потеряться. */
function shouldPassthrough(mime: string): boolean {
  const m = (mime || '').toLowerCase();
  if (!m.startsWith('image/')) return true;
  return m === 'image/gif' || m === 'image/svg+xml' || m === 'image/apng';
}

function passthrough(bytes: Uint8Array, mime: string): CompressResult {
  return { bytes, mime, savedBytes: 0, savedPct: 0 };
}

function resultOf(
  original: Uint8Array,
  next: Uint8Array,
  mime: string,
  width?: number,
  height?: number,
): CompressResult {
  // Если сжатие не дало выигрыша — честно возвращаем оригинал.
  if (next.length >= original.length) return passthrough(original, mime);
  const savedBytes = original.length - next.length;
  return {
    bytes: next,
    mime,
    width,
    height,
    savedBytes,
    savedPct: original.length > 0 ? Math.round((savedBytes / original.length) * 100) : 0,
  };
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== 'function') {
      resolve(null);
      return;
    }
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img as unknown as HTMLImageElement);
    img.onerror = () => reject(new Error('image_decode_failed'));
    img.src = url;
  });
}

/** Web: canvas → WebP (fallback JPEG). */
async function compressWeb(
  bytes: Uint8Array,
  mime: string,
  maxDim: number,
  quality: number,
): Promise<CompressResult | null> {
  try {
    if (typeof document === 'undefined' || typeof Blob === 'undefined') return null;
    const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
    let width = 0;
    let height = 0;
    let source: CanvasImageSource | null = null;
    let objectUrl: string | null = null;

    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(blob);
      width = bitmap.width;
      height = bitmap.height;
      source = bitmap;
    } else {
      objectUrl = URL.createObjectURL(blob);
      const img = await loadImageElement(objectUrl);
      width = img.naturalWidth || img.width;
      height = img.naturalHeight || img.height;
      source = img as unknown as CanvasImageSource;
    }
    if (!width || !height || !source) return null;

    const scale = Math.min(1, maxDim / Math.max(width, height));
    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, targetW, targetH);

    // Освобождаем bitmap/URL сразу после отрисовки.
    const closable = source as unknown as { close?: () => void };
    if (typeof closable.close === 'function') closable.close();
    if (objectUrl) URL.revokeObjectURL(objectUrl);

    let out = await canvasToBlob(canvas, 'image/webp', quality);
    let outMime = 'image/webp';
    // Не все браузеры умеют WebP: type вернётся png/jpeg — тогда пробуем JPEG явно.
    if (!out || (out.type && out.type !== 'image/webp')) {
      out = await canvasToBlob(canvas, 'image/jpeg', quality);
      outMime = 'image/jpeg';
    }
    if (!out) return null;
    const next = new Uint8Array(await out.arrayBuffer());
    return resultOf(bytes, next, out.type || outMime, targetW, targetH);
  } catch {
    return null;
  }
}

function extForMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'jpg';
}

/** Native: динамический import expo-image-manipulator, иначе — оригинал. */
async function compressNative(
  bytes: Uint8Array,
  mime: string,
  maxDim: number,
  quality: number,
): Promise<CompressResult | null> {
  let tempPath: string | null = null;
  try {
    const manipulator = (await import('expo-image-manipulator')) as unknown as {
      manipulateAsync: (
        uri: string,
        actions: { resize: { width: number } }[],
        opts: { compress: number; format: unknown },
      ) => Promise<{ uri: string; width: number; height: number }>;
      SaveFormat?: { WEBP?: unknown; JPEG?: unknown };
    };
    const fs = (await import('expo-file-system')) as unknown as {
      cacheDirectory?: string;
      EncodingType?: { Base64?: string };
      writeAsStringAsync: (uri: string, data: string, opts?: { encoding?: string }) => Promise<void>;
      readAsStringAsync: (uri: string, opts?: { encoding?: string }) => Promise<string>;
      deleteAsync: (uri: string, opts?: { idempotent?: boolean }) => Promise<void>;
    };
    if (!fs.cacheDirectory) return null;

    const encoding = fs.EncodingType?.Base64 ?? 'base64';
    tempPath = `${fs.cacheDirectory}sg-compress-${Date.now()}.${extForMime(mime)}`;
    await fs.writeAsStringAsync(tempPath, toB64(bytes), { encoding });

    // Не апскейлим маленькие изображения: ресайз только если реально больше maxDim.
    const size = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      RNImage.getSize(tempPath as string, (width, height) => resolve({ width, height }), reject);
    });
    const actions: { resize: { width: number } }[] = [];
    if (Math.max(size.width, size.height) > maxDim) {
      actions.push({ resize: { width: Math.round((size.width * maxDim) / Math.max(size.width, size.height)) } });
    }

    const format = manipulator.SaveFormat?.WEBP ?? 'webp';
    const res = await manipulator.manipulateAsync(tempPath, actions, { compress: quality, format });
    const outB64 = await fs.readAsStringAsync(res.uri, { encoding });
    const next = fromB64(outB64);
    await fs.deleteAsync(res.uri, { idempotent: true }).catch(() => undefined);
    return resultOf(bytes, next, 'image/webp', res.width, res.height);
  } catch {
    return null;
  } finally {
    if (tempPath) {
      try {
        const fs = (await import('expo-file-system')) as unknown as {
          deleteAsync: (uri: string, opts?: { idempotent?: boolean }) => Promise<void>;
        };
        await fs.deleteAsync(tempPath, { idempotent: true }).catch(() => undefined);
      } catch {
        /* временный файл не критичен */
      }
    }
  }
}

/**
 * Сжать изображение до шифрования. Никогда не бросает: при любой проблеме
 * возвращает исходные байты (важно для отправки медиа в офлайне/на старых webview).
 */
export async function compressImage(
  bytes: Uint8Array,
  mime: string,
  opts: CompressOptions = {},
): Promise<CompressResult> {
  if (!bytes.length || shouldPassthrough(mime)) return passthrough(bytes, mime);

  const avatar = Boolean(opts.avatar);
  const maxDim = opts.maxDim ?? (avatar ? 512 : 1920);
  const quality = opts.quality ?? (avatar ? 0.85 : 0.82);

  if (Platform.OS === 'web') {
    const res = await compressWeb(bytes, mime, maxDim, quality);
    return res ?? passthrough(bytes, mime);
  }
  const res = await compressNative(bytes, mime, maxDim, quality);
  return res ?? passthrough(bytes, mime);
}

/* -------------------------------------------------------------- загрузка */

export interface UploadProgressOptions {
  onStage?: (stage: UploadStage) => void;
  /** Общий прогресс 0..1 с весами этапов. */
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
}

export interface UploadedBytes {
  objectId: string;
  size: number;
  replicas: number;
}

function abortError(): Error {
  const err = new Error('upload_aborted');
  (err as Error & { name: string }).name = 'AbortError';
  return err;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** Прогресс PUT на web через XHR (fetch не отдаёт upload progress). */
function putViaXhr(
  url: string,
  ticket: string,
  bytes: Uint8Array,
  onPct: (frac: number) => void,
  signal?: AbortSignal,
): Promise<{ size: number; sha256: string } | null> {
  return new Promise((resolve) => {
    if (typeof XMLHttpRequest === 'undefined') {
      resolve(null);
      return;
    }
    const xhr = new XMLHttpRequest();
    let settled = false;
    beginRequest();
    const finish = (value: { size: number; sha256: string } | null) => {
      if (settled) return;
      settled = true;
      endRequest();
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => {
      try {
        xhr.abort();
      } catch {
        /* already aborted */
      }
      finish(null);
    };
    try {
      xhr.open('PUT', api.nodeUrl(url));
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      xhr.setRequestHeader('x-sg-ticket', ticket);
      if (xhr.upload) {
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable && event.total > 0) onPct(event.loaded / event.total);
        };
      }
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          finish(null);
          return;
        }
        try {
          const data = JSON.parse(xhr.responseText || '{}') as { size?: number; sha256?: string };
          finish({ size: data.size ?? bytes.length, sha256: data.sha256 ?? '' });
        } catch {
          finish({ size: bytes.length, sha256: '' });
        }
      };
      xhr.onerror = () => finish(null);
      xhr.ontimeout = () => finish(null);
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort);
      }
      xhr.send(new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' }));
    } catch {
      finish(null);
    }
  });
}

async function putFragmentWithProgress(
  replica: { url: string; ticket: string },
  bytes: Uint8Array,
  onPct: (frac: number) => void,
  signal?: AbortSignal,
): Promise<{ size: number; sha256: string } | null> {
  const web = Platform.OS === 'web';
  if (web) {
    const res = await putViaXhr(replica.url, replica.ticket, bytes, onPct, signal);
    if (res) return res;
    // Фолбэк (например, нет XHR): обычный fetch без прогресса.
    assertNotAborted(signal);
    onPct(1);
    return api.api.putFragment(replica.url, replica.ticket, bytes);
  }
  assertNotAborted(signal);
  const res = await api.api.putFragment(replica.url, replica.ticket, bytes);
  onPct(1);
  return res;
}

/**
 * Загрузить готовые байты (уже зашифрованные!) на реплики узлов.
 * Этапы/прогресс: upload 0.25–0.9, register 0.9–1.
 * Сжатие и шифрование выполняет вызывающая сторона (messaging.ts).
 */
export async function uploadBytesWithProgress(
  bytes: Uint8Array,
  opts: UploadProgressOptions = {},
): Promise<UploadedBytes> {
  const { onStage, onProgress, signal } = opts;
  const report = (p: number) => onProgress?.(Math.max(0, Math.min(1, p)));

  assertNotAborted(signal);
  onStage?.('upload');
  report(0.25);

  const sha256 = sha256Of(bytes);
  const init = await api.api.objectInit(bytes.length, sha256);
  assertNotAborted(signal);

  const replicas = init.replicas ?? [];
  const acks: { index: number; nodeId: string; size: number; sha256: string }[] = [];
  const count = Math.max(1, replicas.length);

  for (let i = 0; i < replicas.length; i += 1) {
    // iOS ATS / Android cleartext блокируют http://IP:909x — сразу идём через Hub,
    // не теряя десятки секунд на таймауты.
    if (Platform.OS !== 'web' && !replicaIsHttps(replicas[i]?.url)) {
      report(0.25 + 0.65 * ((i + 1) / count));
      continue;
    }
    assertNotAborted(signal);
    const replica = replicas[i];
    const res = await putFragmentWithProgress(
      replica,
      bytes,
      (frac) => report(0.25 + 0.65 * ((i + Math.max(0, Math.min(1, frac))) / count)),
      signal,
    );
    assertNotAborted(signal);
    if (res && (!res.sha256 || res.sha256 === sha256)) {
      acks.push({ index: replica.index, nodeId: replica.nodeId, size: res.size, sha256 });
    }
    report(0.25 + 0.65 * ((i + 1) / count));
  }

  if (!acks.length) {
    // Native (iOS ATS / Android cleartext) не может PUT-ить на http://IP:9090.
    // Hub умеет принять объект и разложить его на узлы сам.
    assertNotAborted(signal);
    report(0.7);
    const relayed = await api.api.uploadObjectRelay(bytes);
    assertNotAborted(signal);
    onStage?.('register');
    report(1);
    return {
      objectId: relayed.id,
      size: relayed.sizeBytes,
      replicas: relayed.replicas,
    };
  }

  assertNotAborted(signal);
  onStage?.('register');
  report(0.9);
  const committed = await api.api.objectCommit(init.id, acks);
  assertNotAborted(signal);
  report(1);
  return {
    objectId: committed.id,
    size: committed.sizeBytes,
    replicas: committed.replicas,
  };
}
