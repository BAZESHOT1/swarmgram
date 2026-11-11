/**
 * Баннер найденных рядом носимых модулей. Появляется, когда автопоиск
 * BLE нашёл устройства, но ни одно ещё не подключено к клиенту.
 */
import React from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/useTheme';
import { GlassCard } from '../settings/SettingsUI';
import { Btn } from '../Btn';
import { useStore } from '../../state/useStore';
import { useModuleConnection } from '../../modules/ModuleProvider';

const FRESH_MS = 2 * 60_000;

export function NearbyModulesBanner({ onConnect }: { onConnect: () => void }) {
  const theme = useTheme();
  const nearby = useStore((s) => s.nearbyModules);
  const setNearbyModules = useStore((s) => s.setNearbyModules);
  const connection = useModuleConnection();

  const fresh = nearby.filter((item) => Date.now() - item.seenAt < FRESH_MS);
  if (!fresh.length || connection.connected) return null;

  return (
    <GlassCard>
      <View style={{ padding: 12, gap: 9 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View
            style={{
              width: 32,
              height: 32,
              borderRadius: 10,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: theme.accentSoft,
            }}
          >
            <Ionicons name="bluetooth" size={17} color={theme.accent} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ color: theme.textPrimary, fontSize: 13.5, fontWeight: '700' }}>Рядом найден модуль</Text>
            <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 1 }} numberOfLines={1}>
              {fresh.map((item) => item.name).join(', ')}
            </Text>
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Btn title="Подключить по BLE" size="s" loading={connection.busy === 'ble'} onPress={onConnect} />
          </View>
          <View style={{ flex: 1 }}>
            <Btn title="Скрыть" size="s" variant="ghost" onPress={() => setNearbyModules([])} />
          </View>
        </View>
      </View>
    </GlassCard>
  );
}
