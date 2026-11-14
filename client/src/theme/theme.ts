/**
 * Дизайн-токены Klinto v2. Единственный источник цветов/отступов/шрифтов.
 * Тёмная тема по умолчанию; светлая опциональна.
 */
export type ThemeName = 'dark' | 'light';

/** Акцентная палитра: название → метка, основной цвет, мягкий фон, цвет текста поверх акцента. */
export type AccentName = 'orange' | 'blue' | 'green' | 'purple' | 'pink';
export const ACCENTS: Record<AccentName, { label: string; color: string; soft: string; on: string }> = {
  orange: { label: 'Оранжевый', color: '#F5A623', soft: 'rgba(245,166,35,0.16)', on: '#1A1206' },
  blue: { label: 'Синий', color: '#4C8DFF', soft: 'rgba(76,141,255,0.16)', on: '#06101F' },
  green: { label: 'Зелёный', color: '#2ED47A', soft: 'rgba(46,212,122,0.16)', on: '#04150C' },
  purple: { label: 'Фиолетовый', color: '#A78BFA', soft: 'rgba(167,139,250,0.18)', on: '#120A24' },
  pink: { label: 'Розовый', color: '#F472B6', soft: 'rgba(244,114,182,0.16)', on: '#240815' },
};

export interface Tokens {
  dark: boolean;
  background: string;
  surface: string;
  surfaceElevated: string;
  surfacePressed: string;
  line: string;
  textPrimary: string;
  textSecondary: string;
  textDisabled: string;
  accent: string;
  accentSoft: string;
  onAccent: string;
  success: string;
  successSoft: string;
  warning: string;
  warningSoft: string;
  danger: string;
  dangerSoft: string;
  ringModule: string;
  ringNode: string;
  bubbleOther: string;
  bubbleMine: string;
  overlay: string;
  /** Стеклянные слои для сайдбара, дока и карточек поверх фона. */
  glass: string;
  glassStrong: string;
  glassBorder: string;
  glassShadow: string;
  shadow: { shadowColor: string; shadowOpacity: number; shadowRadius: number; shadowOffset: { width: number; height: number }; elevation: number };
}

const dark: Tokens = {
  dark: true,
  background: '#000000',
  surface: '#161618',
  surfaceElevated: '#1C1C1E',
  surfacePressed: '#2C2C2E',
  line: 'rgba(255,255,255,0.08)',
  textPrimary: '#FFFFFF',
  textSecondary: '#8E8E93',
  textDisabled: '#636366',
  accent: '#F5A623',
  accentSoft: 'rgba(245,166,35,0.16)',
  onAccent: '#1A1206',
  success: '#30D158',
  successSoft: 'rgba(48,209,88,0.16)',
  warning: '#FFD60A',
  warningSoft: 'rgba(255,214,10,0.16)',
  danger: '#FF453A',
  dangerSoft: 'rgba(255,69,58,0.16)',
  ringModule: '#30D158',
  ringNode: '#FFD60A',
  bubbleOther: '#1C1C1E',
  bubbleMine: '#E9820C',
  overlay: 'rgba(0,0,0,0.78)',
  glass: 'rgba(22,22,24,0.78)',
  glassStrong: 'rgba(22,22,24,0.94)',
  glassBorder: 'rgba(255,255,255,0.08)',
  glassShadow: 'rgba(0,0,0,0.6)',
  shadow: { shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 22, shadowOffset: { width: 0, height: 10 }, elevation: 10 },
};

const light: Tokens = {
  dark: false,
  background: '#F4F7FB',
  surface: '#FFFFFF',
  surfaceElevated: '#FFFFFF',
  surfacePressed: '#EAEEF5',
  line: '#DFE5EE',
  textPrimary: '#101828',
  textSecondary: '#667085',
  textDisabled: '#98A2B3',
  accent: '#E8850C',
  accentSoft: 'rgba(232,133,12,0.12)',
  onAccent: '#FFFFFF',
  success: '#12B76A',
  successSoft: 'rgba(18,183,106,0.12)',
  warning: '#F79009',
  warningSoft: 'rgba(247,144,9,0.12)',
  danger: '#F04438',
  dangerSoft: 'rgba(240,68,56,0.12)',
  ringModule: '#12B76A',
  ringNode: '#F79009',
  bubbleOther: '#EEF2F7',
  bubbleMine: '#E8850C',
  overlay: 'rgba(16,24,40,0.45)',
  glass: 'rgba(255,255,255,0.78)',
  glassStrong: 'rgba(255,255,255,0.94)',
  glassBorder: 'rgba(16,24,40,0.08)',
  glassShadow: 'rgba(16,24,40,0.16)',
  shadow: { shadowColor: '#101828', shadowOpacity: 0.10, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 6 },
};

export const tokens: Record<ThemeName, Tokens> = { dark, light };

export const radius = { s: 8, m: 12, l: 16, bubble: 20, avatar: 999, dock: 22 } as const;
export const spacing = { xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32 } as const;
export const font = { xs: 11, s: 13, m: 15, l: 19, xl: 24, xxl: 30 } as const;
export const minTouch = 44;

/** Ширины, на которых пк-layout переключается на «док слева» и двухколоночную сетку. */
export const breakpoint = 900;

export interface Theme extends Tokens {
  radiusS: typeof radius.s;
  radiusM: typeof radius.m;
  radiusL: typeof radius.l;
  radiusBubble: typeof radius.bubble;
  radiusAvatar: typeof radius.avatar;
  radiusDock: typeof radius.dock;
  spacingXs: number;
  spacingS: number;
  spacingM: number;
  spacingL: number;
  spacingXl: number;
  spacingXxl: number;
  fontXs: number;
  fontS: number;
  fontM: number;
  fontL: number;
  fontXl: number;
  fontXxl: number;
  minTouch: number;
  breakpoint: number;
}

export function makeTheme(name: ThemeName, accentName: AccentName = 'orange'): Theme {
  const t = tokens[name];
  const accent = ACCENTS[accentName] ?? ACCENTS.orange;
  // Акцент переопределяет ключевые токены поверх базовой темы.
  const accented: Tokens = {
    ...t,
    accent: accent.color,
    accentSoft: accent.soft,
    onAccent: accent.on,
    bubbleMine: accent.color,
    ringNode: accent.color,
  };
  return {
    ...accented,
    radiusS: radius.s,
    radiusM: radius.m,
    radiusL: radius.l,
    radiusBubble: radius.bubble,
    radiusAvatar: radius.avatar,
    radiusDock: radius.dock,
    spacingXs: spacing.xs,
    spacingS: spacing.s,
    spacingM: spacing.m,
    spacingL: spacing.l,
    spacingXl: spacing.xl,
    spacingXxl: spacing.xxl,
    fontXs: font.xs,
    fontS: font.s,
    fontM: font.m,
    fontL: font.l,
    fontXl: font.xl,
    fontXxl: font.xxl,
    minTouch,
    breakpoint,
  };
}

export const defaultTheme = makeTheme('dark');
