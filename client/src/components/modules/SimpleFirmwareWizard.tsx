/**
 * Упрощённый визард прошивки для сценария «модуль нужно прошить».
 *
 * Отличия от полного FirmwareWizard:
 *  - сначала тип модуля, затем плата, связь, батарея и (для шлюза) Wi-Fi;
 *  - нет шага Hub/привязки, токенов, пинов LoRa и SSID mesh-сети;
 *  - после сборки — FlashStep и показ 8-значного публичного ID.
 *
 * Глобальные параметры (SG-MESH, канал 11, 869.525 МГц) подставляет сервер,
 * поэтому в интерфейсе они только для чтения.
 */
import React from 'react';
import { Linking, Platform, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Btn } from '../Btn';
import { useTheme } from '../../theme/useTheme';
import { GlassCard, SettingsToggle } from '../settings/SettingsUI';
import { SettingsInput, StatusBadge } from '../settings/SettingsWidgets';
import {
  BOARDS,
  boardPreset,
  recommendedBatteryPin,
  recommendedPins,
} from '../firmware/types';
import { FlashStep } from '../firmware/FlashStep';
import { ChoiceCard, ErrorText, Note, StepCard } from '../firmware/FirmwareUI';
import { api, type FirmwareBoard, type FirmwareConfig, type FirmwareBuild, type FirmwareRole } from '../../data/api';
import { kv } from '../../crypto/storage';
import { useModuleConnection } from '../../modules/ModuleProvider';
import { writeLastModule } from '../../modules/types';
import { MESH_ALWAYS } from './moduleUi';

export interface SimpleFirmwareResult {
  hardwareId: string;
  publicId?: string;
  moduleId?: string;
  /** Роль, выбранная в мастере прошивки. */
  role: FirmwareRole;
}

type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
type LinkChoice = 'wifi' | 'wifi_lora';

const ROLE_OPTIONS: Array<{
  id: FirmwareRole;
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
  description: string;
}> = [
  {
    id: 'wearable',
    icon: 'watch-outline',
    title: 'Носимый',
    subtitle: 'подключается к клиенту по BLE/USB',
    description: 'Связывает клиента с mesh-сетью напрямую. Носите с собой или закрепите рядом.',
  },
  {
    id: 'repeater',
    icon: 'radio-outline',
    title: 'Ретранслятор',
    subtitle: 'расширяет покрытие',
    description: 'Повторяет сигнал между модулями. Достаточно питания, интернет не обязателен.',
  },
  {
    id: 'gateway',
    icon: 'git-network-outline',
    title: 'Шлюз',
    subtitle: 'выходит в интернет',
    description: 'Подключается к вашему Wi-Fi-роутеру и передаёт сообщения mesh-сети на Hub.',
  },
];

