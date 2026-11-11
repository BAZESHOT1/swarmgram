import React from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { useTheme } from '../theme/useTheme';

const toneByStatus: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  online: 'success',
  degraded: 'warning',
  draining: 'warning',
  offline: 'neutral',
  banned: 'danger',
  pending: 'neutral',
};

export function NodeStatusPill({ status }: { status: string }) {
  const theme = useTheme();
  const tone = toneByStatus[status] ?? 'neutral';
  const color = tone === 'success' ? theme.success : tone === 'warning' ? theme.warning : tone === 'danger' ? theme.danger : theme.textDisabled;
  return (
    <View style={{ borderWidth: 1, borderColor: color, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 1 }}>
      <Text style={{ color, fontSize: 11 }}>{status}</Text>
    </View>
  );
}
