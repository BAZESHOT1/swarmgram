import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';

import { PressableScale } from './PressableScale';
import { useReducedMotion } from '../useReducedMotion';
import { motion } from '../../theme/motion';

/** Кнопка «вниз» с бейджем новых сообщений; видна, когда пользователь не внизу. */
export function ScrollToBottom({ visible, count, onPress }: { visible: boolean; count: number; onPress: () => void }) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  if (!visible) return null;
  return (
    <MotiView
      from={{ opacity: 0, scale: reduced ? 1 : 0.7, translateY: reduced ? 0 : 8 }}
      animate={{ opacity: 1, scale: 1, translateY: 0 }}
      transition={reduced ? { type: 'timing', duration: 0 } : motion.spring}
      style={styles.wrap}
    >
      <PressableScale
        pressedScale={0.9}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={count > 0 ? `Вниз, новых сообщений: ${count}` : 'Вниз'}
        style={({ pressed }) => [styles.btn, { backgroundColor: theme.surfaceElevated, borderColor: theme.line, opacity: pressed ? 0.8 : 1 }]}
      >
        <Ionicons name="chevron-down" size={20} color={theme.accent} />
        {count > 0 ? (
          <View style={[styles.badge, { backgroundColor: theme.accent }]}>
            <Text style={{ color: theme.onAccent, fontSize: 10.5, fontWeight: '800' }}>{count > 99 ? '99+' : count}</Text>
          </View>
        ) : null}
      </PressableScale>
    </MotiView>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', right: 14, bottom: 14, zIndex: 20 },
  btn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  badge: {
    position: 'absolute',
    top: -3,
    right: -4,
    minWidth: 19,
    height: 19,
    borderRadius: 10,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
