import type { Theme } from '../../theme/theme';

/**
 * Цвет имени участника по его роли в чате (Telegram-style).
 * owner — акцент, admin — зелёный, moderator — предупреждающий, member — вторичный.
 */
export function roleColor(theme: Theme, role?: string | null): string {
  switch ((role ?? '').toLowerCase()) {
    case 'owner':
      return theme.accent;
    case 'admin':
      return theme.success;
    case 'moderator':
      return theme.warning;
    default:
      return theme.textSecondary;
  }
}

/** Человекочитаемая метка роли — используется в подсказках/шапке. */
export function roleLabel(role?: string | null): string {
  switch ((role ?? '').toLowerCase()) {
    case 'owner':
      return 'Владелец';
    case 'admin':
      return 'Администратор';
    case 'moderator':
      return 'Модератор';
    default:
      return 'Участник';
  }
}

/** Склонение числительных: 1 участник, 2 участника, 5 участников. */
export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}
