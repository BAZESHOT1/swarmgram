/**
 * Выбор и загрузка изображения (фоны чатов/профиля).
 *
 * Механика как у аватаров: файл сжимается на устройстве, шифруется (ключ остаётся у клиента)
 * и загружается на узлы; Hub получает только objectId/key/mime.
 */
import { Platform } from 'react-native';
import { encryptFileBytes, fromB64, toB64, toB64u } from '../crypto/core';

export interface PickedImage {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export interface UploadedImage {
  objectId: string;
  key: string;
  mime: string;
  /** data-URI сжатого изображения: мгновенное превью до ответа Hub. */
  preview: string;
}

export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/** Выбор изображения: <input type=file> на web, expo-document-picker нативно. */
export async function pickImage(): Promise<PickedImage | null> {
  if (Platform.OS === 'web') {
    if (typeof document === 'undefined') return null;
    return new Promise<PickedImage | null>((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.style.position = 'fixed';
      input.style.left = '-9999px';
      input.style.opacity = '0';
      let settled = false;
      let focusTimer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (focusTimer) clearTimeout(focusTimer);
        window.removeEventListener('focus', onWindowFocus);
        input.remove();
      };
      const finish = (value: PickedImage | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const onWindowFocus = () => {
        focusTimer = setTimeout(() => {
          if (!input.files?.length) finish(null);
        }, 350);
      };
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return finish(null);
        try {
          finish({ name: file.name, mime: file.type || 'image/jpeg', bytes: new Uint8Array(await file.arrayBuffer()) });
        } catch {
          finish(null);
        }
      };
      input.oncancel = () => finish(null);
      document.body.appendChild(input);
      window.addEventListener('focus', onWindowFocus);
      input.click();
    });
  }
  const DocumentPicker = await import('expo-document-picker');
  const result = await DocumentPicker.getDocumentAsync({ type: 'image/*', copyToCacheDirectory: true });
  if (result.canceled || !result.assets?.length) return null;
  const asset = result.assets[0];
  const FileSystem = await import('expo-file-system');
  const b64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
  return { name: asset.name, mime: asset.mimeType ?? 'image/jpeg', bytes: fromB64(b64) };
}

type Stage = 'compress' | 'encrypt' | 'upload' | 'register';

/** Сжать (до maxDim по большей стороне), зашифровать и загрузить на узлы. */
export async function uploadImage(
  picked: PickedImage,
  opts: { maxDim?: number; signal?: AbortSignal; onStep?: (text: string) => void; onProgress?: (pct: number) => void } = {},
): Promise<UploadedImage> {
  if (!picked.mime.startsWith('image/')) throw new Error('Нужен файл изображения (JPEG, PNG, WebP).');
  if (picked.bytes.length > MAX_IMAGE_BYTES) throw new Error('Файл больше 12 МБ — выберите изображение поменьше.');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const uploader = require('./uploader') as {
    compressImage: (b: Uint8Array, m: string, o?: { maxDim?: number; signal?: AbortSignal }) => Promise<{ bytes: Uint8Array; mime?: string } | Uint8Array>;
    uploadBytesWithProgress: (
      b: Uint8Array,
      o?: { signal?: AbortSignal; onStage?: (s: Stage) => void; onProgress?: (p: number) => void },
    ) => Promise<{ objectId?: string; objectID?: string; id?: string }>;
  };
  opts.onStep?.('Сжатие…');
  let bytes = picked.bytes;
  let mime = picked.mime;
  const compressed = await uploader.compressImage(picked.bytes, picked.mime, { maxDim: opts.maxDim ?? 1600, signal: opts.signal });
  if (compressed instanceof Uint8Array) bytes = compressed;
  else if (compressed?.bytes) {
    bytes = compressed.bytes;
    mime = compressed.mime || picked.mime;
  }
  const preview = `data:${mime};base64,${toB64(bytes)}`;
  opts.onStep?.('Шифрование…');
  const encrypted = encryptFileBytes(bytes);
  const key = toB64u(encrypted.rawKey);
  opts.onStep?.('Загрузка на узлы…');
  const uploaded = await uploader.uploadBytesWithProgress(encrypted.bytes, {
    signal: opts.signal,
    onStage: (stage) => opts.onStep?.(stage === 'register' ? 'Регистрация объекта…' : 'Загрузка на узлы…'),
    onProgress: (v) => opts.onProgress?.(Math.max(0, Math.min(100, Math.round(v <= 1.0001 ? v * 100 : v)))),
  });
  const objectId = String(uploaded?.objectId ?? uploaded?.objectID ?? uploaded?.id ?? '');
  if (!objectId) throw new Error('Загрузчик не вернул objectId');
  return { objectId, key, mime, preview };
}
