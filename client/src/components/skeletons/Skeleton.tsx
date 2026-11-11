/**
 * Базовые скелетоны: крупные полупрозрачные блоки с мягкой пульсацией.
 * Уважают reduced motion (пульсация отключается).
 */
import React from 'react';
import { Animated, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../../theme/useTheme';
import { useReducedMotion } from '../useReducedMotion';

export function SkeletonBlock({
  width,
  height,
  radius = 14,
  style,
}: {
  width?: number | `${number}%` | 'auto';
  height: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const opacity = React.useRef(new Animated.Value(0.35)).current;

  React.useEffect(() => {
    if (reduced) {
      opacity.setValue(0.5);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.72, duration: 750, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.32, duration: 750, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity, reduced]);

  return (
    <Animated.View
      style={[
        {
          width,
          height,
          borderRadius: radius,
          backgroundColor: theme.dark ? 'rgba(255,255,255,0.10)' : 'rgba(16,24,40,0.08)',
          opacity,
        },
        style,
      ]}
    />
  );
}

/** Круглый скелетон — для аватаров. */
export function SkeletonCircle({ size, style }: { size: number; style?: StyleProp<ViewStyle> }) {
  return <SkeletonBlock width={size} height={size} radius={size / 2} style={style} />;
}

/** Контейнер строки скелетона: аватар + две линии. */
export function SkeletonChatRow() {
  return (
    <View style={styles.row}>
      <SkeletonCircle size={48} />
      <View style={{ flex: 1, gap: 8 }}>
        <SkeletonBlock width="52%" height={13} radius={7} />
        <SkeletonBlock width="78%" height={11} radius={6} />
      </View>
      <SkeletonBlock width={34} height={11} radius={6} />
    </View>
  );
}

/** Пузырь сообщения-скелетон. */
export function SkeletonBubble({ mine = false, width = '62%' }: { mine?: boolean; width?: `${number}%` }) {
  return (
    <View style={[styles.bubbleRow, mine && { justifyContent: 'flex-end' }]}>
      <SkeletonBlock width={width} height={44} radius={18} />
    </View>
  );
}

/**
 * Скелетон списка чатов: заголовки секций + 8 строк в стеклянных карточках.
 * Заголовки — отдельные блоки, чтобы экран не «прыгал» при загрузке.
 */
export function SkeletonChatList({ rows = 8 }: { rows?: number }) {
  const theme = useTheme();
  const firstSection = Math.max(1, Math.min(rows - 3, 5));
  const secondSection = Math.max(0, rows - firstSection);

  const renderRows = (count: number, keyPrefix: string) =>
    Array.from({ length: count }).map((_, i) => (
      <View
        key={`${keyPrefix}-${i}`}
        style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.line }]}
      >
        <SkeletonChatRow />
      </View>
    ));

  return (
    <View style={styles.listWrap}>
      <SkeletonBlock width="24%" height={10} radius={5} style={styles.sectionHead} />
      {renderRows(firstSection, 'a')}
      {secondSection > 0 ? (
        <>
          <SkeletonBlock width="18%" height={10} radius={5} style={styles.sectionHead} />
          {renderRows(secondSection, 'b')}
        </>
      ) : null}
    </View>
  );
}

/** Ширины пузырей-скелетонов: чередуем 55–78%, как у реальных сообщений. */
const BUBBLE_WIDTHS = ['78%', '62%', '70%', '55%', '74%', '66%', '58%', '72%'] as const;

/**
 * Скелетон диалога: 8 пузырей, чередование «мои/чужие» и разные ширины.
 * Шапка и композер остаются настоящими.
 */
export function SkeletonMessages({ count = 8 }: { count?: number }) {
  return (
    <View style={styles.messagesWrap}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonBubble
          key={i}
          mine={i % 2 === 1}
          width={BUBBLE_WIDTHS[i % BUBBLE_WIDTHS.length]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 12, paddingHorizontal: 8 },
  bubbleRow: { flexDirection: 'row', paddingHorizontal: 6, marginTop: 10 },
  listWrap: { paddingHorizontal: 2, paddingTop: 2 },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    marginBottom: 6,
    paddingHorizontal: 2,
    overflow: 'hidden',
  },
  sectionHead: { marginTop: 14, marginBottom: 8, marginLeft: 6 },
  messagesWrap: { flex: 1, paddingHorizontal: 10, paddingTop: 12 },
});
