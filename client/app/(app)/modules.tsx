/**
 * Страница «Модули расширения».
 *
 * Структура сверху вниз:
 *  1. шапка с добавлением и обновлением;
 *  2. карта сети от носимого модуля, подключённого к клиенту (сворачиваемая);
 *  3. карточка текущего подключённого модуля;
 *  4. активные модули;
 *  5. неактивные модули и shadow-записи.
 *
 * Подключение и прошивка идут через полноэкранный мастер ConnectModuleFlow.
 */
import React, { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
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
import { CardsSkeleton } from '../../src/components/skeletons/PageSkeletons';
import { NearbyModulesBanner } from '../../src/components/modules/NearbyModulesBanner';
import {
  HeaderIconButton,
  ProgressBar,
  SettingsConfirm,
  SettingsInput,
  SettingsModal,
  StatusBadge,
  formatRelative,
} from '../../src/components/settings/SettingsWidgets';
import { ConnectModuleFlow } from '../../src/components/modules/ConnectModuleFlow';
import { GatewayWifiModal } from '../../src/components/modules/GatewayWifiModal';
import { ModuleCard } from '../../src/components/modules/ModuleCard';
import { ModulesNetworkMap } from '../../src/components/modules/ModulesNetworkMap';
import {
  MESH_ALWAYS,
  moduleEnvironmentLabel,
  moduleRoleLabel,
  moduleStatusView,
} from '../../src/components/modules/moduleUi';
import { useModuleConnection } from '../../src/modules/ModuleProvider';

type ModuleFilter = 'all' | 'online' | 'offline' | 'blocked' | 'wearable' | 'repeater' | 'gateway';
type FlowMode = 'prepared' | 'flash' | 'claim';

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

function moduleName(module: ModuleRow): string {
  const raw = module as unknown as Record<string, unknown>;
  if (typeof raw.name === 'string' && raw.name.trim()) return raw.name.trim();
  return module.publicId ? `Модуль ${module.publicId}` : moduleRoleLabel(module.role);
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

function MiniStat({
  icon,
  label,
  value,
  color,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
  color?: string;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexGrow: 1,
        flexBasis: '46%',
        minWidth: 130,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        paddingVertical: 4,
      }}
    >
      <Ionicons name={icon} size={14} color={color ?? theme.textDisabled} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color: theme.textDisabled, fontSize: 10 }} numberOfLines={1}>
          {label}
        </Text>
        <Text
          style={{
            color: color ?? theme.textPrimary,
            fontSize: 12.5,
            fontWeight: '700',
            fontVariant: ['tabular-nums'] as never,
          }}
          numberOfLines={1}
        >
          {value}
        </Text>
      </View>
    </View>
  );
}

