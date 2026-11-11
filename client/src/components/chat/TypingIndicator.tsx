import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';

/** Анимированные три точки «печатает…» — показываются над композером. */
export function TypingIndicator({ username }: { username: string }) {
  const theme = useTheme();
  return (
    <MotiView
      from={{ opacity: 0, translateY: 6, scale: 0.96 }}
      animate={{ opacity: 1, translateY: 0, scale: 1 }}
      transition={{ type: 'spring', damping: 24, stiffness: 300 }}
      style={[styles.pill, { backgroundColor: theme.surfaceElevated, borderColor: theme.line }]}
      accessibilityLiveRegion="polite"
    >
      <View style={styles.dots}>
        {[0, 1, 2].map((i) => (
          <MotiView
            key={i}
            animate={{ opacity: [0.35, 1, 0.35], translateY: [0, -3, 0] }}
            transition={{ loop: true, type: 'timing', duration: 850, delay: i * 140 }}
            style={[styles.dot, { backgroundColor: theme.accent }]}
          />
        ))}
      </View>
      <Text style={{ color: theme.textSecondary, fontSize: 12.5 }} numberOfLines={1}>
        {username} печатает…
      </Text>
    </MotiView>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    marginHorizontal: 14,
    marginBottom: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    maxWidth: '80%',
  },
  dots: { flexDirection: 'row', alignItems: 'center', gap: 3, height: 12 },
  dot: { width: 5, height: 5, borderRadius: 3 },
});
