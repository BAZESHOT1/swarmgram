import React from 'react';
import { Stack } from 'expo-router';
import { useTheme } from '../../src/theme/useTheme';

/** Группа экранов авторизации: без шапки, фон из темы (не прозрачный). */
export default function AuthLayout() {
  const theme = useTheme();
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.background } }} />;
}
