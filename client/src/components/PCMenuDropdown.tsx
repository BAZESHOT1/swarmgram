/**
 * PC-dropdown (адаптация shadcn-компонента inline-dropdown):
 *  - открывается по тапу на логотип в сайдбаре;
 *  - анимированная смена пунктов (moti), hover-подсветка;
 *  - «Выйти» — hold-to-confirm с прогресс-полосой (1 сек).
 */
import React from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useRouter } from 'expo-router';
import { useTheme } from '../theme/useTheme';
import { logout } from '../data/auth';
import { useStore } from '../state/useStore';
import { hasNetworkAccess } from '../data/access';

const HOLD_MS = 1000;

export function PCMenuDropdown({ onHide }: { onHide: () => void }) {
  const theme = useTheme();
  const router = useRouter();
  const holdingRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const [holding, setHolding] = React.useState(false);
  const [elapsed, setElapsed] = React.useState(0);
  const [loggingOut, setLoggingOut] = useStateSafe();
  const isAdmin = useStore((s) => s.me?.role === 'admin');
  const networkAccess = useStore((s) => hasNetworkAccess(s.me));

  function useStateSafe() {
    return React.useState(false);
  }
  void loggingOut;

  React.useEffect(() => {
    if (holding && elapsed < HOLD_MS) {
      holdingRef.current = setInterval(() => {
        setElapsed((v) => Math.min(v + 100, HOLD_MS));
      }, 100);
    } else if (elapsed >= HOLD_MS) {
      if (holdingRef.current) clearInterval(holdingRef.current);
      setHolding(false);
      setElapsed(0);
      void (async () => {
        await logout();
        onHide();
        router.replace('/login' as never);
      })();
    } else if (holdingRef.current) {
      clearInterval(holdingRef.current);
      holdingRef.current = null;
    }
    return () => {
      if (holdingRef.current) clearInterval(holdingRef.current);
    };
  }, [holding, elapsed]);

  const stopHold = () => {
    setHolding(false);
    setElapsed(0);
    if (holdingRef.current) {
      clearInterval(holdingRef.current);
      holdingRef.current = null;
    }
  };

  const go = (path: string) => {
    onHide();
    router.push(path as never);
  };

  return (
    <MotiView
      from={{ opacity: 0, translateY: -8, scale: 0.97 }}
      animate={{ opacity: 1, translateY: 0, scale: 1 }}
      transition={{ type: 'spring', damping: 24, stiffness: 300 }}
      style={[
        styles.menu,
        {
          backgroundColor: theme.dark ? 'rgba(20,28,40,0.97)' : 'rgba(255,255,255,0.98)',
          borderColor: theme.dark ? 'rgba(255,255,255,0.09)' : 'rgba(16,24,40,0.08)',
        },
      ]}
    >
      <Item icon="person-outline" label="Профиль" onPress={() => go('/settings')} theme={theme} />
      <Sep theme={theme} />
      <Item icon="chatbubbles-outline" label="Чаты" onPress={() => go('/chats')} theme={theme} />
      {networkAccess ? (
        <Item icon="server-outline" label="Узлы хранения" onPress={() => go('/nodes')} theme={theme} />
      ) : null}
      <Item icon="radio-outline" label="Модули расширения" onPress={() => go('/modules')} theme={theme} />
      <Item icon="stats-chart-outline" label="Сеть и статистика" onPress={() => go('/settings')} theme={theme} />
      {isAdmin ? <Item icon="shield-checkmark-outline" label="Админка" onPress={() => go('/admin')} theme={theme} /> : null}
      <Sep theme={theme} />
      {/* hold-to-confirm выход */}
      <Pressable
        onPressIn={() => setHolding(true)}
        onPressOut={stopHold}
        accessibilityRole="button"
        accessibilityLabel="Выйти из аккаунта (удерживайте)"
        style={({ pressed }) => [styles.item, pressed && { backgroundColor: theme.dangerSoft }]}
      >
        {holding ? (
          <Text style={{ fontSize: 13, color: theme.danger }}>Удерживайте для подтверждения…</Text>
        ) : (
          <Text style={{ fontSize: 13, color: theme.danger }}>Выйти из аккаунта</Text>
        )}
        <Ionicons name="log-out-outline" size={15} color={theme.danger} />
        {holding ? (
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <View
              style={{
                height: 3,
                width: `${(elapsed / HOLD_MS) * 100}%` as `${number}%`,
                backgroundColor: theme.danger,
                borderRadius: 999,
              }}
            />
          </View>
        ) : null}
      </Pressable>
    </MotiView>
  );
}

function Item({ icon, label, onPress, theme }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void; theme: ReturnType<typeof useTheme> }) {
  const [hover, setHover] = React.useState(false);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      onHoverIn={() => setHover(true)}
      onHoverOut={() => setHover(false)}
      style={[styles.item, { opacity: hover ? 1 : 0.92 }]}
    >
      <Text style={{ color: theme.textSecondary, fontSize: 13, flex: 1 }}>{label}</Text>
      <Ionicons name={icon} size={15} color={hover ? theme.accent : theme.textDisabled} />
    </Pressable>
  );
}

function Sep({ theme }: { theme: ReturnType<typeof useTheme> }) {
  return <View style={{ height: 1, backgroundColor: theme.line, marginVertical: 6 }} />;
}

const styles = StyleSheet.create({
  menu: {
    width: 220,
    borderRadius: 12,
    borderWidth: 1,
    padding: 6,
    zIndex: 80,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 9,
    minHeight: 36,
  },
});
