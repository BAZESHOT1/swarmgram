/**
 * Телефонный док в стиле LiveActivityDock:
 *  - плавающая стеклянная капсула снизу (blur + тень);
 *  - два раздела: «Чаты» и «Настройки», бейдж непрочитанных (без приглушённых);
 *  - одна движущаяся активная пилюля, haptic-отклик;
 *  - скрывается только внутри открытого чата/создания.
 */
import React from 'react';
import { Animated, Modal, Platform, Pressable, Text, View, StyleSheet, type LayoutChangeEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, usePathname } from 'expo-router';
import { MotiView } from 'moti';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/useTheme';
import { useHaptics } from './useHaptics';
import { useReducedMotion } from './useReducedMotion';
import { useChats } from '../data/queries';
import { useStore } from '../state/useStore';
import { requestReadAll } from '../state/chatEvents';
import { PressableScale } from './chat/PressableScale';
import { motion } from '../theme/motion';

const DOCK_PADDING = 6;
const TILE_GAP = 6;

export function PhoneDock() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const haptics = useHaptics();
  const reduced = useReducedMotion();
  const pathname = usePathname();
  const chats = useChats();
  const mutedChats = useStore((s) => s.mutedChats);
  const transportOnline = useStore((s) => s.transportOnline);
  const directPeer = useStore((s) => s.transportDirectPeer);
  const transportModule = useStore((s) => s.transportModule);
  const transportGateway = useStore((s) => s.transportGateway);

  const [dockWidth, setDockWidth] = React.useState(0);
  const [chatsMenuOpen, setChatsMenuOpen] = React.useState(false);

  const mutedSet = React.useMemo(() => new Set(mutedChats), [mutedChats]);

  // Компактный индикатор транспорта: websocket → P2P → модуль → офлайн.
  const moduleOn = Boolean(transportModule?.gateway || transportModule);
  const netColor = transportOnline
    ? theme.success
    : directPeer
      ? theme.accent
      : moduleOn
        ? theme.warning
        : theme.textDisabled;
  const netIcon: keyof typeof Ionicons.glyphMap = transportOnline
    ? 'wifi'
    : transportGateway
      ? 'git-network'
      : directPeer
        ? 'git-network'
        : moduleOn
          ? 'hardware-chip-outline'
          : 'cloud-offline-outline';
  const netLabel = transportOnline
    ? 'Сеть онлайн'
    : transportGateway
      ? 'Через шлюз модулей'
      : directPeer
        ? 'Прямое соединение'
        : moduleOn
          ? 'Через модуль'
          : 'Нет связи';
  const netPulse = !transportOnline && !reduced;
  const unread = React.useMemo(
    () =>
      (chats.data ?? []).reduce(
        (sum, c) => sum + (mutedSet.has(c.id) ? 0 : Math.max(0, c.unread ?? 0)),
        0,
      ),
    [chats.data, mutedSet],
  );

  const hidden =
    pathname === '/' ||
    pathname === '/login' ||
    pathname.startsWith('/register') ||
    pathname.startsWith('/verify') ||
    pathname.startsWith('/chat/') ||
    pathname.startsWith('/compose');

  // Появление/скрытие дока при смене маршрута: мягкий fade + сдвиг снизу.
  // Хуки должны вызываться до возможного return null — иначе ломается их порядок.
  const enter = React.useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = React.useState(!hidden);
  React.useEffect(() => {
    setChatsMenuOpen(false);
  }, [pathname]);
  React.useEffect(() => {
    if (reduced) {
      enter.setValue(hidden ? 0 : 1);
      setMounted(!hidden);
      return undefined;
    }
    if (!hidden) setMounted(true);
    const animation = Animated.spring(enter, {
      toValue: hidden ? 0 : 1,
      damping: motion.softSpring.damping,
      stiffness: motion.softSpring.stiffness,
      mass: motion.softSpring.mass,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished && hidden) setMounted(false);
    });
    return () => animation.stop();
  }, [pathname, hidden, reduced, enter]);

  if (hidden && !mounted) return null;

  const tiles = [
    { id: 'chats', label: 'Чаты', icon: 'chatbubbles' as const, href: '/chats', badge: unread },
    { id: 'settings', label: 'Настройки', icon: 'settings-outline' as const, href: '/settings' },
  ];

  const activeId = pathname.startsWith('/chats')
    ? 'chats'
    : pathname.startsWith('/settings') ||
        pathname.startsWith('/admin') ||
        pathname.startsWith('/nodes') ||
        pathname.startsWith('/modules') ||
        pathname.startsWith('/language')
      ? 'settings'
      : '';
  const activeIndex = tiles.findIndex((t) => t.id === activeId);

  /** Переход по разделу: навигация без блокировки по «уже активен». */
  const navigateTo = (href: string) => {
    if (href === '/chats') {
      // Возврат из «Настроек» в «Чаты» — слева; в остальных случаях обычно справа.
      router.navigate({ pathname: '/chats', params: { __nav: activeId === 'settings' ? 'left' : 'right' } } as never);
      return;
    }
    if (typeof router.navigate === 'function') router.navigate(href as never);
    else router.push(href as never);
  };

  // Ширина одного тайла: внутренняя ширина минус отступы и gap, делим на два.
  const tileWidth = dockWidth > 0 ? (dockWidth - DOCK_PADDING * 2 - TILE_GAP) / 2 : 0;

  const onDockLayout = (e: LayoutChangeEvent) => setDockWidth(e.nativeEvent.layout.width);

  const enterTranslateY = enter.interpolate({ inputRange: [0, 1], outputRange: [16, 0] });
  // Док плавающий: отступаем от home-indicator, но не рисуем полосу фона.
  const dockBottom = 24 + Math.max(0, insets.bottom);

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.host, { bottom: dockBottom, opacity: enter, transform: [{ translateY: enterTranslateY }] }]}
    >
      <View
        onLayout={onDockLayout}
        style={[
          styles.dock,
          theme.shadow,
          {
            backgroundColor: theme.glass,
            borderColor: theme.glassBorder,
            shadowColor: theme.glassShadow,
            ...(Platform.OS === 'web'
              ? ({ backdropFilter: 'blur(18px) saturate(1.4)', WebkitBackdropFilter: 'blur(18px) saturate(1.4)' } as object)
              : null),
          },
        ]}
      >
        {tileWidth > 0 && activeIndex >= 0 ? (
          <MotiView
            animate={{ translateX: activeIndex * (tileWidth + TILE_GAP) }}
            transition={reduced ? { type: 'timing', duration: 0 } : motion.softSpring}
            style={{
              position: 'absolute',
              left: DOCK_PADDING,
              top: DOCK_PADDING,
              width: tileWidth,
              height: 46,
              borderRadius: 16,
              backgroundColor: theme.accentSoft,
            }}
          />
        ) : null}

        {tiles.map((tile) => {
          const active = tile.id === activeId;
          return (
            <PressableScale
              key={tile.id}
              pressedScale={0.95}
              onPress={() => {
                haptics.tap();
                navigateTo(tile.href);
              }}
              onLongPress={tile.id === 'chats' ? () => {
                haptics.tap();
                setChatsMenuOpen(true);
              } : undefined}
              delayLongPress={350}
              accessibilityRole="tab"
              accessibilityLabel={`${tile.label}${tile.badge ? `, непрочитанных ${tile.badge}` : ''}`}
              accessibilityState={{ selected: active }}
              containerStyle={{ flex: 1 }}
              style={styles.tile}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View>
                  <MotiView
                    animate={{ scale: active && !reduced ? 1.06 : 1 }}
                    transition={reduced ? { type: 'timing', duration: 0 } : motion.pressSpring}
                  >
                    <Ionicons name={tile.icon} size={19} color={active ? theme.accent : theme.textSecondary} />
                  </MotiView>
                  {tile.badge ? (
                    <View style={[styles.badge, { backgroundColor: theme.accent, borderColor: theme.dark ? 'rgba(15,22,33,0.9)' : '#fff' }]}>
                      <Text style={{ color: theme.onAccent, fontSize: 9.5, fontWeight: '800' }}>{tile.badge > 99 ? '99+' : tile.badge}</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={{ color: active ? theme.accent : theme.textSecondary, fontSize: 13.5, fontWeight: active ? '700' : '600' }}>
                  {tile.label}
                </Text>
              </View>
            </PressableScale>
          );
        })}
      </View>

      <View
        pointerEvents="none"
        accessibilityLabel={`Состояние сети: ${netLabel}`}
        style={[
          styles.netBadge,
          { backgroundColor: theme.glass, borderColor: theme.glassBorder },
          Platform.OS === 'web'
            ? ({ backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)' } as object)
            : null,
        ]}
      >
        <MotiView
          animate={netPulse ? { opacity: [0.35, 1, 0.35], scale: [0.9, 1.1, 0.9] } : { opacity: 1, scale: 1 }}
          transition={netPulse ? { loop: true, type: 'timing', duration: 1600 } : { type: 'timing', duration: 0 }}
          style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: netColor }}
        />
        <Ionicons name={netIcon} size={11} color={netColor} />
      </View>

      <Modal visible={chatsMenuOpen} transparent animationType="fade" onRequestClose={() => setChatsMenuOpen(false)}>
        <Pressable style={styles.menuBackdrop} onPress={() => setChatsMenuOpen(false)} accessibilityLabel="Закрыть меню чатов">
          <View style={[styles.menuHost, { bottom: 98 + Math.max(0, insets.bottom) }]}>
            <MotiView
              from={{ opacity: 0, translateY: reduced ? 0 : 10, scale: reduced ? 1 : 0.96 }}
              animate={{ opacity: 1, translateY: 0, scale: 1 }}
              transition={reduced ? { type: 'timing', duration: 0 } : motion.spring}
              style={[styles.menuCard, { backgroundColor: theme.glass, borderColor: theme.glassBorder }, theme.shadow]}
            >
              <Pressable
                onPress={() => {
                  if (!unread) return;
                  haptics.tap();
                  requestReadAll();
                  setChatsMenuOpen(false);
                }}
                disabled={!unread}
                accessibilityRole="button"
                accessibilityLabel={unread ? `Прочитать все, непрочитанных ${unread}` : 'Нет непрочитанных сообщений'}
                style={({ pressed }) => [styles.menuItem, { opacity: unread ? (pressed ? 0.65 : 1) : 0.45 }]}
              >
                <View style={[styles.menuIcon, { backgroundColor: theme.accentSoft }]}>
                  <Ionicons name="checkmark-done" size={17} color={theme.accent} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '600' }}>Прочитать все</Text>
                  <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 1 }}>
                    {unread ? `${unread} непрочитанных` : 'Нет непрочитанных'}
                  </Text>
                </View>
              </Pressable>
            </MotiView>
          </View>
        </Pressable>
      </Modal>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute', left: 16, right: 16, bottom: 24, alignItems: 'center', zIndex: 50 },
  dock: {
    flexDirection: 'row',
    borderRadius: 22,
    padding: DOCK_PADDING,
    gap: TILE_GAP,
    borderWidth: 1,
    height: 60,
    width: '100%',
    maxWidth: 380,
    justifyContent: 'space-between',
  },
  tile: {
    flex: 1,
    height: 46,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
    overflow: 'visible',
    zIndex: 1,
  },
  badge: {
    position: 'absolute',
    right: -7,
    top: -5,
    minWidth: 17,
    height: 17,
    borderRadius: 999,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  netBadge: {
    position: 'absolute',
    top: -9,
    right: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    zIndex: 2,
  },
  menuBackdrop: { flex: 1 },
  menuHost: { position: 'absolute', left: 16, right: 16, bottom: 98, alignItems: 'center' },
  menuCard: { width: '100%', maxWidth: 380, borderRadius: 18, borderWidth: 1, padding: 6 },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, paddingVertical: 9, borderRadius: 12 },
  menuIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});
