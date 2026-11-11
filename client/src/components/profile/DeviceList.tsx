import React from 'react';
import { Platform, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/useTheme';
import { DeviceRowSkeleton } from '../skeletons/PageSkeletons';

export interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  created_at: string;
}

function deviceIcon(platform: string): keyof typeof Ionicons.glyphMap {
  const p = platform.toLowerCase();
  if (p.includes('ios') || p.includes('iphone') || p.includes('mac')) return 'phone-portrait-outline';
  if (p.includes('android')) return 'phone-portrait-outline';
  if (p.includes('web')) return 'globe-outline';
  return 'hardware-chip-outline';
}

/** Список активных устройств текущего пользователя (только для своего профиля). */
export function DeviceList({ devices, loading }: { devices: DeviceRow[]; loading?: boolean }) {
  const theme = useTheme();

  if (loading) {
    return (
      <View>
        {[0, 1, 2, 3].map((index) => (
          <DeviceRowSkeleton key={index} />
        ))}
      </View>
    );
  }
  if (!devices.length) {
    return <Text style={{ color: theme.textSecondary, fontSize: 13 }}>Нет активных устройств.</Text>;
  }

  return (
    <View style={{ gap: 6 }}>
      {devices.map((d) => (
        <View
          key={d.id}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            paddingHorizontal: 10,
            paddingVertical: 8,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: theme.line,
          }}
        >
          <Ionicons name={deviceIcon(d.platform)} size={16} color={theme.textSecondary} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ color: theme.textPrimary, fontSize: 13.5, fontWeight: '600' }} numberOfLines={1}>
              {d.name || 'Устройство'}
            </Text>
            <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 1 }} numberOfLines={1}>
              {Platform.OS === 'web' ? d.platform || 'web' : d.platform || 'device'}
              {d.created_at ? ` · с ${new Date(d.created_at).toLocaleDateString('ru-RU')}` : ''}
            </Text>
          </View>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: theme.success }} />
        </View>
      ))}
    </View>
  );
}
