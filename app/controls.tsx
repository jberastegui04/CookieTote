import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SPEEDS } from './prefs';
import { C, font } from './theme';

// Shared pieces for Settings and the first-launch setup, so both look the same.

export function Section({ title }: { title: string }) {
  return (
    <Text style={s.section} accessibilityRole="header">
      {title}
    </Text>
  );
}

export function Caption({ children }: { children: string }) {
  return <Text style={s.caption}>{children}</Text>;
}

export function Segment<T extends string>(p: {
  options: { value: T; label: string; hint?: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View style={s.segment} accessibilityRole="radiogroup">
      {p.options.map((o) => {
        const on = o.value === p.value;
        return (
          <Pressable
            key={o.value}
            style={[s.segItem, on && s.segOn]}
            onPress={() => p.onChange(o.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={o.label}
            accessibilityHint={o.hint}
          >
            <Text style={[s.segText, on && s.segTextOn]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function ToggleRow(p: { label: string; hint: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Pressable
      style={s.row}
      onPress={() => p.onChange(!p.value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: p.value }}
      accessibilityLabel={p.label}
      accessibilityHint={p.hint}
    >
      <Text style={s.rowLabel}>{p.label}</Text>
      <View style={s.switchWrap}>
        <Text style={[s.switchState, !p.value && s.switchStateOff]}>{p.value ? 'On' : 'Off'}</Text>
        <View style={[s.track, !p.value && s.trackOff]}>
          <View style={[s.knob, p.value ? s.knobOn : s.knobOff]} />
        </View>
      </View>
    </Pressable>
  );
}

export function LinkRow(p: { label: string; hint?: string; value?: string; onPress: () => void; active?: boolean }) {
  return (
    <Pressable
      style={[s.row, p.active && s.rowActive]}
      onPress={p.onPress}
      accessibilityRole="button"
      accessibilityLabel={p.label}
      accessibilityHint={p.hint}
    >
      <Text style={s.rowLabel}>{p.label}</Text>
      <Text style={s.rowValue}>{p.value ? `${p.value}  ›` : '›'}</Text>
    </Pressable>
  );
}

// A list of voices, not a cycle: tap one to pick it and hear its sample.
export function VoiceList(p: {
  voices: { id: string; name: string }[];
  selected: string | null;
  onPick: (v: { id: string; name: string }) => void;
}) {
  if (p.voices.length === 0) {
    return <Caption>Voices appear once the server is awake. This can take about a minute.</Caption>;
  }
  return (
    <View accessibilityRole="radiogroup">
      {p.voices.map((v) => {
        const on = v.id === p.selected;
        return (
          <Pressable
            key={v.id}
            style={[s.row, on && s.rowActive]}
            onPress={() => p.onPick(v)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={v.name}
            accessibilityHint="Double tap to pick this voice and hear it"
          >
            <Text style={s.rowLabel}>{v.name}</Text>
            <View style={[s.radio, on && s.radioOn]}>{on ? <View style={s.radioDot} /> : null}</View>
          </Pressable>
        );
      })}
    </View>
  );
}

// Five steps. VoiceOver users swipe up or down on it; everyone else taps along the track.
export function SpeedSlider(p: { value: number; onChange: (i: number) => void }) {
  const [width, setWidth] = useState(1);
  const last = SPEEDS.length - 1;
  const set = (i: number) => p.onChange(Math.max(0, Math.min(last, i)));
  const frac = p.value / last;
  return (
    <View style={s.sliderCard}>
      <View style={s.sliderHead}>
        <Text style={s.rowLabel}>Warning speech speed</Text>
        <Text style={s.rowValue}>{SPEEDS[p.value].name}</Text>
      </View>
      <Text style={s.sliderCaption}>How fast obstacle warnings are spoken while you walk.</Text>
      <Pressable
        style={s.sliderHit}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        onPress={(e) => set(Math.round((e.nativeEvent.locationX / width) * last))}
        accessibilityRole="adjustable"
        accessibilityLabel="Warning speech speed"
        accessibilityValue={{ text: SPEEDS[p.value].name }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => set(p.value + (e.nativeEvent.actionName === 'increment' ? 1 : -1))}
      >
        <View style={s.sliderTrack}>
          <View style={[s.sliderFill, { width: `${frac * 100}%` }]} />
        </View>
        <View style={[s.sliderThumb, { left: frac * (width - 36) }]} />
      </Pressable>
      <View style={s.sliderEnds} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Text style={s.sliderEnd}>Slower</Text>
        <Text style={s.sliderEnd}>Faster</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  section: { color: C.blue, fontSize: 18, letterSpacing: 0.5, marginTop: 24, marginBottom: 10, ...font('bold') },
  caption: { color: C.ink2, fontSize: 18, marginTop: 4, marginBottom: 6, lineHeight: 24, ...font('regular') },
  segment: {
    flexDirection: 'row',
    backgroundColor: C.card,
    borderColor: C.border,
    borderWidth: 1.5,
    borderRadius: 18,
    padding: 4,
    minHeight: 72,
    marginBottom: 6,
  },
  segItem: { flex: 1, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: C.blue },
  segText: { color: C.ink, fontSize: 22, ...font('bold') },
  segTextOn: { color: '#fff' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: C.card,
    borderColor: C.border,
    borderWidth: 1.5,
    borderRadius: 18,
    minHeight: 72,
    paddingHorizontal: 20,
    marginBottom: 10,
  },
  rowActive: { borderColor: C.blue, borderWidth: 3 },
  rowLabel: { color: C.ink, fontSize: 21, flexShrink: 1, ...font('semibold') },
  rowValue: { color: C.blue, fontSize: 20, ...font('bold') },
  switchWrap: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  switchState: { color: C.blue, fontSize: 19, ...font('bold') },
  switchStateOff: { color: C.ink },
  track: { width: 62, height: 38, borderRadius: 19, backgroundColor: C.blue, justifyContent: 'center' },
  trackOff: { backgroundColor: C.off },
  knob: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#fff' },
  knobOn: { marginLeft: 27 },
  knobOff: { marginLeft: 3 },
  radio: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 3,
    borderColor: C.ink2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { borderColor: C.blue },
  radioDot: { width: 14, height: 14, borderRadius: 7, backgroundColor: C.blue },
  sliderCard: {
    backgroundColor: C.card,
    borderColor: C.border,
    borderWidth: 1.5,
    borderRadius: 18,
    paddingHorizontal: 20,
    paddingVertical: 16,
    marginBottom: 10,
  },
  sliderHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sliderCaption: { color: C.ink2, fontSize: 17, marginTop: 4, ...font('regular') },
  sliderHit: { height: 56, justifyContent: 'center', marginTop: 4 },
  sliderTrack: { height: 8, borderRadius: 4, backgroundColor: '#D1D1D6', overflow: 'hidden' },
  sliderFill: { height: 8, backgroundColor: C.blue },
  sliderThumb: {
    position: 'absolute',
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#fff',
    borderWidth: 3,
    borderColor: C.blue,
  },
  sliderEnds: { flexDirection: 'row', justifyContent: 'space-between' },
  sliderEnd: { color: C.ink2, fontSize: 17, ...font('regular') },
});
