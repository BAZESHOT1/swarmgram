/**
 * Настройка фонового изображения: превью, выбор фото, удаление и прогресс загрузки.
 * Используется в информации о чате (личный чат, группа, канал) и в редактировании профиля.
 */
import React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AvatarInfo } from '../data/api';
import { pickImage, uploadImage, type UploadedImage } from '../data/imageUpload';
import { useStore } from '../state/useStore';
import { useTheme } from '../theme/useTheme';
import { Btn } from './Btn';
import { Wallpaper } from './Wallpaper';

export function BackgroundSetting({
  title = 'Фон',
  hint,
  current,
  onSave,
  onRemove,
}: {
  title?: string;
  hint?: string;
  current?: AvatarInfo | null;
  /** Сохранить загруженное изображение на Hub. */
  onSave: (image: { objectId: string; key: string; mime: string }) => Promise<unknown>;
  onRemove: () => Promise<unknown>;
}) {
  const theme = useTheme();
  const pushToast = useStore((s) => s.pushToast);
  const [busy, setBusy] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);
  const [step, setStep] = React.useState('');
  const [progress, setProgress] = React.useState(0);
  const [preview, setPreview] = React.useState<string | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  React.useEffect(() => setPreview(null), [current?.objectId]);

  async function choose() {
    if (busy || removing) return;
    const picked = await pickImage().catch(() => null);
    if (!picked) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setProgress(0);
    try {
      const uploaded: UploadedImage = await uploadImage(picked, {
        maxDim: 1800,
        signal: controller.signal,
        onStep: setStep,
        onProgress: setProgress,
      });
      setPreview(uploaded.preview);
      setStep('Сохранение…');
      await onSave({ objectId: uploaded.objectId, key: uploaded.key, mime: uploaded.mime });
      pushToast({ kind: 'success', message: 'Фон обновлён' });
    } catch (e) {
      setPreview(null);
      if (!(e instanceof Error && e.name === 'AbortError')) {
        pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Не удалось сменить фон' });
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      setStep('');
    }
  }

  async function remove() {
    if (busy || removing) return;
    setRemoving(true);
    try {
      await onRemove();
      setPreview(null);
      pushToast({ kind: 'success', message: 'Фон сброшен' });
    } catch (e) {
      pushToast({ kind: 'error', message: e instanceof Error ? e.message : 'Не удалось убрать фон' });
    } finally {
      setRemoving(false);
    }
  }

  const has = Boolean(preview || current);
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Ionicons name="color-palette-outline" size={17} color={theme.accent} />
        <Text style={{ color: theme.textPrimary, fontSize: 15, fontWeight: '700' }}>{title}</Text>
      </View>
      {hint ? <Text style={{ color: theme.textSecondary, fontSize: 12.5, lineHeight: 17 }}>{hint}</Text> : null}
      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'stretch' }}>
        <Pressable
          onPress={() => void choose()}
          accessibilityRole="button"
          accessibilityLabel="Выбрать фоновое изображение"
          style={({ pressed }) => ({
            width: 92,
            height: 150,
            borderRadius: 16,
            overflow: 'hidden',
            borderWidth: 1,
            borderColor: theme.line,
            opacity: pressed ? 0.8 : 1,
          })}
        >
          <Wallpaper image={current} previewUri={preview} dim={0.15} />
          {busy ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)' }}>
              <ActivityIndicator color="#fff" />
              <Text style={{ color: '#fff', fontSize: 11, marginTop: 6, fontWeight: '700' }}>{progress}%</Text>
            </View>
          ) : null}
        </Pressable>
        <View style={{ flex: 1, gap: 8, justifyContent: 'center' }}>
          <Btn title={has ? 'Сменить фото' : 'Выбрать фото'} size="s" loading={busy} disabled={busy || removing} onPress={() => void choose()} />
          <Btn
            title="Стандартный фон"
            size="s"
            variant="ghost"
            loading={removing}
            disabled={!current || busy || removing}
            onPress={() => void remove()}
          />
          {busy ? (
            <Pressable onPress={() => abortRef.current?.abort()} accessibilityRole="button" hitSlop={6}>
              <Text style={{ color: theme.textSecondary, fontSize: 12 }}>{step || 'Обработка…'} · отменить</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}