export function SimpleFirmwareWizard({
  initialRole,
  onCancel,
  onComplete,
  onStepChange,
}: {
  initialRole?: FirmwareRole;
  onCancel: () => void;
  onComplete: (result: SimpleFirmwareResult) => void;
  /** Сообщает внешнему мастеру текущий шаг: 7 — прошивка, закрывать нельзя. */
  onStepChange?: (step: number) => void;
}) {
  const theme = useTheme();
  const moduleConnection = useModuleConnection();

  const [step, setStep] = React.useState<Step>(initialRole ? 2 : 1);
  const [role, setRole] = React.useState<FirmwareRole>(initialRole ?? 'wearable');
  const [board, setBoard] = React.useState<FirmwareBoard>('esp32c3');
  const [link, setLink] = React.useState<LinkChoice>('wifi');
  const [battery, setBattery] = React.useState(true);
  const [batteryPin, setBatteryPin] = React.useState<number>(recommendedBatteryPin('esp32c3'));
  const [ssid, setSsid] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [stepError, setStepError] = React.useState('');

  const [availableBoards, setAvailableBoards] = React.useState<FirmwareBoard[] | null>(null);
  const [build, setBuild] = React.useState<FirmwareBuild | null>(null);
  const buildStartedAtRef = React.useRef(0);
  const buildErrorCountRef = React.useRef(0);
  const [building, setBuilding] = React.useState(false);
  const [buildError, setBuildError] = React.useState('');
  const [result, setResult] = React.useState<SimpleFirmwareResult | null>(null);
  const [readError, setReadError] = React.useState('');

  // Сообщаем внешнему мастеру шаг — на шаге прошивки он блокирует закрытие.
  React.useEffect(() => {
    onStepChange?.(step);
  }, [step, onStepChange]);

  // Какие платы реально умеет серверный сборщик (если он отвечает).
  React.useEffect(() => {
    let alive = true;
    void api
      .firmwareBuilderStatus()
      .then((status) => {
        if (!alive) return;
        const boards = (status.boards ?? []).filter((value): value is FirmwareBoard =>
          value === 'esp32c3' || value === 'esp32' || value === 'esp32s3',
        );
        if (boards.length) {
          setAvailableBoards(boards);
          if (!boards.includes(board)) setBoard(boards[0]);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Поллинг сборки. Core 3.x первая сборка может идти несколько минут;
  // после 15 минут показываем честную ошибку вместо вечного «сборка…».
  // Важно: именно setInterval, а не один setTimeout — иначе статус
  // «building» не меняется, эффект не перезапускается и опрос замирает.
  React.useEffect(() => {
    if (!build?.id || build.status === 'ready' || build.status === 'failed') return undefined;
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      const elapsed = Date.now() - (buildStartedAtRef.current || Date.now());
      if (elapsed > 15 * 60 * 1000) {
        setBuildError('Сборка идёт слишком долго (более 15 минут). Проверьте сборщик и попробуйте снова.');
        setBuild((prev) => (prev ? { ...prev, status: 'failed' } : prev));
        return;
      }
      try {
        const next = await api.firmwareBuild(build.id);
        if (cancelled) return;
        buildErrorCountRef.current = 0;
        setBuildError('');
        setBuild(next);
      } catch (error) {
        if (cancelled) return;
        buildErrorCountRef.current += 1;
        if (buildErrorCountRef.current >= 5) {
          setBuildError(
            `Не удаётся получить статус сборки: ${error instanceof Error ? error.message : String(error)}. Нажмите «Повторить».`,
          );
          setBuild((prev) => (prev ? { ...prev, status: 'failed' } : prev));
        }
      }
    };

    const timer = setInterval(() => void tick(), 2000);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [build?.id, build?.status]);

  const boardAvailable = React.useCallback(
    (id: FirmwareBoard) => !availableBoards || availableBoards.includes(id),
    [availableBoards],
  );
  // Показываем все платы, но недоступные на сервере помечаем и не даём выбрать.
  const boards = BOARDS;

  const usbHint = (id: FirmwareBoard): string => {
    if (id === 'esp32') return 'USB: micro-USB (обычно CP210x). Для прошивки подойдёт и UART-переходник.';
    if (id === 'esp32s3') return 'USB: нативный USB-OTG — используйте USB-порт, а не UART.';
    return 'USB: нативный USB-C, драйвер не нужен.';
  };

  const go = (next: Step) => {
    setStep(next);
    setStepError('');
  };

  const next = () => {
    if (step === 1) return go(2);
    if (step === 2) {
      if (!boardAvailable(board)) {
        setStepError('Эта плата не установлена на сервере сборки — выберите другую.');
        return;
      }
      return go(3);
    }
    if (step === 3) return go(4);
    if (step === 4) return go(role === 'gateway' ? 5 : 6);
    if (step === 5) {
      if (!ssid.trim()) {
        setStepError('Укажите SSID вашего Wi-Fi-роутера — шлюзу нужен интернет.');
        return;
      }
      return go(6);
    }
    if (step === 6) {
      const error = validate();
      if (error) {
        setStepError(error);
        return;
      }
      if (build?.status === 'ready') go(7);
      else if (!build || build.status === 'failed') void startBuild();
      return;
    }
    return undefined;
  };

  const back = () => {
    if (step === 6) return go(role === 'gateway' ? 5 : 4);
    if (step === 5) return go(4);
    if (step === 7) return go(6);
    if (step === 8) return go(6);
    return go(Math.max(1, step - 1) as Step);
  };

  const validate = (): string | null => {
    if (!boardAvailable(board)) return 'Выбранная плата не установлена на сервере сборки. Выберите доступную плату.';
    if (role === 'gateway' && !ssid.trim()) return 'Укажите SSID Wi-Fi-роутера.';
    return null;
  };

  const makeConfig = (): FirmwareConfig => ({
    board,
    role,
    connectivity: link,
    wifi: role === 'gateway' ? { ssid: ssid.trim(), password } : undefined,
    // Глобальные mesh-параметры и Hub URL подставляет сервер.
    lora:
      link === 'wifi_lora'
        ? {
            chip: 'sx1278',
            frequencyMhz: 868,
            spreadingFactor: 9,
            bandwidthKhz: 125,
            syncWord: 0x12,
            pins: recommendedPins(board),
          }
        : undefined,
    battery: {
      enabled: battery,
      pin: batteryPin,
      ratio: 2,
      intervalSec: 900,
    },
    ota: true,
  });

  const startBuild = async () => {
    const error = validate();
    if (error) {
      setStepError(error);
      return;
    }
    setBuildError('');
    setStepError('');
    setBuilding(true);
    try {
      const created = await api.buildFirmware(makeConfig());
      buildStartedAtRef.current = Date.now();
      buildErrorCountRef.current = 0;
      setBuild({ id: created.id, status: created.status } as FirmwareBuild);
    } catch (buildFail) {
      setBuildError(buildFail instanceof Error ? buildFail.message : String(buildFail));
    } finally {
      setBuilding(false);
    }
  };

  const download = async () => {
    if (!build?.id) return;
    try {
      const url = api.downloadFirmware(build.id);
      if (Platform.OS === 'web' && typeof document !== 'undefined') {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.rel = 'noopener';
        anchor.target = '_blank';
        anchor.click();
      } else {
        await Linking.openURL(url);
      }
    } catch {
      /* ошибка скачивания не блокирует ручную прошивку */
    }
  };

  /** После записи: мягкая привязка и сохранение последнего модуля. */
  const handleFlashed = async (hardwareId: string) => {
    let moduleId: string | undefined;
    let publicId: string | undefined;
    try {
      const paired = await api.pairModule({
        hardwareId,
        role,
        transport: role === 'wearable' ? 'usb' : link === 'wifi' ? 'wifi' : 'lora',
        kind: link === 'wifi' ? 'wifi' : 'lora',
        firmware: build?.version ?? '',
        battery: undefined,
      });
      moduleId = paired.id;
      publicId = paired.publicId;
      if (role === 'wearable' && paired.id) {
        await api.attachModule(paired.id, 'usb').catch(() => undefined);
      }
    } catch (pairError) {
      // Прошивка уже записана: не теряем результат, привяжем при подключении.
      setBuildError(
        pairError instanceof Error
          ? `Прошивка записана, но привязка не удалась: ${pairError.message}`
          : 'Прошивка записана, но привязка не удалась.',
      );
    }
    if (!publicId) {
      try {
        const list = await api.listModules();
        const row = list.find(
          (item) => (item.hardwareId ?? item.boardUuid ?? item.board_uuid ?? '').toLowerCase() === hardwareId.toLowerCase(),
        );
        publicId = row?.publicId;
        moduleId = moduleId ?? row?.id;
      } catch {
        /* сервер может ещё не отдать publicId — покажем подсказку */
      }
    }
    await writeLastModule(kv, {
      hardwareId,
      publicId,
      moduleId,
      role,
      kind: 'usb',
    });
    setResult({ hardwareId, publicId, moduleId, role });
    // Сразу показываем ID, не дожидаясь авто-перехода FlashStep.
    go(8);
  };

  /** Если API не вернул ID — можно прочитать его из INFO по USB. */
  const readPublicId = async () => {
    setReadError('');
    const info = await moduleConnection.connectUsb();
    if (!info) {
      setReadError(moduleConnection.getLastError() ?? moduleConnection.error ?? 'Не удалось прочитать ID модуля.');
      return;
    }
    setResult((prev) => ({
      hardwareId: info.hardwareId,
      publicId: info.publicId,
      moduleId: prev?.moduleId,
      role: (prev?.role ?? role) as FirmwareRole,
    }));
  };

  const summaryRows = [
    { label: 'Тип', value: ROLE_OPTIONS.find((item) => item.id === role)?.title ?? role },
    { label: 'Плата', value: boardPreset(board).title },
    { label: 'Связь', value: link === 'wifi' ? 'Wi-Fi mesh' : 'Wi-Fi mesh + LoRa' },
    { label: 'Батарея', value: battery ? 'включена · делитель 1:1' : 'выключена' },
    ...(role === 'gateway' ? [{ label: 'Роутер', value: ssid.trim() || '—' }] : []),
  ];

  const stepBody = (() => {
    switch (step) {
      case 1:
        return (
          <View>
            <Note icon="hardware-chip-outline" tone="accent">
              Сначала выберите, чем будет модуль в единой mesh-сети. Это определит прошивку и способ подключения.
            </Note>
            {initialRole ? (
              <>
                <ChoiceCard
                  icon={ROLE_OPTIONS.find((item) => item.id === role)?.icon ?? 'hardware-chip-outline'}
                  title={ROLE_OPTIONS.find((item) => item.id === role)?.title ?? role}
                  subtitle="роль зафиксирована на предыдущем шаге"
                  description="При прошивке роль не меняется — вернитесь в мастер подключения, если выбрали её ошибочно."
                  selected
                  onPress={() => undefined}
                />
                <Note icon="lock-closed-outline" tone="neutral">
                  Роль уже выбрана в мастере подключения и останется неизменной для этой прошивки.
                </Note>
              </>
            ) : (
              ROLE_OPTIONS.map((option) => (
                <ChoiceCard
                  key={option.id}
                  icon={option.icon}
                  title={option.title}
                  subtitle={option.subtitle}
                  description={option.description}
                  selected={role === option.id}
                  onPress={() => setRole(option.id)}
                />
              ))
            )}
          </View>
        );
      case 2:
        return (
          <View>
            <Note icon="hardware-chip-outline" tone="neutral">
              {availableBoards?.length
                ? 'Серверный сборщик поддерживает не все платы: недоступные помечены и не выбираются. ESP32 Lite и ESP32-S3 подключайте по USB; для Lite может понадобиться драйвер CP210x.'
                : 'Доступность плат на сервере не определена. ESP32 Lite прошивается по micro-USB (CP210x), ESP32-S3 — по нативному USB-OTG, ESP32-C3 — по USB-C.'}
            </Note>
            {boards.map((item) => {
              const available = boardAvailable(item.id);
              return (
                <ChoiceCard
                  key={item.id}
                  icon={item.icon}
                  title={item.title}
                  subtitle={item.short}
                  description={`${item.description} ${usbHint(item.id)}`}
                  selected={board === item.id && available}
                  right={
                    available ? undefined : (
                      <StatusBadge text="не установлена на сервере" tone="warning" />
                    )
                  }
                  onPress={() => {
                    if (!available) {
                      setStepError(
                        `Плата «${item.title}» не установлена на сервере сборки. Выберите другую или установите поддержку на Hub.`,
                      );
                      return;
                    }
                    setBoard(item.id);
                    setBatteryPin(recommendedBatteryPin(item.id));
                    setStepError('');
                  }}
                />
              );
            })}
          </View>
        );
      case 3:
        return (
          <View>
            <ChoiceCard
              icon="wifi-outline"
              title="Wi-Fi mesh"
              subtitle="проще · без LoRa-модуля"
              description="Модуль работает через Wi-Fi и BLE. Антенна LoRa не нужна."
              selected={link === 'wifi'}
              onPress={() => setLink('wifi')}
            />
            <ChoiceCard
              icon="cellular-outline"
              title="Wi-Fi + LoRa"
              subtitle="дальняя связь · нужен SX1278"
              description="Добавляет дальний радиоканал. Понадобится антенна на 869 МГц."
              selected={link === 'wifi_lora'}
              onPress={() => setLink('wifi_lora')}
            />
            <ChoiceCard
              icon="radio-outline"
              title="Только LoRa"
              subtitle="пока недоступно"
              description="Серверная сборка ещё не поддерживает режим без Wi-Fi. Выберите Wi-Fi mesh или Wi-Fi + LoRa."
              selected={false}
              onPress={() => setStepError('Режим «только LoRa» пока не поддерживается сборщиком.')}
            />
          </View>
        );
      case 4:
        return (
          <View>
            <StepCard>
              <SettingsToggle
                icon="battery-charging-outline"
                title="Отправлять заряд батареи"
                subtitle="появится в списке модулей"
                value={battery}
                onValueChange={setBattery}
              />
              {battery ? (
                <View style={{ paddingHorizontal: 10, paddingBottom: 10 }}>
                  <SettingsInput
                    label="Пин делителя напряжения (ADC)"
                    value={String(batteryPin)}
                    onChangeText={(text) => {
                      const parsed = Number(text.trim());
                      if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 48) setBatteryPin(parsed);
                    }}
                    keyboardType="numeric"
                    placeholder="0–48"
                    accessibilityLabel="Пин делителя напряжения"
                    maxLength={2}
                  />
                  <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 18, marginTop: -4 }}>
                    Рекомендуемый для платы: GPIO {recommendedBatteryPin(board)}. Делитель 1:1 (коэффициент 2.0).
                  </Text>
                </View>
              ) : null}
            </StepCard>
            <View style={{ height: 10 }} />
            <Note icon="information-circle-outline" tone="neutral">
              Параметры LoRa (869.525 МГц, SF9, BW125) и канал mesh (11) задаёт сервер.
            </Note>
          </View>
        );
      case 5:
        return (
          <View>
            <Note icon="wifi-outline" tone="accent">
              Шлюзу нужен доступ в интернет. Укажите данные вашего домашнего или офисного Wi-Fi — они попадут только в прошивку.
            </Note>
            <SettingsInput
              label="SSID роутера"
              value={ssid}
              onChangeText={(value) => {
                setSsid(value);
                if (stepError) setStepError('');
              }}
              placeholder="например, HomeWiFi"
              autoCapitalize="none"
              maxLength={32}
              accessibilityLabel="SSID Wi-Fi роутера"
            />
            <SettingsInput
              label="Пароль Wi-Fi"
              value={password}
              onChangeText={setPassword}
              placeholder="пароль роутера"
              secureTextEntry
              autoCapitalize="none"
              maxLength={64}
              accessibilityLabel="Пароль Wi-Fi роутера"
            />
          </View>
        );
      case 6:
        return (
          <View>
            <GlassCard>
              <View style={{ padding: 12, gap: 8 }}>
                {summaryRows.map((row) => (
                  <View key={row.label} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
                    <Text style={{ color: theme.textSecondary, fontSize: 12 }}>{row.label}</Text>
                    <Text style={{ color: theme.textPrimary, fontSize: 12.5, fontWeight: '600', flex: 1, textAlign: 'right' }} numberOfLines={1}>
                      {row.value}
                    </Text>
                  </View>
                ))}
                <View style={{ height: 1, backgroundColor: theme.line, marginVertical: 3 }} />
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                  <Ionicons name="git-network-outline" size={14} color={theme.accent} />
                  <Text style={{ color: theme.textSecondary, fontSize: 11.5, flex: 1 }}>
                    {MESH_ALWAYS.networkLine}
                  </Text>
                </View>
              </View>
            </GlassCard>
            <View style={{ height: 12 }} />
            {buildError ? <ErrorText>{buildError}</ErrorText> : null}
            {build ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <StatusBadge
                  text={
                    build.status === 'ready'
                      ? 'сборка готова'
                      : build.status === 'failed'
                        ? 'ошибка сборки'
                        : build.status === 'building'
                          ? 'сборка…'
                          : 'в очереди'
                  }
                  tone={build.status === 'ready' ? 'success' : build.status === 'failed' ? 'danger' : 'accent'}
                />
                {build.version ? <StatusBadge text={`v${build.version}`} tone="neutral" /> : null}
              </View>
            ) : null}
            <Btn
              title={
                build?.status === 'ready'
                  ? 'Сборка готова'
                  : build?.status === 'failed'
                    ? 'Пересобрать'
                    : build
                      ? 'Сборка идёт…'
                      : 'Собрать прошивку'
              }
              loading={building || build?.status === 'building' || build?.status === 'queued'}
              disabled={build?.status === 'ready' || build?.status === 'building' || build?.status === 'queued'}
              onPress={() => void startBuild()}
            />
            {build?.status === 'ready' ? (
              <Text style={{ color: theme.textDisabled, fontSize: 11.5, marginTop: 8, lineHeight: 17 }}>
                Нажмите «К прошивке», подключите плату по USB и запишите .bin.
              </Text>
            ) : null}
          </View>
        );
      case 7:
        return (
          <FlashStep
            build={build}
            onDownload={() => void download()}
            onDone={() => {
              // Если MAC прочитать не удалось, всё равно показываем итог:
              // ID можно прочитать по USB отдельной кнопкой.
              if (!result) setResult({ hardwareId: '', role });
              go(8);
            }}
            onFlashed={handleFlashed}
          />
        );
      case 8:
        return (
          <View>
            <GlassCard>
              <View style={{ padding: 18, alignItems: 'center' }}>
                <View
                  style={{
                    width: 58,
                    height: 58,
                    borderRadius: 29,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: theme.successSoft,
                    marginBottom: 10,
                  }}
                >
                  <Ionicons name="checkmark-done" size={30} color={theme.success} />
                </View>
                <Text style={{ color: theme.textPrimary, fontSize: 18, fontWeight: '800', textAlign: 'center' }}>
                  Прошивка установлена
                </Text>
                {result?.publicId ? (
                  <>
                    <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 10 }}>8-значный ID модуля</Text>
                    <Text
                      selectable
                      style={{
                        color: theme.accent,
                        fontSize: 26,
                        fontWeight: '800',
                        letterSpacing: 4,
                        marginTop: 4,
                        fontVariant: ['tabular-nums'] as never,
                      }}
                    >
                      {result.publicId}
                    </Text>
                    <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 6, textAlign: 'center' }}>
                      Сохраните ID — по нему модуль добавляется на другом устройстве.
                    </Text>
                  </>
                ) : (
                  <>
                    <Text style={{ color: theme.textSecondary, fontSize: 12.5, marginTop: 8, textAlign: 'center', lineHeight: 18 }}>
                      ID появится после первого подключения модуля. Можно прочитать его по USB прямо сейчас.
                    </Text>
                    <View style={{ height: 10 }} />
                    <Btn title="Прочитать ID по USB" size="s" variant="ghost" onPress={() => void readPublicId()} />
                    {readError ? <Text style={{ color: theme.danger, fontSize: 11.5, marginTop: 8 }}>{readError}</Text> : null}
                  </>
                )}
                <Text style={{ color: theme.textDisabled, fontSize: 10.5, marginTop: 12, fontVariant: ['tabular-nums'] as never }}>
                  {result?.hardwareId}
                </Text>
              </View>
            </GlassCard>
            <View style={{ height: 12 }} />
            <Btn
              title="Готово"
              disabled={!result}
              onPress={() => {
                if (result) onComplete(result);
              }}
            />
          </View>
        );
      default:
        return null;
    }
  })();

  const titles: Record<Step, string> = {
    1: 'Тип модуля',
    2: 'Плата',
    3: 'Связь',
    4: 'Батарея',
    5: 'Wi-Fi роутера',
    6: 'Проверка и сборка',
    7: 'Прошивка',
    8: 'Готово',
  };

  const canGoBack = step > 1 && step !== 7;

  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, paddingHorizontal: 2 }}>
        <Text style={{ color: theme.textPrimary, fontSize: 13.5, fontWeight: '700' }}>{titles[step]}</Text>
        <Text style={{ color: theme.textDisabled, fontSize: 11.5 }}>{step <= 6 ? `${step} / 6` : ''}</Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 4, marginBottom: 14 }}>
        {Array.from({ length: 6 }).map((_, index) => {
          const number = index + 1;
          const active = step === number;
          const done = step > number;
          return (
            <View
              key={number}
              style={{
                flex: active ? 2.4 : 1,
                height: 6,
                borderRadius: 999,
                backgroundColor: done ? theme.success : active ? theme.accent : theme.line,
                opacity: done || active ? 1 : 0.55,
              }}
            />
          );
        })}
      </View>

      {stepBody}

      {stepError ? (
        <View style={{ marginTop: 10 }}>
          <ErrorText>{stepError}</ErrorText>
        </View>
      ) : null}

      {step >= 1 && step <= 6 ? (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
          {canGoBack ? (
            <View style={{ flex: 1 }}>
              <Btn title="Назад" variant="ghost" onPress={back} />
            </View>
          ) : null}
          <View style={{ flex: 1.4 }}>
            <Btn
              title={step === 6 ? (build?.status === 'ready' ? 'К прошивке' : 'Собрать') : 'Далее'}
              loading={building}
              onPress={next}
            />
          </View>
        </View>
      ) : null}

      <View style={{ marginTop: 10 }}>
        {step === 7 ? (
          <Text style={{ color: theme.warning, fontSize: 11.5, textAlign: 'center', lineHeight: 17 }}>
            Идёт прошивка — не закрывайте мастер и не отключайте USB, пока запись не завершится.
          </Text>
        ) : (
          <Btn title="Отмена" size="s" variant="ghost" onPress={onCancel} />
        )}
      </View>
    </View>
  );
}
