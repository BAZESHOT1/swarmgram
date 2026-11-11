import React from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { useReducedMotion } from '../useReducedMotion';
import { PressableScale } from './PressableScale';
import { motion } from '../../theme/motion';

/** Строка поиска под шапкой: счётчик совпадений и переход ↑/↓. */
export function ChatSearchBar({
  value,
  onChange,
  count,
  currentIndex,
  onPrev,
  onNext,
  onClose,
}: {
  value: string;
  onChange: (t: string) => void;
  count: number;
  /** 0-based индекс текущего совпадения, -1 если нет. */
  currentIndex: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const inputRef = React.useRef<TextInput>(null);

  React.useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 180);
    return () => clearTimeout(t);
  }, []);

  return (
    <MotiView
      from={{ opacity: 0, translateY: -10 }}
      animate={{ opacity: 1, translateY: 0 }}
      transition={reduced ? { type: 'timing', duration: 0 } : motion.softSpring}
      style={styles.wrap}
    >
      <View style={[styles.bar, { backgroundColor: theme.surface, borderColor: theme.line }]}>
        <Ionicons name="search" size={16} color={theme.textDisabled} />
        <TextInput
          ref={inputRef}
          value={value}
          onChangeText={onChange}
          placeholder="Поиск по сообщениям"
          placeholderTextColor={theme.textDisabled}
          accessibilityLabel="Поиск по чату"
          style={[styles.input, { color: theme.textPrimary }]}
          returnKeyType="search"
        />
        {value.trim() ? (
          <Text style={{ color: count ? theme.accent : theme.textDisabled, fontSize: 12, fontWeight: '600' }}>
            {count ? `${currentIndex + 1}/${count}` : 'Нет'}
          </Text>
        ) : null}
        <PressableScale pressedScale={0.88} onPress={onPrev} disabled={count === 0} accessibilityRole="button" accessibilityLabel="Предыдущее совпадение" hitSlop={6} style={styles.navBtn}>
          <Ionicons name="chevron-up" size={18} color={count ? theme.textSecondary : theme.textDisabled} />
        </PressableScale>
        <PressableScale pressedScale={0.88} onPress={onNext} disabled={count === 0} accessibilityRole="button" accessibilityLabel="Следующее совпадение" hitSlop={6} style={styles.navBtn}>
          <Ionicons name="chevron-down" size={18} color={count ? theme.textSecondary : theme.textDisabled} />
        </PressableScale>
        <PressableScale pressedScale={0.88} onPress={onClose} accessibilityRole="button" accessibilityLabel="Закрыть поиск" hitSlop={6} style={styles.navBtn}>
          <Ionicons name="close" size={18} color={theme.textSecondary} />
        </PressableScale>
      </View>
      {value.trim() ? (
        <Text style={{ color: count ? theme.textSecondary : theme.warning, fontSize: 11.5, paddingHorizontal: 4, marginTop: 4 }}>
          {count ? `${count} найдено` : 'Ничего не найдено'}
        </Text>
      ) : null}
    </MotiView>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 10, paddingTop: 8, paddingBottom: 4 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 12, paddingHorizontal: 10, minHeight: 42 },
  input: { flex: 1, fontSize: 14.5, paddingVertical: 8 },
  navBtn: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
});
