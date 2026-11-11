import React from 'react';
import { ActivityIndicator, Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useTheme } from '../../../../src/theme/useTheme';
import { Avatar, invalidateAvatar } from '../../../../src/components/Avatar';
import { Btn } from '../../../../src/components/Btn';
import { ConfirmModal } from '../../../../src/components/profile/ConfirmModal';
import {
  BannerPicker,
  ChoiceGroup,
  ProfileField,
} from '../../../../src/components/profile/ProfileEditControls';
import { normalizeLinkUrl } from '../../../../src/components/profile/ProfileLinks';
import { DEFAULT_BANNER, bannerPreset, type BannerId } from '../../../../src/components/profile/banner';
import {
  GlassCard,
  SettingsPage,
  SettingsSection,
} from '../../../../src/components/settings/SettingsUI';
import { SettingsRowsSkeleton } from '../../../../src/components/skeletons/PageSkeletons';
import { useMe, humanError, CHATS_KEY } from '../../../../src/data/queries';
import * as api from '../../../../src/data/api';
import type { BioVisibility, LastSeenVisibility, ProfileLink, User } from '../../../../src/data/api';
import { encryptFileBytes, fromB64, toB64, toB64u } from '../../../../src/crypto/core';
import { uploadEnvelope } from '../../../../src/data/chatkit';
import { useStore } from '../../../../src/state/useStore';

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const MAX_LINKS = 3;

