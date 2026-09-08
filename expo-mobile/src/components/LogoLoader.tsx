import React, { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  StyleSheet,
  View,
} from "react-native";
import Svg, { Defs, G, Image as SvgImage, Mask, Path } from "react-native-svg";

const LOGO = require("../../assets/logo.png");
const AnimatedPath = Animated.createAnimatedComponent(Path);

type LogoLoaderProps = {
  size?: number;
  backgroundColor?: string;
};

export function LogoLoader({
  size = 224,
  backgroundColor = "transparent",
}: LogoLoaderProps) {
  const progress = useRef(new Animated.Value(0)).current;
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduceMotion,
    );
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    progress.stopAnimation();
    progress.setValue(0);
    if (reduceMotion) return;

    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: 2100,
        easing: Easing.linear,
        useNativeDriver: false,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [progress, reduceMotion]);

  const dashOffset = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -702],
  });
  const width = size;
  const height = size * (160 / 264);

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel="Inicio Diary is loading"
      style={[styles.screen, { backgroundColor }]}
    >
      <View style={[styles.logoStage, { width, height }]}>
        <Svg
            pointerEvents="none"
            viewBox="0 0 264 160"
            width={width}
            height={height}
            style={styles.flowLayer}
          >
            <Defs>
              <Mask id="inicio-logo-mask" x="0" y="0" width="264" height="160" maskType="alpha">
                <SvgImage href={LOGO} x="0" y="0" width="264" height="160" preserveAspectRatio="xMidYMid meet" />
              </Mask>
            </Defs>
            <G mask="url(#inicio-logo-mask)">
              <AnimatedPath
                d="M 54 13 C 27 2 10 31 11 70 C 12 115 37 144 75 151 C 116 158 157 137 184 110 C 208 86 237 87 252 103 C 267 120 260 144 242 155 C 222 167 202 154 181 135 L 54 13"
                fill="none"
                stroke="#72D8FF"
                strokeWidth="31"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray="82 620"
                strokeDashoffset={dashOffset}
                opacity={0.5}
              />
              <AnimatedPath
                d="M 54 13 C 27 2 10 31 11 70 C 12 115 37 144 75 151 C 116 158 157 137 184 110 C 208 86 237 87 252 103 C 267 120 260 144 242 155 C 222 167 202 154 181 135 L 54 13"
                fill="none"
                stroke="#E5FAFF"
                strokeWidth="8"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray="34 668"
                strokeDashoffset={dashOffset}
                opacity={0.95}
              />
            </G>
        </Svg>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  logoStage: {
    position: "relative",
  },
  flowLayer: {
    ...StyleSheet.absoluteFill,
  },
});
