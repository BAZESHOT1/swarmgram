/**
 * Страница «Модули расширения».
 *
 * Основной формат — карта mesh-сети + карточки реальных модулей. Сверху
 * короткая сводка, поиск и фильтры. Подключение и прошивка идут через
 * полноэкранный мастер ConnectModuleFlow, а автопоиск показывает только
 * маленькую строку статуса — отдельного баннера нет.
 */
import React, { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ModuleRow } from '../../src/data/api';
import {
  humanError,
  useAttachModule,
  useBlockModule,
  useDetachModule,
  useDismissModuleShadow,
  useModules,
  useReportModuleShadow,
  useUnbindModule,
  useUnblockModule,
} from '../../src/data/queries';
import { EmptyState } from '../../src/components/EmptyState';
import { Btn } from '../../src/components/Btn';
import { useTheme } from '../../src/theme/useTheme';
import { motion } from '../../src/theme/motion';
import { useReducedMotion } from '../../src/components/useReducedMotion';
import { useStore } from '../../src/state/useStore';
import { GlassCard, SettingsPage, SettingsSection } from '../../src/components/settings/SettingsUI';
import { CardsSkeleton, SummaryTilesSkeleton } from '../../src/components/skeletons/PageSkeletons';
import {
  HeaderIconButton,
  SettingsConfirm,
  SettingsInput,
  SettingsModal,
  StatusBadge,
  SummaryGrid,
  SummaryTile,
} from '../../src/components/settings/SettingsWidgets';
import { ConnectModuleFlow } from '../../src/components/modules/ConnectModuleFlow';
import { GatewayWifiModal } from '../../src/components/modules/GatewayWifiModal';
import { ModuleCard } from '../../src/components/modules/ModuleCard';
import { ModulesNetworkMap } from '../../src/components/modules/ModulesNetworkMap';
import {
  MESH_ALWAYS,
  moduleEnvironmentLabel,
  moduleRoleLabel,
  qualityFromRssi,
} from '../../src/components/modules/moduleUi';
import { useModuleConnection } from '../../src/modules/ModuleProvider';

type ModuleFilter = 'all' | 'online' | 'offline' | 'blocked' | 'wearable' | 'repeater' | 'gateway';

const FILTERS: Array<{ id: ModuleFilter; label: string }> = [
  { id: 'all', label: 'Все' },
  { id: 'online', label: 'Онлайн' },
  { id: 'offline', label: 'Офлайн' },
  { id: 'blocked', label: 'Заблокированы' },
  { id: 'wearable', label: 'Носимые' },
  { id: 'repeater', label: 'Ретрансляторы' },
  { id: 'gateway', label: 'Шлюзы' },
];

function hardwareIdOf(module: ModuleRow): string {
  return (module.hardwareId ?? module.boardUuid ?? module.board_uuid ?? '').toLowerCase();
}

function isShadow(module: ModuleRow): boolean {
  return Boolean(module.shadow || (module.shadowId && module.status === 'detached'));
}

/** Поиск по имени, публичному ID, hardwareId и роли (включая русские подписи). */
function matchesQuery(module: ModuleRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const raw = module as unknown as Record<string, unknown>;
  const haystack = [
    typeof raw.name === 'string' ? raw.name : '',
    module.publicId ?? '',
    hardwareIdOf(module),
    module.role ?? '',
    moduleRoleLabel(module.role),
    module.kind ?? '',
    module.transport ?? '',
    moduleEnvironmentLabel(module.kind, module.transport),
    module.message ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}

function matchesFilter(module: ModuleRow, filter: ModuleFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'blocked') return Boolean(module.blocked || module.status === 'blocked');
  if (filter === 'online') return module.online === true && !module.blocked;
  if (filter === 'offline') return module.online !== true && !module.blocked;
  return (module.role ?? 'gateway') === filter;
}

