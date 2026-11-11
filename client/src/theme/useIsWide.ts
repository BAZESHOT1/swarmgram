import React from 'react';
import { Dimensions } from 'react-native';

/**
 * «Широкий экран» (ПК): matchMedia на web, ширина Dimensions на native.
 * В React Native `window` существует, но без matchMedia — поэтому проверяем
 * наличие метода, иначе получаем `undefined is not a function` при старте.
 */
function hasMatchMedia(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as { matchMedia?: unknown }).matchMedia === 'function'
  );
}

function mediaQuery(breakpoint: number): string {
  return `(min-width: ${breakpoint}px)`;
}

export function useIsWide(breakpoint = 900): boolean {
  const [wide, setWide] = React.useState(() => {
    if (hasMatchMedia()) return window.matchMedia(mediaQuery(breakpoint)).matches;
    return Dimensions.get('window').width >= breakpoint;
  });

  React.useEffect(() => {
    if (hasMatchMedia()) {
      const mq = window.matchMedia(mediaQuery(breakpoint));
      const update = () => setWide(mq.matches);
      update();
      // Safari < 14 поддерживает только addListener/removeListener.
      if (typeof mq.addEventListener === 'function') {
        mq.addEventListener('change', update);
        return () => mq.removeEventListener('change', update);
      }
      mq.addListener(update);
      return () => mq.removeListener(update);
    }

    const update = ({ window }: { window: { width: number } }) => {
      setWide(window.width >= breakpoint);
    };
    setWide(Dimensions.get('window').width >= breakpoint);
    const sub = Dimensions.addEventListener('change', update);
    return () => sub.remove();
  }, [breakpoint]);

  return wide;
}