interface PickedImage {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

/* ------------------------------------------------ новый upload-менеджер ---- */

interface CompressedImage {
  bytes: Uint8Array;
  mime?: string;
}

interface UploadedBytes {
  objectId?: string;
  objectID?: string;
  id?: string;
  key?: string;
  rawKey?: string;
  keyB64?: string;
  keyBase64?: string;
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

/**
 * uploader.ts добавляет параллельный агент. Грузим лениво и с запасным
 * legacy-путём, чтобы экран не падал, если модуль ещё не собран.
 */
function loadUploader(): UploaderModule | null {
  try {
    // @ts-ignore — модуль src/data/uploader.ts появляется отдельной задачей
    return require('../../../../src/data/uploader') as UploaderModule;
  } catch {
    return null;
  }
}

/** Приводим прогресс к процентам: загрузчик может отдавать 0…1 или 0…100. */
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

interface FormState {
  displayName: string;
  username: string;
  status: string;
  bio: string;
  location: string;
  birthday: string;
  links: ProfileLink[];
  banner: BannerId;
  lastSeenVisibility: LastSeenVisibility;
  bioVisibility: BioVisibility;
}

function formFromUser(me: User): FormState {
  // /v1/me отдаёт bio, но тип User пока его не описывает — читаем безопасно.
  const bio = (me as User & { bio?: string }).bio ?? '';
  return {
    displayName: me.displayName ?? '',
    username: me.username ?? '',
    status: me.status ?? '',
    bio,
    location: me.location ?? '',
    birthday: me.birthday ?? '',
    links: (me.links ?? []).map((link) => ({ label: link.label ?? '', url: link.url ?? '' })),
    banner: (bannerPreset(me.banner).id ?? DEFAULT_BANNER) as BannerId,
    lastSeenVisibility: me.lastSeenVisibility ?? 'everyone',
    bioVisibility: me.bioVisibility ?? 'everyone',
  };
}

/** Проверка даты рождения: пусто — скрыть, иначе строгий YYYY-MM-DD. */
function birthdayError(value: string): string {
  const v = value.trim();
  if (!v) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'Формат: ГГГГ-ММ-ДД';
  const [y, m, d] = v.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
    return 'Такой даты не существует';
  }
  if (date.getTime() > Date.now()) return 'Дата не может быть в будущем';
  if (y < 1900) return 'Слишком давняя дата';
  return '';
}

/**
 * Выбор изображения. В приложении FilePicker — только иконка-скрепка,
 * поэтому для кнопки «Загрузить фото» используем тот же механизм:
 * <input type=file> на web и expo-document-picker на нативных платформах.
 */
async function pickImage(): Promise<PickedImage | null> {
  if (Platform.OS === 'web') {
    if (typeof document === 'undefined') return null;
    return new Promise<PickedImage | null>((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      // Safari/Firefox надёжнее открывают диалог для input, добавленного в DOM.
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
        // Диалог закрыли без выбора — через мгновение input.files пуст.
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
      // click() вызывается синхронно внутри пользовательского жеста.
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

/** Отдельный экран расширенного редактирования профиля. */
export default function UserEditScreen() {
  const theme = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const meQuery = useMe();
  const me = meQuery.data;
  const pushToast = useStore((s) => s.pushToast);

  const [form, setForm] = React.useState<FormState | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState('');

  const [avatarBusy, setAvatarBusy] = React.useState(false);
  const [avatarStep, setAvatarStep] = React.useState('');
  const [avatarProgress, setAvatarProgress] = React.useState<number | null>(null);
  const [avatarError, setAvatarError] = React.useState('');
  const [avatarPreview, setAvatarPreview] = React.useState<string | null>(null);
  const [lastPicked, setLastPicked] = React.useState<PickedImage | null>(null);
  const avatarAbort = React.useRef<AbortController | null>(null);
  const [deleteAvatarOpen, setDeleteAvatarOpen] = React.useState(false);
  const [deletingAvatar, setDeletingAvatar] = React.useState(false);

  React.useEffect(() => {
    if (me && !form) setForm(formFromUser(me));
  }, [me, form]);

  function patch(partial: Partial<FormState>) {
    setForm((prev) => (prev ? { ...prev, ...partial } : prev));
  }

  function patchLink(index: number, partial: Partial<ProfileLink>) {
    setForm((prev) => {
      if (!prev) return prev;
      const links = prev.links.map((link, i) => (i === index ? { ...link, ...partial } : link));
      return { ...prev, links };
    });
  }

  function addLink() {
    setForm((prev) => {
      if (!prev || prev.links.length >= MAX_LINKS) return prev;
      return { ...prev, links: [...prev.links, { label: '', url: '' }] };
    });
  }

  function removeLink(index: number) {
    setForm((prev) => (prev ? { ...prev, links: prev.links.filter((_, i) => i !== index) } : prev));
  }

  async function refreshProfileCaches() {
    const fresh = await api.api.me().catch(() => null);
    if (fresh) useStore.getState().setMe(fresh);
    await queryClient.invalidateQueries({ queryKey: ['me'] });
    await queryClient.invalidateQueries({ queryKey: ['profile'] });
    await queryClient.invalidateQueries({ queryKey: [CHATS_KEY] });
  }

  async function uploadAvatar(retryPicked?: PickedImage) {
    if (!me || avatarBusy) return;
    setAvatarError('');
    try {
      const picked = retryPicked ?? (await pickImage());
      if (!picked) return;
      if (!picked.mime.startsWith('image/')) {
        setAvatarError('Нужен файл изображения (JPEG, PNG, WebP).');
        return;
      }
      if (picked.bytes.length > MAX_AVATAR_BYTES) {
        setAvatarError('Файл больше 5 МБ — выберите изображение поменьше.');
        return;
      }

      avatarAbort.current?.abort();
      const controller = new AbortController();
      avatarAbort.current = controller;
      const { signal } = controller;

      setAvatarBusy(true);
      setAvatarProgress(0);
      setLastPicked(picked);
      setAvatarStep('Сжатие…');

      const uploader = loadUploader();
      let bytes = picked.bytes;
      let mime = picked.mime;

      if (uploader) {
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
      }

      // Локальное превью сразу после сжатия — не ждём узлов и Hub.
      setAvatarPreview(`data:${mime};base64,${toB64(bytes)}`);

      let objectId = '';
      let key = '';

      if (uploader) {
        // uploadBytesWithProgress ждёт уже зашифрованные байты: шифруем до загрузки.
        setAvatarStep('Шифрование…');
        const encrypted = encryptFileBytes(bytes);
        key = toB64u(encrypted.rawKey);
        setAvatarStep('Загрузка на узлы…');
        const uploaded = await uploader.uploadBytesWithProgress(encrypted.bytes, {
          signal,
          onStage: (stage) => {
            if (stage === 'register') setAvatarStep('Регистрация объекта…');
            else if (stage === 'upload') setAvatarStep('Загрузка на узлы…');
          },
          onProgress: (value) => setAvatarProgress(progressPercent(value)),
        });
        // Разные версии загрузчика называют поля по-своему — поддерживаем алиасы.
        objectId = String(uploaded?.objectId ?? uploaded?.objectID ?? uploaded?.id ?? '');
        if (!objectId || !key) throw new Error('Загрузчик не вернул objectId/key');
        setAvatarProgress(100);
      } else {
        // Совместимость, пока uploader.ts не подключён: шифруем и грузим как раньше.
        setAvatarStep('Шифрование…');
        const encrypted = encryptFileBytes(bytes);
        setAvatarStep('Загрузка на узлы…');
        const uploaded = await uploadEnvelope(encrypted.bytes);
        objectId = uploaded.objectId;
        key = toB64u(encrypted.rawKey);
        setAvatarProgress(100);
      }

      if (signal.aborted) throw abortError();
      setAvatarStep('Сохранение…');
      await api.api.putAvatar({ objectId, key, mime });

      invalidateAvatar();
      await refreshProfileCaches();
      setAvatarStep('Готово');
      setAvatarPreview(null);
      setLastPicked(null);
      pushToast({ kind: 'success', message: 'Фото профиля обновлено' });
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'AbortError') {
        setAvatarStep('');
        setAvatarProgress(null);
        pushToast({ kind: 'info', message: 'Загрузка фото отменена' });
        return;
      }
      const message = humanError(e);
      setAvatarError(message);
      pushToast({ kind: 'error', message });
    } finally {
      avatarAbort.current = null;
      setAvatarBusy(false);
      setAvatarStep('');
      setAvatarProgress(null);
    }
  }

  function cancelAvatarUpload() {
    avatarAbort.current?.abort();
  }

  async function deleteAvatar() {
    if (deletingAvatar) return;
    setDeletingAvatar(true);
    try {
      await api.api.deleteAvatar();
      invalidateAvatar();
      setAvatarPreview(null);
      setLastPicked(null);
      await refreshProfileCaches();
      setDeleteAvatarOpen(false);
      pushToast({ kind: 'success', message: 'Фото профиля удалено' });
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: humanError(e) });
    } finally {
      setDeletingAvatar(false);
    }
  }

  async function save() {
    if (!me || !form || saving) return;
    const username = form.username.trim().toLowerCase();
    const usernameChanged = username !== me.username.toLowerCase();
    const birthday = form.birthday.trim();
    if (!form.displayName.trim()) {
      setSaveError('Отображаемое имя не может быть пустым.');
      return;
    }
    if (usernameChanged && !/^[a-z0-9_]{3,32}$/.test(username)) {
      setSaveError('Username: 3–32 символа, только a-z, 0-9 и «_».');
      return;
    }
    if (usernameChanged && me.usernamePolicy?.canChange === false) {
      setSaveError('Смена username пока недоступна.');
      return;
    }
    const bdayError = birthdayError(birthday);
    if (bdayError) {
      setSaveError(bdayError);
      return;
    }

    const links = form.links
      .map((link) => ({ label: link.label.trim(), url: normalizeLinkUrl(link.url) }))
      .filter((link) => Boolean(link.url));

    setSaving(true);
    setSaveError('');
    try {
      await api.api.patchMe({
        displayName: form.displayName.trim(),
        status: form.status.trim(),
        bio: form.bio.trim(),
        links,
        location: form.location.trim(),
        birthday: birthday || null,
        banner: form.banner,
        lastSeenVisibility: form.lastSeenVisibility,
        bioVisibility: form.bioVisibility,
        // status добавит параллельный агент в типы api.ts — сейчас поле новое.
      } as any);
      if (usernameChanged) {
        await api.api.changeUsername(username);
      }
      await refreshProfileCaches();
      pushToast({ kind: 'success', message: usernameChanged ? 'Профиль и username обновлены' : 'Профиль обновлён' });
      if (usernameChanged) {
        router.replace(`/user/${username}` as never);
      } else {
        router.back();
      }
    } catch (e: unknown) {
      const message = humanError(e);
      setSaveError(message);
      pushToast({ kind: 'error', message });
    } finally {
      setSaving(false);
    }
  }

  /* ------------------------------------------------------------- loading */
  if (meQuery.isLoading || (!form && !meQuery.isError)) {
    return (
      <SettingsPage title="Редактировать профиль" subtitle="Загрузка данных…">
        <SettingsSection title="Профиль">
          <GlassCard>
            <View style={{ padding: 8 }}>
              <SettingsRowsSkeleton rows={4} size={42} />
            </View>
          </GlassCard>
        </SettingsSection>
        <SettingsSection title="Основное" delay={60}>
          <GlassCard>
            <View style={{ padding: 8 }}>
              <SettingsRowsSkeleton rows={5} size={40} />
            </View>
          </GlassCard>
        </SettingsSection>
      </SettingsPage>
    );
  }

  if (meQuery.isError || !me || !form) {
    return (
      <SettingsPage title="Редактировать профиль" subtitle="Не удалось загрузить профиль">
        <GlassCard>
          <View style={{ padding: 14, gap: 8 }}>
            <Text style={{ color: theme.danger, fontSize: 13 }}>{humanError(meQuery.error)}</Text>
            <Btn title="Повторить" size="s" variant="ghost" onPress={() => void meQuery.refetch()} />
          </View>
        </GlassCard>
      </SettingsPage>
    );
  }

  const policy = me.usernamePolicy;
  const username = form.username.trim().toLowerCase();
  const usernameChanged = username !== me.username.toLowerCase();
  const usernameValid = /^[a-z0-9_]{3,32}$/.test(username);
  const canChangeUsername = policy?.canChange !== false;
  const bdayError = birthdayError(form.birthday);
  const canSave =
    Boolean(form.displayName.trim()) &&
    (!usernameChanged || (usernameValid && canChangeUsername)) &&
    !bdayError &&
    !saving;

  const cooldownDays = policy?.cooldownDays ?? 90;
  const canChangeAtLabel = policy?.canChangeAt
    ? new Date(policy.canChangeAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
    : '';

  return (
    <>
      <SettingsPage
        title="Редактировать профиль"
        subtitle="Фото, статус, основное, ссылки, баннер и приватность"
        right={
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Закрыть без сохранения"
            hitSlop={8}
            style={({ pressed }) => [styles.closeBtn, { borderColor: theme.line, opacity: pressed ? 0.6 : 1 }]}
          >
            <Ionicons name="close" size={18} color={theme.textSecondary} />
          </Pressable>
        }
      >
        {/* --------------------------------------------------------- Аватар */}
        <SettingsSection title="Фото профиля" delay={0}>
          <GlassCard>
            <View style={styles.avatarRow}>
              {avatarPreview ? (
                <View
                  style={{
                    width: 96,
                    height: 96,
                    borderRadius: 48,
                    overflow: 'hidden',
                    borderWidth: 2,
                    borderColor: theme.accent,
                  }}
                >
                  <Image source={{ uri: avatarPreview }} style={{ width: 96, height: 96 }} resizeMode="cover" />
                </View>
              ) : (
                <Avatar
                  name={form.displayName || form.username || '?'}
                  size={96}
                  avatar={me.avatar}
                  nodeOnline={me.nodeOnline}
                  moduleOnline={me.moduleOnline}
                />
              )}
              <View style={{ flex: 1, minWidth: 0, gap: 8 }}>
                <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '600' }} numberOfLines={2}>
                  {me.avatar ? 'Фото хранится зашифрованным на узлах' : 'Пока без фото — показываем инициалы'}
                </Text>
                <Text style={{ color: theme.textSecondary, fontSize: 11.5, lineHeight: 16 }}>
                  JPEG, PNG или WebP до 5 МБ. Изображение шифруется на устройстве перед загрузкой.
                </Text>
                <View style={styles.avatarButtons}>
                  <View style={{ flex: 1 }}>
                    <Btn
                      title="Загрузить фото"
                      size="s"
                      loading={avatarBusy}
                      disabled={avatarBusy || deletingAvatar}
                      onPress={() => void uploadAvatar()}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Btn
                      title="Удалить"
                      size="s"
                      variant="ghost"
                      disabled={!me.avatar || avatarBusy || deletingAvatar}
                      onPress={() => setDeleteAvatarOpen(true)}
                    />
                  </View>
                </View>
              </View>
            </View>

            {avatarBusy ? (
              <View
                style={[
                  styles.progress,
                  { borderColor: theme.line, backgroundColor: theme.dark ? 'rgba(10,14,20,0.4)' : 'rgba(255,255,255,0.7)' },
                ]}
              >
                <View style={{ flex: 1, gap: 6 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <ActivityIndicator size="small" color={theme.accent} />
                    <Text style={{ color: theme.textSecondary, fontSize: 12, flex: 1 }} numberOfLines={1}>
                      {avatarStep || 'Обработка…'}
                    </Text>
                    <Text style={{ color: theme.accent, fontSize: 11.5, fontWeight: '700', fontVariant: ['tabular-nums'] as never }}>
                      {avatarProgress ?? 0}%
                    </Text>
                  </View>
                  <View style={[styles.progressTrack, { backgroundColor: theme.accentSoft }]}>
                    <View
                      style={[
                        styles.progressFill,
                        { backgroundColor: theme.accent, width: `${Math.max(3, avatarProgress ?? 0)}%` },
                      ]}
                    />
                  </View>
                </View>
                <Pressable
                  onPress={cancelAvatarUpload}
                  accessibilityRole="button"
                  accessibilityLabel="Отменить загрузку фото"
                  hitSlop={8}
                  style={({ pressed }) => [styles.cancelUpload, { opacity: pressed ? 0.6 : 1 }]}
                >
                  <Ionicons name="close" size={16} color={theme.textSecondary} />
                </Pressable>
              </View>
            ) : null}
            {avatarError ? (
              <View style={[styles.avatarErrorRow, { borderColor: theme.danger, backgroundColor: theme.dangerSoft }]}>
                <Ionicons name="alert-circle-outline" size={15} color={theme.danger} />
                <Text style={{ color: theme.danger, fontSize: 12, flex: 1 }}>{avatarError}</Text>
                {lastPicked ? (
                  <Pressable
                    onPress={() => void uploadAvatar(lastPicked)}
                    accessibilityRole="button"
                    accessibilityLabel="Повторить загрузку фото"
                    hitSlop={6}
                    style={({ pressed }) => [styles.retryBtn, { borderColor: theme.danger, opacity: pressed ? 0.6 : 1 }]}
                  >
                    <Text style={{ color: theme.danger, fontSize: 11.5, fontWeight: '700' }}>Повторить</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </GlassCard>
        </SettingsSection>

        {/* ------------------------------------------------------- Основное */}
        <SettingsSection title="Основное" delay={60}>
          <GlassCard>
            <View style={{ padding: 12 }}>
              <ProfileField
                label="Отображаемое имя"
                value={form.displayName}
                onChangeText={(v) => patch({ displayName: v })}
                placeholder="Как вас называть"
                maxLength={64}
                autoCapitalize="words"
              />

              <ProfileField
                label="Username"
                value={form.username}
                onChangeText={(v) => patch({ username: v.toLowerCase().replace(/\s/g, '') })}
                placeholder="username"
                maxLength={32}
                autoCapitalize="none"
                editable={canChangeUsername}
                prefix="@"
                error={usernameChanged && !usernameValid ? '3–32 символа: a-z, 0-9, «_»' : undefined}
                hint={
                  canChangeUsername
                    ? usernameChanged
                      ? 'Новый username сохранится вместе с профилем'
                      : `Смена — не чаще одного раза в ${cooldownDays} дней`
                    : undefined
                }
                right={
                  usernameChanged ? (
                    <Text style={{ color: usernameValid ? theme.success : theme.danger, fontSize: 11, fontWeight: '600' }}>
                      {usernameValid ? 'можно менять' : 'некорректно'}
                    </Text>
                  ) : (
                    <Text style={{ color: theme.textDisabled, fontSize: 11 }}>текущий</Text>
                  )
                }
              />
              {!canChangeUsername ? (
                <Text style={{ color: theme.warning, fontSize: 11.5, marginTop: -6, marginBottom: 12 }}>
                  Смена username доступна с {canChangeAtLabel || 'позже'}.
                </Text>
              ) : null}

              <ProfileField
                label="Статус"
                value={form.status}
                onChangeText={(v) => patch({ status: v })}
                placeholder="На связи 🚀"
                maxLength={80}
                hint="Короткая подпись под именем · эмодзи можно · пусто — скрыть"
              />

              {/* Живое превью: ровно то, что увидит гость под @username в hero. */}
              <View
                style={[
                  styles.statusPreview,
                  {
                    borderColor: theme.line,
                    backgroundColor: theme.dark ? 'rgba(255,255,255,0.04)' : 'rgba(16,24,40,0.03)',
                  },
                ]}
              >
                <View style={[styles.statusPreviewBar, { backgroundColor: form.status.trim() ? theme.accent : theme.line }]} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ color: theme.textDisabled, fontSize: 10.5, fontWeight: '700', letterSpacing: 0.5 }}>
                    ПРЕВЬЮ В ПРОФИЛЕ
                  </Text>
                  <Text style={{ color: form.status.trim() ? theme.textPrimary : theme.textDisabled, fontSize: 13, fontWeight: '600', marginTop: 2 }} numberOfLines={2}>
                    {form.status.trim() || 'Без статуса'}
                  </Text>
                </View>
                <Ionicons name="eye-outline" size={15} color={theme.textDisabled} />
              </View>

              <ProfileField
                label="О себе"
                value={form.bio}
                onChangeText={(v) => patch({ bio: v })}
                placeholder="Пара слов о себе"
                maxLength={280}
                multiline
                hint="Видно другим пользователям согласно настройкам приватности ниже"
              />

              <ProfileField
                label="Локация"
                value={form.location}
                onChangeText={(v) => patch({ location: v })}
                placeholder="Город или страна"
                maxLength={64}
                hint="Пусто — не показывать"
              />

              <ProfileField
                label="Дата рождения"
                value={form.birthday}
                onChangeText={(v) => patch({ birthday: v })}
                placeholder="2000-01-31"
                maxLength={10}
                autoCapitalize="none"
                keyboardType="numbers-and-punctuation"
                error={bdayError || undefined}
                hint="Формат ГГГГ-ММ-ДД · пусто — скрыть дату"
              />
            </View>
          </GlassCard>
        </SettingsSection>

        {/* --------------------------------------------------------- Ссылки */}
        <SettingsSection
          title="Ссылки"
          delay={120}
          right={<Text style={{ color: theme.textDisabled, fontSize: 12 }}>{form.links.length}/{MAX_LINKS}</Text>}
        >
          <GlassCard>
            <View style={{ padding: 12 }}>
              {form.links.length === 0 ? (
                <Text style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 19, marginBottom: 10 }}>
                  Добавьте до трёх ссылок: сайт, портфолио, соцсети.
                </Text>
              ) : null}

              {form.links.map((link, index) => (
                <View key={index} style={[styles.linkBox, { borderColor: theme.line }]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: '700' }}>
                      Ссылка {index + 1}
                    </Text>
                    <Pressable
                      onPress={() => removeLink(index)}
                      accessibilityRole="button"
                      accessibilityLabel={`Удалить ссылку ${index + 1}`}
                      hitSlop={8}
                      style={({ pressed }) => [styles.removeLink, { opacity: pressed ? 0.6 : 1 }]}
                    >
                      <Ionicons name="trash-outline" size={15} color={theme.danger} />
                    </Pressable>
                  </View>
                  <ProfileField
                    label="Название"
                    value={link.label}
                    onChangeText={(v) => patchLink(index, { label: v })}
                    placeholder="Мой сайт"
                    maxLength={40}
                  />
                  <ProfileField
                    label="URL"
                    value={link.url}
                    onChangeText={(v) => patchLink(index, { url: v })}
                    placeholder="example.com"
                    maxLength={200}
                    autoCapitalize="none"
                    keyboardType="url"
                  />
                </View>
              ))}

              <View style={{ marginTop: form.links.length ? 2 : 0 }}>
                <Btn
                  title={form.links.length >= MAX_LINKS ? 'Лимит ссылок' : 'Добавить ссылку'}
                  size="s"
                  variant="ghost"
                  disabled={form.links.length >= MAX_LINKS}
                  onPress={addLink}
                />
              </View>
            </View>
          </GlassCard>
        </SettingsSection>

        {/* --------------------------------------------------------- Баннер */}
        <SettingsSection title="Баннер профиля" delay={180}>
          <GlassCard>
            <View style={{ padding: 12 }}>
              <BannerPicker value={form.banner} onChange={(value) => patch({ banner: value })} />
              <Text style={{ color: theme.textSecondary, fontSize: 11.5, lineHeight: 16, marginTop: 12 }}>
                Цвет шапки профиля. Не влияет на приватность и виден всем, кто открывает профиль.
              </Text>
            </View>
          </GlassCard>
        </SettingsSection>

        {/* ------------------------------------------------------ Приватность */}
        <SettingsSection title="Приватность" delay={240}>
          <GlassCard>
            <View style={{ paddingHorizontal: 12, paddingTop: 12 }}>
              <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: '700', marginBottom: 6 }}>
                Кто видит последний визит
              </Text>
              <ChoiceGroup<LastSeenVisibility>
                value={form.lastSeenVisibility}
                onChange={(value) => patch({ lastSeenVisibility: value })}
                options={[
                  { value: 'everyone', label: 'Все', subtitle: 'Точное время последней активности', icon: 'globe-outline' },
                  { value: 'shared', label: 'Общие чаты', subtitle: 'Только участники ваших общих групп', icon: 'people-outline' },
                  { value: 'nobody', label: 'Никто', subtitle: 'Показывать «был(а) недавно»', icon: 'eye-off-outline' },
                ]}
              />
            </View>
            <View style={{ height: 1, backgroundColor: theme.line, marginHorizontal: 12, marginTop: 8 }} />
            <View style={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4 }}>
              <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: '700', marginBottom: 6 }}>
                Кто видит био и ссылки
              </Text>
              <ChoiceGroup<BioVisibility>
                value={form.bioVisibility}
                onChange={(value) => patch({ bioVisibility: value })}
                options={[
                  { value: 'everyone', label: 'Все', subtitle: 'Био, ссылки, локация и дата рождения', icon: 'globe-outline' },
                  { value: 'chat', label: 'Только из чатов', subtitle: 'Пользователи, с которыми у вас есть общий чат', icon: 'chatbubbles-outline' },
                ]}
              />
            </View>
          </GlassCard>
        </SettingsSection>

        {saveError ? (
          <View style={[styles.saveError, { backgroundColor: theme.dangerSoft, borderColor: theme.danger }]}>
            <Ionicons name="alert-circle-outline" size={16} color={theme.danger} />
            <Text style={{ color: theme.danger, fontSize: 12.5, flex: 1 }}>{saveError}</Text>
          </View>
        ) : null}

        <View style={styles.footer}>
          <View style={{ flex: 1 }}>
            <Btn title="Отмена" variant="ghost" onPress={() => router.back()} disabled={saving} />
          </View>
          <View style={{ flex: 1 }}>
            <Btn title="Сохранить" loading={saving} disabled={!canSave} onPress={() => void save()} />
          </View>
        </View>
        <Text style={{ color: theme.textDisabled, fontSize: 11, textAlign: 'center', marginTop: 8 }}>
          Изменения появятся в профиле и списке чатов сразу после сохранения.
        </Text>
      </SettingsPage>

      <ConfirmModal
        visible={deleteAvatarOpen}
        title="Удалить фото профиля?"
        message="В профиле снова будут показываться инициалы. Зашифрованный файл на узлах останется, но Hub перестанет на него ссылаться."
        confirmLabel="Удалить"
        loading={deletingAvatar}
        onClose={() => setDeleteAvatarOpen(false)}
        onConfirm={() => void deleteAvatar()}
      />
    </>
  );
}

const styles = StyleSheet.create({
  closeBtn: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  avatarRow: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 12 },
  avatarButtons: { flexDirection: 'row', gap: 8 },
  progress: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, marginHorizontal: 12, marginBottom: 12 },
  progressTrack: { height: 4, borderRadius: 999, overflow: 'hidden' },
  progressFill: { height: 4, borderRadius: 999 },
  cancelUpload: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  avatarErrorRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, marginHorizontal: 12, marginBottom: 12 },
  retryBtn: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 },
  linkBox: { borderWidth: 1, borderRadius: 14, padding: 10, marginBottom: 10 },
  statusPreview: { flexDirection: 'row', alignItems: 'center', gap: 9, borderWidth: 1, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 8, marginTop: -4, marginBottom: 12 },
  statusPreviewBar: { width: 3, height: 26, borderRadius: 2 },  removeLink: { width: 28, height: 28, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  saveError: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 14 },
  footer: { flexDirection: 'row', gap: 10 },
});
