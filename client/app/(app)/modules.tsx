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
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useFocusEffect } from 'expo-router';
import { api, type ModuleRow, type ModuleTransferRow } from '../../src/data/api';
import {
  humanError,
  useAcceptModuleTransfer,
  useAttachModule,
  useBlockModule,
  useCancelModuleTransfer,
  useDeclineModuleTransfer,
  useDetachModule,
  useDismissModuleShadow,
  useModuleTransfers,
  useModules,
  useReportModuleShadow,
  useUnbindModule,
  useUnblockModule,
} from '../../src/data/queries';
import { Btn } from '../../src/components/Btn';
import { useTheme } from '../../src/theme/useTheme';
import { motion } from '../../src/theme/motion';
import { useReducedMotion } from '../../src/components/useReducedMotion';
import { useStore } from '../../src/state/useStore';
import { GlassCard, SettingsPage, SettingsSection } from '../../src/components/settings/SettingsUI';
import { CardsSkeleton } from '../../src/components/skeletons/PageSkeletons';
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
import { ModuleOtaSheet } from '../../src/components/modules/ModuleOtaSheet';
import { ModulesNetworkMap } from '../../src/components/modules/ModulesNetworkMap';
import { SerialMonitor } from '../../src/components/modules/SerialMonitor';
import {
  MESH_ALWAYS,
  moduleEnvironmentLabel,
  moduleRoleLabel,
  moduleStatusView,
  firmwareUpdateAvailable,
} from '../../src/components/modules/moduleUi';
import { useModuleConnection } from '../../src/modules/ModuleProvider';
import { ModuleConfigSheet } from '../../src/components/modules/ModuleConfigSheet';
import { ClusterMap, nodeIdFromMac, type MapLink, type MapNode } from '../../src/components/modules/ClusterMap';
import { kv } from '../../src/crypto/storage';
import { router } from 'expo-router';

const LAST_ROOT_KEY = 'sg:kmesh:map-root';

type ModuleFilter = 'all' | 'online' | 'offline' | 'blocked' | 'wearable' | 'repeater' | 'gateway';
type FlowMode = 'prepared' | 'flash' | 'claim';

