/**
 * Нижняя парящая навигация Klinto (OLED-стиль).
 *
 * Центральная капсула «Чаты / Настройки», слева — статус соединения,
 * справа — капсула носимого модуля KMesh_v1. Боковые капсулы появляются
 * только при необходимости и анимируются пружиной.
 */
import React from 'react';
import { Animated, Modal, Platform, Pressable, Text, View, StyleSheet, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { BlurView } from 'expo-blur';
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
import { useChatSearchActive } from '../state/chatSearchState';
import { PressableScale } from './chat/PressableScale';
import { Avatar } from './Avatar';
import { motion } from '../theme/motion';

const DOCK_PADDING = 5;
const TILE_GAP = 4;
const DOCK_WIDTH = 200;
const DOCK_WIDTH_COMPACT = 176;

export function PhoneDock() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const narrow = screenWidth < 360;
  const compact = screenWidth < 390;
  const dockWidthTarget = narrow ? 160 : compact ? DOCK_WIDTH_COMPACT : DOCK_WIDTH;
  const haptics = useHaptics();
  const reduced = useReducedMotion();
  const pathname = usePathname();
  const searchActive = useChatSearchActive();
  const chats = useChats();
  const me = useStore((s) => s.me);
  const myUsername = useStore((s) => s.me?.username ?? s.session?.username ?? '');
  const mutedChats = useStore((s) => s.mutedChats);
  const transportOnline = useStore((s) => s.transportOnline);
  const transportKnown = useStore((s) => s.transportKnown);
  const directPeer = useStore((s) => s.transportDirectPeer);
  const transportModule = useStore((s) => s.transportModule);
  const meshPeers = useStore((s) => s.meshPeers);

  const [dockWidth, setDockWidth] = React.useState(0);
  const [chatsMenuOpen, setChatsMenuOpen] = React.useState(false);

  const mutedSet = React.useMemo(() => new Set(mutedChats), [mutedChats]);
  const unread = React.useMemo(
    () => (Array.isArray(chats.data) ? chats.data : []).reduce(
      (sum, c) => sum + (mutedSet.has(c.id) ? 0 : Math.max(0, c.unread ?? 0)),
      0,
    ),
    [chats.data, mutedSet],
  );

  const hidden =
    searchActive ||
    pathname === '/' ||
    pathname === '/login' ||
    pathname.startsWith('/register') ||
    pathname.startsWith('/verify') ||
    pathname.startsWith('/chat/') ||
    pathname.startsWith('/compose');

  const enter = React.useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = React.useState(!hidden);
  React.useEffect(() => setChatsMenuOpen(false), [pathname]);
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

  const navigateTo = (href: string) => {
    if (href === '/chats') {
      router.navigate({ pathname: '/chats', params: { __nav: activeId === 'settings' ? 'left' : 'right' } } as never);
      return;
    }
    if (typeof router.navigate === 'function') router.navigate(href as never);
    else router.push(href as never);
  };

  const tileWidth = dockWidth > 0 ? (dockWidth - DOCK_PADDING * 2 - TILE_GAP * (tiles.length - 1)) / tiles.length : 0;
  const onDockLayout = (e: LayoutChangeEvent) => setDockWidth(e.nativeEvent.layout.width);
  const enterTranslateY = enter.interpolate({ inputRange: [0, 1], outputRange: [16, 0] });
  const dockBottom = Math.max(12, insets.bottom > 0 ? insets.bottom + 4 : 12);

  const userMatch = /^\/user\/([^/]+)(?:\/edit)?/.exec(pathname);
  const viewingOtherProfile =
    Boolean(userMatch) &&
    !pathname.endsWith('/edit') &&
    decodeURIComponent(userMatch?.[1] ?? '').toLowerCase() !== myUsername.toLowerCase();
  const dockVisible =
    pathname.startsWith('/chats') || pathname.startsWith('/settings') || viewingOtherProfile;
  if (!dockVisible) return null;

  const syncing = chats.isLoading || (chats.isFetching && !chats.data);
  const showLeft = !transportKnown || !transportOnline || syncing;
  const leftText = !transportOnline ? 'Соединение...' : syncing ? 'Синхронизация...' : 'Обновление...';
  const moduleOn = Boolean(transportModule || directPeer);
  const routeCount = Math.max(1, Object.keys(meshPeers || {}).length + 1);

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.host,
        { bottom: dockBottom, opacity: enter, transform: [{ translateY: enterTranslateY }], gap: compact ? 6 : 8 },
      ]}
    >
      {/* Левая капсула статуса сети/синхронизации. */}
      {showLeft ? (
        <MotiView
          from={reduced ? { opacity: 0 } : { opacity: 0, translateX: -20 }}
          animate={{ opacity: 1, translateX: 0 }}
          transition={reduced ? { type: 'timing', duration: 0 } : motion.softSpring}
          style={[styles.sideCapsule, { backgroundColor: '#161618', borderColor: 'rgba(255,255,255,0.08)', maxWidth: narrow ? 66 : compact ? 74 : 96 }]}
        >
          <View style={[styles.dot, { backgroundColor: transportOnline ? '#30D158' : '#FF9F0A' }]} />
          <Text numberOfLines={1} style={styles.sideText}>
            {leftText}
          </Text>
        </MotiView>
      ) : (
        <View style={styles.sideSpacer} />
      )}

      <View
        onLayout={onDockLayout}
        style={[
          styles.dock,
          {
            width: dockWidthTarget,
            backgroundColor: '#161618',
            borderColor: 'rgba(255,255,255,0.10)',
            ...(Platform.OS === 'web'
              ? ({ backdropFilter: 'blur(18px) saturate(1.4)', WebkitBackdropFilter: 'blur(18px) saturate(1.4)' } as object)
              : null),
          },
        ]}
      >
        {Platform.OS === 'ios' ? (
          <BlurView intensity={55} tint="dark" style={StyleSheet.absoluteFill} pointerEvents="none" />
        ) : null}
        {tileWidth > 0 && activeIndex >= 0 ? (
          <MotiView
            animate={{ translateX: activeIndex * (tileWidth + TILE_GAP) }}
            transition={reduced ? { type: 'timing', duration: 0 } : motion.softSpring}
            style={{
              position: 'absolute',
              left: DOCK_PADDING,
              top: DOCK_PADDING,
              width: tileWidth,
              height: 50,
              borderRadius: 25,
              backgroundColor: '#2C2C2E',
            }}
          />
        ) : null}

        {tiles.map((tile) => {
          const active = tile.id === activeId;
          return (
            <PressableScale
              key={tile.id}
              pressedScale={0.96}
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
              <View style={{ alignItems: 'center', gap: 3 }}>
                <View>
                  {tile.id === 'settings' && me ? (
                    <Avatar name={me.displayName || me.username || 'Я'} size={20} radius={7} avatar={me.avatar ?? null} />
                  ) : (
                    <Ionicons name={tile.icon} size={20} color={active ? '#FFFFFF' : '#8E8E93'} />
                  )}
                  {tile.badge ? (
                    <View style={[styles.badge, { backgroundColor: '#3A3A3C' }]}>
                      <Text style={{ color: '#FFFFFF', fontSize: 9, fontWeight: '700' }}>
                        {tile.badge > 99 ? '99+' : tile.badge}
                      </Text>
                    </View>
                  ) : null}
                </View>
                <Text numberOfLines={1} style={{ color: active ? '#FFFFFF' : '#8E8E93', fontSize: 11, fontWeight: active ? '600' : '500' }}>
                  {tile.label}
                </Text>
              </View>
            </PressableScale>
          );
        })}
      </View>

      {/* Правая капсула носимого модуля KMesh_v1. */}
      {moduleOn ? (
        <MotiView
          from={reduced ? { opacity: 0 } : { opacity: 0, translateX: 20 }}
          animate={{ opacity: 1, translateX: 0 }}
          transition={reduced ? { type: 'timing', duration: 0 } : motion.softSpring}
          style={styles.sideRight}
        >
          <Pressable
            onPress={() => {
              haptics.tap();
              router.navigate('/modules' as never);
            }}
            accessibilityRole="button"
            accessibilityLabel={`Модуль Klinto подключён, узлов ${routeCount}`}
            style={[styles.sideCapsule, { backgroundColor: '#161618', borderColor: 'rgba(255,255,255,0.08)', maxWidth: narrow ? 52 : compact ? 58 : 68 }]}
          >
            <View style={[styles.dot, { backgroundColor: '#30D158' }]} />
            <Text style={{ color: '#FFFFFF', fontSize: 13, fontWeight: '600' }}>{routeCount}</Text>
            <Ionicons name="swap-horizontal" size={15} color="#FFD60A" />
          </Pressable>
        </MotiView>
      ) : (
        <View style={styles.sideSpacer} />
      )}

      <Modal visible={chatsMenuOpen} transparent animationType="fade" onRequestClose={() => setChatsMenuOpen(false)}>
        <Pressable style={styles.menuBackdrop} onPress={() => setChatsMenuOpen(false)} accessibilityLabel="Закрыть меню чатов">
          <View style={[styles.menuHost, { bottom: dockBottom + 72 }]}>
            <MotiView
              from={{ opacity: 0, translateY: reduced ? 0 : 10, scale: reduced ? 1 : 0.96 }}
              animate={{ opacity: 1, translateY: 0, scale: 1 }}
              transition={reduced ? { type: 'timing', duration: 0 } : motion.spring}
              style={[styles.menuCard, { backgroundColor: '#161618', borderColor: 'rgba(255,255,255,0.08)' }]}
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
                <View style={[styles.menuIcon, { backgroundColor: '#2C2C2E' }]}>
                  <Ionicons name="checkmark-done" size={17} color="#FFFFFF" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: '#FFFFFF', fontSize: 14, fontWeight: '600' }}>Прочитать все</Text>
                  <Text style={{ color: '#8E8E93', fontSize: 11.5, marginTop: 1 }}>
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
  host: {
    position: 'absolute',
    left: 10,
    right: 10,
    bottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    zIndex: 50,
  },
  dock: {
    flexDirection: 'row',
    borderRadius: 30,
    padding: DOCK_PADDING,
    gap: TILE_GAP,
    borderWidth: 1,
    height: 60,
    width: DOCK_WIDTH,
    maxWidth: '100%',
    justifyContent: 'space-between',
  },
  tile: {
    height: 50,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    zIndex: 1,
  },
  sideCapsule: {
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 11,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: 96,
    flexShrink: 1,
  },
  sideRight: { maxWidth: 68, flexShrink: 1 },
  sideText: { color: '#D1D1D6', fontSize: 12, flexShrink: 1 },
  sideSpacer: { width: 0 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  badge: {
    position: 'absolute',
    right: -8,
    top: -5,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  menuBackdrop: { flex: 1 },
  menuHost: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  menuCard: { width: '100%', maxWidth: 380, borderRadius: 18, borderWidth: 1, padding: 6 },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, paddingVertical: 9, borderRadius: 12 },
  menuIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});
