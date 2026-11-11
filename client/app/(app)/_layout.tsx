import React, { useEffect } from 'react';
import { Stack, usePathname, useRouter } from 'expo-router';
import { View, StyleSheet } from 'react-native';
import { AppShell } from '../../src/components/AppShell';
import { useStore } from '../../src/state/useStore';
import { useTheme } from '../../src/theme/useTheme';

/** Каркас приложения: маршрут без сессии всегда уводит на /login. */
export default function AppLayout() {
  const pathname = usePathname();
  const router = useRouter();
  const theme = useTheme();
  const session = useStore((s) => s.session);
  const ready = useStore((s) => s.ready);

  useEffect(() => {
    if (!ready || !pathname) return;
    if (!session) router.replace('/login' as never);
  }, [pathname, ready, session, router]);

  if (!ready || !session) {
    // корневой layout восстанавливает сессию и выставляет ready
    return <View style={{ ...StyleSheet.absoluteFillObject, backgroundColor: theme.background }} />;
  }

  return (
    <AppShell>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.background },
          animation: 'slide_from_right',
          animationDuration: 240,
          // iOS: интерактивный свайп назад для всех страниц, включая настройки
          // и профиль. customAnimationOnGesture сохраняет нашу анимацию.
          gestureEnabled: true,
          fullScreenGestureEnabled: false,
          customAnimationOnGesture: true,
          gestureDirection: 'horizontal',
        }}
      >
        <Stack.Screen
          name="chats"
          options={({ route }) => ({
            // Из «Настроек» в «Чаты» на телефоне — анимация слева.
            animation: (route.params as { __nav?: string } | undefined)?.__nav === 'left'
              ? 'slide_from_left'
              : 'slide_from_right',
          })}
        />
        <Stack.Screen name="settings" />
        <Stack.Screen name="settings/params" />
        <Stack.Screen name="settings/notifications" />
        <Stack.Screen name="settings/appearance" />
        <Stack.Screen name="settings/network" />
        <Stack.Screen name="settings/security" />
        <Stack.Screen name="settings/privacy" />
        <Stack.Screen name="settings/about" />
        <Stack.Screen name="modules" />
        <Stack.Screen name="firmware" />
        <Stack.Screen name="nodes" />
        <Stack.Screen name="language" />
        <Stack.Screen name="admin" />
        <Stack.Screen name="chat/[id]" />
        <Stack.Screen name="chat/[id]/info" />
        <Stack.Screen name="user/[username]" />
        <Stack.Screen name="user/[username]/edit" />
        <Stack.Screen name="compose" options={{ presentation: 'modal', animation: 'slide_from_bottom', gestureEnabled: false }} />
      </Stack>
    </AppShell>
  );
}
