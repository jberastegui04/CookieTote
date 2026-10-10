import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

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
