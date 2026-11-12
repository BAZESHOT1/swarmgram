/**
 * Пошаговый визард прошивки ESP32-модуля.
 * Шаги 1–6 собирают конфиг, шаг 7 запускает сборку на Hub, шаг 8 —
 * Web Serial-прошивка или скачивание .bin. Ниже всегда видна история сборок.
 * Черновик сохраняется в localStorage под ключом sg:firmware-draft.
 */
import React from 'react';
import { Animated, Easing, Linking, Platform, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useRouter } from 'expo-router';
import { Btn } from '../Btn';
import { useTheme } from '../../theme/useTheme';
import { motion } from '../../theme/motion';
import { useReducedMotion } from '../useReducedMotion';
import { GlassCard } from '../settings/SettingsUI';
import { formatBytes, StatusBadge } from '../settings/SettingsWidgets';
import { BoardStep, ConnectivityStep, RoleStep } from './StepsBasic';
import { LoRaStep } from './LoRaStep';
import { BatteryStep } from './BatteryStep';
import { HubStep } from './HubStep';
import { ReviewStep } from './ReviewStep';
import { FlashStep } from './FlashStep';
import { HistorySection } from './HistorySection';
import { ErrorText, Note, WizardProgress } from './FirmwareUI';
import { useStore } from '../../state/useStore';
import { api } from '../../data/api';
import {
  DRAFT_KEY,
  boardPreset,
  buildFirmware,
  checkLoraPins,
  defaultConfig,
  downloadFirmware,
  firmwareBuild,
  firmwareBuilds,
  isReadyStatus,
  isTerminalStatus,
  pairModule,
  resolveDownloadUrl,
  validateConfig,
  type FirmwareBuild,
  type FirmwareConfig,
} from './types';

/**
 * Локальный тип сборки: сервер отдаёт progress/phase/startedAt, а тип в
 * ./types пока описывает только базовые поля. Расширение совместимо с ним
 * и не требует менять общий модуль.
 */
type WizardBuild = FirmwareBuild & {
  progress?: number;
  phase?: string;
  startedAt?: string | null;
};

/** Человекочитаемые фазы серверной сборки. */
const BUILD_PHASE_LABEL: Record<string, string> = {
  queued: 'В очереди',
  preparing: 'Подготовка',
  compiling: 'Компиляция',
  linking: 'Линковка',
  finalizing: 'Финализация',
  ready: 'Готово',
  failed: 'Ошибка',
  timeout: 'Таймаут',
};

function buildPhaseLabel(build: WizardBuild | null): string {
  if (!build) return BUILD_PHASE_LABEL.preparing;
  if (build.status === 'ready') return BUILD_PHASE_LABEL.ready;
  if (build.status === 'failed') return BUILD_PHASE_LABEL[build.phase ?? ''] ?? BUILD_PHASE_LABEL.failed;
  return BUILD_PHASE_LABEL[build.phase ?? ''] ?? (build.status === 'queued' ? BUILD_PHASE_LABEL.queued : 'Подготовка');
}

/**
 * Полоса прогресса, плавно доезжающая до нового значения (общий ProgressBar
 * перезапускает анимацию с нуля, из-за чего обновления каждые 4.5 с мигают).
 */
