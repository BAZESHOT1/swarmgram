import React from 'react';
import { View, StyleSheet } from 'react-native';
import { usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/useTheme';
import { useBodyBackground } from '../theme/useBodyBackground';
import { useIsWide } from '../theme/useIsWide';
import { AppNavbar, SIDEBAR_WIDTH } from './AppNavbar';

/**
 * Каркас страницы: сайдбар/док и контент с отступами + safe-area.
 * На web фон дублируется в <body>; на native задаём theme.background,
 * иначе прозрачный Stack показывал чёрный экран.
 *
 * Под навбаром (док на смартфоне / сайдбар на ПК) НЕ резервируем полосу:
 * контент при скролле уходит под плавающий док. Безопасный нижний отступ
 * задаётся на самих страницах через contentContainerStyle (chats — 130,
 * settings — 120/140), чтобы последние элементы не прятались под кнопками.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const inset = useSafeAreaInsets();
  const wide = useIsWide();
  const pathname = usePathname();
  const theme = useTheme();
  const actualInChat = pathname.startsWith('/chat/') || pathname.startsWith('/compose');
  // Не меняем боковые отступы во время анимации перехода: иначе ширина
  // страницы меняется на лету и сообщения/строки «дёргаются».
  const [inChat, setInChat] = React.useState(actualInChat);
  React.useEffect(() => {
    if (!actualInChat) {
      setInChat(false);
      return undefined;
    }
    const timer = setTimeout(() => setInChat(true), 320);
    return () => clearTimeout(timer);
  }, [actualInChat]);
  useBodyBackground();

  return (
    <View
      style={[
        styles.root,
        {
          backgroundColor: theme.background,
          paddingTop: (inset.top || 12) + 12,
          // Док/сайдбар плавающие: фоновая полоса под ними не нужна.
          paddingBottom: wide ? 32 : 0,
          paddingLeft: wide ? (inset.left || 0) + SIDEBAR_WIDTH + 24 : inChat ? 0 : 16,
          paddingRight: wide ? 28 : inChat ? 0 : 16,
        },
      ]}
    >
      {children}
      <AppNavbar />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
