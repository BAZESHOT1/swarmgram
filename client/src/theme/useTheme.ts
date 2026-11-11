import React from 'react';
import { useColorScheme } from 'react-native';
import { useStore } from '../state/useStore';
import { makeTheme, type Theme, type ThemeName } from './theme';

/** Тема с учётом «следовать за системой»: system → colorScheme ОС, fallback dark. */
export function useTheme(): Theme {
  const preference = useStore((s) => s.themeName);
  const accentName = useStore((s) => s.accentName);
  const osScheme = useColorScheme();
  const resolved: Extract<ThemeName, 'dark' | 'light'> =
    preference === 'system' ? (osScheme === 'light' ? 'light' : 'dark') : preference;
  return React.useMemo(() => makeTheme(resolved, accentName), [resolved, accentName]);
}

/** Фактически выбранная тёмная/светлая тема (для StatusBar и т. п.). */
export function useResolvedThemeName(): 'dark' | 'light' {
  const theme = useTheme();
  return theme.dark ? 'dark' : 'light';
}
