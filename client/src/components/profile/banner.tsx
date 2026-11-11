import { Platform } from 'react-native';

/** Идентификаторы палитры баннера профиля (контракт data-слоя). */
export type BannerId = 'orange' | 'blue' | 'green' | 'purple' | 'pink' | 'graphite';

export interface BannerPreset {
  id: BannerId;
  label: string;
  colors: [string, string, string];
}

/** Палитра баннеров: три оттенка для мягкого «стеклянного» градиента. */
export const BANNERS: BannerPreset[] = [
  { id: 'orange', label: 'Оранжевый', colors: ['#F5A623', '#E8620C', '#7A2E08'] },
  { id: 'blue', label: 'Синий', colors: ['#4D7CFE', '#2B4EDB', '#132A70'] },
  { id: 'green', label: 'Зелёный', colors: ['#2ED47A', '#0E9C60', '#064A2C'] },
  { id: 'purple', label: 'Фиолетовый', colors: ['#B95CF4', '#7B2EDB', '#33106B'] },
  { id: 'pink', label: 'Розовый', colors: ['#F973B1', '#D63189', '#5C103C'] },
  { id: 'graphite', label: 'Графит', colors: ['#5A6A80', '#2C3747', '#0E141D'] },
];

export const DEFAULT_BANNER: BannerId = 'orange';

/** Безопасно привести строку из API к известному пресету. */
export function bannerPreset(value?: string | null): BannerPreset {
  return BANNERS.find((b) => b.id === value) ?? BANNERS[0];
}

/**
 * Фон баннера: на web — настоящий CSS-градиент, на нативных платформах
 * — базовый цвет + полупрозрачные слои (без внешних зависимостей).
 */
export function bannerBackground(value?: string | null): any {
  const preset = bannerPreset(value);
  const [a, b, c] = preset.colors;
  if (Platform.OS === 'web') {
    return {
      backgroundColor: a,
      backgroundImage: `linear-gradient(135deg, ${a} 0%, ${b} 52%, ${c} 100%)`,
    };
  }
  return { backgroundColor: b };
}
