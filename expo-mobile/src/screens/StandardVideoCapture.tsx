import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, AppState, BackHandler, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { CameraView, useCameraPermissions, useMicrophonePermissions } from "expo-camera";
import { useVideoPlayer, VideoView } from "expo-video";
import * as FileSystem from "expo-file-system/legacy";
import { preserveMedia, QueuedMedia } from "../diaryQueue";
import { ScreenDoodleField } from "../components/Doodles";

const LIMIT_SECONDS = 45;

function Playback({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri);
  return <VideoView player={player} style={styles.camera} nativeControls contentFit="contain" />;
}

function Action({ title, onPress, disabled = false, secondary = false }: { title: string; onPress: () => void; disabled?: boolean; secondary?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[styles.action, secondary && styles.actionSecondary, disabled && styles.disabled]}><Text style={styles.actionText}>{title}</Text></Pressable>;
}

export function StandardVideoCaptureScreen({
  respondentId,
  questionId,
  questionText,
  mode,
  onBack,
  onCaptured,
}: {
  respondentId: number;
  questionId: number;
  questionText: string;
  mode: "light" | "dark";
  onBack: () => void;
  onCaptured: (asset: QueuedMedia) => void;
}) {
  const { height } = useWindowDimensions();
  const cameraHeight = Math.max(280, Math.min(430, height * .5));
  const camera = useRef<CameraView>(null);
  const recordingRef = useRef(false);
  const mounted = useRef(true);
  const startedAt = useRef(0);
  const [cameraPermission, requestCamera] = useCameraPermissions();
  const [micPermission, requestMic] = useMicrophonePermissions();
  const [facing, setFacing] = useState<"back" | "front">("back");
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [draft, setDraft] = useState<QueuedMedia | null>(null);
  const [error, setError] = useState("");

  function requestBack() {
    if (recordingRef.current || saving) {
      Alert.alert("Recording in progress", "Stop the recording and wait for the preview before going back.");
      return;
    }
    if (!draft) return onBack();
    Alert.alert("Discard this video?", "The recording has not been attached to your answer yet.", [
      { text: "Keep reviewing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: async () => { await FileSystem.deleteAsync(draft.uri, { idempotent: true }); onBack(); } },
    ]);
  }

  useEffect(() => {
    mounted.current = true;
    const appState = AppState.addEventListener("change", (state) => {
      setForeground(state === "active");
      if (state !== "active" && recordingRef.current) camera.current?.stopRecording();
    });
    const back = BackHandler.addEventListener("hardwareBackPress", () => { requestBack(); return true; });
    return () => {
      mounted.current = false;
      appState.remove();
      back.remove();
      if (recordingRef.current) camera.current?.stopRecording();
    };
  }, [draft, saving]);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setElapsed(Math.min(LIMIT_SECONDS, Math.floor((Date.now() - startedAt.current) / 1000))), 250);
    return () => clearInterval(timer);
  }, [recording]);

  async function record() {
    if (!camera.current || !ready || saving || recordingRef.current) return;
    setError("");
    setElapsed(0);
    startedAt.current = Date.now();
    recordingRef.current = true;
    setRecording(true);
    try {
      const result = await camera.current.recordAsync({ maxDuration: LIMIT_SECONDS, maxFileSize: 45 * 1024 * 1024 });
      if (!result?.uri) throw new Error("The camera did not return a recording.");
      if (mounted.current) setSaving(true);
      const extension = Platform.OS === "ios" ? "mov" : "mp4";
      const asset = await preserveMedia({
        uri: result.uri,
        fileName: `question-${questionId}-${Date.now()}.${extension}`,
        mimeType: Platform.OS === "ios" ? "video/quicktime" : "video/mp4",
        field: String(questionId),
      }, `draft-${respondentId}`);
      if (mounted.current) setDraft(asset);
    } catch (caught: any) {
      if (mounted.current) setError(caught.message || "Could not save this recording.");
    } finally {
      recordingRef.current = false;
      if (mounted.current) { setRecording(false); setSaving(false); }
    }
  }

  async function retake() {
    if (!draft || saving) return;
    await FileSystem.deleteAsync(draft.uri, { idempotent: true });
    setDraft(null);
    setReady(false);
    setElapsed(0);
  }

  function useVideo() {
    if (!draft || saving) return;
    onCaptured(draft);
  }

  const granted = cameraPermission?.granted && micPermission?.granted;
  const dark = mode === "dark";
  return <View style={[styles.page, { backgroundColor: dark ? "#0A1628" : "#FAF9F7" }]}>
    <ScreenDoodleField color={dark ? "#60A5FA" : "#1D4ED8"} withBottom />
    <View style={styles.header}><Pressable accessibilityRole="button" onPress={requestBack}><Text style={[styles.back, { color: dark ? "#B0C8FF" : "#1D4ED8" }]}>‹ Back to question</Text></Pressable><Text style={[styles.eyebrow, { color: dark ? "#B0C8FF" : "#1D4ED8" }]}>VIDEO ANSWER</Text></View>
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={[styles.title, { color: dark ? "#F8FAFC" : "#0F172A" }]}>{draft ? "Review your video" : "Record inside Inicio"}</Text>
      <Text style={[styles.question, { color: dark ? "#DCE7F7" : "#334155" }]}>{questionText}</Text>
      <Text style={[styles.copy, { color: dark ? "#B7C5D9" : "#64748B" }]}>{draft ? "Play it below, record again, or attach it to this question." : "The camera stays inside the diary. Keep the requested evidence visible and record for up to 45 seconds."}</Text>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {draft ? <>
        <View style={[styles.viewfinder, { height: cameraHeight }]}><Playback uri={draft.uri} /></View>
        <Action title="Use this video" onPress={useVideo} disabled={saving} />
        <Action title="Record again" onPress={retake} disabled={saving} secondary />
      </> : Platform.OS === "web" ? <Text style={[styles.copy, { color: dark ? "#B7C5D9" : "#64748B" }]}>Install the Android app to record video evidence.</Text> : !granted ? <View style={[styles.permission, { backgroundColor: dark ? "#182A44" : "#FFFFFF" }]}>
        <Text style={[styles.question, { color: dark ? "#F8FAFC" : "#0F172A" }]}>Camera and microphone access</Text>
        <Text style={[styles.copy, { color: dark ? "#B7C5D9" : "#64748B" }]}>Both are needed to record a video answer with sound.</Text>
        <Action title="Enable camera & microphone" onPress={async () => { try { await requestCamera(); await requestMic(); } catch (caught: any) { setError(caught.message); } }} />
        {cameraPermission?.canAskAgain === false || micPermission?.canAskAgain === false ? <Action title="Open device settings" onPress={() => Linking.openSettings()} secondary /> : null}
      </View> : <>
        <View style={[styles.viewfinder, { height: cameraHeight }]}>
          {foreground ? <CameraView ref={camera} style={styles.camera} facing={facing} mode="video" videoQuality="720p" videoBitrate={2500000} onCameraReady={() => setReady(true)} onMountError={(event) => { setReady(false); setError(event.message); }} /> : <ActivityIndicator style={styles.camera} color="#FFFFFF" />}
          <View style={styles.cameraTop}><Text style={styles.recordingLabel}>{recording ? `● REC · ${elapsed}s / ${LIMIT_SECONDS}s` : "READY"}</Text><Pressable accessibilityRole="button" accessibilityLabel="Flip camera" disabled={recording} onPress={() => { setReady(false); setFacing((value) => value === "back" ? "front" : "back"); }} style={styles.flip}><Text style={styles.flipText}>↻ Flip</Text></Pressable></View>
        </View>
        <Action title={saving ? "Preparing preview…" : recording ? "Stop & review" : "Start recording"} disabled={saving || !ready || !foreground} onPress={recording ? () => camera.current?.stopRecording() : record} />
      </>}
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  header: { paddingHorizontal: 20, paddingVertical: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  back: { fontSize: 14, fontWeight: "800", paddingVertical: 10 },
  eyebrow: { fontSize: 10, letterSpacing: 1.1, fontWeight: "900" },
  content: { paddingHorizontal: 20, paddingBottom: 32, gap: 13 },
  title: { fontSize: 25, lineHeight: 31, fontWeight: "900" },
  question: { fontSize: 15, lineHeight: 21, fontWeight: "800" },
  copy: { fontSize: 13, lineHeight: 19 },
  error: { color: "#D84B5D", fontSize: 13, lineHeight: 19 },
  viewfinder: { width: "100%", borderRadius: 20, overflow: "hidden", backgroundColor: "#101827", borderWidth: 1, borderColor: "#304466" },
  camera: { width: "100%", height: "100%" },
  cameraTop: { position: "absolute", top: 12, left: 12, right: 12, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  recordingLabel: { color: "#FFFFFF", backgroundColor: "rgba(8,18,34,.66)", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, fontSize: 11, fontWeight: "900" },
  flip: { backgroundColor: "rgba(8,18,34,.66)", borderRadius: 999, paddingHorizontal: 11, paddingVertical: 7 },
  flipText: { color: "#FFFFFF", fontSize: 11, fontWeight: "900" },
  action: { minHeight: 50, borderRadius: 14, backgroundColor: "#375BC7", alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
  actionSecondary: { backgroundColor: "#334B70", borderColor: "#496188", borderWidth: 1 },
  actionText: { color: "#FFFFFF", fontSize: 15, fontWeight: "800" },
  disabled: { opacity: .45 },
  permission: { borderRadius: 18, padding: 18, gap: 14 },
});
