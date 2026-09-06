import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, BackHandler, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { useVideoPlayer, VideoView } from 'expo-video';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { packetId, preserveMedia } from '../diaryQueue';

export type VideoScript = { prompts: Array<{ id: string; text: string; hint?: string }>; secondsEach: number; truncated: boolean; totalFillable: number };
export type VideoDraft = { id: string; uri: string; captureTime: string; fileName: string; mimeType: string };
const LIMIT = 90;

function Playback({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri);
  return <VideoView player={player} style={styles.camera} nativeControls contentFit="contain" />;
}
function Button({ title, onPress, disabled = false, secondary = false }: { title: string; onPress: () => void; disabled?: boolean; secondary?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} onPress={onPress} disabled={disabled} style={[styles.button, secondary && styles.secondary, disabled && { opacity: .45 }]}><Text style={styles.buttonText}>{title}</Text></Pressable>;
}

export function VideoDiaryScreen({ respondentId, script, onBack, onSubmit }: { respondentId: number; script: VideoScript; onBack: () => void; onSubmit: (draft: VideoDraft) => Promise<void> }) {
  const camera = useRef<CameraView>(null);
  const recordingRef = useRef(false);
  const mounted = useRef(true);
  const started = useRef(0);
  const [cameraPermission, requestCamera] = useCameraPermissions();
  const [micPermission, requestMic] = useMicrophonePermissions();
  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<VideoDraft | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [index, setIndex] = useState(0);
  const [auto, setAuto] = useState(true);
  const [pace, setPace] = useState(Math.max(5, script.secondsEach));
  const [error, setError] = useState('');
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const draftKey = `inicio.video-draft.v1.${respondentId}`;
  const prompt = script.prompts[index];

  useEffect(() => {
    mounted.current = true;
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(draftKey);
        if (saved) {
          const value: VideoDraft = JSON.parse(saved);
          if ((await FileSystem.getInfoAsync(value.uri)).exists) { if (mounted.current) setDraft(value); }
          else await AsyncStorage.removeItem(draftKey);
        }
      } catch { if (mounted.current) setError('Could not restore your saved recording. Please try reopening Video mode.'); }
      finally { if (mounted.current) setLoading(false); }
    })();
    const subscription = AppState.addEventListener('change', state => {
      setForeground(state === 'active');
      if (state !== 'active' && recordingRef.current) camera.current?.stopRecording();
    });
    return () => { mounted.current = false; subscription.remove(); if (recordingRef.current) camera.current?.stopRecording(); };
  }, [draftKey]);

  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (recordingRef.current || saving) { Alert.alert('Recording in progress', 'Stop the recording and wait for it to save before leaving.'); return true; }
      onBack(); return true;
    });
    return () => back.remove();
  }, [saving, onBack]);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setElapsed(Math.min(LIMIT, Math.floor((Date.now() - started.current) / 1000))), 250);
    return () => clearInterval(timer);
  }, [recording]);
  useEffect(() => {
    if (!recording || !auto) return;
    const timer = setInterval(() => setIndex(value => Math.min(value + 1, script.prompts.length - 1)), pace * 1000);
    return () => clearInterval(timer);
  }, [recording, auto, pace, script.prompts.length, index]);

  async function record() {
    if (!ready || recordingRef.current || saving || !camera.current) return;
    setError(''); setIndex(0); setElapsed(0); started.current = Date.now();
    const captureTime = new Date(started.current).toISOString();
    recordingRef.current = true; setRecording(true);
    try {
      const result = await camera.current.recordAsync({ maxDuration: LIMIT, maxFileSize: 55 * 1024 * 1024 });
      if (!result?.uri) throw new Error('The camera did not return a recording. Please try again.');
      if (mounted.current) setSaving(true);
      const id = packetId();
      const fileName = `diary-${id}.${Platform.OS === 'ios' ? 'mov' : 'mp4'}`;
      const mimeType = Platform.OS === 'ios' ? 'video/quicktime' : 'video/mp4';
      const saved = await preserveMedia({ uri: result.uri, fileName, mimeType, field: 'video' }, `video-draft-${respondentId}`);
      const value = { id, uri: saved.uri, captureTime, fileName, mimeType };
      await AsyncStorage.setItem(draftKey, JSON.stringify(value));
      if (mounted.current) setDraft(value);
    } catch (e: any) { if (mounted.current) setError(e.message || 'Could not save the recording. Please try again.'); }
    finally { recordingRef.current = false; if (mounted.current) { setRecording(false); setSaving(false); } }
  }
  async function submit() {
    if (!draft || saving) return;
    setSaving(true); setError('');
    try {
      await onSubmit(draft); // Resolves only after a durable queue packet exists.
      await AsyncStorage.removeItem(draftKey);
      await FileSystem.deleteAsync(draft.uri, { idempotent: true });
    } catch (e: any) { if (mounted.current) setError(e.message || 'Could not queue your video. Your recording is still saved.'); }
    finally { if (mounted.current) setSaving(false); }
  }
  function retake() {
    Alert.alert('Replace this recording?', 'Your saved recording will be deleted so you can record again.', [{ text: 'Keep recording', style: 'cancel' }, { text: 'Record again', style: 'destructive', onPress: async () => {
      if (!draft) return;
      try { await FileSystem.deleteAsync(draft.uri, { idempotent: true }); await AsyncStorage.removeItem(draftKey); setDraft(null); setReady(false); setIndex(0); setElapsed(0); }
      catch { setError('Could not remove the saved recording. Please try again.'); }
    } }]);
  }
  const granted = cameraPermission?.granted && micPermission?.granted;
  return <View style={styles.page}>
    <View style={styles.header}><Pressable accessibilityRole="button" onPress={onBack} disabled={recording || saving}><Text style={[styles.back, (recording || saving) && { opacity: .4 }]}>‹ Change method</Text></Pressable><Text style={styles.eyebrow}>VIDEO DIARY</Text></View>
    {loading ? <ActivityIndicator color="#9DBBFF" /> : <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.title}>{draft ? 'Review your recording' : 'Your diary, in your words'}</Text>
      <Text style={styles.copy}>{draft ? 'Play your video, record again, or submit. There is no form to fill in afterwards.' : 'Read each prompt near the camera and answer out loud. Keep the product label visible. Up to 90 seconds.'}</Text>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {draft ? <>
        <View style={styles.viewfinder}><Playback uri={draft.uri} /></View>
        <Text style={styles.copy}>Saved on this device. Submission queues the video safely if you are offline.</Text>
        <Button title={saving ? 'Saving…' : 'Submit video'} onPress={submit} disabled={saving} />
        <Button title="Record again" onPress={retake} disabled={saving} secondary />
      </> : Platform.OS === 'web' ? <Text style={styles.copy}>Install the Android app to record with the camera and teleprompter.</Text> : !granted ? <View style={styles.permission}>
        <Text style={styles.promptText}>Camera and microphone access</Text><Text style={styles.copy}>Both are needed to record your video diary with sound.</Text>
        <Button title="Enable camera & microphone" onPress={async () => { try { await requestCamera(); await requestMic(); } catch (e: any) { setError(e.message); } }} />
        {cameraPermission?.canAskAgain === false || micPermission?.canAskAgain === false ? <Button title="Open device settings" onPress={() => { Linking.openSettings(); }} secondary /> : null}
      </View> : <>
        <View style={styles.viewfinder}>
          {foreground ? <CameraView ref={camera} style={styles.camera} facing="front" mode="video" videoQuality="720p" videoBitrate={2500000} onCameraReady={() => setReady(true)} onMountError={e => { setReady(false); setError(e.message); }} /> : null}
          <View style={styles.overlay}>
            <View style={styles.promptHeader}><Text style={styles.eyebrow}>PROMPT {index + 1} / {script.prompts.length}</Text><Text style={styles.clock}>{recording ? '● REC' : 'READY'} · {elapsed}s / {LIMIT}s</Text></View>
            <ScrollView style={styles.promptScroll}><Text style={styles.promptText}>{prompt?.text}</Text>{prompt?.hint ? <Text style={styles.hint}>{prompt.hint}</Text> : null}</ScrollView>
            <View style={styles.promptNav}><Pressable accessibilityRole="button" disabled={index === 0} onPress={() => setIndex(i => Math.max(0, i - 1))}><Text style={[styles.back, index === 0 && { opacity: .4 }]}>‹ Previous</Text></Pressable><Pressable accessibilityRole="button" disabled={index >= script.prompts.length - 1} onPress={() => setIndex(i => Math.min(script.prompts.length - 1, i + 1))}><Text style={[styles.back, index >= script.prompts.length - 1 && { opacity: .4 }]}>Next ›</Text></Pressable></View>
          </View>
        </View>
        <View style={styles.controls}><Pressable accessibilityRole="button" onPress={() => setAuto(value => !value)}><Text style={styles.back}>{auto ? 'Pause auto prompts' : 'Resume auto prompts'}</Text></Pressable><View style={styles.pace}><Pressable accessibilityRole="button" accessibilityLabel="Faster prompts" onPress={() => setPace(p => Math.max(5, p - 5))}><Text style={styles.back}>−</Text></Pressable><Text style={styles.copy}>{pace}s / prompt</Text><Pressable accessibilityRole="button" accessibilityLabel="Slower prompts" onPress={() => setPace(p => Math.min(90, p + 5))}><Text style={styles.back}>+</Text></Pressable></View></View>
        <Text style={styles.copy}>Pausing prompts keeps the camera recording. You can move between prompts yourself.</Text>
        {script.truncated ? <Text style={styles.copy}>Some study questions exceed this recording’s time limit. Cover the prompts shown; the team will review your answers.</Text> : null}
        <Button title={saving ? 'Saving recording…' : recording ? 'Stop & review' : 'Start recording'} disabled={saving || !ready || !foreground} onPress={recording ? () => camera.current?.stopRecording() : record} />
      </>}
    </ScrollView>}
  </View>;
}
const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#0A1628' }, header: { padding: 20, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  content: { paddingHorizontal: 20, paddingBottom: 32, gap: 14 }, title: { color: '#F8FAFC', fontSize: 25, fontWeight: '800' }, copy: { color: '#B7C5D9', fontSize: 13, lineHeight: 20 },
  back: { color: '#B0C8FF', fontSize: 14, fontWeight: '700', paddingVertical: 10, paddingHorizontal: 4 }, eyebrow: { color: '#B0C8FF', fontSize: 10, letterSpacing: 1.1, fontWeight: '800' },
  viewfinder: { height: 440, borderRadius: 22, overflow: 'hidden', backgroundColor: '#14233B', borderColor: '#304466', borderWidth: 1 }, camera: { width: '100%', height: '100%' },
  overlay: { position: 'absolute', top: 12, left: 12, right: 12, padding: 14, borderRadius: 16, backgroundColor: 'rgba(8,18,34,.9)' }, promptHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: 4 },
  clock: { color: '#FFFFFF', fontSize: 10, fontWeight: '800' }, promptScroll: { maxHeight: 150, marginTop: 10 }, promptText: { color: '#FFFFFF', fontSize: 21, lineHeight: 28, fontWeight: '700' }, hint: { color: '#D3DFF0', fontSize: 13, lineHeight: 19, marginTop: 8 },
  promptNav: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }, controls: { gap: 4 }, pace: { flexDirection: 'row', alignItems: 'center', gap: 20 },
  button: { backgroundColor: '#375BC7', minHeight: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center', padding: 14 }, secondary: { backgroundColor: '#1C2D48', borderColor: '#496188', borderWidth: 1 }, buttonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  permission: { padding: 22, borderRadius: 20, backgroundColor: '#182A44', gap: 18 }, error: { color: '#FFB5B5', fontSize: 13, lineHeight: 20 },
});