function BuildProgressBar({ pct }: { pct: number }) {
  const theme = useTheme();
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const value = React.useRef(new Animated.Value(clamped)).current;

  React.useEffect(() => {
    const animation = Animated.timing(value, {
      toValue: clamped,
      duration: 900,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [clamped, value]);

  return (
    <View
      style={{
        height: 6,
        borderRadius: 999,
        overflow: 'hidden',
        backgroundColor: theme.surfacePressed,
      }}
    >
      <Animated.View
        style={{
          height: '100%',
          borderRadius: 999,
          backgroundColor: theme.accent,
          width: value.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }),
        }}
      />
    </View>
  );
}

function readDraft(): FirmwareConfig | null {
  if (Platform.OS !== 'web' || typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FirmwareConfig>;
    const base = defaultConfig();
    const board = parsed.board === 'esp32' || parsed.board === 'esp32s3' || parsed.board === 'esp32c3' ? parsed.board : base.board;
    return {
      ...base,
      ...parsed,
      board,
      wifi: { ...base.wifi!, ...(parsed.wifi ?? {}) },
      lora: {
        ...base.lora!,
        ...(parsed.lora ?? {}),
        pins: { ...base.lora!.pins, ...(parsed.lora?.pins ?? {}) },
      },
      battery: { ...base.battery!, ...(parsed.battery ?? {}) },
    };
  } catch {
    return null;
  }
}

function saveDraft(config: FirmwareConfig): void {
  if (Platform.OS !== 'web' || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(config));
  } catch {
    /* приватный режим или переполнение — черновик просто не сохранится */
  }
}

function openDownload(url: string): void {
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.rel = 'noopener';
    anchor.target = '_blank';
    anchor.click();
    return;
  }
  void Linking.openURL(url).catch(() => undefined);
}

/** Экран «Готово» после прошивки. */
function SuccessStep({
  config,
  build,
  onAgain,
}: {
  config: FirmwareConfig;
  build: FirmwareBuild | null;
  onAgain: () => void;
}) {
  const theme = useTheme();
  const router = useRouter();
  const preset = boardPreset(config.board);
  const checks = [
    { icon: 'list-outline' as const, text: 'Модуль появится в списке «Модули» после первого check-in — обновите список через минуту.' },
    { icon: 'power-outline' as const, text: 'Проверьте питание: стабильные 3.3 В или USB, без просадок при передаче по LoRa.' },
    {
      icon: 'radio-outline' as const,
      text:
        config.connectivity === 'wifi_lora'
          ? `Подключите антенну LoRa на ${config.lora?.frequencyMhz ?? 433} МГц — без неё передатчик может выйти из строя.`
          : 'Антенна LoRa не нужна: модуль работает только через Wi-Fi mesh.',
    },
  ];
  return (
    <View>
      <GlassCard>
        <View style={{ padding: 18, alignItems: 'center' }}>
          <View
            style={{
              width: 62,
              height: 62,
              borderRadius: 31,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: theme.successSoft,
              marginBottom: 12,
            }}
          >
            <Ionicons name="checkmark-done" size={32} color={theme.success} />
          </View>
          <Text style={{ color: theme.textPrimary, fontSize: 20, fontWeight: '800', textAlign: 'center' }}>
            Прошивка установлена
          </Text>
          <Text style={{ color: theme.textSecondary, fontSize: 12.5, lineHeight: 18, marginTop: 6, textAlign: 'center' }}>
            {preset.title}
            {build?.version ? ` · версия ${build.version}` : ''}
            {build?.sizeBytes ? ` · ${formatBytes(build.sizeBytes)}` : ''}
          </Text>
        </View>
      </GlassCard>

      <View style={{ height: 12 }} />

      <GlassCard>
        <View style={{ padding: 13, gap: 11 }}>
          {checks.map((check) => (
            <View key={check.text} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 9 }}>
              <View
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 8,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: theme.successSoft,
                }}
              >
                <Ionicons name={check.icon} size={14} color={theme.success} />
              </View>
              <Text style={{ color: theme.textSecondary, fontSize: 12.5, lineHeight: 18, flex: 1 }}>{check.text}</Text>
            </View>
          ))}
        </View>
      </GlassCard>

      <View style={{ height: 14 }} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Btn title="К модулям" onPress={() => router.replace('/modules' as never)} />
        </View>
        <View style={{ flex: 1 }}>
          <Btn title="Прошить ещё" variant="ghost" onPress={onAgain} />
        </View>
      </View>
    </View>
  );
}