export default function ModulesScreen() {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const localConnection = useModuleConnection();
  const modules = useModules();
  const unbind = useUnbindModule();
  const attach = useAttachModule();
  const detach = useDetachModule();
  const block = useBlockModule();
  const unblock = useUnblockModule();
  const dismissShadow = useDismissModuleShadow();
  const reportShadow = useReportModuleShadow();

  const [connectOpen, setConnectOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ModuleFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [unbindTarget, setUnbindTarget] = useState<ModuleRow | null>(null);
  const [blockTarget, setBlockTarget] = useState<ModuleRow | null>(null);
  const [blockReason, setBlockReason] = useState('');
  const [gatewayTarget, setGatewayTarget] = useState<ModuleRow | null>(null);

  const list = modules.data ?? [];
  const realModules = list.filter((module) => !isShadow(module));
  const shadows = list.filter(isShadow);
  const total = realModules.length;
  const online = realModules.filter((module) => module.online === true && !module.blocked).length;
  const gateways = realModules.filter((module) => (module.role ?? 'gateway') === 'gateway').length;

  const qualities = realModules
    .filter((module) => module.online === true)
    .map((module) => qualityFromRssi(module.rssi))
    .filter((value): value is number => value !== null);
  const avgQuality = qualities.length
    ? Math.round(qualities.reduce((sum, value) => sum + value, 0) / qualities.length)
    : null;
  const rssiValues = realModules
    .filter((module) => module.online === true && Number(module.rssi) !== 0)
    .map((module) => Number(module.rssi));
  const avgRssi = rssiValues.length
    ? Math.round(rssiValues.reduce((sum, value) => sum + value, 0) / rssiValues.length)
    : null;
  const loading = modules.isLoading;

  const visibleModules = realModules.filter(
    (module) => matchesFilter(module, filter) && matchesQuery(module, query),
  );
  const filtering = query.trim().length > 0 || filter !== 'all';

  const localAttachedTo = (module: ModuleRow): boolean =>
    Boolean(
      localConnection.connected &&
        localConnection.info &&
        localConnection.info.hardwareId.toLowerCase() === hardwareIdOf(module),
    );

  const confirmUnbind = async () => {
    if (!unbindTarget) return;
    try {
      await unbind.mutateAsync(unbindTarget.id);
    } catch {
      /* ошибка отобразится в тосте */
    } finally {
      setUnbindTarget(null);
    }
  };

  const confirmBlock = async () => {
    if (!blockTarget) return;
    try {
      await block.mutateAsync({ id: blockTarget.id, reason: blockReason.trim() || undefined });
      useStore.getState().pushToast({ kind: 'success', message: 'Модуль заблокирован по hardwareId' });
    } catch (error) {
      useStore.getState().pushToast({ kind: 'error', message: humanError(error) });
    } finally {
      setBlockTarget(null);
      setBlockReason('');
    }
  };

  const runUnblock = async (module: ModuleRow) => {
    try {
      await unblock.mutateAsync(module.id);
      useStore.getState().pushToast({ kind: 'success', message: 'Блокировка снята' });
    } catch (error) {
      useStore.getState().pushToast({ kind: 'error', message: humanError(error) });
    }
  };

  /** Подключение/отключение носимого: сначала локальное соединение, затем сервер. */
  const toggleAttach = async (module: ModuleRow) => {
    const transport: 'ble' | 'usb' = module.transport === 'ble' ? 'ble' : 'usb';
    try {
      if (localAttachedTo(module)) {
        await localConnection.disconnect();
        return;
      }
      if (module.attached) await detach.mutateAsync(module.id);
      else await attach.mutateAsync({ id: module.id, transport });
    } catch (error) {
      useStore.getState().pushToast({ kind: 'error', message: humanError(error) });
    }
  };

  const handleDismissShadow = async (shadowId: string) => {
    try {
      await dismissShadow.mutateAsync(shadowId);
      useStore.getState().pushToast({ kind: 'success', message: 'Shadow-запись удалена' });
    } catch (error) {
      useStore.getState().pushToast({ kind: 'error', message: humanError(error) });
    }
  };

  const handleReportShadow = async (shadowId: string) => {
    try {
      await reportShadow.mutateAsync(shadowId);
      useStore.getState().pushToast({
        kind: 'success',
        message: 'Сообщение отправлено. Если модуль не ваш — поддержка разберётся.',
      });
    } catch (error) {
      useStore.getState().pushToast({ kind: 'error', message: humanError(error) });
    }
  };

  // Маленькая строка автопоиска: провайдер уже сканирует сам, баннер не нужен.
  const autoStatus = localConnection.busy
    ? {
        icon: 'sync-outline' as const,
        color: theme.accent,
        text: localConnection.busy === 'usb' ? 'Ищем модули по USB…' : 'Ищем модули рядом по Bluetooth…',
      }
    : localConnection.connected && localConnection.info
      ? {
          icon: 'checkmark-circle-outline' as const,
          color: theme.success,
          text: `Модуль подключён автоматически · ${moduleRoleLabel(localConnection.info.role)}${
            localConnection.info.publicId ? ` ${localConnection.info.publicId}` : ''
          }`,
        }
      : null;

  return (
    <SettingsPage
      title="Модули расширения"
      subtitle="Модули расширяют покрытие mesh-сети — это вклад в связь для всех, а не личное хранилище"
      right={
        <HeaderIconButton
          icon="refresh-outline"
          label="Обновить список модулей"
          onPress={() => void modules.refetch()}
          disabled={modules.isFetching}
        />
      }
    >
      <SettingsSection title="Сводка" delay={0}>
        <SummaryGrid>
          {loading ? (
            <SummaryTilesSkeleton count={4} />
          ) : (
            <>
              <SummaryTile icon="hardware-chip-outline" label="Всего" value={String(total)} tone="accent" />
              <SummaryTile
                icon="pulse-outline"
                label="Онлайн"
                value={String(online)}
                sub={total > 0 ? `из ${total}` : 'нет модулей'}
                tone="success"
              />
              <SummaryTile
                icon="git-network-outline"
                label="Шлюзы"
                value={String(gateways)}
                sub="с выходом в интернет"
                tone="warning"
              />
              <SummaryTile
                icon="stats-chart-outline"
                label="Качество"
                value={avgQuality === null ? '—' : `${avgQuality}%`}
                sub={avgRssi === null ? 'нет данных RSSI' : `средний RSSI ${avgRssi} dBm`}
                tone={avgQuality === null ? 'neutral' : avgQuality >= 65 ? 'success' : avgQuality >= 40 ? 'warning' : 'danger'}
              />
            </>
          )}
        </SummaryGrid>
      </SettingsSection>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 2, marginBottom: 10 }}>
        <Ionicons name="wifi-outline" size={13} color={theme.textDisabled} />
        <Text style={{ color: theme.textDisabled, fontSize: 11.5, flex: 1 }} numberOfLines={2}>
          {MESH_ALWAYS.networkLine} · модуль — вклад в общую связь
        </Text>
      </View>

      {autoStatus ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 2, marginBottom: 10 }}>
          <Ionicons name={autoStatus.icon} size={14} color={autoStatus.color} />
          <Text style={{ color: autoStatus.color, fontSize: 12, flex: 1 }} numberOfLines={1}>
            {autoStatus.text}
          </Text>
        </View>
      ) : null}

      <View style={{ marginBottom: 12 }}>
        <Btn
          title="Подключить модуль"
          onPress={() => setConnectOpen(true)}
          accessibilityLabel="Подключить подготовленный или новый модуль"
        />
      </View>

      {/* Поиск: имя, publicId, hardwareId или роль. */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          borderWidth: 1,
          borderColor: theme.line,
          backgroundColor: theme.surface,
          borderRadius: 13,
          paddingHorizontal: 11,
          height: 42,
          marginBottom: 10,
        }}
      >
        <Ionicons name="search-outline" size={16} color={theme.textDisabled} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Поиск: имя, ID, hardwareId или роль"
          placeholderTextColor={theme.textDisabled}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Поиск модулей"
          style={{ flex: 1, color: theme.textPrimary, fontSize: 13, paddingVertical: 0 }}
        />
        {query ? (
          <Pressable
            onPress={() => setQuery('')}
            accessibilityRole="button"
            accessibilityLabel="Очистить поиск"
            hitSlop={8}
          >
            <Ionicons name="close-circle" size={16} color={theme.textDisabled} />
          </Pressable>
        ) : null}
      </View>

      {/* Фильтры-чипы. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 6, paddingBottom: 2, marginBottom: 12 }}
      >
        {FILTERS.map((item) => {
          const active = filter === item.id;
          return (
            <Pressable
              key={item.id}
              onPress={() => setFilter(item.id)}
              accessibilityRole="button"
              accessibilityLabel={`Фильтр: ${item.label}`}
              accessibilityState={{ selected: active }}
              style={({ pressed }) => ({
                paddingHorizontal: 11,
                height: 30,
                borderRadius: 999,
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: 1,
                borderColor: active ? theme.accent : theme.line,
                backgroundColor: active ? theme.accentSoft : theme.surface,
                opacity: pressed ? 0.75 : 1,
              })}
            >
              <Text
                style={{
                  color: active ? theme.accent : theme.textSecondary,
                  fontSize: 11.5,
                  fontWeight: active ? '700' : '600',
                }}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {loading ? (
        <CardsSkeleton count={3} />
      ) : total === 0 ? (
        <View style={{ minHeight: 340, justifyContent: 'center' }}>
          <EmptyState
            icon="hardware-chip-outline"
            title="Модулей пока нет"
            subtitle="Два пути: подключить уже прошитый модуль по USB/BLE или 8-значному ID — либо собрать и прошить новый. Оба сценария открываются одной кнопкой."
            actionLabel="Подключить или прошить"
            onAction={() => setConnectOpen(true)}
          />
        </View>
      ) : (
        <>
          <SettingsSection
            title="Карта сети"
            delay={motion.staggerStepMs}
            right={
              <Text style={{ color: theme.textDisabled, fontSize: 11.5, fontWeight: '600' }}>
                {filtering ? `${visibleModules.length} из ${total}` : `${total} узлов`}
              </Text>
            }
          >
            <GlassCard>
              <View style={{ padding: 8 }}>
                {visibleModules.length > 0 ? (
                  <ModulesNetworkMap
                    modules={visibleModules}
                    selectedId={selectedId}
                    onSelect={(module) => setSelectedId(module.id)}
                  />
                ) : (
                  <View style={{ height: 120, alignItems: 'center', justifyContent: 'center', gap: 6, padding: 12 }}>
                    <Ionicons name="funnel-outline" size={22} color={theme.textDisabled} />
                    <Text style={{ color: theme.textSecondary, fontSize: 12, textAlign: 'center' }}>
                      Под текущий поиск и фильтр модулей нет.
                    </Text>
                  </View>
                )}
              </View>
            </GlassCard>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingHorizontal: 2, marginTop: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <View style={{ width: 7, height: 7, borderRadius: 999, backgroundColor: theme.success }} />
                <Text style={{ color: theme.textDisabled, fontSize: 10.5 }}>онлайн</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <View style={{ width: 7, height: 7, borderRadius: 999, backgroundColor: theme.textDisabled }} />
                <Text style={{ color: theme.textDisabled, fontSize: 10.5 }}>офлайн</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <View style={{ width: 7, height: 7, borderRadius: 999, backgroundColor: theme.danger }} />
                <Text style={{ color: theme.textDisabled, fontSize: 10.5 }}>заблокирован</Text>
              </View>
              <Text style={{ color: theme.textDisabled, fontSize: 10.5 }}>
                пунктир — нет подтверждённой связи
              </Text>
            </View>
          </SettingsSection>

          {shadows.length > 0 ? (
            <SettingsSection title="Привязаны на другом устройстве" delay={motion.staggerStepMs}>
              {shadows.map((module) => {
                const shadowId = module.shadowId ?? module.id;
                const busy = dismissShadow.isPending || reportShadow.isPending;
                return (
                  <GlassCard key={`shadow-${module.id}`} style={{ marginBottom: 8 }}>
                    <View style={{ padding: 12, gap: 9 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 9 }}>
                        <View
                          style={{
                            width: 34,
                            height: 34,
                            borderRadius: 10,
                            alignItems: 'center',
                            justifyContent: 'center',
                            backgroundColor: theme.warningSoft,
                          }}
                        >
                          <Ionicons name="help-circle-outline" size={17} color={theme.warning} />
                        </View>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={{ color: theme.textPrimary, fontSize: 14.5, fontWeight: '700' }}>
                            Модуль привязан на другом устройстве
                          </Text>
                          <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 2 }} numberOfLines={2}>
                            {module.message ||
                              'Был привязан на другом устройстве. Если это не вы — не подключайте его.'}
                          </Text>
                        </View>
                        <StatusBadge text="отвязан" tone="warning" />
                      </View>

                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                        {module.publicId ? <StatusBadge text={`ID ${module.publicId}`} tone="neutral" /> : null}
                        <StatusBadge text={moduleRoleLabel(module.role)} tone="accent" />
                        <StatusBadge text={moduleEnvironmentLabel(module.kind, module.transport)} tone="neutral" />
                      </View>

                      <Text style={{ color: theme.textSecondary, fontSize: 11.5, lineHeight: 17 }}>
                        Мы не добавляем такой модуль в ваш аккаунт автоматически. Удалите запись, если он вам не нужен,
                        или сообщите «Это не я», если модуль подключили без вашего ведома.
                      </Text>

                      <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        <Btn
                          title="Удалить"
                          size="s"
                          variant="ghost"
                          loading={dismissShadow.isPending}
                          disabled={busy}
                          onPress={() => void handleDismissShadow(shadowId)}
                        />
                        <Btn
                          title="Это не я"
                          size="s"
                          variant="danger"
                          loading={reportShadow.isPending}
                          disabled={busy}
                          onPress={() => void handleReportShadow(shadowId)}
                        />
                      </View>
                    </View>
                  </GlassCard>
                );
              })}
            </SettingsSection>
          ) : null}

          <SettingsSection
            title="Ваши модули"
            delay={motion.staggerStepMs}
            right={
              <Text style={{ color: theme.textDisabled, fontSize: 11.5, fontWeight: '600' }}>
                {filtering ? `${visibleModules.length} из ${total}` : `${total} шт.`}
              </Text>
            }
          >
            {visibleModules.length === 0 ? (
              <View style={{ paddingVertical: 26, alignItems: 'center', gap: 8 }}>
                <Ionicons name="search-outline" size={26} color={theme.textDisabled} />
                <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '700' }}>Ничего не найдено</Text>
                <Text style={{ color: theme.textSecondary, fontSize: 12, textAlign: 'center', lineHeight: 18 }}>
                  Попробуйте другой запрос или сбросьте фильтр. Поиск ищет по имени, publicId, hardwareId и роли.
                </Text>
                <Btn
                  title="Сбросить поиск и фильтры"
                  size="s"
                  variant="ghost"
                  onPress={() => {
                    setQuery('');
                    setFilter('all');
                  }}
                />
              </View>
            ) : (
              visibleModules.map((module, index) => (
                <ModuleCard
                  key={module.id}
                  module={module}
                  index={index}
                  selected={selectedId === module.id}
                  reduced={reduced}
                  localInfo={localConnection.info}
                  localConnected={localConnection.connected}
                  localKind={localConnection.connection?.kind ?? null}
                  attachPending={attach.isPending || detach.isPending}
                  unblockPending={unblock.isPending}
                  onSelect={(value) => setSelectedId(value.id)}
                  onToggleAttach={(value) => void toggleAttach(value)}
                  onBlock={(value) => {
                    setBlockReason('');
                    setBlockTarget(value);
                  }}
                  onUnblock={(value) => void runUnblock(value)}
                  onUnbind={(value) => setUnbindTarget(value)}
                  onGatewayWifi={(value) => setGatewayTarget(value)}
                />
              ))
            )}
          </SettingsSection>
        </>
      )}

      {/* Полноэкранный мастер подключения/прошивки. */}
      <ConnectModuleFlow
        visible={connectOpen}
        onClose={() => setConnectOpen(false)}
        onComplete={() => {
          void modules.refetch();
        }}
      />

      {/* Wi-Fi шлюза через активное USB/BLE-соединение. */}
      <GatewayWifiModal
        visible={gatewayTarget !== null}
        module={gatewayTarget}
        connected={Boolean(gatewayTarget && localAttachedTo(gatewayTarget))}
        saving={localConnection.configuring}
        onClose={() => setGatewayTarget(null)}
        onSave={(ssid, password) => localConnection.configureGateway(ssid, password)}
      />

      {/* Блокировка модуля по hardwareId */}
      <SettingsModal
        visible={blockTarget !== null}
        title="Заблокировать модуль?"
        subtitle={
          blockTarget
            ? `Плата ${hardwareIdOf(blockTarget).slice(0, 14)}… не сможет привязаться даже после перепрошивки.`
            : undefined
        }
        onClose={() => setBlockTarget(null)}
      >
        <View style={{ gap: 10 }}>
          <SettingsInput
            label="Причина (необязательно)"
            value={blockReason}
            onChangeText={setBlockReason}
            placeholder="например, потерян или украден"
            accessibilityLabel="Причина блокировки"
            maxLength={300}
          />
          <Text style={{ color: theme.textSecondary, fontSize: 11.5, lineHeight: 17 }}>
            Блокировка действует по hardwareId (MAC из eFuse) и сохраняется на сервере.
          </Text>
          <Btn
            title="Заблокировать"
            size="s"
            variant="danger"
            loading={block.isPending}
            onPress={() => void confirmBlock()}
          />
        </View>
      </SettingsModal>

      {/* Подтверждение отвязки */}
      <SettingsConfirm
        visible={unbindTarget !== null}
        title="Отвязать модуль?"
        message="Модуль исчезнет из аккаунта. Плату можно будет привязать снова — блокировка при отвязке не ставится."
        confirmLabel="Отвязать"
        loading={unbind.isPending}
        onClose={() => setUnbindTarget(null)}
        onConfirm={() => void confirmUnbind()}
      />
    </SettingsPage>
  );
}
