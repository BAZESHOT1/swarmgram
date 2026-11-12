/**
 * Обновление прошивки уже привязанного модуля.
 *
 * - «По сети»: Hub ставит OTA-задание, модуль с Wi-Fi сам скачивает app-образ
 *   и перезагружается в новый раздел.
 * - «По USB»: открывает мастер прошивки (Web Serial на ПК); образ пишется
 *   через esptool с сохранением привязки модуля.
 */
import React from 'react';
import { Modal, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Btn } from '../Btn';
import { useTheme } from '../../theme/useTheme';
import { api, type FirmwareBuild, type ModuleRow } from '../../data/api';
import { humanError } from '../../data/queries';
import { useStore } from '../../state/useStore';

export function ModuleOtaSheet({ module, onClose }: { module: ModuleRow | null; onClose: () => void }) {
  const theme = useTheme();
  const toast = useStore((s) => s.pushToast);
  const [builds, setBuilds] = React.useState<FirmwareBuild[]>([]);
  const [buildId, setBuildId] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState<{ status: string; progress: number; error?: string | null; version?: string } | null>(null);
  const [error, setError] = React.useState('');

  const open = Boolean(module);

  React.useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setLoading(true);
    setError('');
    setStatus(null);
    void api
      .firmwareBuilds()
      .then((list) => {
        if (!alive) return;
        const ready = list.filter((b) => b.status === 'ready');
        setBuilds(ready);
        setBuildId(ready[0]?.id ?? null);
      })
      .catch((e) => alive && setError(humanError(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open, module?.id]);

  // Пока задание активно — поллим прогресс.
  React.useEffect(() => {
    if (!open || !module || !status) return undefined;
    if (!['pending', 'downloading', 'installing'].includes(status.status)) return undefined;
    let alive = true;
    const timer = setInterval(() => {
      void api
        .moduleOtaStatus(module.id)
        .then((res) => {
          if (!alive || !res.job) return;
          setStatus({ status: res.job.status, progress: res.job.progress, error: res.job.error, version: res.job.version });
        })
        .catch(() => undefined);
    }, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [open, module?.id, status?.status]);

  const startOta = async () => {
    if (!module) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.moduleOta(module.id, buildId ?? undefined);
      setStatus({ status: 'pending', progress: 0, version: res.version });
      toast({ kind: 'info', message: 'OTA-задание создано. Модуль обновится при связи с сервером.' });
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 16 }} onPress={onClose}>
        <Pressable
          onPress={(event) => event.stopPropagation?.()}
          style={{
            backgroundColor: theme.surface,
            borderRadius: 18,
            borderWidth: 1,
            borderColor: theme.glassBorder,
            padding: 16,
            maxHeight: '85%',
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: theme.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name="cloud-download-outline" size={20} color={theme.accent} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: theme.textPrimary, fontWeight: '800', fontSize: 16 }}>Обновление модуля</Text>
              <Text numberOfLines={1} style={{ color: theme.textSecondary, fontSize: 12 }}>
                {module?.publicId ? `ID ${module.publicId}` : module?.hardwareId} · сейчас {module?.firmware || '—'}
              </Text>
            </View>
            <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Закрыть">
              <Ionicons name="close" size={20} color={theme.textDisabled} />
            </Pressable>
          </View>

          <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ gap: 10 }}>
            <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 17 }}>
              «По сети» работает, если модуль сам выходит в интернет (шлюз/репитер с Wi-Fi). Wearable обновляется по USB или BLE.
            </Text>

            <Text style={{ color: theme.textPrimary, fontSize: 12.5, fontWeight: '700' }}>По сети</Text>
            {loading ? (
              <Text style={{ color: theme.textDisabled, fontSize: 12 }}>Загружаем сборки…</Text>
            ) : builds.length === 0 ? (
              <Text style={{ color: theme.textDisabled, fontSize: 12 }}>
                Нет готовых сборок. Сначала соберите прошивку в разделе «Прошивка».
              </Text>
            ) : (
              <>
                {builds.slice(0, 8).map((build) => (
                  <Pressable
                    key={build.id}
                    onPress={() => setBuildId(build.id)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: build.id === buildId }}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8,
                      padding: 10,
                      borderRadius: 12,
                      borderWidth: 1,
                      borderColor: build.id === buildId ? theme.accent : theme.glassBorder,
                      backgroundColor: build.id === buildId ? theme.accentSoft : 'transparent',
                    }}
                  >
                    <Ionicons
                      name={build.id === buildId ? 'radio-button-on' : 'radio-button-off'}
                      size={16}
                      color={build.id === buildId ? theme.accent : theme.textDisabled}
                    />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ color: theme.textPrimary, fontSize: 12.5, fontWeight: '600' }} numberOfLines={1}>
                        {build.version || build.id.slice(0, 8)}
                      </Text>
                      <Text style={{ color: theme.textDisabled, fontSize: 10.5 }}>
                        {(build.sizeBytes / 1024 / 1024).toFixed(2)} МБ · {new Date(build.createdAt).toLocaleString()}
                      </Text>
                    </View>
                  </Pressable>
                ))}
                <Btn title={busy ? 'Создаём задание…' : 'Обновить по сети'} loading={busy} onPress={() => void startOta()} />
              </>
            )}

            {status ? (
              <View style={{ padding: 10, borderRadius: 12, backgroundColor: theme.surfacePressed, gap: 4 }}>
                <Text style={{ color: theme.textPrimary, fontSize: 12, fontWeight: '700' }}>
                  {status.status === 'installed'
                    ? 'Обновление установлено'
                    : status.status === 'failed'
                      ? 'Ошибка обновления'
                      : `Обновление: ${status.progress}%`}
                </Text>
                {status.version ? (
                  <Text style={{ color: theme.textSecondary, fontSize: 11 }}>версия {status.version}</Text>
                ) : null}
                {status.error ? <Text style={{ color: theme.danger, fontSize: 11 }}>{status.error}</Text> : null}
              </View>
            ) : null}

            <View style={{ height: 1, backgroundColor: theme.glassBorder, marginVertical: 4 }} />
            <Text style={{ color: theme.textPrimary, fontSize: 12.5, fontWeight: '700' }}>По USB</Text>
            <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 17 }}>
              {Platform.OS === 'web'
                ? 'Подключите модуль к ПК и прошейте через Web Serial. Привязка к аккаунту сохранится.'
                : 'USB-прошивка доступна с ПК в Chrome/Edge. На телефоне используйте OTA по сети.'}
            </Text>
            {Platform.OS === 'web' ? (
              <Btn
                title="Открыть прошивку по USB"
                variant="ghost"
                onPress={() => {
                  onClose();
                  router.push('/firmware' as never);
                }}
              />
            ) : null}
            {error ? <Text style={{ color: theme.danger, fontSize: 11.5 }}>{error}</Text> : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
