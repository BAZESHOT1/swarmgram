/**
 * Блок аватара группы/канала: превью, загрузка/смена и удаление.
 *
 * Механика повторяет аватар профиля: файл сжимается на устройстве, шифруется
 * (ключ остаётся у клиента) и загружается на узлы; Hub получает только
 * objectId/key/mime. Показывается лишь при наличии права set_avatar
 * (владелец — всегда, admin/moderator — по матрице прав).
 */
import React from 'react';
import { ActivityIndicator, Image, Platform, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/useTheme';
import { Avatar } from '../Avatar';
import { Btn } from '../Btn';
import { useStore } from '../../state/useStore';
import { encryptFileBytes, fromB64, toB64, toB64u } from '../../crypto/core';
import { ManageSection } from './ManageUI';
import { manageActions, manageError } from './ManageData';
import { resolvePermissions, type ManageChat } from './ManageTypes';

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

interface PickedImage {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

interface CompressedImage {
  bytes: Uint8Array;
  mime?: string;
}

interface UploadedBytes {
  objectId?: string;
  objectID?: string;
  id?: string;
}

interface UploaderModule {
  compressImage: (
    bytes: Uint8Array,
    mime: string,
    opts?: { avatar?: boolean; maxDim?: number; signal?: AbortSignal },
  ) => Promise<CompressedImage | Uint8Array>;
  uploadBytesWithProgress: (
    bytes: Uint8Array,
    opts?: {
      signal?: AbortSignal;
      onStage?: (stage: 'compress' | 'encrypt' | 'upload' | 'register') => void;
      onProgress?: (progress: number) => void;
    },
  ) => Promise<UploadedBytes>;
}

/** uploader.ts грузим лениво — блок не должен падать, если модуля ещё нет. */
function loadUploader(): UploaderModule | null {
  try {
    // @ts-ignore — опциональный модуль data/uploader.ts
    return require('../../data/uploader') as UploaderModule;
  } catch {
    return null;
  }
}

function progressPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const percent = value <= 1.0001 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

function abortError(): Error {
  const error = new Error('Загрузка отменена');
  error.name = 'AbortError';
  return error;
}

/** Выбор изображения: <input type=file> на web, expo-document-picker нативно. */
async function pickImage(): Promise<PickedImage | null> {
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
        if (!file) {
          finish(null);
          return;
        }
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          finish({ name: file.name, mime: file.type || 'image/jpeg', bytes });
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
  return {
    name: asset.name,
    mime: asset.mimeType ?? 'image/jpeg',
    bytes: fromB64(b64),
  };
}

/** Может ли текущий пользователь менять аватар (сервер уже посчитал право). */
function canManageAvatar(chat: ManageChat, fallback: boolean): boolean {
  if (typeof chat.canSetAvatar === 'boolean') return chat.canSetAvatar;
  const role = chat.myRole;
  if (!role) return fallback;
  if (role === 'owner') return true;
  if (role !== 'admin' && role !== 'moderator') return false;
  return resolvePermissions(chat)[role].setAvatar;
}

export function ManageAvatar({
  chat,
  canEdit,
  onChanged,
}: {
  chat: ManageChat;
  canEdit: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const theme = useTheme();
  const pushToast = useStore((s) => s.pushToast);
  const canSetAvatar = canManageAvatar(chat, canEdit);

  const [busy, setBusy] = React.useState(false);
  const [step, setStep] = React.useState('');
  const [progress, setProgress] = React.useState<number | null>(null);
  const [error, setError] = React.useState('');
  const [preview, setPreview] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const abortRef = React.useRef<AbortController | null>(null);

  React.useEffect(() => {
    // Сменился чат или аватар — локальное превью больше не актуально.
    setPreview(null);
    setError('');
  }, [chat.id, chat.avatar?.objectId]);

  if (!canSetAvatar) return null;

  async function upload() {
    if (busy || deleting) return;
    setError('');
    try {
      const picked = await pickImage();
      if (!picked) return;
      if (!picked.mime.startsWith('image/')) {
        setError('Нужен файл изображения (JPEG, PNG, WebP).');
        return;
      }
      if (picked.bytes.length > MAX_AVATAR_BYTES) {
        setError('Файл больше 5 МБ — выберите изображение поменьше.');
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const { signal } = controller;

      setBusy(true);
      setProgress(0);
      setStep('Сжатие…');

      const uploader = loadUploader();
      if (!uploader) throw new Error('Загрузчик недоступен. Обновите приложение.');

      let bytes = picked.bytes;
      let mime = picked.mime;
      const compressed = await uploader.compressImage(picked.bytes, picked.mime, {
        avatar: true,
        maxDim: 512,
        signal,
      });
      if (compressed instanceof Uint8Array) {
        bytes = compressed;
      } else if (compressed?.bytes) {
        bytes = compressed.bytes;
        mime = compressed.mime || picked.mime;
      }
      if (signal.aborted) throw abortError();

      // Локальное превью сразу после сжатия — не ждём узлов и Hub.
      setPreview(`data:${mime};base64,${toB64(bytes)}`);

      setStep('Шифрование…');
      const encrypted = encryptFileBytes(bytes);
      const key = toB64u(encrypted.rawKey);

      setStep('Загрузка на узлы…');
      const uploaded = await uploader.uploadBytesWithProgress(encrypted.bytes, {
        signal,
        onStage: (stage) => {
          if (stage === 'register') setStep('Регистрация объекта…');
          else if (stage === 'upload') setStep('Загрузка на узлы…');
        },
        onProgress: (value) => setProgress(progressPercent(value)),
      });
      const objectId = String(uploaded?.objectId ?? uploaded?.objectID ?? uploaded?.id ?? '');
      if (!objectId || !key) throw new Error('Загрузчик не вернул objectId/key');
      setProgress(100);

      if (signal.aborted) throw abortError();
      setStep('Сохранение…');
      await manageActions.setChatAvatar(chat.id, { objectId, key, mime });

      setStep('Готово');
      setPreview(null);
      await onChanged();
      pushToast({ kind: 'success', message: 'Аватар обновлён' });
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'AbortError') {
        setPreview(null);
        pushToast({ kind: 'info', message: 'Загрузка аватара отменена' });
        return;
      }
      const message = manageError(e);
      setError(message);
      pushToast({ kind: 'error', message });
    } finally {
      abortRef.current = null;
      setBusy(false);
      setStep('');
      setProgress(null);
    }
  }

  async function remove() {
    if (busy || deleting || !chat.avatar) return;
    setDeleting(true);
    setError('');
    try {
      await manageActions.deleteChatAvatar(chat.id);
      setPreview(null);
      await onChanged();
      pushToast({ kind: 'success', message: 'Аватар удалён' });
    } catch (e: unknown) {
      const message = manageError(e);
      setError(message);
      pushToast({ kind: 'error', message });
    } finally {
      setDeleting(false);
    }
  }

  const isChannel = chat.type === 'channel';

  return (
    <ManageSection
      icon="image-outline"
      title={isChannel ? 'Аватар канала' : 'Аватар группы'}
      subtitle="Изображение шифруется на устройстве и хранится на узлах"
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        {preview ? (
          <View
            style={{
              width: 84,
              height: 84,
              borderRadius: 42,
              overflow: 'hidden',
              borderWidth: 2,
              borderColor: theme.accent,
            }}
          >
            <Image source={{ uri: preview }} style={{ width: 84, height: 84 }} resizeMode="cover" />
          </View>
        ) : (
          <Avatar name={chat.title || '?'} size={84} avatar={chat.avatar ?? null} />
        )}

        <View style={{ flex: 1, minWidth: 0, gap: 7 }}>
          <Text style={{ color: theme.textSecondary, fontSize: 11.5, lineHeight: 16 }}>
            {chat.avatar
              ? 'Аватар хранится зашифрованным на узлах'
              : 'Пока без аватара — показываем инициалы'}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Btn
                title={chat.avatar ? 'Заменить' : 'Загрузить'}
                size="s"
                loading={busy}
                disabled={busy || deleting}
                onPress={() => void upload()}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Btn
                title="Удалить"
                size="s"
                variant="ghost"
                disabled={!chat.avatar || busy || deleting}
                loading={deleting}
                onPress={() => void remove()}
              />
            </View>
          </View>
        </View>
      </View>

      {busy ? (
        <View
          style={{
            marginTop: 10,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            padding: 8,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: theme.line,
            backgroundColor: theme.dark ? 'rgba(10,14,20,0.4)' : 'rgba(255,255,255,0.7)',
          }}
        >
          <ActivityIndicator size="small" color={theme.accent} />
          <Text style={{ color: theme.textSecondary, fontSize: 12, flex: 1 }} numberOfLines={1}>
            {step || 'Обработка…'}
          </Text>
          <Text style={{ color: theme.accent, fontSize: 11.5, fontWeight: '700' }}>
            {progress ?? 0}%
          </Text>
          <Pressable
            onPress={() => abortRef.current?.abort()}
            accessibilityRole="button"
            accessibilityLabel="Отменить загрузку аватара"
            hitSlop={8}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
          >
            <Ionicons name="close" size={16} color={theme.textSecondary} />
          </Pressable>
        </View>
      ) : null}

      {error ? (
        <View
          style={{
            marginTop: 9,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 7,
            padding: 9,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: theme.danger,
            backgroundColor: theme.dangerSoft,
          }}
        >
          <Ionicons name="alert-circle-outline" size={15} color={theme.danger} />
          <Text style={{ color: theme.danger, fontSize: 12, flex: 1 }}>{error}</Text>
        </View>
      ) : null}
    </ManageSection>
  );
}
