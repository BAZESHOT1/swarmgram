import React from 'react';
import { Stack } from 'expo-router';

/** Группа экранов авторизации: без шапки, фон задаёт AuthShell/<body>. */
export default function AuthLayout() {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: 'transparent' } }} />;
}
