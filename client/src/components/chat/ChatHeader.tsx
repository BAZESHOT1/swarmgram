import React from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
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

  return (
    <Animated.View
      style={[
        styles.header,
        {
          paddingTop,
          paddingBottom,
          opacity: enter,
          transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [-10, 0] }) }],
          backgroundColor: theme.background,
          borderBottomColor: secret ? theme.accent : theme.line,
        },
      ]}
    >
      <Animated.View style={{ transform: [{ translateY: parallax }], opacity: contentOpacity, flexDirection: 'row', alignItems: 'center', width: '100%', gap: 10 }}>
        <PressableScale
          pressedScale={0.9}
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Назад"
          hitSlop={6}
          style={({ pressed }) => [styles.iconBtn, { backgroundColor: pressed ? theme.surfacePressed : 'transparent' }]}
        >
          <Ionicons name="chevron-back" size={22} color={theme.textSecondary} />
        </PressableScale>

        <Pressable
          onPress={onOpenInfo}
          disabled={!onOpenInfo}
          accessibilityRole="button"
          accessibilityLabel="Информация о чате"
          style={({ pressed }) => [styles.titleBtn, { opacity: pressed ? 0.72 : 1 }]}
        >
          <View ref={avatarRef as never} style={{ opacity: hideAvatar ? 0 : 1 }}>
            <Avatar
              name={title || 'Диалог'}
              size={36}
              nodeOnline={nodeOnline}
              moduleOnline={moduleOnline}
              avatar={avatar}
            />
          </View>

          <Animated.View style={{ flex: 1, minWidth: 0, transform: [{ scale: nameScale }] }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', minWidth: 0 }}>
              <Text numberOfLines={1} style={{ color: theme.textPrimary, fontWeight: '700', fontSize: 16, flexShrink: 1 }}>
                {title || 'Диалог'}
              </Text>
              {secret ? <Ionicons name="lock-closed" size={13} color={theme.accent} style={{ marginLeft: 5 }} /> : null}
              {linkMode && linkMode !== 'internet' ? (
                <View
                  style={{
                    marginLeft: 6,
                    paddingHorizontal: 6,
                    paddingVertical: 1.5,
                    borderRadius: 999,
                    backgroundColor: linkMode === 'gateway' ? theme.successSoft : theme.accentSoft,
                  }}
                >
                  <Text style={{ color: linkMode === 'gateway' ? theme.success : theme.accent, fontSize: 9.5, fontWeight: '700' }}>
                    {linkMode === 'gateway' ? 'Через шлюз' : 'Модульная сеть'}
                  </Text>
                </View>
              ) : null}
            </View>
            <Animated.View style={{ height: statusHeight, opacity: statusOpacity, overflow: 'hidden', flexDirection: 'row', alignItems: 'center' }}>
              {/* key заставляет статус плавно въезжать при смене канала/печати */}
              <MotiView
                key={`${typingUsername ? 'typing' : secret ? 'secret' : channel}-${subtitle}`}
                from={reduced ? { opacity: 1 } : { opacity: 0, translateX: 6, scale: 0.92 }}
                animate={{ opacity: 1, translateX: 0, scale: 1 }}
                transition={reduced ? { type: 'timing', duration: 0 } : motion.softSpring}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1 }}
              >
                {secret && !typingUsername ? (
                  <Ionicons name="lock-closed" size={11} color={theme.accent} />
                ) : (
                  <StatusDot color={dotColor} waiting={!typingUsername && channel === 'waiting'} />
                )}
                <Text
                  numberOfLines={1}
                  style={{
                    color: typingUsername ? theme.accent : theme.textSecondary,
                    fontSize: 12,
                    fontWeight: typingUsername ? '600' : '400',
                    flexShrink: 1,
                  }}
                >
                  {subtitle}
                </Text>
              </MotiView>
            </Animated.View>
          </Animated.View>
          {onOpenInfo ? <Ionicons name="chevron-forward" size={14} color={theme.textDisabled} style={{ marginRight: 2 }} /> : null}
        </Pressable>

        <PressableScale
          pressedScale={0.9}
          onPress={onMenu}
          accessibilityRole="button"
          accessibilityLabel="Меню чата"
          hitSlop={6}
          style={({ pressed }) => [styles.iconBtn, { backgroundColor: pressed ? theme.surfacePressed : 'transparent' }]}
        >
          <Ionicons name="ellipsis-vertical" size={20} color={theme.textSecondary} />
        </PressableScale>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    overflow: 'hidden',
  },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleBtn: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  dotWrap: { width: 9, height: 9, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 7, height: 7, borderRadius: 4 },
  pulseRing: { position: 'absolute', width: 7, height: 7, borderRadius: 4 },
});
