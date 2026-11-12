/**
 * Обновление модуля. Пользователь не видит файлов сборок: сервер собирает
 * свежую прошивку из сохранённой конфигурации модуля, затем ставит OTA-задание.
 */
import React from 'react';
import { Modal, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Btn } from '../Btn';
import { useTheme } from '../../theme/useTheme';
import { api, type FirmwareConfig, type ModuleRow } from '../../data/api';
import { humanError } from '../../data/queries';
import { useStore } from '../../state/useStore';

type Phase = 'idle' | 'building' | 'queued' | 'downloading' | 'installing' | 'installed' | 'failed';

const PHASE_LABEL: Record<Phase, string> = {
  idle: '',
  building: 'Собираем свежую прошивку…',
  queued: 'Ожидаем модуль…',
  downloading: 'Модуль скачивает прошивку…',
  installing: 'Устанавливаем…',
  installed: 'Обновление установлено',
  failed: 'Ошибка обновления',
};

export function ModuleOtaSheet({ module, onClose }: { module: ModuleRow | null; onClose: () => void }) {
  const theme = useTheme();
  const toast = useStore((s) => s.pushToast);
  const [busy, setBusy] = React.useState(false);
  const [phase, setPhase] = React.useState<Phase>('idle');
  const [progress, setProgress] = React.useState(0);
  const [error, setError] = React.useState('');
  const [hasConfig, setHasConfig] = React.useState<boolean | null>(null);
  const buildIdRef = React.useRef<string | null>(null);

  const open = Boolean(module);

  React.useEffect(() => {
    if (!open || !module) return undefined;
    let alive = true;
    setBusy(false);
    setPhase('idle');
    setProgress(0);
    setError('');
    setHasConfig(null);
    void api
      .moduleOtaStatus(module.id)
      .then((res) => {
        if (!alive || !res.job) return;
        setPhase(res.job.status as Phase);
        setProgress(res.job.progress);
        setError(res.job.error ?? '');
      })
      .catch(() => undefined);
    void api
      .moduleFirmwareConfig(module.id)
      .then((res) => alive && setHasConfig(Boolean(res.config)))
      .catch(() => alive && setHasConfig(false));
    return () => {
      alive = false;
    };
  }, [open, module?.id]);

  // Прогресс активного задания.
  React.useEffect(() => {
    if (!open || !module) return undefined;
    if (!['queued', 'downloading', 'installing'].includes(phase)) return undefined;
    const timer = setInterval(() => {
      void api
        .moduleOtaStatus(module.id)
        .then((res) => {
          if (!res.job) return;
          setPhase(res.job.status as Phase);
          setProgress(res.job.progress);
          setError(res.job.error ?? '');
        })
        .catch(() => undefined);
    }, 3000);
    return () => clearInterval(timer);
  }, [open, module?.id, phase]);

  const startUpdate = async () => {
    if (!module) return;
    setBusy(true);
    setError('');
    setPhase('building');
    try {
      const cfg = await api.moduleFirmwareConfig(module.id);
      if (!cfg.config) {
        setHasConfig(false);
        setPhase('idle');
        setError('Нет сохранённой конфигурации. Один раз прошейте модуль по USB — дальше обновления пойдут по сети.');
        return;
      }
      const config: FirmwareConfig = cfg.config;
      const created = await api.buildFirmware(config);
      buildIdRef.current = created.id;
      // Ждём готовности сборки.
      for (let i = 0; i < 80; i += 1) {
        await new Promise((r) => setTimeout(r, 4000));
        const build = await api.firmwareBuild(created.id);
        if (build.status === 'failed') throw new Error(build.log || 'Не удалось собрать прошивку');
        if (build.status === 'ready') break;
        if (i === 79) throw new Error('Сборка прошивки занимает слишком долго');
      }
      const ota = await api.moduleOta(module.id, created.id);
      setPhase('queued');
      setProgress(0);
      toast({ kind: 'info', message: `Обновление ${ota.version} отправлено модулю` });
    } catch (e) {
      setPhase('failed');
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const finish = () => {
    buildIdRef.current = null;
    onClose();
  };

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={finish} statusBarTranslucent>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 16 }} onPress={finish}>
        <Pressable
          onPress={(event) => event.stopPropagation?.()}
          style={{ backgroundColor: theme.surface, borderRadius: 20, borderWidth: 1, borderColor: theme.glassBorder, padding: 18 }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: theme.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name="cloud-download-outline" size={22} color={theme.accent} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: theme.textPrimary, fontWeight: '800', fontSize: 17 }} numberOfLines={1}>
                {module?.name || module?.publicId || 'Модуль'}
              </Text>
              <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 2 }}>
                {module?.firmware || 'версия неизвестна'} · {module?.online ? 'онлайн' : 'офлайн'}
              </Text>
            </View>
            <Pressable onPress={finish} hitSlop={10} accessibilityRole="button" accessibilityLabel="Закрыть">
              <Ionicons name="close" size={20} color={theme.textDisabled} />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={{ gap: 12 }}>
            <Text style={{ color: theme.textSecondary, fontSize: 12.5, lineHeight: 18 }}>
              Приложение соберёт свежую прошивку из сохранённых настроек модуля и передаст её по сети. Файлы сборок не хранятся.
            </Text>

            {phase !== 'idle' ? (
              <View style={{ padding: 12, borderRadius: 14, backgroundColor: theme.surfacePressed, gap: 6 }}>
                <Text style={{ color: theme.textPrimary, fontSize: 13, fontWeight: '700' }}>{PHASE_LABEL[phase]}</Text>
                {['building', 'downloading', 'installing'].includes(phase) ? (
                  <View style={{ height: 6, borderRadius: 3, backgroundColor: theme.glassBorder, overflow: 'hidden' }}>
                    <View style={{ width: `${Math.max(4, progress)}%`, height: 6, backgroundColor: theme.accent }} />
                  </View>
                ) : null}
                {error ? <Text style={{ color: theme.danger, fontSize: 11.5 }}>{error}</Text> : null}
              </View>
            ) : null}

            {hasConfig === false ? (
              <View style={{ padding: 12, borderRadius: 14, backgroundColor: theme.surfacePressed, gap: 6 }}>
                <Text style={{ color: theme.textPrimary, fontSize: 12.5, fontWeight: '700' }}>Нужна первичная USB-прошивка</Text>
                <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 17 }}>
                  Один раз прошейте модуль по USB, чтобы сохранить его настройки. После этого обновления будут по сети.
                </Text>
                {Platform.OS === 'web' ? (
                  <Btn
                    title="Открыть USB-прошивку"
                    size="s"
                    onPress={() => {
                      finish();
                      router.push('/firmware' as never);
                    }}
                  />
                ) : null}
              </View>
            ) : null}

            <Btn
              title={busy ? 'Подготовка…' : phase === 'installed' ? 'Готово' : 'Обновить по сети'}
              loading={busy}
              disabled={busy || hasConfig === false || phase === 'installed'}
              onPress={() => (phase === 'installed' ? finish() : void startUpdate())}
            />
            {phase === 'failed' ? (
              <Btn title="Повторить" variant="ghost" disabled={busy} onPress={() => void startUpdate()} />
            ) : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
