import React, { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, DimensionValue } from "react-native";
import Svg, { Path, Circle } from "react-native-svg";
import { ICONS } from "../icons";

type DoodleProps = { size?: number; color?: string };

function outline(d: string) {
  return function DoodleIcon({ size = 24, color = "#1D4ED8" }: DoodleProps) {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Path d={d} stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
    );
  };
}

const Notebook = outline(ICONS.book);
const Burger = outline(
  "M3 9.5C3 6.5 7 4 12 4s9 2.5 9 5.5M3 9.5h18M4 12.5h16M4 15.5h16M3 18.5c0 1.1 4 2 9 2s9-.9 9-2M3 18.5v-3h18v3"
);
const Fries = outline(
  "M5 10h14l-1.5 10.5a1.5 1.5 0 01-1.5 1.5H8a1.5 1.5 0 01-1.5-1.5zM8 10V5.5A1 1 0 019 4.5a1 1 0 011 1V10M11 10V4a1 1 0 012 0v6M14 10V5.5a1 1 0 012 0V10"
);
const DrinkCup = outline("M7 7h10l-1.2 12.5a1.5 1.5 0 01-1.5 1.5h-4.6a1.5 1.5 0 01-1.5-1.5zM6.7 7h10.6M11 2.5v4.5");
const Apple = outline(
  "M12 9c-2.5-2-6-1-6 3s2.5 8 5 8c1 0 1-.5 1.9-.5S14 20 15 20c2.5 0 5-4.5 5-8 0-3.3-3-4.5-5-3M12 9V6.5M12 6.5c0-1.2.8-2 2-2"
);
const IceCream = outline("M8 10a4 4 0 118 0M6.5 10h11L15 20.5a1 1 0 01-.9.6h-4.2a1 1 0 01-.9-.6z");
const Sandwich = outline("M4 17l8-9 8 9M4 17h16v1.5a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 18.5zM7.5 14h9");
const Mug = outline(
  "M5 9h11v6.5a3.5 3.5 0 01-3.5 3.5h-4A3.5 3.5 0 015 15.5zM16 10.5h1.5a2 2 0 010 4H16M8 6.5c0-1 .8-1 .8-2M11.5 6.5c0-1 .8-1 .8-2"
);
const Bowl = outline("M4 12h16a8 6 0 01-16 0zM6 12a6 4 0 0112 0");

function Cookie({ size = 24, color = "#1D4ED8" }: DoodleProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={12} r={8.5} stroke={color} strokeWidth={1.6} />
      <Circle cx={9} cy={9.5} r={0.9} fill={color} />
      <Circle cx={14} cy={8.5} r={0.9} fill={color} />
      <Circle cx={15.5} cy={13} r={0.9} fill={color} />
      <Circle cx={10} cy={15} r={0.9} fill={color} />
    </Svg>
  );
}

type Placement = {
  Doodle: React.ComponentType<DoodleProps>;
  size: number;
  rotate: number;
  top?: DimensionValue;
  bottom?: DimensionValue;
  left?: DimensionValue;
  right?: DimensionValue;
};

// Percentage-based so the spread adapts to any screen size, and deliberately
// reaching through the middle of the screen, not just the corners. Placements
// are still kept clear of the actual input/button/card rectangles: a solid
// rounded-corner box only *mostly* hides whatever sits behind it — the 4
// corners cut a small gap in the rounding where an overlapping icon peeks
// through as an ugly sliver. Plain text has no such box, so overlapping text
// is fine; overlapping an input, button, or card is not.

// Tall scroll layout (respondent): fields sit roughly 38%-57% down, the
// "first time here?" card roughly 75%-85% — both treated as no-go bands.
const RESPONDENT_PLACEMENTS: Placement[] = [
  { Doodle: Notebook, size: 30, rotate: -16, top: "4%", left: "6%" },
  { Doodle: Burger, size: 34, rotate: 12, top: "6%", right: "8%" },
  { Doodle: Cookie, size: 22, rotate: 0, top: "15%", left: "42%" },
  { Doodle: Mug, size: 26, rotate: -10, top: "21%", right: "16%" },
  { Doodle: Apple, size: 24, rotate: 8, top: "27%", left: "14%" },
  { Doodle: IceCream, size: 26, rotate: 14, top: "60%", left: "32%" },
  { Doodle: Sandwich, size: 28, rotate: 10, top: "64%", left: "54%" },
  { Doodle: DrinkCup, size: 24, rotate: -6, top: "68%", right: "38%" },
  { Doodle: Bowl, size: 26, rotate: -4, top: "72%", right: "12%" },
  { Doodle: Fries, size: 26, rotate: -8, top: "88%", left: "44%" },
  { Doodle: Notebook, size: 22, rotate: 20, top: "92%", left: "10%" },
  { Doodle: Cookie, size: 20, rotate: 0, top: "90%", right: "14%" },
];

