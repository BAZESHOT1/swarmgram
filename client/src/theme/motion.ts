/**
 * Единые тайминги анимаций в iOS-подобном стиле.
 * Используем мягкие пружины и короткие easing-переходы.
 */
export const motion = {
  /** Основная пружина для карточек, меню, кнопок. */
  spring: { type: 'spring' as const, damping: 22, stiffness: 260, mass: 0.9 },
  /** Более мягкая пружина для больших поверхностей. */
  softSpring: { type: 'spring' as const, damping: 26, stiffness: 210, mass: 1 },
  /** Быстрый пружинный отклик на нажатие. */
  pressSpring: { type: 'spring' as const, damping: 18, stiffness: 420, mass: 0.6 },
  /** Короткий fade/сдвиг. */
  quick: { type: 'timing' as const, duration: 180 },
  base: { type: 'timing' as const, duration: 240 },
  staggerStepMs: 40,
} as const;
