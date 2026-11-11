import React, { useEffect } from 'react';
import { Platform } from 'react-native';
import { useTheme } from '../theme/useTheme';

/** Синхронизирует фон <body> с темой (иначе под обводкой всех компонентов виден белый). */
export function useBodyBackground(): void {
  const theme = useTheme();
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const b = document.body;
    const h = document.documentElement;
    b.style.backgroundColor = theme.background;
    h.style.backgroundColor = theme.background;
    b.style.color = theme.textPrimary;
  }, [theme.background, theme.textPrimary]);
}
