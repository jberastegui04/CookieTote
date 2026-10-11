import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { Tap } from './controls';
import { useReduceMotion } from './motion';
import { C, font, SPACE } from './theme';

// Walker, the voice assistant: press and hold anywhere (or tap him), say what you need ("find the little green dragon"), and he
// answers in his own voice and does it. He has his own color (light blue) as well as his own
// voice, so he's never mistaken for the guide.
export type WalkerState = 'idle' | 'listening' | 'thinking' | 'talking';

const STATE_TEXT: Record<Exclude<WalkerState, 'idle'>, string> = {
  listening: 'Listening…',
  thinking: 'Thinking…',
  talking: 'Walker',
};

// A friendly round face; sound waves beside it while he talks (the face shifts left to make room).
// Decorative, VoiceOver skips it.
export function WalkerIcon({ size = 40, color = C.walker, talking = false }: { size?: number; color?: string; talking?: boolean }) {
  return (
    <Svg width={size} height={size} viewBox={talking ? '0 0 48 48' : '-5 0 48 48'} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Circle cx={19} cy={24} r={15} stroke={color} strokeWidth={3.5} fill="none" />
      <Circle cx={14} cy={21} r={2.6} fill={color} />
      <Circle cx={24} cy={21} r={2.6} fill={color} />
      <Path d="M13 28.5 Q19 33.5 25 28.5" stroke={color} strokeWidth={3} strokeLinecap="round" fill="none" />
      {talking ? (
        <>
          <Path d="M37 17 Q41 24 37 31" stroke={color} strokeWidth={3} strokeLinecap="round" fill="none" />
          <Path d="M42 13 Q47 24 42 35" stroke={color} strokeWidth={3} strokeLinecap="round" fill="none" />
        </>
      ) : null}
    </Svg>
  );
}

// 0 -> 1 -> 0 forever while active: fast while listening, slower while talking or thinking.
function usePulse(state: WalkerState, reduce: boolean) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (state === 'idle') {
      v.setValue(0);
      return;
    }
    if (reduce) {
      v.setValue(1);
      return;
    }
    const half = state === 'listening' ? 450 : state === 'talking' ? 600 : 900;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: half, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(v, { toValue: 0, duration: half, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [state, reduce, v]);
  return v;
}

// The round Walker button next to Find and Guide (and next to Stop finding).
export function WalkerButton(p: { state: WalkerState; onPress: () => void; size: number }) {
  const reduce = useReduceMotion();
  const pulse = usePulse(p.state, reduce);
  const filled = p.state === 'listening' || p.state === 'talking';
  const r = p.size / 2;
  return (
    <View style={{ width: p.size, height: p.size }}>
      {p.state !== 'idle' ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.ring,
            { borderRadius: r + 8, opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0.8] }) },
            reduce ? null : { transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] }) }] },
          ]}
        />
      ) : null}
      <Tap
        style={[styles.button, { borderRadius: r }, filled ? styles.filled : styles.outline, p.state === 'thinking' && styles.thinking]}
        onPress={p.onPress}
        accessibilityRole="button"
        accessibilityLabel="Walker"
        accessibilityValue={{ text: p.state !== 'idle' ? STATE_TEXT[p.state] : '' }}
        accessibilityHint={
          p.state === 'listening'
            ? 'Double tap to stop listening'
            : p.state === 'idle'
              ? 'Or press and hold anywhere. Then say what you need, like: find the red chair, or start walking'
              : 'Double tap to stop Walker'
        }
      >
        <WalkerIcon size={p.size * 0.56} color={filled ? C.onWalker : C.walker} talking={p.state === 'talking'} />
      </Tap>
    </View>
  );
}

// What Walker is doing, shown above the buttons while he's busy: "Listening…", "Thinking…", or what
// he's saying. Visual only; his voice says the same thing.
export function WalkerBubble(p: { state: WalkerState; text: string | null }) {
  if (p.state === 'idle') return null;
  return (
    <View style={styles.bubble} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <WalkerIcon size={30} talking={p.state === 'talking'} />
      <Text style={styles.bubbleText} numberOfLines={3}>
        {p.state === 'talking' && p.text ? p.text : STATE_TEXT[p.state]}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  ring: { position: 'absolute', top: -8, bottom: -8, left: -8, right: -8, borderWidth: 4, borderColor: C.walker },
  button: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  outline: { backgroundColor: C.glass, borderWidth: 2, borderColor: C.walker },
  filled: { backgroundColor: C.walker },
  thinking: { borderWidth: 3 },
  bubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.md,
    backgroundColor: C.glass,
    borderColor: C.walker,
    borderWidth: 2,
    borderRadius: 22,
    paddingHorizontal: SPACE.lg,
    paddingVertical: SPACE.md,
  },
  bubbleText: { flex: 1, color: C.walker, fontSize: 22, ...font('bold') },
});
