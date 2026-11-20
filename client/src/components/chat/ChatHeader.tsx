import React from 'react';
import { Animated, Platform, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Glass, GLASS_FILL_BUTTON } from '../Glass';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { Avatar } from '../Avatar';
import { useReducedMotion } from '../useReducedMotion';
import { PressableScale } from './PressableScale';
import { motion } from '../../theme/motion';
import { plural } from './roles';

/** Канал доставки — влияет на подпись и цвет точки статуса. */
export type ChatChannel = 'internet' | 'directLink' | 'module' | 'waiting';

const STATUS_LABEL: Record<ChatChannel, string> = {
  internet: 'Интернет',
  directLink: 'Прямая связь',
  module: 'Через модуль',
  waiting: 'Ожидание сети',
};

/** Точка статуса: при ожидании сети мягко пульсирует (reduced motion — статично). */
function StatusDot({ color, waiting }: { color: string; waiting: boolean }) {
  const reduced = useReducedMotion();
  const pulse = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    if (!waiting || reduced) {
      pulse.setValue(0);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 800, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 800, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [waiting, reduced, pulse]);

  return (
    <View style={styles.dotWrap}>
      {waiting && !reduced ? (
        <Animated.View
          style={[
            styles.pulseRing,
            {
              backgroundColor: color,
              opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
              transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.3] }) }],
            },
          ]}
        />
      ) : null}
      {/* Волна при смене канала: компонент перемонтируется по key в шапке. */}
      {!reduced ? (
        <MotiView
          from={{ scale: 0.6, opacity: 0.55 }}
          animate={{ scale: 2.2, opacity: 0 }}
          transition={{ type: 'timing', duration: 520 }}
          style={[styles.pulseRing, { backgroundColor: color }]}
          pointerEvents="none"
        />
      ) : null}
      <View style={[styles.dot, { backgroundColor: color }]} />
    </View>
  );
}

/**
 * Компактная шапка чата: сворачивается при прокрутке вниз (paddingTop/Bottom),
 * статус плавно прячется, лёгкий параллакс содержимого. JS-driver — потому что
 * анимируются layout-свойства (native driver для padding невозможен).
 */
