import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, BackHandler, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { useVideoPlayer, VideoView } from 'expo-video';
import { File as ExpoFile } from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { ScreenDoodleField } from '../components/Doodles';
import { packetId, preserveMedia } from '../diaryQueue';
import { api } from '../api';

export type VideoScript = { prompts: Array<{ id: string; text: string; hint?: string }>; secondsEach: number; truncated: boolean; totalFillable: number };
export type VideoDraft = { id: string; uri: string; captureTime: string; fileName: string; mimeType: string };
type VideoAnalysis = {
  transcriptStatus: 'processing' | 'done' | 'unavailable' | 'error' | 'pending';
  transcriptText?: string | null;
  scoreStatus?: 'processing' | 'done' | 'unavailable' | 'error';
  score?: number | null;
  scoreRationale?: string | null;
  detectionStatus?: 'processing' | 'done' | 'needs_review' | 'unavailable' | 'error' | 'pending';
  detectedBrand?: string | null;
  detectedCategory?: string | null;
  detectionConfidence?: number | null;
};
const LIMIT = 90;

function Playback({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri);
  return <VideoView player={player} style={styles.camera} nativeControls contentFit="contain" />;
}
function Button({ title, onPress, disabled = false, secondary = false }: { title: string; onPress: () => void; disabled?: boolean; secondary?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} onPress={onPress} disabled={disabled} style={[styles.button, secondary && styles.secondary, disabled && { opacity: .45 }]}><Text style={styles.buttonText}>{title}</Text></Pressable>;
}
function AnalysisCard({ analysis, styles }: { analysis: VideoAnalysis; styles: ReturnType<typeof videoStyles> }) {
  return <View style={styles.analysisCard}>
    <Text style={styles.analysisTitle}>Instant transcript</Text>
    {analysis.transcriptStatus === 'processing' ? <View style={styles.analysisBusy}><ActivityIndicator size="small" color="#9DBBFF" /><Text style={styles.copy}>Transcribing and scoring…</Text></View> : null}
    {analysis.transcriptStatus === 'done' ? <Text style={styles.analysisBody}>{analysis.transcriptText}</Text> : null}
    {analysis.transcriptStatus === 'pending' ? <Text style={styles.copy}>Offline preview only. Transcription and scoring will run when this entry syncs.</Text> : null}
    {analysis.transcriptStatus === 'unavailable' ? <Text style={styles.copy}>Transcription unavailable. The recording is still saved and playable.</Text> : null}
    {analysis.transcriptStatus === 'error' ? <Text style={styles.copy}>The recording could not be transcribed. Record again or submit it for retry.</Text> : null}
    {analysis.transcriptStatus === 'done' && analysis.scoreStatus === 'done' ? <View style={styles.analysisPillRow}><View style={styles.analysisPill}><Text style={styles.analysisPillText}>{analysis.score}/100</Text></View><View style={{ flex: 1 }}><Text style={styles.analysisSubtitle}>AI response-quality score</Text><Text style={styles.copy}>{analysis.scoreRationale}</Text></View></View> : null}
    {analysis.transcriptStatus === 'done' && analysis.scoreStatus !== 'done' ? <Text style={styles.copy}>AI score unavailable. This does not affect the saved transcript.</Text> : null}
    <Text style={[styles.analysisTitle, { marginTop: 8 }]}>Brand & category detection</Text>
    {analysis.detectionStatus === 'processing' ? <View style={styles.analysisBusy}><ActivityIndicator size="small" color="#9DBBFF" /><Text style={styles.copy}>Looking for a brand…</Text></View> : null}
    {(analysis.detectionStatus === 'done' || analysis.detectionStatus === 'needs_review') && analysis.detectedBrand ? <View style={styles.analysisPillRow}><View style={styles.analysisPill}><Text style={styles.analysisPillText}>{analysis.detectedBrand}</Text></View><View style={{ flex: 1 }}><Text style={styles.analysisSubtitle}>{analysis.detectionStatus === 'done' ? 'Brand detected' : 'Possible brand match'}{analysis.detectedCategory ? ` · ${analysis.detectedCategory}` : ''}</Text><Text style={styles.copy}>{analysis.detectionConfidence != null ? `${Math.round(analysis.detectionConfidence * 100)}% confidence` : 'Pending confirmation'}</Text></View></View> : null}
    {analysis.detectionStatus === 'pending' ? <Text style={styles.copy}>Offline preview only. Brand detection will run when this entry syncs.</Text> : null}
    {analysis.detectionStatus === 'unavailable' ? <Text style={styles.copy}>No brand was identified. The video is still saved.</Text> : null}
    {analysis.detectionStatus === 'error' ? <Text style={styles.copy}>Brand detection failed. Record again or submit it for retry.</Text> : null}
  </View>;
}

