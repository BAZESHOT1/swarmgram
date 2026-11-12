/**
 * Карточка модуля: статус, метрики, идентификация, быстрые действия и
 * раскрываемая диагностика с загрузкой соседей по требованию.
 */
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useQuery } from '@tanstack/react-query';
import * as api from '../../data/api';
import type { MeshNeighbor, ModuleRow } from '../../data/api';
import { humanError } from '../../data/queries';
import { Btn } from '../Btn';
import { GlassCard } from '../settings/SettingsUI';
import { formatDateTime, formatRelative, ProgressBar, StatusBadge } from '../settings/SettingsWidgets';
import { useTheme } from '../../theme/useTheme';
import { motion } from '../../theme/motion';
import type { ModuleInfo } from '../../modules/types';
import {
  moduleEnvironmentLabel,
  moduleHops,
  moduleRoleLabel,
  moduleStatusView,
  moduleTransportLabel,
} from './moduleUi';

function hardwareIdOf(module: ModuleRow): string {
  return (module.hardwareId ?? module.boardUuid ?? module.board_uuid ?? '').toLowerCase();
}

export function shortHardwareId(module: ModuleRow): string {
  const value = hardwareIdOf(module);
  if (!value) return '—';
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

/** Секунды uptime в компактный вид: 3д 4ч 12м. */
export function formatUptime(seconds: number | undefined): string {
  const total = Math.max(0, Math.trunc(Number(seconds ?? 0)));
  if (total <= 0) return '—';
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return `${days}д ${hours}ч`;
  if (hours > 0) return `${hours}ч ${minutes}м`;
  return `${minutes}м`;
}

function batteryTone(battery: number): 'success' | 'warning' | 'danger' {
  if (battery <= 20) return 'danger';
  if (battery <= 50) return 'warning';
  return 'success';
}

function rssiTone(rssi: number): 'success' | 'warning' | 'danger' {
  if (rssi >= -70) return 'success';
  if (rssi >= -85) return 'warning';
  return 'danger';
}

function errorTextOf(module: ModuleRow): string | null {
  const raw = module as unknown as Record<string, unknown>;
  for (const key of ['lastError', 'last_error', 'error']) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function Metric({
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
        minWidth: 120,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        paddingVertical: 5,
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

function DiagRow({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 3 }}>
      <Text style={{ color: theme.textDisabled, fontSize: 11.5, width: 98 }}>{label}</Text>
      <Text
        selectable
        style={{
          color: theme.textSecondary,
          fontSize: 11.5,
          flex: 1,
          lineHeight: 16,
          fontVariant: ['tabular-nums'] as never,
        }}
      >
        {value || '—'}
      </Text>
    </View>
  );
}

export function ModuleCard({
  module,
  index,
  selected,
  reduced,
  localInfo,
  localConnected,
  localKind,
  attachPending,
  unblockPending,
  onSelect,
  onToggleAttach,
  onBlock,
  onUnblock,
  onUnbind,
  onGatewayWifi,
  onOta,
}: {
  module: ModuleRow;
  index: number;
  selected: boolean;
  reduced: boolean;
  localInfo: ModuleInfo | null;
  localConnected: boolean;
  localKind?: 'usb' | 'ble' | null;
  attachPending: boolean;
  unblockPending: boolean;
  onSelect: (module: ModuleRow) => void;
  onToggleAttach: (module: ModuleRow) => void;
  onBlock: (module: ModuleRow) => void;
  onUnblock: (module: ModuleRow) => void;
  onUnbind: (module: ModuleRow) => void;
  onGatewayWifi: (module: ModuleRow) => void;
  onOta?: (module: ModuleRow) => void;
}) {
  const theme = useTheme();
  const [expanded, setExpanded] = React.useState(false);
  const hardwareId = hardwareIdOf(module);
  const status = moduleStatusView(module);
  const isBlocked = status.text === 'заблокирован';
  const isWearable = module.role === 'wearable';
  const isGateway = (module.role ?? 'gateway') === 'gateway';
  const publicId = module.publicId ?? '';
  const rssi = Number(module.rssi ?? 0);
  const batteryPct = Math.max(0, Math.min(100, Number(module.battery ?? 0)));
  const lastSeen = module.lastSeenAt ?? module.last_seen_at;
  const hops = moduleHops(module);
  const neighborsCount = Math.max(0, Number(module.neighbors ?? 0));
  const localAttached =
    isWearable && localConnected && Boolean(localInfo && localInfo.hardwareId.toLowerCase() === hardwareId);
  const attached = Boolean(module.attached || localAttached);
  const attachedTransport = localAttached ? localKind ?? 'usb' : module.transport;
  const canConfigureGateway =
    isGateway && localConnected && Boolean(localInfo && localInfo.hardwareId.toLowerCase() === hardwareId);
  const moduleError = errorTextOf(module);

  const neighbors = useQuery({
    queryKey: ['module-neighbors', module.id],
    queryFn: () => api.api.moduleNeighbors(module.id),
    enabled: expanded,
    staleTime: 30_000,
  });

  const battery = batteryTone(batteryPct);
  const batteryColor = battery === 'danger' ? theme.danger : battery === 'warning' ? theme.warning : theme.success;

  return (
    <MotiView
      nativeID={`module-card-${module.id}`}
      from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 12, scale: 0.99 }}
      animate={{ opacity: 1, translateY: 0, scale: 1 }}
      transition={
        reduced
          ? { type: 'timing', duration: 0 }
          : { ...motion.spring, delay: Math.min(index, 6) * motion.staggerStepMs }
      }
      style={{ marginBottom: 9 }}
    >
      <GlassCard
        style={
          selected
            ? { borderColor: theme.accent, borderWidth: 1.5, backgroundColor: theme.accentSoft }
            : undefined
        }
      >
        <View style={{ padding: 12, gap: 9 }}>
          <Pressable
            onPress={() => onSelect(module)}
            accessibilityRole="button"
            accessibilityLabel={`Показать ${moduleRoleLabel(module.role)}${publicId ? ` ID ${publicId}` : ''}`}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: 9,
              opacity: pressed ? 0.78 : 1,
            })}
          >
            <View
              style={{
                width: 36,
                height: 36,
                borderRadius: 11,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: isBlocked
                  ? theme.dangerSoft
                  : module.online
                    ? theme.successSoft
                    : theme.surfacePressed,
              }}
            >
              <Ionicons
                name={isGateway ? 'git-network-outline' : isWearable ? 'watch-outline' : 'radio-outline'}
                size={18}
                color={isBlocked ? theme.danger : module.online ? theme.success : theme.textSecondary}
              />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text style={{ color: theme.textPrimary, fontSize: 14.5, fontWeight: '700' }} numberOfLines={1}>
                  {moduleRoleLabel(module.role)}
                </Text>
                {selected ? <StatusBadge text="выбрано" tone="accent" /> : null}
              </View>
              <Text
                style={{
                  color: theme.textSecondary,
                  fontSize: 12,
                  marginTop: 2,
                  fontVariant: ['tabular-nums'] as never,
                }}
                numberOfLines={1}
              >
                {publicId ? `ID ${publicId}` : 'ID пока нет'} · {moduleEnvironmentLabel(module.kind, module.transport)} ·
                прошивка {module.firmware || '—'}
              </Text>
            </View>
            <StatusBadge text={status.text} tone={status.tone} />
          </Pressable>

          {isBlocked ? (
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
              <Ionicons name="ban-outline" size={14} color={theme.danger} />
              <Text style={{ color: theme.danger, fontSize: 11.5, flex: 1, lineHeight: 16 }}>
                {module.blockReason
                  ? `Причина: ${module.blockReason}`
                  : 'Аппаратная блокировка по hardwareId — перепрошивка не поможет.'}
              </Text>
            </View>
          ) : null}

          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ color: theme.textSecondary, fontSize: 12 }}>Заряд</Text>
            <Text style={{ color: batteryColor, fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] as never }}>
              {batteryPct}%
            </Text>
          </View>
          <ProgressBar pct={batteryPct} tone={battery} />

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            <StatusBadge text={moduleEnvironmentLabel(module.kind, module.transport)} tone="neutral" />
            <StatusBadge text={moduleRoleLabel(module.role)} tone="accent" />
            {isWearable ? (
              <StatusBadge
                text={attached ? `к клиенту${localAttached ? ' · USB/BLE' : ''}` : 'не подключён'}
                tone={attached ? 'success' : 'neutral'}
              />
            ) : null}
            <StatusBadge text={`${neighborsCount} соседей`} tone={neighborsCount > 0 ? 'accent' : 'neutral'} />
            <StatusBadge
              text={hops === null ? 'до шлюза: —' : `до шлюза: ${hops} хоп${hops === 1 ? '' : hops < 5 ? 'а' : 'ов'}`}
              tone="neutral"
            />
          </View>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 2, marginTop: 1 }}>
            <Metric icon="battery-half-outline" label="Заряд" value={`${batteryPct}%`} color={batteryColor} />
            <Metric
              icon="wifi-outline"
              label="RSSI"
              value={rssi === 0 ? '—' : `${rssi} dBm`}
              color={rssi === 0 ? theme.textDisabled : rssiTone(rssi) === 'success' ? theme.success : rssiTone(rssi) === 'warning' ? theme.warning : theme.danger}
            />
            <Metric icon="time-outline" label="Последний контакт" value={formatRelative(lastSeen)} />
            <Metric icon="pulse-outline" label="Uptime" value={formatUptime(module.uptime)} />
          </View>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            <Text style={{ color: theme.textDisabled, fontSize: 10.5, flexGrow: 1, minWidth: 140 }} numberOfLines={1}>
              hw {shortHardwareId(module)} · привязан {formatDateTime(module.created_at)}
            </Text>
          </View>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' }}>
            {isWearable ? (
              <Btn
                title={attached ? 'Отключить' : 'Подключить'}
                size="s"
                variant="ghost"
                loading={attachPending}
                onPress={() => onToggleAttach(module)}
              />
            ) : null}
            {isGateway ? (
              <Btn
                title="Wi-Fi шлюза"
                size="s"
                variant="ghost"
                disabled={!canConfigureGateway}
                onPress={() => onGatewayWifi(module)}
              />
            ) : null}
            {onOta ? (
              <Btn title="Обновить" size="s" variant="ghost" onPress={() => onOta(module)} />
            ) : null}
            {isBlocked ? (
              <Btn
                title="Разблокировать"
                size="s"
                variant="ghost"
                loading={unblockPending}
                onPress={() => onUnblock(module)}
              />
            ) : (
              <Btn title="Заблокировать" size="s" variant="danger" onPress={() => onBlock(module)} />
            )}
            <Btn title="Отвязать" size="s" variant="danger" onPress={() => onUnbind(module)} />
          </View>

          {isGateway && !canConfigureGateway ? (
            <Text style={{ color: theme.textDisabled, fontSize: 10.5, textAlign: 'right' }}>
              Подключите шлюз по USB/BLE, чтобы сменить Wi-Fi роутера.
            </Text>
          ) : null}

          <Pressable
            onPress={() => setExpanded((value) => !value)}
            accessibilityRole="button"
            accessibilityLabel={expanded ? 'Скрыть диагностику' : 'Показать диагностику'}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 5,
              alignSelf: 'flex-start',
              paddingVertical: 2,
              opacity: pressed ? 0.65 : 1,
            })}
          >
            <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={theme.accent} />
            <Text style={{ color: theme.accent, fontSize: 11.5, fontWeight: '700' }}>Диагностика</Text>
          </Pressable>

          {expanded ? (
            <View
              style={{
                borderTopWidth: 1,
                borderTopColor: theme.line,
                paddingTop: 8,
                gap: 2,
              }}
            >
              <DiagRow label="Публичный ID" value={publicId || '—'} />
              <DiagRow label="hardwareId" value={hardwareId || '—'} />
              <DiagRow label="Роль / среда" value={`${moduleRoleLabel(module.role)} · ${moduleEnvironmentLabel(module.kind, module.transport)}`} />
              <DiagRow label="Прошивка" value={module.firmware || '—'} />
              <DiagRow label="Uptime" value={formatUptime(module.uptime)} />
              <DiagRow label="RSSI" value={rssi === 0 ? '—' : `${rssi} dBm`} />
              <DiagRow label="Last seen" value={lastSeen ? `${formatDateTime(lastSeen)} · ${formatRelative(lastSeen)}` : '—'} />
              <DiagRow label="Транспорт" value={localAttached ? 'USB/BLE (клиент)' : moduleTransportLabel(attachedTransport)} />
              <DiagRow label="Ошибки" value={moduleError ?? (isBlocked ? module.blockReason ?? 'заблокирован' : 'нет')} />

              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 }}>
                <Text style={{ color: theme.textSecondary, fontSize: 11.5, fontWeight: '700' }}>
                  Соседи ({neighborsCount})
                </Text>
                <Text
                  onPress={() => void neighbors.refetch()}
                  accessibilityRole="button"
                  accessibilityLabel="Обновить соседей"
                  style={{ color: theme.accent, fontSize: 11, fontWeight: '700' }}
                >
                  Обновить
                </Text>
              </View>
              {neighbors.isLoading ? (
                <Text style={{ color: theme.textSecondary, fontSize: 11.5, paddingVertical: 4 }}>Загрузка соседей…</Text>
              ) : neighbors.isError ? (
                <Text style={{ color: theme.danger, fontSize: 11.5, lineHeight: 16, paddingVertical: 4 }}>
                  {humanError(neighbors.error)}
                </Text>
              ) : (neighbors.data ?? []).length === 0 ? (
                <Text style={{ color: theme.textSecondary, fontSize: 11.5, lineHeight: 16, paddingVertical: 4 }}>
                  Соседей пока нет: модуль не слышит другие платы. Проверьте питание и дальность.
                </Text>
              ) : (
                (neighbors.data ?? []).map((neighbor: MeshNeighbor, neighborIndex: number) => (
                  <View
                    key={`${neighbor.neighbor_uuid}-${neighbor.channel}-${neighborIndex}`}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      paddingVertical: 4,
                      borderTopWidth: neighborIndex === 0 ? 0 : 1,
                      borderTopColor: theme.line,
                    }}
                  >
                    <Text
                      style={{
                        color: theme.textPrimary,
                        fontSize: 11.5,
                        flex: 1,
                        fontVariant: ['tabular-nums'] as never,
                      }}
                      numberOfLines={1}
                    >
                      {neighbor.neighbor_uuid.slice(0, 18)}…
                    </Text>
                    <Text style={{ color: theme.textDisabled, fontSize: 10.5 }}>
                      канал {neighbor.channel || '—'} · {formatRelative(neighbor.seen_at)}
                    </Text>
                    <StatusBadge text={`${neighbor.rssi} dBm`} tone={rssiTone(neighbor.rssi)} />
                  </View>
                ))
              )}
            </View>
          ) : null}
        </View>
      </GlassCard>
    </MotiView>
  );
}