export function ChatHeader({
  title,
  channel,
  secret,
  typingUsername,
  scrollY,
  collapse,
  onBack,
  onMenu,
  onOpenInfo,
  avatarRef,
  hideAvatar,
  nodeOnline,
  moduleOnline,
  avatar,
  chatType,
  membersCount,
  linkMode,
  statusText,
}: {
  title: string;
  channel: ChatChannel;
  secret: boolean;
  typingUsername?: string | null;
  scrollY: Animated.Value;
  /** 0 — развёрнута, 1 — свёрнута; управляется экраном по направлению скролла. */
  collapse: Animated.Value;
  onBack: () => void;
  onMenu: () => void;
  /** Тап по аватару/названию открывает информацию о чате. */
  onOpenInfo?: () => void;
  avatarRef: React.RefObject<View | null>;
  hideAvatar?: boolean;
  /** Direct-чат: онлайн-статус собеседника для обводки аватара. */
  nodeOnline?: boolean;
  moduleOnline?: boolean;
  avatar?: { objectId: string; key: string; mime: string } | null;
  /** Тип чата — определяет подпись «участники/подписчики». */
  chatType?: 'direct' | 'group' | 'channel';
  /** Временный статус соединения вместо метода доставки. */
  statusText?: string | null;
  /** Количество участников/подписчиков. */
  membersCount?: number;
  /** Текущий канал доставки (для бейджа в шапке). */
  linkMode?: 'internet' | 'gateway' | 'mesh';
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const wide = width >= 900;

  // Появление шапки при открытии чата: мягкий fade + сдвиг сверху.
  const enter = React.useRef(new Animated.Value(reduced ? 1 : 0)).current;
  React.useEffect(() => {
    if (reduced) {
      enter.setValue(1);
      return;
    }
    Animated.spring(enter, {
      toValue: 1,
      damping: motion.softSpring.damping,
      stiffness: motion.softSpring.stiffness,
      mass: motion.softSpring.mass,
      useNativeDriver: false,
    }).start();
  }, [reduced, enter]);

  const paddingTop = collapse.interpolate({ inputRange: [0, 1], outputRange: [44, 10] });
  const paddingBottom = collapse.interpolate({ inputRange: [0, 1], outputRange: [10, 6] });
  const statusOpacity = collapse.interpolate({ inputRange: [0, 0.55], outputRange: [1, 0], extrapolate: 'clamp' });
  const statusHeight = collapse.interpolate({ inputRange: [0, 1], outputRange: [17, 0] });
  const parallax = scrollY.interpolate({ inputRange: [0, 140], outputRange: [0, -4], extrapolate: 'clamp' });
  const contentOpacity = collapse.interpolate({ inputRange: [0, 1], outputRange: [1, 0.94] });
  const nameScale = collapse.interpolate({ inputRange: [0, 1], outputRange: [1, 0.96] });

  const dotColor =
    typingUsername
      ? theme.accent
      : channel === 'internet' || channel === 'directLink'
        ? theme.success
        : channel === 'module'
          ? theme.accent
          : theme.warning;

  const subtitle = typingUsername
    ? `${typingUsername} печатает…`
    : statusText
      ? statusText
      : secret
        ? '🔒 Секретный (E2E)'
        : chatType === 'channel' && membersCount
          ? `${membersCount} ${plural(membersCount, 'подписчик', 'подписчика', 'подписчиков')}`
          : chatType === 'group' && membersCount
            ? `${membersCount} ${plural(membersCount, 'участник', 'участника', 'участников')}`
            : STATUS_LABEL[channel];

  // Шапка по макету: стеклянная «назад», капсула с названием и статусом, квадратный аватар справа.
  const titleSize = wide ? 22 : 20;
  return (
    <Animated.View
      style={[
        styles.header,
        {
          paddingTop: (Platform.OS === 'web' ? 12 : insets.top + 6),
          opacity: enter,
          transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [-10, 0] }) }],
        },
      ]}
    >
      <View style={[styles.row, wide && { maxWidth: 980, alignSelf: 'center', width: '100%' }]}>
        <PressableScale pressedScale={0.9} onPress={onBack} accessibilityRole="button" accessibilityLabel="Назад" hitSlop={6}>
          <Glass radius={28} fill={GLASS_FILL_BUTTON} style={styles.round}>
            <Ionicons name="chevron-back" size={26} color={theme.textPrimary} />
          </Glass>
        </PressableScale>

        <PressableScale
          pressedScale={0.97}
          onPress={onMenu}
          onLongPress={onOpenInfo}
          accessibilityRole="button"
          accessibilityLabel={`${title || 'Диалог'}, меню чата`}
          style={{ flex: 1, minWidth: 0 }}
        >
          <Glass radius={29} fill={GLASS_FILL_BUTTON} style={styles.pill}>
            <View style={{ flexDirection: 'row', alignItems: 'center', maxWidth: '100%' }}>
              {secret ? <Ionicons name="lock-closed" size={14} color={theme.accent} style={{ marginRight: 5 }} /> : null}
              <Text numberOfLines={1} style={{ color: theme.textPrimary, fontWeight: '800', fontSize: titleSize, flexShrink: 1 }}>
                {title || 'Диалог'}
              </Text>
            </View>
            <MotiView
              key={`${typingUsername ? 'typing' : channel}-${subtitle}`}
              from={reduced ? { opacity: 1 } : { opacity: 0, translateY: 3 }}
              animate={{ opacity: 1, translateY: 0 }}
              transition={reduced ? { type: 'timing', duration: 0 } : motion.softSpring}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: '100%' }}
            >
              {!typingUsername && channel === 'waiting' ? <StatusDot color={dotColor} waiting /> : null}
              <Text
                numberOfLines={1}
                style={{ color: typingUsername ? theme.accent : theme.textSecondary, fontSize: 13.5, flexShrink: 1 }}
              >
                {subtitle}
                {linkMode && linkMode !== 'internet' ? (linkMode === 'gateway' ? ' · через шлюз' : ' · модульная сеть') : ''}
              </Text>
            </MotiView>
          </Glass>
        </PressableScale>

        <PressableScale
          pressedScale={0.92}
          onPress={onOpenInfo}
          disabled={!onOpenInfo}
          accessibilityRole="button"
          accessibilityLabel="Информация о чате"
        >
          <View ref={avatarRef as never} style={{ opacity: hideAvatar ? 0 : 1 }}>
            <Avatar
              name={title || 'Диалог'}
              size={58}
              radius={16}
              ringSize={3}
              nodeOnline={nodeOnline}
              moduleOnline={moduleOnline}
              avatar={avatar}
            />
          </View>
        </PressableScale>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 12, paddingBottom: 8, zIndex: 5 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  round: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center' },
  pill: { height: 58, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  dotWrap: { width: 9, height: 9, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 7, height: 7, borderRadius: 4 },
  pulseRing: { position: 'absolute', width: 7, height: 7, borderRadius: 4 },
});
