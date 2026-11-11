/**
 * Pressable с iOS-подобным пружинным сжатием при нажатии.
 * Уважает reduced motion: при отключённых анимациях масштаб не меняется.
 */
import React from 'react';
import { Animated, Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { motion } from '../../theme/motion';
import { useReducedMotion } from '../useReducedMotion';

type Props = Omit<PressableProps, 'style'> & {
  style?: StyleProp<ViewStyle>;
  /** До какого масштаба сжимать плитку при нажатии. */
  scaleTo?: number;
  children?: React.ReactNode;
};

export function PressableScale({ style, scaleTo = 0.97, disabled, onPressIn, onPressOut, children, ...rest }: Props) {
  const reduced = useReducedMotion();
  const scale = React.useRef(new Animated.Value(1)).current;

  const animateTo = React.useCallback(
    (toValue: number) => {
      Animated.spring(scale, {
        toValue,
        damping: motion.pressSpring.damping,
        stiffness: motion.pressSpring.stiffness,
        mass: motion.pressSpring.mass,
        useNativeDriver: true,
      }).start();
    },
    [scale],
  );

  return (
    <Pressable
      {...rest}
      disabled={disabled}
      onPressIn={(event) => {
        if (!disabled && !reduced) animateTo(scaleTo);
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        if (!reduced) animateTo(1);
        onPressOut?.(event);
      }}
    >
      <Animated.View style={[style, { transform: [{ scale }] }]}>{children}</Animated.View>
    </Pressable>
  );
}
