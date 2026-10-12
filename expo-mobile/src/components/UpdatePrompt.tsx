import React, { useEffect, useState } from "react";
import { AppState, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useColorScheme } from "nativewind";
import { AvailableUpdate, checkForUpdate, installUpdate, snoozeUpdate } from "../appUpdate";

// Checks on launch and whenever the app returns to the foreground.
export function UpdatePrompt() {
  const { colorScheme } = useColorScheme();
  const dark = colorScheme === "dark";
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);

  useEffect(() => {
    let active = true;
    const check = () => checkForUpdate().then(found => { if (active) setUpdate(found); });
    check();
    const sub = AppState.addEventListener("change", state => { if (state === "active") check(); });
    return () => { active = false; sub.remove(); };
  }, []);

  async function later() {
    if (update) await snoozeUpdate(update);
    setUpdate(null);
  }

  const card = dark ? "#11213A" : "#FFFFFF";
  const text = dark ? "#F1F5FB" : "#12213A";
  const muted = dark ? "#9AA9BF" : "#6F7F95";
  const border = dark ? "#22395C" : "#DFE7F1";
  const size = update?.bytes ? ` (${Math.round(update.bytes / 1048576)} MB)` : "";

  return (
    <Modal visible={!!update} transparent animationType="fade" onRequestClose={later}>
      <View style={styles.backdrop}>
        <View style={[styles.card, { backgroundColor: card, borderColor: border }]}>
          <Text style={[styles.title, { color: text }]}>Update available</Text>
          <Text style={[styles.message, { color: muted }]}>
            A new version of INICIO Diary{update?.version ? ` (${update.version})` : ""} is ready{size}. Download it, then open the file and tap Update. Your
            login and saved entries stay on this phone.
          </Text>
          <Pressable onPress={() => { installUpdate(); setUpdate(null); }} style={styles.primary}>
            <Text style={styles.primaryText}>Update now</Text>
          </Pressable>
          <Pressable onPress={later} style={styles.secondary}>
            <Text style={{ color: muted, fontWeight: "700", fontSize: 13 }}>Later</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(15,23,42,0.55)", alignItems: "center", justifyContent: "center", padding: 24 },
  card: { width: "100%", maxWidth: 340, borderWidth: 1, borderRadius: 20, padding: 22, alignItems: "center" },
  title: { fontSize: 17, fontWeight: "900", textAlign: "center" },
  message: { fontSize: 13, lineHeight: 19, textAlign: "center", marginTop: 6 },
  primary: { marginTop: 18, width: "100%", backgroundColor: "#1769FF", borderRadius: 14, paddingVertical: 13, alignItems: "center" },
  primaryText: { color: "#FFFFFF", fontWeight: "800", fontSize: 15 },
  secondary: { marginTop: 10, paddingVertical: 6, paddingHorizontal: 16 },
});
