/**
 * Полноэкранный мастер подключения/прошивки модуля.
 *
 * Шаги:
 *  1. модуль уже подготовлен или его нужно прошить;
 *  2. роль в mesh-сети;
 *  3. подключение по USB/BLE или ввод 8-значного ID
 *     (для прошивки — встроенный SimpleFirmwareWizard);
 *  4. успех с публичным ID.
 *
 * Во время записи прошивки закрытие запрещено: пользователь не должен
 * случайно прервать процесс на середине.
 */
import React from 'react';
import { Modal, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { Btn } from '../Btn';
import { useTheme } from '../../theme/useTheme';
import { GlassCard } from '../settings/SettingsUI';
import { SettingsInput, StatusBadge } from '../settings/SettingsWidgets';
import { ChoiceCard, Note } from '../firmware/FirmwareUI';
import { api, ApiError, type ModuleRole } from '../../data/api';
import { humanError } from '../../data/queries';
import { useModuleConnection } from '../../modules/ModuleProvider';
import { MESH_ALWAYS, moduleRoleLabel } from './moduleUi';
import { SimpleFirmwareWizard, type SimpleFirmwareResult } from './SimpleFirmwareWizard';

type Stage = 'prepared-or-flash' | 'role' | 'wearable' | 'claim' | 'flash' | 'success';

interface FlowResult {
  publicId?: string;
  hardwareId?: string;
  moduleId?: string;
  role?: string;
  source: 'local' | 'claimed' | 'flashed';
}

const STEPS = ['Сценарий', 'Роль', 'Подключение', 'Готово'] as const;

function stepIndex(stage: Stage): number {
  if (stage === 'prepared-or-flash') return 0;
  if (stage === 'role') return 1;
  if (stage === 'success') return 3;
  return 2;
}

export function ConnectModuleFlow({
  visible,
  onClose,
  onComplete,
  initialMode,
}: {
  visible: boolean;
  onClose: () => void;
  /** Вызывается после успеха; список модулей уже инвалидируется провайдером/мутациями. */
  onComplete?: (result: FlowResult) => void;
  /**
   * С какого шага открыть мастер: сразу к прошивке, к добавлению прошитого
   * или к поиску по 8-значному ID. Без значения — экран выбора сценария.
   */
  initialMode?: 'prepared' | 'flash' | 'claim';
}) {
  const theme = useTheme();
  const qc = useQueryClient();
  const modules = useModuleConnection();

  const [stage, setStage] = React.useState<Stage>('prepared-or-flash');
  const [role, setRole] = React.useState<ModuleRole>('wearable');
  const [publicId, setPublicId] = React.useState('');
  const [claimError, setClaimError] = React.useState('');
  const [searching, setSearching] = React.useState(false);
  const [claiming, setClaiming] = React.useState(false);
  const [result, setResult] = React.useState<FlowResult | null>(null);
  const [localError, setLocalError] = React.useState('');
  /** Внутренний шаг SimpleFirmwareWizard: 7 — экран прошивки, закрывать нельзя. */
  const [wizardStep, setWizardStep] = React.useState(1);

  const pollTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopped = React.useRef(true);

  const stopPolling = React.useCallback(() => {
    stopped.current = true;
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
    setSearching(false);
  }, []);

  const reset = React.useCallback(() => {
    stopPolling();
    setStage('prepared-or-flash');
    setRole('wearable');
    setPublicId('');
    setClaimError('');
    setClaiming(false);
    setResult(null);
    setLocalError('');
    setWizardStep(1);
    modules.clearError();
  }, [modules, stopPolling]);

  React.useEffect(() => {
    if (!visible) {
      stopPolling();
      return;
    }
    reset();
    if (initialMode === 'flash') setStage('flash');
    else if (initialMode === 'prepared') setStage('role');
    else if (initialMode === 'claim') setStage('claim');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, initialMode]);

  React.useEffect(() => () => stopPolling(), [stopPolling]);

  // Автовосстановленный модуль уже подключён — показываем его в сценарии wearable.
  React.useEffect(() => {
    if (!visible || stage !== 'wearable') return;
    if (modules.info && modules.connected) {
      setResult({
        publicId: modules.info.publicId,
        hardwareId: modules.info.hardwareId,
        role: modules.info.role,
        source: 'local',
      });
    }
  }, [visible, stage, modules.info, modules.connected]);

  // Успешное локальное подключение сразу переводит сценарий на итоговую карточку.
  React.useEffect(() => {
    if (!visible || stage !== 'wearable' || !result) return;
    setStage('success');
    void qc.invalidateQueries({ queryKey: ['modules'] });
  }, [visible, stage, result, qc]);

  const flashing = stage === 'flash' && wizardStep === 7;

  const close = React.useCallback(() => {
    if (flashing) return;
    onClose();
  }, [flashing, onClose]);

  const connectUsb = async () => {
    setLocalError('');
    const info = await modules.connectUsb();
    if (info) {
      setResult({ publicId: info.publicId, hardwareId: info.hardwareId, role: info.role, source: 'local' });
    } else {
      setLocalError(modules.getLastError() ?? modules.error ?? 'Не удалось подключить модуль по USB.');
    }
  };

  const connectBle = async () => {
    setLocalError('');
    const info = await modules.connectBle();
    if (info) {
      setResult({ publicId: info.publicId, hardwareId: info.hardwareId, role: info.role, source: 'local' });
    } else {
      setLocalError(modules.getLastError() ?? modules.error ?? 'Не удалось подключить модуль по Bluetooth.');
    }
  };

  /** claimModule с ретраями: 404 = модуль ещё не появился в сети. */
  const runClaim = async () => {
    const value = publicId.trim();
    if (!/^\d{8}$/.test(value)) {
      setClaimError('Введите 8 цифр публичного ID модуля.');
      return;
    }
    stopPolling();
    stopped.current = false;
    setClaimError('');
    setClaiming(true);
    const deadline = Date.now() + 60_000;

    const tick = async (): Promise<void> => {
      if (stopped.current) return;
      try {
        const row = await api.claimModule(value);
        if (stopped.current) return;
        stopped.current = true;
        setClaiming(false);
        setSearching(false);
        const nextResult: FlowResult = {
          publicId: row.publicId ?? value,
          hardwareId: row.hardwareId ?? row.boardUuid ?? row.board_uuid,
          moduleId: row.id,
          role: row.role,
          source: 'claimed',
        };
        setResult(nextResult);
        setStage('success');
        onComplete?.(nextResult);
        return;
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) {
          if (!stopped.current) {
            setClaiming(false);
            setSearching(false);
            setClaimError(humanError(error));
          }
          return;
        }
      }
      if (stopped.current) return;
      if (Date.now() >= deadline) {
        setClaiming(false);
        setSearching(false);
        setClaimError('Модуль не найден за 60 секунд. Проверьте питание и близость к сети, затем попробуйте снова.');
        return;
      }
      setSearching(true);
      pollTimer.current = setTimeout(() => void tick(), 3000);
    };

    await tick();
  };

  const finish = () => {
    if (result) onComplete?.(result);
    onClose();
  };

  const goBack = () => {
    if (flashing) return;
    if (stage === 'role') return setStage('prepared-or-flash');
    if (stage === 'wearable' || stage === 'claim') return setStage('role');
    if (stage === 'flash') return setStage('prepared-or-flash');
    if (stage === 'success') return finish();
    return undefined;
  };

  const title =
    stage === 'success'
      ? 'Модуль подключён'
      : stage === 'flash'
        ? 'Прошивка нового модуля'
        : stage === 'role'
          ? 'Роль модуля'
          : 'Подключить модуль';

  const subtitle =
    stage === 'prepared-or-flash'
      ? 'Модуль уже прошит и готов к работе или его нужно собрать и прошить?'
      : stage === 'role'
        ? 'Выберите, какую роль модуль будет выполнять в mesh-сети.'
        : stage === 'claim'
          ? 'Введите 8-значный ID — мы найдём модуль в сети и добавим его в аккаунт.'
          : stage === 'wearable'
            ? role === 'gateway'
              ? 'Подключите подготовленный шлюз по USB/BLE — после этого можно задать Wi-Fi роутера.'
              : 'Подключите подготовленный модуль к этому устройству по USB/BLE.'
            : undefined;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      transparent={false}
      onRequestClose={close}
    >
      <View style={{ flex: 1, backgroundColor: theme.background }}>
        <View
          style={{
            flex: 1,
            width: '100%',
            maxWidth: 620,
            alignSelf: 'center',
            ...(Platform.OS === 'web'
              ? ({ boxShadow: '0 0 60px rgba(0,0,0,0.35)' } as object)
              : null),
          }}
        >
          {/* Шапка мастера: назад, заголовок, отмена. */}
          <View
            style={{
              paddingHorizontal: 14,
              paddingTop: Platform.OS === 'ios' ? 52 : 14,
              paddingBottom: 10,
              borderBottomWidth: 1,
              borderBottomColor: theme.line,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Pressable
                onPress={goBack}
                disabled={stage === 'prepared-or-flash' || flashing}
                accessibilityRole="button"
                accessibilityLabel="Назад"
                hitSlop={8}
                style={({ pressed }) => ({
                  width: 36,
                  height: 36,
                  borderRadius: 11,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: stage === 'prepared-or-flash' || flashing ? 0.25 : pressed ? 0.6 : 1,
                })}
              >
                <Ionicons name="chevron-back" size={22} color={theme.textSecondary} />
              </Pressable>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: theme.textPrimary, fontSize: 19, fontWeight: '800' }} numberOfLines={1}>
                  {title}
                </Text>
                {subtitle ? (
                  <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 2, lineHeight: 17 }} numberOfLines={2}>
                    {subtitle}
                  </Text>
                ) : null}
              </View>
              <Pressable
                onPress={close}
                disabled={flashing}
                accessibilityRole="button"
                accessibilityLabel={flashing ? 'Закрытие заблокировано во время прошивки' : 'Закрыть мастер'}
                hitSlop={8}
                style={({ pressed }) => ({
                  width: 36,
                  height: 36,
                  borderRadius: 11,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: flashing ? 0.25 : pressed ? 0.6 : 1,
                  backgroundColor: theme.surfacePressed,
                })}
              >
                <Ionicons name="close" size={20} color={theme.textSecondary} />
              </Pressable>
            </View>

            {/* Прогресс крупных шагов мастера. */}
            <View style={{ flexDirection: 'row', gap: 4, marginTop: 12 }}>
              {STEPS.map((label, index) => {
                const current = stepIndex(stage);
                const active = current === index;
                const done = current > index;
                return (
                  <View key={label} style={{ flex: active ? 2.2 : 1 }}>
                    <View
                      style={{
                        height: 5,
                        borderRadius: 999,
                        backgroundColor: done ? theme.success : active ? theme.accent : theme.line,
                        opacity: done || active ? 1 : 0.55,
                      }}
                    />
                    <Text
                      style={{
                        color: active ? theme.textPrimary : theme.textDisabled,
                        fontSize: 9.5,
                        fontWeight: active ? '700' : '500',
                        marginTop: 4,
                      }}
                      numberOfLines={1}
                    >
                      {label}
                    </Text>
                  </View>
                );
              })}
            </View>

            {flashing ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 }}>
                <Ionicons name="lock-closed-outline" size={13} color={theme.warning} />
                <Text style={{ color: theme.warning, fontSize: 11.5 }}>
                  Идёт прошивка — мастер нельзя закрыть, пока запись не завершится.
                </Text>
              </View>
            ) : null}
          </View>

          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: 14, paddingBottom: 28 }}
            nestedScrollEnabled
            showsVerticalScrollIndicator={false}
          >
            {stage === 'prepared-or-flash' ? (
              <View>
                <ChoiceCard
                  icon="build-outline"
                  title="Прошить новый"
                  subtitle="соберём прошивку на Hub"
                  description="Выберем тип, плату, связь и батарею — без лишних настроек."
                  selected={false}
                  onPress={() => setStage('flash')}
                />
                <ChoiceCard
                  icon="checkmark-done-outline"
                  title="Добавить прошитый"
                  subtitle="модуль уже включается"
                  description="Носимый — по USB (компьютер) или BLE (телефон). Шлюз и ретранслятор — по 8-значному ID."
                  selected={false}
                  onPress={() => setStage('role')}
                />
                <ChoiceCard
                  icon="keypad-outline"
                  title="Найти по ID"
                  subtitle="автономные шлюзы и ретрансляторы"
                  description="Модуль уже в сети: опросим его 8-значный ID и привяжем к аккаунту."
                  selected={false}
                  onPress={() => setStage('claim')}
                />
                <Note icon="git-network-outline" tone="neutral">
                  {MESH_ALWAYS.networkLine}. Параметры сети подставляет сервер — менять их вручную не нужно.
                </Note>
              </View>
            ) : null}

            {stage === 'role' ? (
              <View>
                <ChoiceCard
                  icon="watch-outline"
                  title="Носимый"
                  subtitle="подключён к этому устройству"
                  description="Свяжем по USB (ПК) или Bluetooth (ПК/телефон) и автоматически привяжем к аккаунту."
                  selected={role === 'wearable'}
                  onPress={() => setRole('wearable')}
                />
                <ChoiceCard
                  icon="radio-outline"
                  title="Ретранслятор"
                  subtitle="работает автономно"
                  description="Добавим по 8-значному ID, когда модуль появится в mesh-сети."
                  selected={role === 'repeater'}
                  onPress={() => setRole('repeater')}
                />
                <ChoiceCard
                  icon="git-network-outline"
                  title="Шлюз"
                  subtitle="выход в интернет"
                  description="Добавим по 8-значному ID; шлюз сам выйдет на Hub через Wi-Fi."
                  selected={role === 'gateway'}
                  onPress={() => setRole('gateway')}
                />
                <Note icon={role === 'wearable' ? 'watch-outline' : 'globe-outline'} tone="accent">
                  {role === 'wearable'
                    ? 'Носимый модуль — адаптер в радио-сеть для этого клиента. Добавить его можно только физическим подключением: USB на компьютере или BLE на телефоне.'
                    : 'Ретранслятор и шлюз работают автономно. После включения они сами выходят в mesh-сеть, поэтому добавляются по 8-значному ID.'}
                </Note>
                <Btn
                  title={
                    role === 'wearable'
                      ? Platform.OS === 'web'
                        ? 'Подключить по USB или BLE'
                        : 'Подключить по BLE'
                      : 'Найти по 8-значному ID'
                  }
                  onPress={() => setStage(role === 'wearable' ? 'wearable' : 'claim')}
                />
              </View>
            ) : null}

            {stage === 'wearable' ? (
              <View>
                <Note icon="watch-outline" tone="accent">
                  Носимый модуль — адаптер в радио-сеть. Его нельзя добавить по ID: подключите плату физически
                  {Platform.OS === 'web' ? ' — по USB или BLE.' : ' по BLE.'}
                </Note>
                {Platform.OS === 'web' ? (
                  <>
                    <Note icon="desktop-outline" tone="accent">
                      На компьютере подключите модуль по USB (Chrome/Edge) или по Bluetooth,
                      если браузер поддерживает Web Bluetooth.
                    </Note>
                    {modules.supportedUsb ? (
                      <View style={{ marginBottom: 8 }}>
                        <Btn
                          title="Подключить по USB"
                          loading={modules.busy === 'usb'}
                          disabled={modules.busy !== null}
                          onPress={() => void connectUsb()}
                        />
                      </View>
                    ) : (
                      <Note icon="alert-circle-outline" tone="warning">
                        Web Serial недоступен: нужен Chrome/Edge на компьютере и HTTPS (или localhost).
                      </Note>
                    )}
                    {modules.supportedBle ? (
                      <Btn
                        title="Подключить по Bluetooth"
                        variant="ghost"
                        loading={modules.busy === 'ble'}
                        disabled={modules.busy !== null}
                        onPress={() => void connectBle()}
                      />
                    ) : (
                      <Note icon="logo-apple" tone="neutral">
                        Web Bluetooth нет в iOS Safari и некоторых браузерах. На iPhone используйте нативное приложение —
                        там BLE работает через системный API.
                      </Note>
                    )}
                  </>
                ) : (
                  <>
                    <Note icon="logo-android" tone="accent">
                      На телефоне модуль подключается по Bluetooth. USB на Android/iOS недоступен — для USB-прошивки
                      используйте компьютер.
                    </Note>
                    <Btn
                      title="Найти по Bluetooth"
                      loading={modules.busy === 'ble'}
                      disabled={modules.busy !== null}
                      onPress={() => void connectBle()}
                    />
                  </>
                )}

                {localError ? (
                  <Text style={{ color: theme.danger, fontSize: 12, lineHeight: 17, marginTop: 10 }}>{localError}</Text>
                ) : null}

                {modules.connected && modules.info ? (
                  <View style={{ marginTop: 12 }}>
                    <GlassCard>
                      <View style={{ padding: 12, gap: 6 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                          <Ionicons name="checkmark-circle" size={18} color={theme.success} />
                          <Text style={{ color: theme.textPrimary, fontSize: 13.5, fontWeight: '700', flex: 1 }}>
                            Модуль подключён
                          </Text>
                          <StatusBadge text="online" tone="success" />
                        </View>
                        <Text style={{ color: theme.textSecondary, fontSize: 12 }}>
                          {moduleRoleLabel(modules.info.role)} · {modules.info.firmware || 'прошивка —'} · батарея{' '}
                          {modules.info.battery}%
                        </Text>
                        <Text style={{ color: theme.textDisabled, fontSize: 11.5 }}>
                          hardwareId {modules.info.hardwareId}
                        </Text>
                      </View>
                    </GlassCard>
                  </View>
                ) : null}

                <View style={{ marginTop: 12 }}>
                  <Btn title="Ввести 8-значный ID" variant="ghost" size="s" onPress={() => setStage('claim')} />
                </View>
              </View>
            ) : null}

            {stage === 'claim' ? (
              <View>
                <SettingsInput
                  label="8-значный ID модуля"
                  value={publicId}
                  onChangeText={(value) => {
                    setPublicId(value.replace(/\D/g, '').slice(0, 8));
                    if (claimError) setClaimError('');
                  }}
                  placeholder="12345678"
                  keyboardType="numeric"
                  maxLength={8}
                  autoCapitalize="none"
                  accessibilityLabel="8-значный ID модуля"
                  style={{ fontSize: 20, letterSpacing: 3, textAlign: 'center', fontVariant: ['tabular-nums'] as never }}
                />
                <Text
                  style={{
                    color: theme.textSecondary,
                    fontSize: 11.5,
                    lineHeight: 17,
                    marginBottom: 12,
                    paddingHorizontal: 2,
                  }}
                >
                  ID показывается на экране модуля или в прошивке. По ID добавляются автономные ретрансляторы и
                  шлюзы, которые сами вышли в сеть. Носимый модуль добавляется только физическим подключением по
                  USB/BLE.
                </Text>
                {searching ? (
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8,
                      padding: 11,
                      borderRadius: 14,
                      backgroundColor: theme.accentSoft,
                      marginBottom: 10,
                    }}
                  >
                    <Ionicons name="sync-outline" size={16} color={theme.accent} />
                    <Text style={{ color: theme.textSecondary, fontSize: 12, flex: 1 }}>
                      Ищем модуль в сети… Опрос каждые 3 секунды до 60 секунд.
                    </Text>
                  </View>
                ) : null}
                {claimError ? (
                  <Text style={{ color: theme.danger, fontSize: 12, lineHeight: 17, marginBottom: 8 }}>{claimError}</Text>
                ) : null}
                <Btn
                  title={searching ? 'Ищем модуль…' : 'Добавить'}
                  loading={claiming}
                  disabled={publicId.trim().length !== 8 || searching}
                  onPress={() => void runClaim()}
                />
              </View>
            ) : null}

            {stage === 'flash' ? (
              <SimpleFirmwareWizard
                onStepChange={setWizardStep}
                onCancel={close}
                onComplete={(flashed: SimpleFirmwareResult) => {
                  const nextResult: FlowResult = {
                    publicId: flashed.publicId,
                    hardwareId: flashed.hardwareId,
                    moduleId: flashed.moduleId,
                    role: flashed.role,
                    source: 'flashed',
                  };
                  setResult(nextResult);
                  setStage('success');
                  onComplete?.(nextResult);
                }}
              />
            ) : null}

            {stage === 'success' ? (
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
                      {moduleRoleLabel(result?.role)} подключён
                    </Text>
                    {result?.publicId ? (
                      <>
                        <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 10 }}>
                          Публичный ID модуля
                        </Text>
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
                      </>
                    ) : (
                      <Text
                        style={{
                          color: theme.textSecondary,
                          fontSize: 12.5,
                          marginTop: 8,
                          textAlign: 'center',
                          lineHeight: 18,
                        }}
                      >
                        ID появится после первого INFO от модуля. Модуль уже добавлен в список.
                      </Text>
                    )}
                    {result?.hardwareId ? (
                      <Text selectable style={{ color: theme.textDisabled, fontSize: 10.5, marginTop: 10 }}>
                        {result.hardwareId}
                      </Text>
                    ) : null}
                    <View style={{ height: 12 }} />
                    <StatusBadge text="в списке модулей" tone="success" />
                  </View>
                </GlassCard>
                <View style={{ height: 12 }} />
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Btn title="Добавить ещё" variant="ghost" onPress={reset} />
                  </View>
                  <View style={{ flex: 1.3 }}>
                    <Btn title="Готово" onPress={finish} />
                  </View>
                </View>
              </View>
            ) : null}

            {stage !== 'success' && stage !== 'flash' ? (
              <View style={{ marginTop: 16 }}>
                <Btn title="Отмена" size="s" variant="ghost" onPress={close} />
              </View>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
