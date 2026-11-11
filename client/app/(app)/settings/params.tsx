/**
 * Старый маршрут /settings/params оставлен для совместимости со ссылками.
 * Все параметры оформления переехали на /settings/appearance.
 */
import React from 'react';
import { Redirect } from 'expo-router';

export default function ParamsRedirect() {
  return <Redirect href="/settings/appearance" />;
}
