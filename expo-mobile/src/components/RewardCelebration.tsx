import React, { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Dimensions, Easing, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import type { RewardCelebrationData } from "../screens/Rewards";

const PARTICLES = Array.from({ length: 18 }, (_, index) => ({
  left: ((index * 37) % 94) + 3,
  delay: (index % 6) * 90,
  width: index % 3 === 0 ? 6 : 9,
  height: index % 3 === 0 ? 13 : 8,
}));

export function RewardCelebration({
  celebration,
  onContinue,
  onViewRewards,
}: {
  celebration: RewardCelebrationData | null;
  onContinue: () => void;
  onViewRewards: () => void;
}) {
  const [reduceMotion, setReduceMotion] = useState<boolean | null>(null);
  const entrance = useRef(new Animated.Value(0)).current;
  const confetti = useRef(PARTICLES.map(() => new Animated.Value(0))).current;
  const screenHeight = Dimensions.get("window").height;

  useEffect(() => {
    let active = true;
    const fallback = setTimeout(() => { if (active) setReduceMotion(true); }, 250);
    AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (active) { clearTimeout(fallback); setReduceMotion(value); } }).catch(() => {});
    return () => { active = false; clearTimeout(fallback); };
  }, []);

  useEffect(() => {
    if (!celebration) return;
    entrance.setValue(0);
    confetti.forEach((value) => value.setValue(0));
    if (reduceMotion === null) return;
    if (reduceMotion) entrance.setValue(1);
    else Animated.timing(entrance, { toValue: 1, duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    if (!reduceMotion) {
      Animated.parallel(confetti.map((value, index) => Animated.timing(value, {
        toValue: 1,
        duration: celebration.durationMs,
        delay: PARTICLES[index].delay,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }))).start();
    }
  }, [celebration, confetti, entrance, reduceMotion]);

  if (!celebration) return null;
  const allPaid = celebration.items.every((item) => item.status === "paid");
  return (
    <Modal transparent visible animationType="none" statusBarTranslucent onRequestClose={onContinue}>
      <View style={styles.backdrop}>
        {reduceMotion === false ? confetti.map((value, index) => {
          const particle = PARTICLES[index];
          return <Animated.View key={index} pointerEvents="none" style={[styles.confetti, {
            left: `${particle.left}%`,
            width: particle.width,
            height: particle.height,
            backgroundColor: index % 4 === 0 ? "#F6C453" : index % 2 === 0 ? celebration.accentColor : celebration.primaryColor,
            opacity: value.interpolate({ inputRange: [0, .08, .82, 1], outputRange: [0, 1, 1, 0] }),
            transform: [
              { translateY: value.interpolate({ inputRange: [0, 1], outputRange: [-30, screenHeight * .72] }) },
              { rotate: value.interpolate({ inputRange: [0, 1], outputRange: ["0deg", index % 2 ? "520deg" : "-440deg"] }) },
            ],
          }]} />;
        }) : null}
        <Animated.View accessibilityRole="alert" accessibilityLiveRegion="assertive" style={[styles.card, {
          opacity: entrance,
          transform: [{ scale: entrance.interpolate({ inputRange: [0, 1], outputRange: [reduceMotion ? 1 : .84, 1] }) }],
        }]}>
          <View style={[styles.iconRing, { backgroundColor: celebration.primaryColor }]}>
            <Text style={styles.check}>✓</Text>
          </View>
          <Text style={styles.eyebrow}>{allPaid ? "PAYMENT UPDATE" : "MILESTONE CONFIRMED"}</Text>
          <Text style={styles.title}>{celebration.headline}</Text>
          <Text style={[styles.amount, { color: celebration.primaryColor }]}>{celebration.currency} {Number(celebration.amount || 0).toLocaleString()}</Text>
          <Text style={styles.message}>{celebration.message}</Text>
          {!allPaid ? <View style={styles.notice}><Text style={styles.noticeText}>Eligibility is confirmed. The finance team will process payment manually.</Text></View> : null}
          <Pressable accessibilityRole="button" onPress={onViewRewards} style={[styles.primaryButton, { backgroundColor: celebration.primaryColor }]}><Text style={styles.primaryText}>View my rewards</Text></Pressable>
          <Pressable accessibilityRole="button" onPress={onContinue} style={styles.secondaryButton}><Text style={[styles.secondaryText, { color: celebration.primaryColor }]}>Continue</Text></Pressable>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: "center", justifyContent: "center", padding: 22, backgroundColor: "rgba(4,15,32,.74)" },
  card: { width: "100%", maxWidth: 390, alignItems: "center", borderRadius: 28, backgroundColor: "#FFFFFF", paddingHorizontal: 24, paddingTop: 28, paddingBottom: 20, shadowColor: "#000", shadowOpacity: .25, shadowRadius: 24, shadowOffset: { width: 0, height: 12 }, elevation: 12 },
  iconRing: { width: 68, height: 68, alignItems: "center", justifyContent: "center", borderRadius: 34, borderWidth: 6, borderColor: "#DBEAFE" },
  check: { color: "#FFFFFF", fontSize: 30, lineHeight: 34, fontWeight: "900" },
  eyebrow: { marginTop: 18, color: "#64748B", fontSize: 10, letterSpacing: 1.2, fontWeight: "800" },
  title: { marginTop: 5, color: "#0F172A", textAlign: "center", fontSize: 25, lineHeight: 30, fontWeight: "900" },
  amount: { marginTop: 10, fontSize: 28, lineHeight: 34, fontWeight: "900" },
  message: { marginTop: 10, color: "#475569", textAlign: "center", fontSize: 13, lineHeight: 20 },
  notice: { marginTop: 16, borderRadius: 14, backgroundColor: "#EFF6FF", paddingHorizontal: 13, paddingVertical: 10 },
  noticeText: { color: "#1E40AF", textAlign: "center", fontSize: 11, lineHeight: 16, fontWeight: "600" },
  primaryButton: { width: "100%", minHeight: 48, marginTop: 20, alignItems: "center", justifyContent: "center", borderRadius: 14 },
  primaryText: { color: "#FFFFFF", fontSize: 13, fontWeight: "800" },
  secondaryButton: { minHeight: 44, alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
  secondaryText: { fontSize: 12, fontWeight: "800" },
  confetti: { position: "absolute", top: 0, borderRadius: 2 },
});
