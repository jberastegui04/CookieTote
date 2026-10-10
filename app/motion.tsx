import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, Easing, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';

// True when the iPhone's Reduce Motion setting is on. Animations skip straight to their end state.
export function useReduceMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduce).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => sub.remove();
  }, []);
  return reduce;
}

const ENTER_MS = 260;
const ENTER_DISTANCE = 24;

// A screen that fades in and slides a short way when it appears: up for screens that open over the
// camera, from the right for a page opened from a list (like iPhone Settings), or just a fade.
// Only on appearing, so it never slows anything down. Reduce Motion shows it straight away.
export function Enter({
  from = 'up',
  style,
  children,
  ...rest
}: ViewProps & { from?: 'up' | 'right' | 'fade'; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const reduce = useReduceMotion();
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(t, { toValue: 1, duration: ENTER_MS, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [t]);
  const shift = t.interpolate({ inputRange: [0, 1], outputRange: [ENTER_DISTANCE, 0] });
  const motion = reduce
    ? null
    : {
        opacity: t,
        transform: from === 'up' ? [{ translateY: shift }] : from === 'right' ? [{ translateX: shift }] : [],
      };
  return (
    <Animated.View {...rest} style={[style, motion]}>
      {children}
    </Animated.View>
  );
}
