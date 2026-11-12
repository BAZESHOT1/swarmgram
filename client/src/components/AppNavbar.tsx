import React from 'react';
import { Modal, Pressable, View, Text, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { usePathname, router } from 'expo-router';
import { MotiView } from 'moti';
import { useTheme } from '../theme/useTheme';
import { useHaptics } from './useHaptics';
import { useReducedMotion } from './useReducedMotion';
import { useIsWide } from '../theme/useIsWide';
import { PhoneDock } from './PhoneDock';
import { PCMenuDropdown } from './PCMenuDropdown';
import { PressableScale } from './chat/PressableScale';
import { motion } from '../theme/motion';
import { useStore } from '../state/useStore';
import { requestReadAll } from '../state/chatEvents';
import { useChats } from '../data/queries';

export const SIDEBAR_WIDTH = 210;

const BASE_ITEMS = [
  { key: 'chats', href: '/chats', label: 'Чаты', icon: 'chatbubbles' as const },
  { key: 'settings', href: '/settings', label: 'Настройки', icon: 'settings-outline' as const },
];

/**
 * Навигация:
 *  - смартфон: плавающий док снизу (LiveActivityDock-стиль: тайлы + live-карта);
 *  - ПК: узкий сайдбар слева с лого; тап по лого открывает ПК-dropdown (inline-dropdown).
 * Админка — только для роли admin.
 */
export function AppNavbar() {
  const theme = useTheme();
  const pathname = usePathname();
  const wide = useIsWide();
  const haptics = useHaptics();
  const reduced = useReducedMotion();
  const isAdmin = useStore((s) => s.me?.role === 'admin') === true;
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [chatsMenuOpen, setChatsMenuOpen] = React.useState(false);
  const [hoverKey, setHoverKey] = React.useState<string | null>(null);
  const chatsQuery = useChats();
  const mutedChats = useStore((s) => s.mutedChats);
  const transportOnline = useStore((s) => s.transportOnline);
  const directPeer = useStore((s) => s.transportDirectPeer);
  const transportModule = useStore((s) => s.transportModule);
  const transportGateway = useStore((s) => s.transportGateway);
  const unread = React.useMemo(() => {
    const muted = new Set(mutedChats);
    return (chatsQuery.data ?? []).reduce(
      (sum, c) => sum + (muted.has(c.id) ? 0 : Math.max(0, c.unread ?? 0)),
      0,
    );
  }, [chatsQuery.data, mutedChats]);

  const items = isAdmin
    ? [...BASE_ITEMS, { key: 'admin', href: '/admin', label: 'Админка', icon: 'shield-checkmark-outline' as const }]
    : BASE_ITEMS;

  // Маленький индикатор транспорта: websocket → прямое P2P → модуль → офлайн.
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

  const activeKey =
    pathname.startsWith('/settings') ||
    pathname.startsWith('/nodes') ||
    pathname.startsWith('/modules') ||
    pathname.startsWith('/language')
      ? 'settings'
      : pathname.startsWith('/admin')
        ? 'admin'
        : pathname.startsWith('/chats')
          ? 'chats'
          : '';

  /** Переход по разделу: не блокируем его, если раздел уже подсвечен. */
  const navigateTo = (href: string) => {
    if (typeof router.navigate === 'function') router.navigate(href as never);
    else router.push(href as never);
  };

  if (!wide) {
    /* ------- смартфоны: LiveActivityDock-стиль ------- */
    return <PhoneDock />;
  }

  /* --------------------------- ПК: узкий сайдбар --------------------------- */
  return (
    <MotiView
      from={reduced ? { opacity: 0 } : { opacity: 0, translateX: -24 }}
      animate={{ opacity: 1, translateX: 0 }}
      transition={reduced ? { type: 'timing', duration: 0 } : motion.softSpring}
      style={[
        styles.sidebar,
        theme.shadow,
        {
          width: SIDEBAR_WIDTH,
          backgroundColor: theme.glass,
          borderColor: theme.glassBorder,
          shadowColor: theme.glassShadow,
          ...(Platform.OS === 'web'
            ? ({ backdropFilter: 'blur(22px) saturate(1.45)', WebkitBackdropFilter: 'blur(22px) saturate(1.45)' } as object)
            : null),
        },
      ]}
    >
      <View style={[styles.logoRow, { borderBottomColor: theme.glassBorder }]}>
        <PressableScale
          pressedScale={0.92}
          onPress={() => setMenuOpen((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel="Меню приложения"
          style={{ width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.accent }}
        >
          <Ionicons name="git-network" size={20} color={theme.onAccent} />
        </PressableScale>
        <Text style={{ color: theme.textPrimary, fontWeight: '800', fontSize: 15 }}>Kinto</Text>
      </View>

      {menuOpen && pathname ? <PCMenuDropdown onHide={() => setMenuOpen(false)} /> : null}

      {items.map((item) => {
        const active = item.key === activeKey;
        return (
          <MotiView
            key={item.key}
            animate={{ scale: hoverKey === item.key && !reduced ? 1.015 : 1 }}
            transition={reduced ? { type: 'timing', duration: 0 } : motion.pressSpring}
          >
            <PressableScale
              pressedScale={0.98}
              onPress={() => {
                haptics.tap();
                navigateTo(item.href);
              }}
              onLongPress={item.key === 'chats' ? () => {
                haptics.tap();
                setChatsMenuOpen(true);
              } : undefined}
              delayLongPress={350}
              onHoverIn={() => setHoverKey(item.key)}
              onHoverOut={() => setHoverKey((cur) => (cur === item.key ? null : cur))}
              accessibilityRole="tab"
              accessibilityLabel={item.label}
              accessibilityState={{ selected: active }}
              style={styles.sideItem}
            >
              {active ? (
                <MotiView
                  from={reduced ? { opacity: 0 } : { opacity: 0, scaleX: 0.92 }}
                  animate={{ opacity: 1, scaleX: 1 }}
                  transition={reduced ? { type: 'timing', duration: 0 } : motion.softSpring}
                  style={[StyleSheet.absoluteFillObject, { backgroundColor: theme.accentSoft, borderRadius: 14 }]}
                />
              ) : null}
              {active ? <View style={[styles.rail, { backgroundColor: theme.accent }]} /> : null}
              <Ionicons name={item.icon} size={20} color={active ? theme.accent : theme.textSecondary} />
              <Text style={{ color: active ? theme.textPrimary : theme.textSecondary, fontWeight: '600', fontSize: 14 }}>
                {item.label}
              </Text>
            </PressableScale>
          </MotiView>
        );
      })}

      <View
        style={[styles.statusRow, { marginTop: 'auto', marginBottom: 12 }]}
        accessibilityLabel={`Состояние сети: ${netLabel}`}
      >
        <MotiView
          animate={netPulse ? { opacity: [0.35, 1, 0.35], scale: [0.9, 1.08, 0.9] } : { opacity: 1, scale: 1 }}
          transition={netPulse ? { loop: true, type: 'timing', duration: 1600 } : { type: 'timing', duration: 0 }}
          style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: netColor }}
        />
        <Ionicons name={netIcon} size={12} color={netColor} />
        <Text style={{ color: theme.textDisabled, fontSize: 12 }}>{netLabel}</Text>
      </View>

      <Modal visible={chatsMenuOpen} transparent animationType="fade" onRequestClose={() => setChatsMenuOpen(false)}>
        <Pressable style={{ flex: 1 }} onPress={() => setChatsMenuOpen(false)} accessibilityLabel="Закрыть меню чатов">
          <View style={{ position: 'absolute', top: 118, left: 12, width: SIDEBAR_WIDTH - 24 }}>
            <MotiView
              from={{ opacity: 0, translateY: reduced ? 0 : 8, scale: reduced ? 1 : 0.97 }}
              animate={{ opacity: 1, translateY: 0, scale: 1 }}
              transition={reduced ? { type: 'timing', duration: 0 } : motion.spring}
              style={[styles.chatsMenu, { backgroundColor: theme.glass, borderColor: theme.glassBorder }, theme.shadow]}
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
                style={({ pressed }) => [styles.chatsMenuItem, { opacity: unread ? (pressed ? 0.65 : 1) : 0.45 }]}
              >
                <View style={[styles.chatsMenuIcon, { backgroundColor: theme.accentSoft }]}>
                  <Ionicons name="checkmark-done" size={17} color={theme.accent} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: theme.textPrimary, fontSize: 13.5, fontWeight: '600' }}>Прочитать все</Text>
                  <Text style={{ color: theme.textSecondary, fontSize: 11, marginTop: 1 }}>
                    {unread ? `${unread} непрочитанных` : 'Нет непрочитанных'}
                  </Text>
                </View>
              </Pressable>
            </MotiView>
          </View>
        </Pressable>
      </Modal>
    </MotiView>
  );
}

const styles = StyleSheet.create({
  sidebar: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    zIndex: 40,
    borderTopWidth: 1,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderLeftWidth: 1,
    borderTopRightRadius: 24,
    borderBottomRightRadius: 24,
    paddingTop: 18,
    gap: 4,
    overflow: 'hidden',
  },
  logoRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingBottom: 14, borderBottomWidth: 1, marginBottom: 10, marginTop: 8 },
  sideItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 10,
    marginBottom: 4,
    paddingVertical: 11,
    paddingHorizontal: 12,
    borderRadius: 14,
    minHeight: 44,
    overflow: 'hidden',
  },
  rail: { position: 'absolute', left: 0, top: 8, bottom: 8, width: 3, borderRadius: 999 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18 },
  chatsMenu: { borderRadius: 16, borderWidth: 1, padding: 6 },
  chatsMenuItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, paddingVertical: 9, borderRadius: 12 },
  chatsMenuIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});