export function FirmwareWizard() {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const [config, setConfig] = React.useState<FirmwareConfig>(() => defaultConfig());
  const [hydrated, setHydrated] = React.useState(false);
  const [step, setStep] = React.useState(1);
  const [stepError, setStepError] = React.useState('');

  const [build, setBuild] = React.useState<WizardBuild | null>(null);
  const [building, setBuilding] = React.useState(false);
  const [buildError, setBuildError] = React.useState('');
  const [buildStartedAt, setBuildStartedAt] = React.useState<number | null>(null);
  const [pollActive, setPollActive] = React.useState(false);
  const [historyToken, setHistoryToken] = React.useState(0);
  const [downloadError, setDownloadError] = React.useState('');

  // Черновик: читаем один раз при монтировании.
  React.useEffect(() => {
    const draft = readDraft();
    if (draft) setConfig(draft);
    setHydrated(true);
  }, []);

  React.useEffect(() => {
    if (hydrated) saveDraft(config);
  }, [config, hydrated]);

  // Поллинг сборки: детали каждые 2 с, при ошибке — список сборок.
  React.useEffect(() => {
    if (!build?.id || !pollActive) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (buildStartedAt && Date.now() - buildStartedAt > 15 * 60 * 1000) {
        setBuildError('Сборка идёт слишком долго (более 15 минут). Проверьте сборщик и попробуйте снова.');
        setBuild((prev) => (prev ? { ...prev, status: 'failed' } : prev));
        setPollActive(false);
        return;
      }
      try {
        let detail: WizardBuild | null = null;
        try {
          detail = await firmwareBuild(build.id);
        } catch {
          const list = await firmwareBuilds();
          detail = list.find((item) => item.id === build.id) ?? null;
        }
        if (cancelled) return;
        if (detail) {
          setBuildError('');
          setBuild((prev) => ({ ...(prev ?? { id: build.id, status: 'queued' }), ...detail }));
          if (isTerminalStatus(detail.status)) {
            setPollActive(false);
            setHistoryToken((value) => value + 1);
            return;
          }
        }
      } catch (error) {
        if (cancelled) return;
        setBuildError(error instanceof Error ? error.message : String(error));
      }
      if (!cancelled) timer = setTimeout(tick, 2000);
    };

    timer = setTimeout(tick, 2000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [build?.id, pollActive, buildStartedAt]);

  const patch = (next: Partial<FirmwareConfig>) => {
    setConfig((prev) => ({ ...prev, ...next }));
    if (stepError) setStepError('');
    // Любая правка конфигурации делает прежнюю сборку неактуальной.
    if (build) {
      setBuild(null);
      setBuildStartedAt(null);
      setPollActive(false);
      setBuildError('');
    }
  };

  const goTo = (next: number) => {
    setStep(next);
    setStepError('');
  };

  const validateStep = (value: number): string | null => {
    if (value === 4 && config.connectivity === 'wifi_lora' && config.lora) {
      const error = checkLoraPins(config.lora, config.board, config.battery?.enabled ? config.battery.pin : undefined).find(
        (issue) => issue.kind === 'error',
      );
      if (error) return error.message;
    }
    if (value === 5 && config.battery?.enabled) {
      if (!Number.isFinite(config.battery.ratio) || config.battery.ratio <= 1) {
        return 'Коэффициент делителя должен быть больше 1 (для 1:1 — 2.0).';
      }
      if (!Number.isInteger(config.battery.pin) || config.battery.pin < 0 || config.battery.pin > 48) {
        return 'Пин АЦП батареи должен быть целым числом 0–48.';
      }
    }
    if (value === 6) {
      if (!config.wifi?.ssid.trim()) return 'Укажите SSID Wi-Fi сети.';
      if (!config.hubUrl || !/^https?:\/\/[^\s]+$/i.test(config.hubUrl.trim())) {
        return 'URL Hub должен начинаться с http:// или https://.';
      }
      const token = (config.moduleToken ?? '').trim();
      if (token && token.length < 8) return 'Токен модуля слишком короткий — минимум 8 символов.';
    }
    return null;
  };

  const next = () => {
    const error = validateStep(step);
    if (error) {
      setStepError(error);
      return;
    }
    if (step === 3 && config.connectivity === 'wifi') {
      goTo(5); // шаг LoRa пропускаем
      return;
    }
    if (step === 6) {
      const overall = validateConfig(config);
      if (overall) {
        setStepError(overall);
        return;
      }
    }
    goTo(Math.min(8, step + 1));
  };

  const back = () => {
    if (step === 5 && config.connectivity === 'wifi') {
      goTo(3);
      return;
    }
    goTo(Math.max(1, step - 1));
  };

  const startBuild = async () => {
    setBuildError('');
    setDownloadError('');
    const overall = validateConfig(config);
    if (overall) {
      setBuildError(overall);
      return;
    }
    setBuilding(true);
    try {
      const result = await buildFirmware(config);
      if (!result?.id) throw new Error('Hub не вернул идентификатор сборки.');
      setBuild({ id: result.id, status: result.status || 'queued', progress: 0, phase: 'queued' });
      setBuildStartedAt(Date.now());
      setPollActive(true);
    } catch (error) {
      setBuildError(error instanceof Error ? error.message : String(error));
    } finally {
      setBuilding(false);
    }
  };

  const download = async (target: FirmwareBuild | null) => {
    if (!target?.id) {
      setDownloadError('Скачивать пока нечего: сначала соберите прошивку.');
      return;
    }
    setDownloadError('');
    try {
      const path = await downloadFirmware(target.id);
      openDownload(resolveDownloadUrl(path));
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : String(error));
    }
  };

  const currentBoard = boardPreset(config.board);

  const stepBody = (() => {
    switch (step) {
      case 1:
        return <BoardStep config={config} onChange={patch} />;
      case 2:
        return <RoleStep config={config} onChange={patch} />;
      case 3:
        return <ConnectivityStep config={config} onChange={patch} />;
      case 4:
        return <LoRaStep config={config} onChange={patch} />;
      case 5:
        return <BatteryStep config={config} onChange={patch} />;
      case 6:
        return <HubStep config={config} onChange={patch} firmwareVersion={build?.version} />;
      case 7:
        return (
          <View>
            {build && !isTerminalStatus(build.status) ? (
              <View style={{ marginBottom: 14 }}>
                <GlassCard>
                  <View style={{ padding: 13 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text style={{ color: theme.textPrimary, fontSize: 12.5, fontWeight: '700' }}>
                        {buildPhaseLabel(build)}
                      </Text>
                      <Text
                        style={{
                          color: theme.textSecondary,
                          fontSize: 11.5,
                          fontVariant: ['tabular-nums'] as never,
                        }}
                      >
                        {Math.round(Math.max(0, Math.min(100, build.progress ?? 0)))}%
                      </Text>
                    </View>
                    <View style={{ height: 8 }} />
                    <BuildProgressBar pct={build.progress ?? 0} />
                  </View>
                </GlassCard>
              </View>
            ) : null}
            <ReviewStep
              config={config}
              build={build}
              building={building}
              buildError={buildError}
              buildStartedAt={buildStartedAt}
              onEditStep={goTo}
              onBuild={() => void startBuild()}
              onGoFlash={() => goTo(8)}
              onDownload={() => void download(build)}
            />
          </View>
        );
      case 8:
        return (
          <FlashStep
            build={build}
            onDownload={() => void download(build)}
            onDone={() => goTo(9)}
            onFlashed={async (hardwareId) => {
              // Мягкая привязка: чужой модуль не отбираем, а создаём заявку.
              const paired = await pairModule({
                boardUuid: hardwareId,
                kind: config.connectivity === 'wifi_lora' ? 'lora' : 'wifi',
                firmware: build?.version ?? '',
              });
              if (paired?.pendingTransfer) {
                useStore.getState().pushToast({
                  kind: 'error',
                  message: 'Модуль принадлежит другому пользователю. Заявка на перенос отправлена.',
                });
                return;
              }
              // Носимый модуль после USB-прошивки физически подключён к клиенту.
              if (config.role === 'wearable') {
                const moduleId = (await api.listModules()).find(
                  (m) => (m.hardwareId || m.board_uuid || '').toLowerCase() === hardwareId.toLowerCase(),
                )?.id;
                if (moduleId) await api.attachModule(moduleId, 'usb').catch(() => undefined);
              }
              useStore.getState().pushToast({ kind: 'success', message: 'Модуль привязан к аккаунту' });
            }}
          />
        );
      case 9:
        return <SuccessStep config={config} build={build} onAgain={() => {
          setBuild(null);
          setBuildStartedAt(null);
          setPollActive(false);
          setBuildError('');
          goTo(1);
        }} />;
      default:
        return null;
    }
  })();

  const stepTitles = [
    '',
    'Плата',
    'Роль модуля',
    'Связь',
    'LoRa',
    'Батарея',
    'Hub и привязка',
    'Проверка',
    'Прошивка',
    'Готово',
  ];

  const showNav = step <= 8;
  const nextDisabled = step === 7 && !isReadyStatus(build?.status);

  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, paddingHorizontal: 2 }}>
        <Text style={{ color: theme.textPrimary, fontSize: 13, fontWeight: '700' }}>
          {step <= 8 ? stepTitles[step] : 'Готово'}
        </Text>
        <Text style={{ color: theme.textDisabled, fontSize: 11.5 }}>
          {currentBoard.short}
        </Text>
      </View>
      {step <= 8 ? (
        <WizardProgress
          step={step}
          onStepPress={(value) => {
            // Вперёд — только через «Далее», чтобы не пропустить валидацию шагов.
            if (value <= step) goTo(value);
          }}
        />
      ) : null}

      {downloadError ? <ErrorText>{downloadError}</ErrorText> : null}

      <MotiView
        key={step}
        from={reduced ? { opacity: 0 } : { opacity: 0, translateX: 14 }}
        animate={{ opacity: 1, translateX: 0 }}
        transition={reduced ? { type: 'timing', duration: 0 } : motion.spring}
      >
        {stepBody}
      </MotiView>

      {stepError ? (
        <View style={{ marginTop: 12 }}>
          <ErrorText>{stepError}</ErrorText>
        </View>
      ) : null}

      {showNav ? (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 16 }}>
          {step > 1 ? (
            <View style={{ flex: 1 }}>
              <Btn title="Назад" variant="ghost" onPress={back} />
            </View>
          ) : null}
          {step < 8 ? (
            <View style={{ flex: 1.4 }}>
              <Btn
                title={step === 7 ? 'К прошивке' : 'Далее'}
                disabled={nextDisabled}
                onPress={next}
              />
            </View>
          ) : null}
        </View>
      ) : null}

      {step === 7 && !isReadyStatus(build?.status) ? (
        <View style={{ marginTop: 8 }}>
          <Note icon="time-outline" tone="neutral">
            Кнопка «К прошивке» станет активной после статуса «готова». Если сборка упала — исправьте конфигурацию и запустите заново.
          </Note>
        </View>
      ) : null}

      <View style={{ height: 26 }} />

      {step === 9 && build ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10, paddingHorizontal: 2 }}>
          <StatusBadge text="прошивка установлена" tone="success" />
          {build.version ? <StatusBadge text={`v${build.version}`} tone="neutral" /> : null}
        </View>
      ) : null}

      <HistorySection
        refreshToken={historyToken}
        onReflash={(target) => {
          setBuild(target);
          setBuildStartedAt(null);
          setPollActive(false);
          goTo(8);
        }}
        onDownload={(target) => void download(target)}
      />
    </View>
  );
}
