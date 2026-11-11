/**
 * Pressable с iOS-подобным пружинным сжатием: scale 0.9–0.99 на время нажатия.
 * Работает поверх обычных style-callback'ов Pressable и уважает reduced motion.
 * По умолчанию даёт лёгкую вибрацию на onPress (можно отключить пропом haptic={false});
 * антидубликат живёт в useHaptics, поэтому ручные haptics.tap() не задвоятся.
 */
import React from 'react';
import { Animated, Pressable, View, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { motion } from '../../theme/motion';
import { useReducedMotion } from '../useReducedMotion';
import { useHaptics } from '../useHaptics';

type Props = PressableProps & {
  /** Насколько сжать элемент при нажатии. */
  pressedScale?: number;
  /** Стиль внешней Animated-обёртки (transform не перезаписывается). */
  containerStyle?: StyleProp<ViewStyle>;
  /** Лёгкая вибрация на onPress (по умолчанию включена). */
  haptic?: boolean;
};

export const PressableScale = React.forwardRef<View, Props>(function PressableScale(
  { pressedScale = 0.97, containerStyle, haptic = true, onPress, onPressIn, onPressOut, disabled, children, ...rest },
  ref,
) {
  const reduced = useReducedMotion();
  const haptics = useHaptics();
  const scale = React.useRef(new Animated.Value(1)).current;

  const animateTo = React.useCallback(
    (toValue: number) => {
      if (reduced) {
        scale.setValue(toValue);
        return;
      }
      Animated.spring(scale, {
        toValue,
        damping: motion.pressSpring.damping,
        stiffness: motion.pressSpring.stiffness,
        mass: motion.pressSpring.mass,
        useNativeDriver: true,
      }).start();
    },
    [reduced, scale],
  );

  return (
    <Animated.View style={[containerStyle, { transform: [{ scale }] }]}>
      <Pressable
        ref={ref}
        {...rest}
        disabled={disabled}
        onPress={onPress ? (event) => {
          if (!disabled && haptic) haptics.tap();
          onPress(event);
        } : undefined}
        onPressIn={(event) => {
          animateTo(pressedScale);
          onPressIn?.(event);
        }}
        onPressOut={(event) => {
          animateTo(1);
          onPressOut?.(event);
        }}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
});