export function VideoDiaryScreen({ respondentId, script, onBack, onSubmit, mode = 'light' }: { mode?: 'light' | 'dark'; respondentId: number; script: VideoScript; onBack: () => void; onSubmit: (draft: VideoDraft) => Promise<void> }) {
  const {height} = useWindowDimensions();
  const styles = videoStyles(mode, Math.max(240, Math.min(360, height * .42)));
  const camera = useRef<CameraView>(null);
  const recordingRef = useRef(false);
  const mounted = useRef(true);
  const started = useRef(0);
  const [cameraPermission, requestCamera] = useCameraPermissions();
  const [micPermission, requestMic] = useMicrophonePermissions();
  const [facing, setFacing] = useState<'front' | 'back'>('front');
  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<VideoDraft | null>(null);
  const [analysis, setAnalysis] = useState<VideoAnalysis | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [index, setIndex] = useState(0);
  const [auto, setAuto] = useState(true);
  const [pace, setPace] = useState(4);
  const [showPromptSettings, setShowPromptSettings] = useState(false);
  const [error, setError] = useState('');
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const draftKey = `inicio.video-draft.v1.${respondentId}`;

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
    if (!draft) return;
    setAnalysis({ transcriptStatus: 'processing', scoreStatus: 'processing', detectionStatus: 'processing' });
    (async () => {
      try {
        const form = new FormData();
        form.append('video', new ExpoFile(draft.uri));
        const result = await api.videoPreview(respondentId, form);
        if (mounted.current) setAnalysis(result);
      } catch (e: any) {
        const offline = !e.status;
        if (mounted.current) setAnalysis({
          transcriptStatus: offline ? 'pending' : 'error',
          scoreStatus: 'unavailable',
          detectionStatus: offline ? 'pending' : 'error',
          scoreRationale: offline ? 'Waiting for a connection.' : (e.message || 'Analysis failed.'),
        });
      }
    })();
  }, [draft, respondentId]);

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
      try { await FileSystem.deleteAsync(draft.uri, { idempotent: true }); await AsyncStorage.removeItem(draftKey); setDraft(null); setAnalysis(null); setReady(false); setIndex(0); setElapsed(0); }
      catch { setError('Could not remove the saved recording. Please try again.'); }
    } }]);
  }
  const granted = cameraPermission?.granted && micPermission?.granted;
  return <View style={styles.page}>
    <ScreenDoodleField color={mode==='dark'?'#60A5FA':'#1D4ED8'} withBottom /><View style={styles.header}><Pressable accessibilityRole="button" onPress={onBack} disabled={recording || saving}><Text style={[styles.back, (recording || saving) && { opacity: .4 }]}>‹ Change method</Text></Pressable><Text style={styles.eyebrow}>VIDEO DIARY</Text></View>
    {loading ? <ActivityIndicator color="#9DBBFF" /> : <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.title}>{draft ? 'Review your recording' : 'Your diary, in your words'}</Text>
      <Text style={styles.copy}>{draft ? 'Play your video, record again, or submit. There is no form to fill in afterwards.' : 'Read each prompt near the camera and answer out loud. Keep the product label visible. Up to 90 seconds.'}</Text>
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      {draft ? <>
        <View style={styles.viewfinder}><Playback uri={draft.uri} /></View>
        <Text style={styles.copy}>Saved on this device. Submission queues the video safely if you are offline.</Text>
        {analysis ? <AnalysisCard analysis={analysis} styles={styles} /> : null}
        <Button title={saving ? 'Saving…' : 'Submit video'} onPress={submit} disabled={saving} />
        <Button title="Record again" onPress={retake} disabled={saving} secondary />
      </> : Platform.OS === 'web' ? <Text style={styles.copy}>Install the Android app to record with the camera and teleprompter.</Text> : !granted ? <View style={styles.permission}>
        <Text style={styles.promptText}>Camera and microphone access</Text><Text style={styles.copy}>Both are needed to record your video diary with sound.</Text>
        <Button title="Enable camera & microphone" onPress={async () => { try { await requestCamera(); await requestMic(); } catch (e: any) { setError(e.message); } }} />
        {cameraPermission?.canAskAgain === false || micPermission?.canAskAgain === false ? <Button title="Open device settings" onPress={() => { Linking.openSettings(); }} secondary /> : null}
      </View> : <>
        <View style={styles.viewfinder}>
          {foreground ? <CameraView ref={camera} style={styles.camera} facing={facing} mode="video" videoQuality="720p" videoBitrate={2500000} onCameraReady={() => setReady(true)} onMountError={e => { setReady(false); setError(e.message); }} /> : null}
          <View style={styles.overlay}>
            <View style={styles.promptHeader}><Text style={styles.eyebrow}>PROMPT {index + 1} / {script.prompts.length}</Text><Pressable accessibilityRole="button" accessibilityLabel="Flip camera" disabled={recording} onPress={() => { setReady(false); setFacing(value => value === 'front' ? 'back' : 'front'); }} style={[styles.flip, recording && { opacity: .4 }]}><Text style={styles.flipText}>↻ Flip</Text></Pressable><Text style={styles.clock}>{recording ? '● REC' : 'READY'} · {elapsed}s / {LIMIT}s</Text></View>
            <ScrollView style={styles.promptScroll}>
              {script.prompts.map((item, i) => <Pressable key={item.id} accessibilityRole="button" onPress={() => setIndex(i)} style={styles.promptItem}>
                <Text style={i === index ? styles.promptItemActive : styles.promptItemText}>{i + 1}. {item.text}</Text>
                {i === index && item.hint ? <Text style={styles.hint}>{item.hint}</Text> : null}
              </Pressable>)}
            </ScrollView>
          </View>
        </View>
        <View style={styles.controls}>
          <Pressable accessibilityRole="button" onPress={() => setShowPromptSettings(value => !value)}><Text style={styles.back}>{showPromptSettings ? 'Hide auto-advance settings' : 'Auto-advance settings'}</Text></Pressable>
          {showPromptSettings ? <>
            <Pressable accessibilityRole="button" onPress={() => setAuto(value => !value)}><Text style={styles.back}>{auto ? 'Pause auto prompts' : 'Resume auto prompts'}</Text></Pressable>
            <View style={styles.pace}><Pressable accessibilityRole="button" accessibilityLabel="Faster prompts" onPress={() => setPace(p => Math.max(3, p - 1))}><Text style={styles.back}>−</Text></Pressable><Text style={styles.copy}>{pace}s / prompt</Text><Pressable accessibilityRole="button" accessibilityLabel="Slower prompts" onPress={() => setPace(p => Math.min(90, p + 1))}><Text style={styles.back}>+</Text></Pressable></View>
            <Text style={styles.copy}>Pausing prompts keeps the camera recording. You can move between prompts yourself.</Text>
          </> : null}
        </View>
        {script.truncated ? <Text style={styles.copy}>Some study questions exceed this recording’s time limit. Cover the prompts shown; the team will review your answers.</Text> : null}

      </>}
    </ScrollView>}
    {!loading&&!draft&&granted&&Platform.OS!=='web'?<View style={styles.footer}><Button title={saving ? 'Saving recording…' : recording ? 'Stop & review' : 'Start recording'} disabled={saving || !ready || !foreground} onPress={recording ? () => camera.current?.stopRecording() : record} /></View>:null}
  </View>;
}
const styles = videoStyles('light', 300);
function videoStyles(mode: 'light' | 'dark', cameraHeight: number) {
const dark=mode==='dark';
return StyleSheet.create({
  page: { flex: 1, backgroundColor: dark?'#0A1628':'#FAF9F7' }, header: { padding: 20, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  footer: {paddingHorizontal:20,paddingVertical:12,borderTopWidth:1,borderColor:dark?'#304466':'#E2E8F0',backgroundColor:dark?'#0A1628':'#FAF9F7'},
  content: { paddingHorizontal: 20, paddingBottom: 32, gap: 14 }, title: { color: dark?'#F8FAFC':'#0F172A', fontSize: 25, fontWeight: '800' }, copy: { color: dark?'#B7C5D9':'#64748B', fontSize: 13, lineHeight: 20 },
  back: { color: dark?'#B0C8FF':'#1D4ED8', fontSize: 14, fontWeight: '700', paddingVertical: 10, paddingHorizontal: 4 }, eyebrow: { color: dark?'#B0C8FF':'#1D4ED8', fontSize: 10, letterSpacing: 1.1, fontWeight: '800' },
  viewfinder: { height: cameraHeight, borderRadius: 22, overflow: 'hidden', backgroundColor: '#14233B', borderColor: '#304466', borderWidth: 1 }, camera: { width: '100%', height: '100%' },
  overlay: { position: 'absolute', top: 12, left: 12, right: 12, padding: 14, borderRadius: 16, backgroundColor: dark?'rgba(8,18,34,.44)':'rgba(255,255,255,.46)' }, promptHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: 4 },
  clock: { color: dark?'#FFFFFF':'#334155', fontSize: 10, fontWeight: '800' }, promptScroll: { maxHeight: Math.max(120, Math.min(230, cameraHeight - 70)), marginTop: 10 },
  flip: { backgroundColor: 'rgba(8,18,34,.5)', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 }, flipText: { color: '#FFFFFF', fontSize: 10, fontWeight: '800' },
  promptText: { color: dark?'#FFFFFF':'#0F172A', fontSize: 21, lineHeight: 28, fontWeight: '700' },
  promptItem: { paddingVertical: 6 }, promptItemActive: { color: dark?'#FFFFFF':'#0F172A', fontSize: 19, lineHeight: 25, fontWeight: '700' }, promptItemText: { color: dark?'#C3D2E6':'#64748B', fontSize: 14, lineHeight: 20, fontWeight: '600' },
  hint: { color: dark?'#D3DFF0':'#64748B', fontSize: 13, lineHeight: 19, marginTop: 4 },
  controls: { gap: 4 }, pace: { flexDirection: 'row', alignItems: 'center', gap: 20 },
  button: { backgroundColor: '#375BC7', minHeight: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center', padding: 14 }, secondary: { backgroundColor: '#334B70', borderColor: '#496188', borderWidth: 1 }, buttonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  permission: { padding: 22, borderRadius: 20, backgroundColor: dark?'#182A44':'#FFFFFF', gap: 18 }, error: { color: dark?'#FFB5B5':'#B42318', fontSize: 13, lineHeight: 20 },
  analysisCard: { padding: 16, borderRadius: 16, backgroundColor: dark?'#132544':'#F1F5F9', borderColor: dark?'#304466':'#E2E8F0', borderWidth: 1, gap: 8 },
  analysisTitle: { color: dark?'#F8FAFC':'#0F172A', fontWeight: '900', fontSize: 12 },
  analysisSubtitle: { color: dark?'#F8FAFC':'#0F172A', fontWeight: '800', fontSize: 12 },
  analysisBusy: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  analysisBody: { color: dark?'#DCE7F7':'#334155', fontSize: 13, lineHeight: 19 },
  analysisPillRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  analysisPill: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, backgroundColor: dark?'#1E3A72':'#DBEAFE' },
  analysisPillText: { color: dark?'#9DBBFF':'#1D4ED8', fontWeight: '900' },
});
}