// Compact centered layout (interviewer): flex-1 + justify-center means the
// logo/fields/button/link stack sits in the vertical middle with open margin
// above and below — that margin is the only safe territory here.
const INTERVIEWER_PLACEMENTS: Placement[] = [
  { Doodle: Notebook, size: 28, rotate: -16, top: "3%", left: "8%" },
  { Doodle: Burger, size: 32, rotate: 12, top: "5%", right: "10%" },
  { Doodle: Cookie, size: 20, rotate: 0, top: "14%", left: "40%" },
  { Doodle: Mug, size: 24, rotate: -10, top: "10%", left: "60%" },
  { Doodle: Apple, size: 22, rotate: 8, top: "18%", right: "34%" },
  { Doodle: Fries, size: 24, rotate: -8, top: "82%", left: "10%" },
  { Doodle: IceCream, size: 24, rotate: 14, top: "86%", left: "44%" },
  { Doodle: DrinkCup, size: 22, rotate: -6, top: "80%", right: "12%" },
  { Doodle: Bowl, size: 22, rotate: -4, top: "90%", right: "40%" },
  { Doodle: Sandwich, size: 24, rotate: 10, top: "94%", left: "26%" },
];

// Deterministic pseudo-random in [0,1), so each icon gets a stable but
// distinct drift/speed/phase without hand-tuning every entry.
function seeded(n: number) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function FloatingDoodle({
  index,
  baseRotate,
  style,
  children,
}: {
  index: number;
  baseRotate: number;
  style: any;
  children: React.ReactNode;
}) {
  const t = useRef(new Animated.Value(0)).current;

  // Small amplitudes — enough to read as "alive", not enough to drift into
  // the no-go bands the placements were already kept clear of.
  const driftX = (seeded(index * 3.1 + 1) - 0.5) * 14;
  const driftY = (seeded(index * 4.7 + 2) - 0.5) * 18;
  const wobble = (seeded(index * 5.3 + 3) - 0.5) * 8;
  const duration = 4200 + seeded(index * 2.3 + 4) * 3200;
  const delay = seeded(index * 1.9 + 5) * 2000;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(t, {
          toValue: 1,
          duration,
          delay,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(t, {
          toValue: 0,
          duration,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [t, duration, delay]);

  const translateX = t.interpolate({ inputRange: [0, 1], outputRange: [-driftX, driftX] });
  const translateY = t.interpolate({ inputRange: [0, 1], outputRange: [-driftY, driftY] });
  const rotate = t.interpolate({
    inputRange: [0, 1],
    outputRange: [`${baseRotate - wobble}deg`, `${baseRotate + wobble}deg`],
  });

  return (
    <Animated.View style={[style, { transform: [{ translateX }, { translateY }, { rotate }] }]}>
      {children}
    </Animated.View>
  );
}

function DoodleField({ placements, color }: { placements: Placement[]; color: string }) {
  return (
    <Animated.View style={[StyleSheet.absoluteFill, { pointerEvents: "none" }]}>
      {placements.map((p, i) => {
        const { Doodle, size, rotate, ...pos } = p;
        return (
          <FloatingDoodle key={i} index={i} baseRotate={rotate} style={[{ position: "absolute", opacity: 0.22 }, pos]}>
            <Doodle size={size} color={color} />
          </FloatingDoodle>
        );
      })}
    </Animated.View>
  );
}

export function LoginDoodleField({
  color = "#1D4ED8",
  variant = "respondent",
}: {
  color?: string;
  variant?: "respondent" | "interviewer";
}) {
  const placements = variant === "interviewer" ? INTERVIEWER_PLACEMENTS : RESPONDENT_PLACEMENTS;
  return <DoodleField placements={placements} color={color} />;
}

// The tab screens (Home/Entries/Activity/Profile) are packed edge-to-edge
// with rounded cards, unlike the two open login screens — there's no safe
// mid-screen gap to scatter into without risking the same rounded-corner
// clipping the login placements had to dodge. The one band that's reliably
// open on every one of them, regardless of how much data is in the list
// below, is the strip alongside the header title: a small icon badge on the
// left and a circular bell/search button on the right, both narrow, leaving
// the horizontal center of that row empty all the way down to where content
// starts. Positions are fixed pixels (not %) since this is a fixed-height
// header row, not a proportional slice of the screen.
const SCREEN_HEADER_PLACEMENTS: Placement[] = [
  { Doodle: Cookie, size: 15, rotate: 0, top: 4, left: "44%" },
  { Doodle: Notebook, size: 16, rotate: -12, top: 2, left: "64%" },
];

// Profile's content is fixed (no data-length-dependent list), so unlike
// Home/Entries/Activity it reliably leaves open space below the "Sign out"
// button before the tab bar — safe to use, kept conservative in case the
// estimate runs tight on a shorter screen.
const PROFILE_BOTTOM_PLACEMENTS: Placement[] = [
  { Doodle: Apple, size: 18, rotate: 10, bottom: "6%", left: "20%" },
  { Doodle: Mug, size: 18, rotate: -8, bottom: "4%", right: "22%" },
];

export function ScreenDoodleField({ color = "#1D4ED8", withBottom = false }: { color?: string; withBottom?: boolean }) {
  const placements = withBottom ? [...SCREEN_HEADER_PLACEMENTS, ...PROFILE_BOTTOM_PLACEMENTS] : SCREEN_HEADER_PLACEMENTS;
  return <DoodleField placements={placements} color={color} />;
}
