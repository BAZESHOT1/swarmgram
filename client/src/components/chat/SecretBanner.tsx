import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { useReducedMotion } from '../useReducedMotion';
import { motion } from '../../theme/motion';

/** Баннер секретного чата: E2E, история не синхронизируется, скриншоты скрываются. */
export function SecretBanner() {
  const theme = useTheme();
  const reduced = useReducedMotion();
  return (
    <MotiView
      from={reduced ? { opacity: 1 } : { opacity: 0, translateY: -8 }}
      animate={{ opacity: 1, translateY: 0 }}
      transition={reduced ? { type: 'timing', duration: 0 } : motion.softSpring}
      style={[styles.wrap, { backgroundColor: theme.accentSoft, borderColor: theme.accent }]}
    >
      <View style={[styles.icon, { backgroundColor: theme.accent }]}>
        <Ionicons name="lock-closed" size={13} color={theme.onAccent} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: theme.accent, fontSize: 12.5, fontWeight: '800' }}>Секретный чат · E2E</Text>
        <Text style={{ color: theme.textSecondary, fontSize: 11.5 }} numberOfLines={1}>
          Сквозное шифрование · история не синхронизируется
        </Text>
      </View>
      <Ionicons name="shield-checkmark-outline" size={16} color={theme.accent} />
    </MotiView>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: 10,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  icon: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
});
