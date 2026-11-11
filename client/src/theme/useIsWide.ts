import React from 'react';

/** Надёжное определение «широкого экрана» (ПК): matchMedia, работает с SSR и при resize. */
export function useIsWide(breakpoint = 900): boolean {
  const [wide, setWide] = React.useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(`(min-width: ${breakpoint}px)`).matches;
  });
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(`(min-width: ${breakpoint}px)`);
    const update = () => setWide(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [breakpoint]);
  return wide;
}
