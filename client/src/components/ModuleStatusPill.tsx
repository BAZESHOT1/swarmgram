/**
 * Компактный индикатор носимого модуля для шапки «Чаты»:
 * пульсирующая зелёная иконка подключённого wearable, число соседей
 * и наличие интернета. Если модуль не подключён — нейтральный «SwarmGram».
 */
import React from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../theme/useTheme';
import { useReducedMotion } from './useReducedMotion';
import { useModuleConnection } from '../modules/ModuleProvider';
import { useModules } from '../data/queries';
import { useStore } from '../state/useStore';

export function ModuleStatusPill() {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const connection = useModuleConnection();
  const modules = useModules();
  const transportOnline = useStore((s) => s.transportOnline);

  const info = connection.connected ? connection.info : null;
  const wearable = info && info.role === 'wearable';
  const row = React.useMemo(() => {
    if (!wearable || !info) return null;
    const hw = info.hardwareId.toLowerCase();
    return (modules.data ?? []).find((module) => (module.hardwareId ?? module.board_uuid ?? '').toLowerCase() === hw) ?? null;
  }, [modules.data, wearable, info]);

  if (!wearable || !info) {
    return (
      <Text style={{ color: theme.textDisabled, fontSize: 11.5, fontWeight: '800', letterSpacing: 0.4 }} numberOfLines={1}>
        SwarmGram
      </Text>
    );
  }

  const neighbors = Number(row?.neighbors ?? 0);
  // Интернет: websocket или путь через шлюз mesh-сети.
  const internet = transportOnline;
  const viaGateway = !internet && Boolean(info.gateway);
  const netIcon: keyof typeof Ionicons.glyphMap = internet
    ? 'wifi'
    : viaGateway
      ? 'git-network-outline'
      : 'cloud-offline-outline';
  const netColor = internet ? theme.success : viaGateway ? theme.warning : theme.textDisabled;

  return (
    <View
      accessibilityLabel={`Носимый модуль подключён${row?.publicId ? `, ID ${row.publicId}` : ''}. Соседей: ${neighbors}. ${internet ? 'Интернет доступен' : viaGateway ? 'Интернет через шлюз' : 'Интернета нет'}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}
    >
      <MotiView
        animate={reduced ? { opacity: 1, scale: 1 } : { opacity: [0.45, 1, 0.45], scale: [0.92, 1.06, 0.92] }}
        transition={reduced ? { type: 'timing', duration: 0 } : { loop: true, type: 'timing', duration: 1600 }}
        style={{ width: 9, height: 9, borderRadius: 999, backgroundColor: theme.success }}
      />
      <Ionicons name="hardware-chip" size={15} color={theme.success} />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
        <Ionicons name="radio-outline" size={13} color={theme.textSecondary} />
        <Text style={{ color: theme.textSecondary, fontSize: 11.5, fontWeight: '700', fontVariant: ['tabular-nums'] as never }}>
          {neighbors}
        </Text>
      </View>
      <Ionicons name={netIcon} size={15} color={netColor} />
    </View>
  );
}
