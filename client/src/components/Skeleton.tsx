import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useTheme } from '../theme/useTheme';

/** «Скелетон» вместо спиннера: блоки занятого контента. */
export function Skeleton({ height = 14, width = '70%' as const, delay = 0 }: { height?: number; width?: `${number}%` | number; delay?: number }) {
  const theme = useTheme();
  return (
    <View
      style={{
        height,
        width: width as `${number}%`,
        borderRadius: 4,
        backgroundColor: theme.surfacePressed,
        opacity: 0.6,
        marginTop: delay,
      }}
    />
  );
}

export function SkeletonList({ rows = 4 }: { rows?: number }) {
  const theme = useTheme();
  return (
    <View>
      {Array.from({ length: rows }).map((_, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 12, padding: 12, borderBottomWidth: 1, borderBottomColor: theme.line }}>
          <View style={{ width: 48, height: 48, borderRadius: 999, backgroundColor: theme.surfacePressed }} />
          <View style={{ flex: 1, gap: 8 }}>
            <Skeleton height={12} width="50%" />
            <Skeleton height={12} width="80%" delay={8} />
          </View>
        </View>
      ))}
    </View>
  );
}