/** Карточка носимого модуля, который сейчас подключён к клиенту напрямую. */
function ConnectedModuleCard({
  module,
  kind,
  battery,
  rssi,
  firmware,
  onDisconnect,
  onBlock,
  onUnbind,
}: {
  module: ModuleRow;
  kind: 'usb' | 'ble' | null;
  battery: number;
  rssi: number;
  firmware: string;
  onDisconnect: () => void;
  onBlock: () => void;
  onUnbind: () => void;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const status = moduleStatusView(module);
  const batteryPct = Math.max(0, Math.min(100, Math.round(battery)));
  const batteryTone = batteryPct <= 20 ? 'danger' : batteryPct <= 50 ? 'warning' : 'success';
  const batteryColor =
    batteryTone === 'danger' ? theme.danger : batteryTone === 'warning' ? theme.warning : theme.success;
  const neighbors = Math.max(0, Number(module.neighbors ?? 0));
  const lastSeen = module.lastSeenAt ?? module.last_seen_at;
  const transportName = kind === 'ble' ? 'Bluetooth LE' : kind === 'usb' ? 'USB' : 'USB / BLE';
  const transportHint =
    kind === 'ble' ? 'Беспроводное подключение к этому устройству' : kind === 'usb' ? 'Кабель к компьютеру' : 'Прямое подключение к клиенту';

  return (
    <MotiView
      from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 10, scale: 0.995 }}
      animate={{ opacity: 1, translateY: 0, scale: 1 }}
      transition={reduced ? { type: 'timing', duration: 0 } : motion.spring}
    >
      <GlassCard style={{ borderColor: theme.accent, borderWidth: 1.5 }}>
        <View style={{ padding: 14, gap: 11 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View
              style={{
                width: 42,
                height: 42,
                borderRadius: 13,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: theme.accentSoft,
              }}
            >
              <Ionicons name="watch-outline" size={21} color={theme.accent} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: theme.textPrimary, fontSize: 16, fontWeight: '800' }} numberOfLines={1}>
                {moduleName(module)}
              </Text>
              <Text
                style={{ color: theme.textSecondary, fontSize: 12, marginTop: 2 }}
                numberOfLines={1}
              >
                {module.publicId ? `ID ${module.publicId}` : 'ID пока нет'} · {moduleRoleLabel(module.role)}
              </Text>
            </View>
            <StatusBadge text={status.text} tone={status.tone} />
          </View>

          {/* Главный акцент: каким образом модуль подключён к клиенту. */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 11,
              padding: 12,
              borderRadius: 14,
              backgroundColor: theme.accentSoft,
            }}
          >
            <View
              style={{
                width: 38,
                height: 38,
                borderRadius: 12,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: theme.surfaceElevated,
              }}
            >
              <Ionicons
                name={kind === 'ble' ? 'bluetooth' : 'usb-outline'}
                size={20}
                color={theme.accent}
              />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: theme.textSecondary, fontSize: 10, fontWeight: '700', letterSpacing: 0.4 }}>
                ПОДКЛЮЧЁН К КЛИЕНТУ
              </Text>
              <Text style={{ color: theme.accent, fontSize: 21, fontWeight: '800' }} numberOfLines={1}>
                {transportName}
              </Text>
              <Text style={{ color: theme.textSecondary, fontSize: 11 }} numberOfLines={1}>
                {transportHint}
              </Text>
            </View>
          </View>

          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ color: theme.textSecondary, fontSize: 12 }}>Заряд</Text>
            <Text
              style={{
                color: batteryColor,
                fontSize: 12,
                fontWeight: '700',
                fontVariant: ['tabular-nums'] as never,
              }}
            >
              {batteryPct}%
            </Text>
          </View>
          <ProgressBar pct={batteryPct} tone={batteryTone} />

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <StatusBadge text={`${neighbors} соседей`} tone={neighbors > 0 ? 'accent' : 'neutral'} />
            <StatusBadge text={moduleEnvironmentLabel(module.kind, module.transport)} tone="neutral" />
            {firmware ? <StatusBadge text={`прошивка ${firmware}`} tone="neutral" /> : null}
          </View>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 2 }}>
            <MiniStat icon="battery-half-outline" label="Заряд" value={`${batteryPct}%`} color={batteryColor} />
            <MiniStat
              icon="wifi-outline"
              label="RSSI"
              value={rssi === 0 ? '—' : `${rssi} dBm`}
              color={rssi === 0 ? theme.textDisabled : theme.textPrimary}
            />
            <MiniStat icon="time-outline" label="Последний контакт" value={formatRelative(lastSeen)} />
            <MiniStat icon="git-network-outline" label="Соседи" value={String(neighbors)} />
          </View>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' }}>
            <Btn title="Отключить" size="s" variant="ghost" onPress={onDisconnect} />
            <Btn title="Заблокировать" size="s" variant="danger" onPress={onBlock} />
            <Btn title="Отвязать" size="s" variant="danger" onPress={onUnbind} />
          </View>
        </View>
      </GlassCard>
    </MotiView>
  );
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
  const [flowMode, setFlowMode] = useState<FlowMode | undefined>(undefined);
  const [mapExpanded, setMapExpanded] = useState(false);
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
  const loading = modules.isLoading;

  /** Носимый модуль, который прямо сейчас подключён к этому клиенту. */
  const directInfo = localConnection.connected ? localConnection.info : null;
  const directModule =
    directInfo && directInfo.role === 'wearable' && directInfo.hardwareId
      ? realModules.find((module) => hardwareIdOf(module) === directInfo.hardwareId.toLowerCase()) ?? null
      : null;
  const directKind: 'usb' | 'ble' | null =
    localConnection.connection?.kind ??
    (directModule?.transport === 'ble' ? 'ble' : directModule?.transport === 'usb' ? 'usb' : null);

  const openFlow = (mode?: FlowMode) => {
    setFlowMode(mode);
    setConnectOpen(true);
  };

  const filtering = query.trim().length > 0 || filter !== 'all';
  const predicate = (module: ModuleRow) => matchesFilter(module, filter) && matchesQuery(module, query);

  const activeModules = realModules
    .filter((module) => module.id !== directModule?.id && module.online === true && !module.blocked)
    .filter(predicate);
  const inactiveModules = realModules
    .filter((module) => module.id !== directModule?.id && (module.online !== true || module.blocked))
    .filter(predicate);
  const nothingFound = filtering && activeModules.length === 0 && inactiveModules.length === 0;

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

  const disconnectCurrent = async () => {
    try {
      await localConnection.disconnect();
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

  const autoStatus = localConnection.busy
    ? {
        icon: 'sync-outline' as const,
        color: theme.accent,
        text: localConnection.busy === 'usb' ? 'Ищем модули по USB…' : 'Ищем модули рядом по Bluetooth…',
      }
    : directInfo
      ? {
          icon: 'checkmark-circle-outline' as const,
          color: theme.success,
          text: `Модуль подключён · ${moduleRoleLabel(directInfo.role)}${
            directInfo.publicId ? ` ${directInfo.publicId}` : ''
          }`,
        }
      : null;

  const subtitle = loading
    ? 'Загружаем модули…'
    : total > 0
      ? `${total} модулей · ${online} онлайн · ${gateways} шлюзов`
      : 'Модули расширяют покрытие mesh-сети';

  const renderCard = (module: ModuleRow, index: number) => (
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
  );

  return (
    <SettingsPage
      title="Модули"
      subtitle={subtitle}
      right={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <HeaderIconButton icon="add" label="Добавить модуль" onPress={() => openFlow()} />
          <HeaderIconButton
            icon="refresh-outline"
            label="Обновить список модулей"
            onPress={() => void modules.refetch()}
            disabled={modules.isFetching}
          />
        </View>
      }
    >
      {/* 1. КАРТА СЕТИ — от носимого модуля, подключённого к клиенту. */}
      <SettingsSection
        title="Карта сети"
        delay={0}
        right={
          <Text style={{ color: theme.textDisabled, fontSize: 11.5, fontWeight: '600' }}>
            {loading ? '…' : `${total} узлов`}
          </Text>
        }
      >
        {loading ? (
          <GlassCard>
            <View style={{ height: 190, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: theme.textSecondary, fontSize: 12 }}>Строим карту сети…</Text>
            </View>
          </GlassCard>
        ) : directModule ? (
          <>
            <GlassCard>
              <ModulesNetworkMap
                modules={realModules}
                focus={directModule}
                selectedId={selectedId}
                onSelect={(module) => setSelectedId(module.id)}
                expanded={mapExpanded}
              />
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  paddingHorizontal: 12,
                  paddingVertical: 9,
                  borderTopWidth: 1,
                  borderTopColor: theme.line,
                }}
              >
                <Text style={{ color: theme.textDisabled, fontSize: 10.5, flex: 1 }} numberOfLines={1}>
                  Центр — носимый модуль, подключённый к клиенту
                </Text>
                <Pressable
                  onPress={() => setMapExpanded((value) => !value)}
                  accessibilityRole="button"
                  accessibilityLabel={mapExpanded ? 'Свернуть карту' : 'Развернуть карту'}
                  hitSlop={8}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 3,
                    opacity: pressed ? 0.6 : 1,
                  })}
                >
                  <Text style={{ color: theme.accent, fontSize: 11.5, fontWeight: '700' }}>
                    {mapExpanded ? 'Свернуть' : 'Развернуть'}
                  </Text>
                  <Ionicons
                    name={mapExpanded ? 'chevron-up' : 'chevron-down'}
                    size={13}
                    color={theme.accent}
                  />
                </Pressable>
              </View>
            </GlassCard>
            <View
              style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingHorizontal: 2, marginTop: 8 }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <View style={{ width: 7, height: 7, borderRadius: 999, backgroundColor: theme.accent }} />
                <Text style={{ color: theme.textDisabled, fontSize: 10.5 }}>ваш модуль</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <View style={{ width: 7, height: 7, borderRadius: 999, backgroundColor: theme.success }} />
                <Text style={{ color: theme.textDisabled, fontSize: 10.5 }}>онлайн</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <View style={{ width: 7, height: 7, borderRadius: 999, backgroundColor: theme.textDisabled }} />
                <Text style={{ color: theme.textDisabled, fontSize: 10.5 }}>офлайн</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <Ionicons name="globe-outline" size={11} color={theme.warning} />
                <Text style={{ color: theme.textDisabled, fontSize: 10.5 }}>шлюз с интернетом</Text>
              </View>
            </View>
          </>
        ) : (
          <GlassCard>
            <View style={{ padding: 18, alignItems: 'center', gap: 9 }}>
              <View
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 16,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: theme.accentSoft,
                }}
              >
                <Ionicons name="bluetooth-outline" size={25} color={theme.accent} />
              </View>
              <Text style={{ color: theme.textPrimary, fontSize: 14.5, fontWeight: '700' }}>
                Карта сети пока не построена
              </Text>
              <Text
                style={{
                  color: theme.textSecondary,
                  fontSize: 12,
                  lineHeight: 18,
                  textAlign: 'center',
                  maxWidth: 320,
                }}
              >
                Подключите носимый модуль, чтобы построить карту
              </Text>
              <Btn title="Добавить модуль" size="s" onPress={() => openFlow('prepared')} />
            </View>
          </GlassCard>
        )}
      </SettingsSection>

      {/* Найденные рядом носимые модули (автопоиск BLE). */}
      <NearbyModulesBanner onConnect={() => void localConnection.connectBle()} />

      {/* 2. ТЕКУЩИЙ МОДУЛЬ — прямое USB/BLE-подключение. */}
      {!loading && total > 0 ? (
        <SettingsSection
          title="Текущий модуль"
          delay={motion.staggerStepMs}
          right={<Text style={{ color: theme.textDisabled, fontSize: 11.5 }}>USB / BLE</Text>}
        >
          {directModule ? (
            <ConnectedModuleCard
              module={directModule}
              kind={directKind}
              battery={Number(directInfo?.battery ?? directModule.battery ?? 0)}
              rssi={Number(directInfo?.rssi || directModule.rssi || 0)}
              firmware={directInfo?.firmware || directModule.firmware || ''}
              onDisconnect={() => void disconnectCurrent()}
              onBlock={() => {
                setBlockReason('');
                setBlockTarget(directModule);
              }}
              onUnbind={() => setUnbindTarget(directModule)}
            />
          ) : (
            <GlassCard>
              <View style={{ padding: 12, flexDirection: 'row', alignItems: 'center', gap: 9 }}>
                <Ionicons name="information-circle-outline" size={17} color={theme.textDisabled} />
                <Text style={{ color: theme.textSecondary, fontSize: 12, flex: 1, lineHeight: 17 }}>
                  Носимый модуль не подключён к клиенту. Подключите его по USB или BLE, чтобы видеть текущий
                  модуль и строить карту от него.
                </Text>
              </View>
            </GlassCard>
          )}
        </SettingsSection>
      ) : null}

      {autoStatus ? (
        <View
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 2, marginBottom: 12 }}
        >
          <Ionicons name={autoStatus.icon} size={14} color={autoStatus.color} />
          <Text style={{ color: autoStatus.color, fontSize: 12, flex: 1 }} numberOfLines={1}>
            {autoStatus.text}
          </Text>
        </View>
      ) : null}

      {!loading && total > 0 ? (
        <>
          {/* Поиск и фильтры применяются к активным и неактивным модулям. */}
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

          {/* 3. АКТИВНЫЕ МОДУЛИ. */}
          <SettingsSection
            title="Активные модули"
            delay={motion.staggerStepMs}
            right={
              <Text style={{ color: theme.textDisabled, fontSize: 11.5, fontWeight: '600' }}>
                {filtering ? `${activeModules.length} из ${total}` : `${activeModules.length} шт.`}
              </Text>
            }
          >
            {nothingFound ? (
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
            ) : activeModules.length === 0 ? (
              <Text style={{ color: theme.textSecondary, fontSize: 12, paddingHorizontal: 2, paddingBottom: 4 }}>
                {directModule
                  ? 'Других активных модулей сейчас нет.'
                  : 'Активных модулей сейчас нет. Подключите носимый модуль или дождитесь выхода шлюзов в сеть.'}
              </Text>
            ) : (
              activeModules.map((module, index) => renderCard(module, index))
            )}
          </SettingsSection>

          {/* 4. НЕАКТИВНЫЕ МОДУЛИ. */}
          {inactiveModules.length > 0 ? (
            <SettingsSection
              title="Неактивные модули"
              delay={motion.staggerStepMs}
              right={
                <Text style={{ color: theme.textDisabled, fontSize: 11.5, fontWeight: '600' }}>
                  {inactiveModules.length} шт.
                </Text>
              }
            >
              <Text style={{ color: theme.textSecondary, fontSize: 11.5, paddingHorizontal: 2, marginBottom: 8 }}>
                Офлайн или заблокированы. Карточка покажет последний контакт и доступные действия.
              </Text>
              {inactiveModules.map((module, index) => renderCard(module, index))}
            </SettingsSection>
          ) : null}
        </>
      ) : null}

      {/* Shadow-записи модулей, привязанных на другом устройстве. */}
      {!loading && shadows.length > 0 ? (
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
                          <Text
                            style={{ color: theme.textSecondary, fontSize: 12, marginTop: 2 }}
                            numberOfLines={2}
                          >
                            {module.message ||
                              'Был привязан на другом устройстве. Если это не вы — не подключайте его.'}
                          </Text>
                        </View>
                        <StatusBadge text="отвязан" tone="warning" />
                      </View>

                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                        {module.publicId ? <StatusBadge text={`ID ${module.publicId}`} tone="neutral" /> : null}
                        <StatusBadge text={moduleRoleLabel(module.role)} tone="accent" />
                        <StatusBadge
                          text={moduleEnvironmentLabel(module.kind, module.transport)}
                          tone="neutral"
                        />
                      </View>

                      <Text style={{ color: theme.textSecondary, fontSize: 11.5, lineHeight: 17 }}>
                        Мы не добавляем такой модуль в ваш аккаунт автоматически. Удалите запись, если он вам не
                        нужен, или сообщите «Это не я», если модуль подключили без вашего ведома.
                      </Text>

                      <View
                        style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}
                      >
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

      {!loading && total === 0 ? (
        <View style={{ minHeight: 300, justifyContent: 'center' }}>
          <EmptyState
            icon="hardware-chip-outline"
            title="Модулей пока нет"
            subtitle="Прошейте новый модуль, добавьте уже прошитый по USB/BLE — или найдите автономный шлюз по 8-значному ID."
            actionLabel="Добавить модуль"
            onAction={() => openFlow()}
          />
        </View>
      ) : null}

      {loading ? <CardsSkeleton count={2} /> : null}

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 2, marginTop: 4 }}>
        <Ionicons name="wifi-outline" size={13} color={theme.textDisabled} />
        <Text style={{ color: theme.textDisabled, fontSize: 11.5, flex: 1 }} numberOfLines={2}>
          {MESH_ALWAYS.networkLine} · модуль — вклад в общую связь
        </Text>
      </View>

      {/* Полноэкранный мастер подключения/прошивки. */}
      <ConnectModuleFlow
        visible={connectOpen}
        initialMode={flowMode}
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