/** Период опроса модулей, пока страница «Модули» в фокусе. */
const MODULES_POLL_MS = 3000;

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
  onOta,
}: {
  module: ModuleRow;
  kind: 'usb' | 'ble' | null;
  battery: number;
  rssi: number;
  firmware: string;
  onDisconnect: () => void;
  onBlock: () => void;
  onUnbind: () => void;
  onOta: () => void;
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
                MAC {module.hardwareId || module.boardUuid || '—'} · {moduleRoleLabel(module.role)}
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
                name={kind === 'ble' ? 'bluetooth' : 'hardware-chip'}
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
            <Btn title="Обновить" size="s" variant="ghost" onPress={onOta} />
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
  const transfers = useModuleTransfers();
  const acceptTransfer = useAcceptModuleTransfer();
  const declineTransfer = useDeclineModuleTransfer();
  const cancelTransfer = useCancelModuleTransfer();

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
  const [otaTarget, setOtaTarget] = useState<ModuleRow | null>(null);
  const [releases, setReleases] = useState<Record<string, string>>({});
  const [meshModules, setMeshModules] = useState<{
    modules: Array<{ moduleMac: string; mod6: string; customName: string; bleName: string; online?: boolean }>;
    incoming: Array<{ id: string; moduleMac: string; mod6: string; toUsername: string }>;
    outgoing: Array<{ id: string; moduleMac: string; mod6: string; fromUsername: string }>;
    identity: { blePrefix: string; netId: number };
  } | null>(null);

  const reloadMeshModules = useCallback(async () => {
    try {
      const res = await api.kmeshV1Modules();
      setMeshModules({
        modules: res.modules,
        incoming: res.incoming,
        outgoing: res.outgoing,
        identity: res.identity,
      });
    } catch {
      /* оффлайн: показываем локальные данные */
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void api
      .firmwareReleases()
      .then((list) => {
        if (!alive) return;
        setReleases(Object.fromEntries(list.map((r) => [r.board, r.version])));
      })
      .catch(() => undefined);
    void reloadMeshModules();
    // Статус KMesh-модулей (онлайн/офлайн) должен обновляться без перезахода.
    const meshTimer = setInterval(() => {
      if (AppState.currentState !== 'background') void reloadMeshModules();
    }, 15_000);
    return () => {
      alive = false;
      clearInterval(meshTimer);
    };
  }, [reloadMeshModules]);
  /** События WebSocket, которые кладёт общий RealtimeBridge (второй сокет не нужен). */
  const pushEvent = useStore((s) => s.pushEvent);

  /* ------------------------------------------------- realtime модулей -- */
  // Пока экран в фокусе и приложение активно, список обновляется каждые 3 с.
  // При уходе со страницы интервал снимается — фонового трафика нет.
  const focusedRef = useRef(false);
  const appActiveRef = useRef(AppState.currentState !== 'background');
  const refreshBusyRef = useRef(false);
  const refetchRef = useRef(modules.refetch);
  refetchRef.current = modules.refetch;

  const refreshModules = useCallback(() => {
    if (!focusedRef.current || !appActiveRef.current || refreshBusyRef.current) return;
    refreshBusyRef.current = true;
    void refetchRef
      .current()
      .catch(() => undefined)
      .finally(() => {
        refreshBusyRef.current = false;
      });
  }, []);

  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      refreshModules();
      const timer = setInterval(refreshModules, MODULES_POLL_MS);
      return () => {
        focusedRef.current = false;
        clearInterval(timer);
      };
    }, [refreshModules]),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      appActiveRef.current = state === 'active';
      if (state === 'active') refreshModules();
    });
    return () => subscription.remove();
  }, [refreshModules]);

  // Если push-событие о модуле всё же пришло через общий сокет — обновляем сразу.
  useEffect(() => {
    if (!pushEvent) return;
    const kind = String(pushEvent.kind ?? '').toLowerCase();
    if (!kind || !/module|status/.test(kind)) return;
    if (!focusedRef.current || !appActiveRef.current) return;
    void refetchRef.current().catch(() => undefined);
  }, [pushEvent]);

  const list = modules.data ?? [];
  // Жёсткая дедупликация по MAC: один физический модуль = одна карточка,
  // даже если сервер/кэш успели вернуть старую и новую запись.
  const realModules = useMemo(() => {
    const byMac = new Map<string, ModuleRow>();
    for (const module of list) {
      if (isShadow(module)) continue;
      const key = hardwareIdOf(module) || module.id;
      const prev = byMac.get(key);
      if (!prev || String(module.lastSeenAt ?? '') > String(prev.lastSeenAt ?? '')) {
        byMac.set(key, module);
      }
    }
    // Модуль может быть уже подключён по BLE, но ещё не появиться в ответе
    // сервера (pair/attach в процессе или офлайн). Показываем локальную карточку.
    const info = localConnection.connected ? localConnection.info : null;
    if (info?.hardwareId) {
      const key = info.hardwareId.toLowerCase();
      if (!byMac.has(key)) {
        byMac.set(key, {
          id: `local:${key}`,
          hardwareId: info.hardwareId,
          publicId: info.publicId,
          role: info.role,
          online: true,
          status: 'attached',
          transport: localConnection.connection?.kind ?? 'ble',
          firmware: info.firmware,
          battery: info.battery,
          name: info.publicId ? `Модуль ${info.publicId}` : 'Носимый модуль',
          lastSeenAt: new Date().toISOString(),
          attached: true,
          blocked: false,
        } as unknown as ModuleRow);
      }
    }
    return [...byMac.values()];
  }, [list, localConnection.connected, localConnection.info, localConnection.connection]);
  const shadows = list.filter(isShadow);
  const total = realModules.length;
  const online = realModules.filter((module) => module.online === true && !module.blocked).length;
  const updateCount = realModules.filter((module) => {
    const latest = releases[module.board || 'esp32'];
    return firmwareUpdateAvailable(latest, module.firmware);
  }).length;
  const gateways = realModules.filter((module) => (module.role ?? 'gateway') === 'gateway').length;
  const loading = modules.isLoading;

  /** Носимый модуль, который прямо сейчас подключён к этому клиенту. */
  const directInfo = localConnection.connected ? localConnection.info : null;
  const directModule =
    directInfo && directInfo.hardwareId
      ? realModules.find((module) => hardwareIdOf(module) === directInfo.hardwareId.toLowerCase()) ?? null
      : null;
  const directKind: 'usb' | 'ble' | null =
    localConnection.connection?.kind ??
    (directModule?.transport === 'ble' ? 'ble' : directModule?.transport === 'usb' ? 'usb' : null);

  /** Причина, по которой Serial-монитор не должен занимать USB-порт. */
  const serialBlockedReason = connectOpen
    ? 'Открыт мастер подключения/прошивки. Закройте его, чтобы открыть Serial-порт.'
    : localConnection.busy
      ? 'Идёт поиск модуля по USB/BLE. Дождитесь окончания.'
      : localConnection.connected
        ? 'Модуль подключён к клиенту и занимает USB-порт. Сначала отключите его.'
        : undefined;

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

  /** Удаление модуля из аккаунта: и записи сервера, и привязки по MAC (в том числе без данных о модуле). */
  const confirmDelete = async () => {
    const target = deleteTarget;
    if (!target) return;
    try {
      if (target.legacy && !String(target.legacy.id).startsWith('local:')) {
        await unbind.mutateAsync(target.legacy.id).catch(() => undefined);
      }
      if (target.mesh) await api.kmeshV1DeleteModule(target.mesh.moduleMac).catch(() => undefined);
      await reloadMeshModules();
      void modules.refetch();
      useStore.getState().pushToast({ kind: 'success', message: 'Модуль удалён' });
    } catch (error) {
      useStore.getState().pushToast({ kind: 'error', message: humanError(error) });
    } finally {
      setDeleteTarget(null);
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

  const acceptIncoming = async (transfer: ModuleTransferRow) => {
    try {
      await acceptTransfer.mutateAsync(transfer.id);
      useStore.getState().pushToast({
        kind: 'success',
        message: `Модуль ${transfer.publicId || transfer.moduleName} передан вам`,
      });
    } catch (error) {
      useStore.getState().pushToast({ kind: 'error', message: humanError(error) });
    }
  };

  const declineIncoming = async (transfer: ModuleTransferRow) => {
    try {
      await declineTransfer.mutateAsync(transfer.id);
      useStore.getState().pushToast({ kind: 'success', message: 'Заявка на перенос отклонена' });
    } catch (error) {
      useStore.getState().pushToast({ kind: 'error', message: humanError(error) });
    }
  };

  const cancelOutgoing = async (transfer: ModuleTransferRow) => {
    try {
      await cancelTransfer.mutateAsync(transfer.id);
      useStore.getState().pushToast({ kind: 'success', message: 'Заявка на перенос отменена' });
    } catch (error) {
      useStore.getState().pushToast({ kind: 'error', message: humanError(error) });
    }
  };

  const transferBusy =
    acceptTransfer.isPending || declineTransfer.isPending || cancelTransfer.isPending;

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

  /* ------------------------------------------------ карта и список -- */
  const [configTarget, setConfigTarget] = useState<{ name: string; mac: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ key: string; name: string; mac: string; mesh?: { moduleMac: string }; legacy?: ModuleRow } | null>(null);
  const [topology, setTopology] = useState<Awaited<ReturnType<typeof api.kmeshV1Topology>> | null>(null);
  const [rootId, setRootId] = useState<number>(0);

  // Корень карты — последний подключённый носимый модуль (запоминаем между сессиями).
  useEffect(() => {
    if (directInfo?.nodeId) {
      setRootId(directInfo.nodeId);
      void kv.set(LAST_ROOT_KEY, String(directInfo.nodeId)).catch(() => undefined);
    } else if (!rootId) {
      void kv
        .get(LAST_ROOT_KEY)
        .then((v) => v && setRootId(Number(v) || 0))
        .catch(() => undefined);
    }
  }, [directInfo?.nodeId, rootId]);

  useEffect(() => {
    let alive = true;
    const load = () => {
      if (AppState.currentState === 'background') return;
      void api
        .kmeshV1Topology(rootId || undefined)
        .then((t) => alive && setTopology(t))
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [rootId]);

  const map = useMemo(() => {
    const byNode = new Map<number, { name: string; mac: string }>();
    for (const m of meshModules?.modules ?? []) {
      const id = nodeIdFromMac(m.moduleMac);
      if (id) byNode.set(id, { name: m.customName || `Модуль ${m.mod6}`, mac: m.moduleMac });
    }
    const root = rootId || topology?.root || 0;
    if (!root) return { nodes: [] as MapNode[], links: [] as MapLink[], byNode };
    const nodes = new Map<number, MapNode>();
    const linkMap = new Map<string, MapLink>();
    const addLink = (a: number, b: number, rssi: number, flags: number) => {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const prev = linkMap.get(key);
      if (!prev || rssi > prev.rssi) linkMap.set(key, { a, b, rssi, lora: (flags & 2) !== 0 });
    };
    const label = (id: number, fallback?: string) =>
      byNode.get(id)?.name || fallback || `Узел ${id.toString(16).slice(-4)}`;
    const topo = topology && topology.root === root ? topology : null;
    const rootTopo = topo?.nodes.find((n) => n.nodeId === root);
    const liveNb = directInfo?.nodeId === root ? directInfo.nb ?? [] : null;
    nodes.set(root, {
      nodeId: root,
      name: label(root, (directInfo?.nodeId === root ? directInfo.name : '') || rootTopo?.name || 'Мой модуль'),
      mac: byNode.get(root)?.mac,
      online: directInfo?.nodeId === root || Boolean(rootTopo?.online),
      gateway: false,
      hub: Boolean(rootTopo?.hub),
      rssi: null,
      battery: directInfo?.nodeId === root ? directInfo.battery : rootTopo?.battery ?? null,
      layer: 0,
      mine: true,
    });
    const direct = new Set<number>();
    for (const [id, rssi, flags] of liveNb ?? []) {
      direct.add(id >>> 0);
      addLink(root, id >>> 0, rssi, flags);
    }
    for (const l of topo?.links ?? []) {
      if (!liveNb && (l.a === root || l.b === root)) direct.add(l.a === root ? l.b : l.a);
      addLink(l.a, l.b, l.rssi, l.flags);
    }
    for (const n of topo?.nodes ?? []) {
      if (n.nodeId === root) continue;
      nodes.set(n.nodeId, {
        nodeId: n.nodeId,
        name: label(n.nodeId, n.name),
        mac: byNode.get(n.nodeId)?.mac,
        online: n.online,
        gateway: n.role === 2 || n.hub,
        hub: n.hub,
        rssi: n.rssi,
        battery: n.battery,
        layer: direct.has(n.nodeId) ? 1 : n.sameCluster ? 2 : 3,
        mine: byNode.has(n.nodeId),
      });
    }
    for (const [id, rssi, flags] of liveNb ?? []) {
      const nid = id >>> 0;
      const prev = nodes.get(nid);
      if (prev) {
        prev.online = true;
        prev.rssi = rssi;
        prev.layer = 1;
        if (flags & 1) prev.gateway = true;
      } else {
        nodes.set(nid, {
          nodeId: nid,
          name: label(nid),
          mac: byNode.get(nid)?.mac,
          online: true,
          gateway: (flags & 1) !== 0,
          hub: false,
          rssi,
          battery: null,
          layer: 1,
          mine: byNode.has(nid),
        });
      }
    }
    const links = [...linkMap.values()].filter((l) => nodes.has(l.a) && nodes.has(l.b));
    return { nodes: [...nodes.values()], links, byNode };
  }, [meshModules, topology, rootId, directInfo]);

  type Row = {
    key: string;
    name: string;
    mac: string;
    role: string;
    online: boolean;
    rssi: number | null;
    battery: number | null;
    mesh?: NonNullable<typeof meshModules>['modules'][number];
    legacy?: ModuleRow;
  };
  const rows = useMemo<Row[]>(() => {
    const macKey = (v: string) => v.toLowerCase().replace(/^esp32-/, '').replace(/[^0-9a-f]/g, '');
    const out = new Map<string, Row>();
    const mapNode = (mac: string) => map.nodes.find((n) => n.nodeId === nodeIdFromMac(mac));
    for (const m of meshModules?.modules ?? []) {
      const node = mapNode(m.moduleMac);
      out.set(macKey(m.moduleMac), {
        key: macKey(m.moduleMac),
        name: m.customName || node?.name || `Модуль ${m.mod6}`,
        mac: m.moduleMac,
        role: node?.layer === 0 ? 'носимый' : node?.gateway ? 'шлюз' : '',
        online: Boolean(m.online || node?.online),
        rssi: node?.rssi ?? null,
        battery: node?.battery ?? null,
        mesh: m,
      });
    }
    for (const mod of realModules) {
      const key = macKey(hardwareIdOf(mod)) || mod.id;
      const prev = out.get(key);
      const live = directInfo && macKey(directInfo.hardwareId) === key;
      const merged: Row = {
        key,
        name: prev?.name || moduleName(mod),
        mac: prev?.mac || hardwareIdOf(mod),
        role: moduleRoleLabel(mod.role),
        online: Boolean(prev?.online || live || (mod.online === true && !mod.blocked)),
        rssi: live && directInfo.rssi ? directInfo.rssi : prev?.rssi ?? (mod.rssi ? Number(mod.rssi) : null),
        battery: live ? directInfo.battery : prev?.battery ?? (mod.battery != null ? Number(mod.battery) : null),
        mesh: prev?.mesh,
        legacy: mod,
      };
      out.set(key, merged);
    }
    return [...out.values()].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  }, [meshModules, realModules, map, directInfo]);

  const subtitle = loading
    ? 'Загружаем модули…'
    : total > 0
      ? `${total} модулей · ${online} онлайн · ${gateways} шлюзов${updateCount ? ` · ${updateCount} обновлений` : ''}`
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
      onOta={(value) => setOtaTarget(value)}
      latestVersion={releases[module.board || 'esp32'] ?? releases.esp32}
    />
  );

  return (
    <SettingsPage
      title="Модули"
      subtitle={subtitle}
      right={<HeaderIconButton icon="add" label="Добавить модуль" onPress={() => router.push('/modules-add')} />}
    >
      {/* 1. ПОДКЛЮЧЁННЫЙ МОДУЛЬ — только при активном BLE/USB-подключении. */}
      {directModule ? (
        <SettingsSection title="Подключённый модуль" delay={0}>
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
            onOta={() => setOtaTarget(directModule)}
          />
        </SettingsSection>
      ) : autoStatus ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 2, marginBottom: 12 }}>
          <Ionicons name={autoStatus.icon} size={14} color={autoStatus.color} />
          <Text style={{ color: autoStatus.color, fontSize: 12, flex: 1 }} numberOfLines={1}>
            {autoStatus.text}
          </Text>
        </View>
      ) : null}

      {/* 2. КАРТА КЛАСТЕРА — от последнего подключённого носимого, данные модуля + Hub. */}
      <SettingsSection
        title="Карта кластера"
        delay={motion.staggerStepMs}
        right={
          <Text style={{ color: theme.textDisabled, fontSize: 11.5, fontWeight: '600' }}>
            {map.nodes.length ? `${map.nodes.length} узлов` : ''}
          </Text>
        }
      >
        <GlassCard>
          {map.nodes.length ? (
            <ClusterMap nodes={map.nodes} links={map.links} />
          ) : (
            <View style={{ padding: 18, alignItems: 'center', gap: 8 }}>
              <Ionicons name="git-network-outline" size={26} color={theme.textDisabled} />
              <Text style={{ color: theme.textSecondary, fontSize: 12, textAlign: 'center', lineHeight: 18 }}>
                Подключите носимый модуль — карта строится от него и обновляется по данным модуля и Hub.
              </Text>
            </View>
          )}
        </GlassCard>
        {map.nodes.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingHorizontal: 2, marginTop: 8 }}>
            {[
              { c: theme.accent, t: 'мой модуль' },
              { c: theme.success, t: 'онлайн' },
              { c: theme.textDisabled, t: 'офлайн' },
            ].map((x) => (
              <View key={x.t} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <View style={{ width: 7, height: 7, borderRadius: 999, backgroundColor: x.c }} />
                <Text style={{ color: theme.textDisabled, fontSize: 10.5 }}>{x.t}</Text>
              </View>
            ))}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <Ionicons name="globe-outline" size={11} color={theme.warning} />
              <Text style={{ color: theme.textDisabled, fontSize: 10.5 }}>шлюз с Hub</Text>
            </View>
            <Text style={{ color: theme.textDisabled, fontSize: 10.5 }}>нижний ряд — соседние кластеры</Text>
          </View>
        ) : null}
      </SettingsSection>

      {/* 3. КОМПАКТНЫЙ СПИСОК — онлайн сначала. */}
      <SettingsSection
        title="Мои модули"
        delay={motion.staggerStepMs}
        right={
          <Text style={{ color: theme.textDisabled, fontSize: 11.5, fontWeight: '600' }}>
            {rows.length ? `${rows.filter((r) => r.online).length} из ${rows.length} онлайн` : ''}
          </Text>
        }
      >
        <GlassCard>
          {rows.length === 0 ? (
            <Text style={{ color: theme.textSecondary, fontSize: 12, padding: 12 }}>
              {loading ? 'Загружаем модули…' : 'Модулей пока нет. Нажмите «+», чтобы добавить или прошить модуль.'}
            </Text>
          ) : (
            rows.map((r, i) => {
              const fw = r.legacy?.firmware ?? '';
              const latest = r.legacy ? releases[r.legacy.board || 'esp32'] ?? releases.esp32 : undefined;
              const hasUpdate = firmwareUpdateAvailable(latest, fw);
              const isGw = (r.legacy?.role ?? '') === 'gateway';
              const lastSeen = r.legacy?.lastSeenAt ?? r.legacy?.last_seen_at;
              const iconBtn = (
                icon: keyof typeof Ionicons.glyphMap,
                label: string,
                onPress: () => void,
                color: string = theme.textSecondary,
              ) => (
                <Pressable
                  key={label}
                  onPress={onPress}
                  accessibilityRole="button"
                  accessibilityLabel={label}
                  hitSlop={6}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 4,
                    paddingHorizontal: 8,
                    height: 26,
                    borderRadius: 8,
                    backgroundColor: theme.surfacePressed,
                    opacity: pressed ? 0.6 : 1,
                  })}
                >
                  <Ionicons name={icon} size={13} color={color} />
                  <Text style={{ color, fontSize: 11, fontWeight: '600' }}>{label}</Text>
                </Pressable>
              );
              return (
                <View
                  key={r.key}
                  style={{
                    borderTopWidth: i ? 1 : 0,
                    borderTopColor: theme.line,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    gap: 5,
                  }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <View
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: r.online ? theme.success : theme.textDisabled,
                      }}
                    />
                    <Text
                      style={{ color: theme.textPrimary, fontSize: 13, fontWeight: '700', flexShrink: 1 }}
                      numberOfLines={1}
                    >
                      {r.name}
                    </Text>
                    {r.role ? <StatusBadge text={r.role} tone="neutral" /> : null}
                    {hasUpdate ? <StatusBadge text="обновление" tone="accent" /> : null}
                    <View style={{ flex: 1 }} />
                    <Text
                      style={{ color: theme.textSecondary, fontSize: 11, fontVariant: ['tabular-nums'] as never }}
                    >
                      {r.rssi != null ? `${r.rssi} dBm` : ''}
                      {r.rssi != null && r.battery != null ? ' · ' : ''}
                      {r.battery != null ? `${r.battery}%` : ''}
                    </Text>
                  </View>
                  <Text style={{ color: theme.textDisabled, fontSize: 10.5 }} numberOfLines={1}>
                    {r.mac || '—'}
                    {fw ? ` · прошивка ${fw}` : ''}
                    {!r.online && lastSeen ? ` · был(а) ${formatRelative(lastSeen)}` : ''}
                    {r.mesh ? ` · ${r.mesh.bleName}` : ''}
                  </Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    {r.mesh ? (
                      <TextInput
                        defaultValue={r.mesh.customName}
                        placeholder="название"
                        placeholderTextColor={theme.textDisabled}
                        onEndEditing={(event) => {
                          const name = event.nativeEvent.text.trim();
                          if (!r.mesh || name === r.mesh.customName) return;
                          void api
                            .kmeshV1RenameModule(r.mesh.moduleMac, name)
                            .then(() => reloadMeshModules())
                            .catch(() => undefined);
                        }}
                        style={{
                          color: theme.textPrimary,
                          fontSize: 11.5,
                          minWidth: 90,
                          flexGrow: 1,
                          flexBasis: 90,
                          height: 26,
                          paddingVertical: 0,
                          paddingHorizontal: 8,
                          borderRadius: 8,
                          borderWidth: 1,
                          borderColor: theme.line,
                        }}
                      />
                    ) : null}
                    {r.legacy && !String(r.legacy.id).startsWith('local:')
                      ? iconBtn(
                          'cloud-download-outline',
                          hasUpdate ? 'Обновить' : 'Прошивка',
                          () => setOtaTarget(r.legacy!),
                          hasUpdate ? theme.accent : theme.textSecondary,
                        )
                      : null}
                    {r.legacy && isGw ? iconBtn('wifi-outline', 'Wi-Fi', () => setGatewayTarget(r.legacy!)) : null}
                    {r.mac ? iconBtn('settings-outline', 'Настроить', () => setConfigTarget({ name: r.name, mac: r.mac })) : null}
                    {iconBtn('trash-outline', 'Удалить', () => setDeleteTarget(r), theme.danger)}
                  </View>
                </View>
              );
            })
          )}
        </GlassCard>
        {meshModules?.incoming.map((c) => (
          <GlassCard key={c.id} style={{ marginTop: 8 }}>
            <View style={{ padding: 12 }}>
              <Text style={{ color: theme.textPrimary, fontSize: 13, fontWeight: '700' }}>
                @{c.toUsername} просит передать модуль {c.mod6}
              </Text>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                <Btn
                  title="Передать"
                  size="s"
                  onPress={() => {
                    void api.kmeshV1AcceptModuleTransfer(c.id).then(() => reloadMeshModules()).catch(() => undefined);
                  }}
                />
                <Btn
                  title="Отказать"
                  size="s"
                  variant="ghost"
                  onPress={() => {
                    void api.kmeshV1RejectModuleTransfer(c.id).then(() => reloadMeshModules()).catch(() => undefined);
                  }}
                />
              </View>
            </View>
          </GlassCard>
        ))}
        {meshModules?.outgoing.map((c) => (
          <GlassCard key={c.id} style={{ marginTop: 8 }}>
            <View style={{ padding: 12, gap: 8 }}>
              <Text style={{ color: theme.textPrimary, fontSize: 13, fontWeight: '700' }}>
                Модуль {c.mod6}: ждём подтверждения от @{c.fromUsername}
              </Text>
              <Btn
                title="Отменить запрос"
                size="s"
                variant="ghost"
                onPress={() => {
                  void api.kmeshV1CancelModuleTransfer(c.id).then(() => reloadMeshModules()).catch(() => undefined);
                }}
              />
            </View>
          </GlassCard>
        ))}
      </SettingsSection>
      {/* 1b. ЗАЯВКИ НА ПЕРЕНОС — входящие и исходящие. */}
      {(transfers.data?.incoming.length ?? 0) + (transfers.data?.outgoing.length ?? 0) > 0 ? (
        <SettingsSection
          title="Заявки на перенос"
          delay={motion.staggerStepMs}
          right={
            <Text style={{ color: theme.textDisabled, fontSize: 11.5, fontWeight: '600' }}>
              {(transfers.data?.incoming.length ?? 0) + (transfers.data?.outgoing.length ?? 0)} шт.
            </Text>
          }
        >
          {(transfers.data?.incoming ?? []).map((transfer) => (
            <GlassCard key={`in-${transfer.id}`} style={{ marginBottom: 8 }}>
              <View style={{ padding: 12, gap: 9 }}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 9 }}>
                  <View
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 10,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: theme.accentSoft,
                    }}
                  >
                    <Ionicons name="arrow-down-circle-outline" size={18} color={theme.accent} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ color: theme.textPrimary, fontSize: 13.5, fontWeight: '700' }} numberOfLines={1}>
                      {transfer.moduleName || `Модуль ${transfer.publicId}`}
                    </Text>
                    <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 2 }} numberOfLines={2}>
                      От @{transfer.fromOwner.username}
                      {transfer.publicId ? ` · ID ${transfer.publicId}` : ''}
                    </Text>
                  </View>
                  <StatusBadge text="Входящая" tone="accent" />
                </View>
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  <Btn
                    title="Передать"
                    size="s"
                    loading={acceptTransfer.isPending}
                    disabled={transferBusy}
                    onPress={() => void acceptIncoming(transfer)}
                  />
                  <Btn
                    title="Отменить"
                    size="s"
                    variant="ghost"
                    loading={declineTransfer.isPending}
                    disabled={transferBusy}
                    onPress={() => void declineIncoming(transfer)}
                  />
                </View>
              </View>
            </GlassCard>
          ))}
          {(transfers.data?.outgoing ?? []).map((transfer) => (
            <GlassCard key={`out-${transfer.id}`} style={{ marginBottom: 8 }}>
              <View style={{ padding: 12, gap: 9 }}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 9 }}>
                  <View
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 10,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: theme.surfacePressed,
                    }}
                  >
                    <Ionicons name="arrow-up-circle-outline" size={18} color={theme.textSecondary} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ color: theme.textPrimary, fontSize: 13.5, fontWeight: '700' }} numberOfLines={1}>
                      {transfer.moduleName || `Модуль ${transfer.publicId}`}
                    </Text>
                    <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 2 }} numberOfLines={2}>
                      Для @{transfer.toOwner.username}
                      {transfer.publicId ? ` · ID ${transfer.publicId}` : ''}
                    </Text>
                  </View>
                  <StatusBadge text="Исходящая" tone="neutral" />
                </View>
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  <Btn
                    title="Отменить заявку"
                    size="s"
                    variant="ghost"
                    loading={cancelTransfer.isPending}
                    disabled={transferBusy}
                    onPress={() => void cancelOutgoing(transfer)}
                  />
                </View>
              </View>
            </GlassCard>
          ))}
        </SettingsSection>
      ) : null}

      {/* 2b. SERIAL-МОНИТОР — отладка прошивки по USB только на ПК (web). */}
      {Platform.OS === 'web' ? (
        <SettingsSection
          title="Отладка по USB"
          delay={motion.staggerStepMs}
          right={<Text style={{ color: theme.textDisabled, fontSize: 11.5 }}>Serial · 115200</Text>}
        >
          <SerialMonitor blocked={Boolean(serialBlockedReason)} blockedReason={serialBlockedReason} />
        </SettingsSection>
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
                        <StatusBadge text={`MAC ${module.hardwareId || module.boardUuid || '—'}`} tone="neutral" />
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

      {/* OTA: сеть (Wi-Fi) или USB-прошивка. */}
      <ModuleOtaSheet module={otaTarget} onClose={() => setOtaTarget(null)} />

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

      <ModuleConfigSheet target={configTarget} onClose={() => setConfigTarget(null)} />

      <SettingsConfirm
        visible={deleteTarget !== null}
        title="Удалить модуль?"
        message={`«${deleteTarget?.name ?? ''}» будет отвязан от аккаунта. Плату можно будет добавить снова.`}
        confirmLabel="Удалить"
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />

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
