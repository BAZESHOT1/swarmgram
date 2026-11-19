/**
 * Компактный индикатор носимого модуля для шапки «Чаты»:
 * пульсирующая зелёная иконка подключённого wearable, число соседей
 * и наличие интернета. Если модуль не подключён — нейтральный «Kinto».
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

/**
 * Доступ к Hub через kMesh: пульсирующий зелёный глобус — есть (шлюз в кластере или соседнем,
 * либо мобильный шлюз), мигающий красный крест — нет. При подключении носимого модуля, его
 * переподключении или смене кластера — индикатор загрузки, пока состояние не устоится.
 */
function HubAccessIcon({ hub, clusterKey }: { hub: boolean; clusterKey: string }) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const connection = useModuleConnection();
  const [settling, setSettling] = React.useState(true);
  const lastKey = React.useRef<string | null>(null);
  const connectedAt = React.useRef(Date.now());
  React.useEffect(() => {
    // Новое подключение или другой кластер — показываем загрузку несколько секунд.
    if (lastKey.current !== clusterKey) {
      lastKey.current = clusterKey;
      setSettling(true);
      const t = setTimeout(() => setSettling(false), 6000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [clusterKey]);
  React.useEffect(() => {
    if (hub) setSettling(false);
  }, [hub]);
  React.useEffect(() => {
    // Переподключение носимого модуля — тоже «загрузка», пока не придёт состояние кластера.
    connectedAt.current = Date.now();
    setSettling(true);
    const t = setTimeout(() => setSettling(false), 6000);
    return () => clearTimeout(t);
  }, [connection.connection]);
  if (connection.busy || settling) {
    return (
      <MotiView
        accessibilityLabel="Подключение к кластеру kMesh"
        animate={reduced ? { rotate: '0deg' } : { rotate: '360deg' }}
        from={{ rotate: '0deg' }}
        transition={reduced ? { type: 'timing', duration: 0 } : { loop: true, repeatReverse: false, type: 'timing', duration: 900 }}
      >
        <Ionicons name="sync" size={15} color={theme.accent} />
      </MotiView>
    );
  }
  if (hub) {
    return (
      <MotiView
        accessibilityLabel="Есть доступ к Hub через kMesh"
        animate={reduced ? { scale: 1, opacity: 1 } : { scale: [0.9, 1.12, 0.9], opacity: [0.7, 1, 0.7] }}
        transition={reduced ? { type: 'timing', duration: 0 } : { loop: true, type: 'timing', duration: 1500 }}
      >
        <Ionicons name="globe" size={15} color={theme.success} />
      </MotiView>
    );
  }
  return (
    <MotiView
      accessibilityLabel="Нет доступа к Hub через kMesh"
      animate={reduced ? { opacity: 1 } : { opacity: [1, 0.25, 1] }}
      transition={reduced ? { type: 'timing', duration: 0 } : { loop: true, type: 'timing', duration: 900 }}
    >
      <Ionicons name="close-circle" size={15} color={theme.danger} />
    </MotiView>
  );
}

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
        Kinto
      </Text>
    );
  }

  // Соседи и RSSI приходят живьём из INFO/STATUS; серверная карточка — fallback.
  const neighbors = Math.max(0, Number(info.neighbors ?? row?.neighbors ?? 0));
  const rssi = Number(info.rssi ?? 0);
  // Интернет: websocket или путь через шлюз mesh-сети.
  const internet = transportOnline;
  const viaGateway = Boolean(info.gateway);

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
      {rssi !== 0 ? (
        <Text
          accessibilityLabel={`Сигнал ${rssi} dBm`}
          style={{ color: theme.textSecondary, fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] as never }}
        >
          {rssi}
        </Text>
      ) : null}
      <HubAccessIcon hub={viaGateway || Boolean(info.mobile)} clusterKey={`${info.hardwareId}:${info.clusterId ?? ''}`} />
    </View>
  );
}
