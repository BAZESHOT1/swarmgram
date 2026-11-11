import React from 'react';
import { AccessibilityInfo } from 'react-native';
import { useStore } from '../state/useStore';

/** Уважение к prefers-reduced-motion: анимации отключаются/упрощаются. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled?.().then(setReduced).catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (v: boolean) => setReduced(v));
    return () => sub?.remove?.();
  }, []);
  return reduced;
}
