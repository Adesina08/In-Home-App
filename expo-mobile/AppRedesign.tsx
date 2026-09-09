import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  ActivityIndicator,
  Alert,
  BackHandler,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import {
  useAudioRecorder,
  useAudioPlayer,
  useAudioPlayerStatus,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from "expo-audio";
import { File as ExpoFile } from "expo-file-system";
import { useVideoPlayer, VideoView } from "expo-video";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as LocalAuthentication from "expo-local-authentication";
import { useColorScheme } from "nativewind";
import { api, API_BASE, clearRememberedSession, extendRememberedSession, getRememberedSession, getToken, MobileEnrolment, setToken } from "./src/api";
import { VideoDiaryScreen, VideoDraft } from "./src/screens/VideoDiary";
import { StandardVideoCaptureScreen } from "./src/screens/StandardVideoCapture";
import { HomeScreen, DisplayRecord } from "./src/screens/Home";
import { EntriesScreen } from "./src/screens/Entries";
import { ActivityScreen } from "./src/screens/Activity";
import { ProfileScreen } from "./src/screens/Profile";
import { LoginDoodleField, ScreenDoodleField } from "./src/components/Doodles";
import { Icon as LineIcon } from "./src/icons";
import { LogoLoader } from "./src/components/LogoLoader";

import { enqueue, listQueue, syncQueue, removeQueued, packetId, preserveMedia, DiaryPacket } from "./src/diaryQueue";

type ThemeMode = "dark" | "light";
type Screen =
  | "participation"
  | "rewards"
  | "sync"
  | "loading"
  | "login"
  | "forgotPassword"
  | "verifyLoginCode"
  | "setNewPassword"
  | "profileGate"
  | "studies"
  | "home"
  | "entries"
  | "activity"
  | "profile"
  | "diaryMode"
  | "diary"
  | "diaryQuestionVideo"
  | "diaryVideo"
  | "diaryVideoDone";
type AnswerMap = Record<string, string | string[]>;
type OtherTextMap = Record<string, Record<string, string>>;
type MediaAsset = { uri: string; fileName?: string | null; mimeType?: string | null };
type MediaMap = Record<string, MediaAsset>;
type MediaAnalysis = {
  transcriptStatus: "processing" | "done" | "unavailable" | "error" | "pending";
  transcriptText?: string | null;
  scoreStatus?: "processing" | "done" | "unavailable" | "error";
  score?: number | null;
  scoreRationale?: string | null;
};
type MediaAnalysisMap = Record<string, MediaAnalysis>;
type ProfileForm = {
  name: string;
  location: string;
  age: string;
  gender: string;
  education_level: string;
  occupation: string;
  religion: string;
  marital_status: string;
  recontact_consent: string;
};

type Theme = {
  bg: string;
  bg2: string;
  card: string;
  card2: string;
  text: string;
  muted: string;
  subtle: string;
  border: string;
  borderStrong: string;
  blue: string;
  blueDark: string;
  blueSoft: string;
  green: string;
  greenSoft: string;
  amber: string;
  amberSoft: string;
  purple: string;
  purpleSoft: string;
  red: string;
  nav: string;
  white: string;
};

const DARK: Theme = {
  bg: "#091426",
  bg2: "#0A1527",
  card: "#0F1F38",
  card2: "#102541",
  text: "#FEFEFE",
  muted: "#9EA9BA",
  subtle: "#6F7D91",
  border: "#173757",
  borderStrong: "#1B4268",
  blue: "#1C4ED8",
  blueDark: "#163EB1",
  blueSoft: "#102C68",
  green: "#18C58C",
  greenSoft: "#073B3A",
  amber: "#F4B229",
  amberSoft: "#392D1D",
  purple: "#B187FF",
  purpleSoft: "#2B2154",
  red: "#EA5A65",
  nav: "#0D213C",
  white: "#FFFFFF",
};

const LIGHT: Theme = {
  bg: "#F9F8F6",
  bg2: "#FAF9F7",
  card: "#FEFEFE",
  card2: "#FFFFFF",
  text: "#091426",
  muted: "#768294",
  subtle: "#9AA4B3",
  border: "#E4E6EA",
  borderStrong: "#D7DBE2",
  blue: "#1C4ED8",
  blueDark: "#173FB4",
  blueSoft: "#EEF3FF",
  green: "#179C6B",
  greenSoft: "#EAF8F2",
  amber: "#B66A00",
  amberSoft: "#FFF7E8",
  purple: "#7B52D8",
  purpleSoft: "#F4EFFF",
  red: "#D84B5D",
  nav: "#FFFFFF",
  white: "#FFFFFF",
};

const EMPTY_PROFILE: ProfileForm = {
  name: "",
  location: "",
  age: "",
  gender: "",
  education_level: "",
  occupation: "",
  religion: "",
  marital_status: "",
  recontact_consent: "",
};

const GENDERS = [
  ["male", "Male"],
  ["female", "Female"],
  ["other", "Other"],
  ["prefer_not_to_say", "Prefer not to say"],
];
const EDUCATION = [
  ["no_formal_schooling", "No formal schooling"],
  ["primary", "Primary"],
  ["secondary", "Secondary"],
  ["vocational_technical", "Vocational / technical"],
  ["tertiary_university", "Tertiary / university"],
  ["postgraduate", "Postgraduate"],
  ["other", "Other"],
  ["prefer_not_to_say", "Prefer not to say"],
];
const MARITAL = [
  ["single", "Single"],
  ["married", "Married"],
  ["living_with_partner", "Living with partner"],
  ["separated", "Separated"],
  ["divorced", "Divorced"],
  ["widowed", "Widowed"],
  ["other", "Other"],
  ["prefer_not_to_say", "Prefer not to say"],
];

const THEME_KEY = "inicio.theme";

function ruleMatches(rule: any, answers: AnswerMap) {
  const raw = answers[String(rule.conditionQuestionId)];
  const actual = Array.isArray(raw) ? raw.join("|") : String(raw ?? "");
  const expected = String(rule.value ?? "");
  if (rule.operator === "equals") return actual === expected;
  if (rule.operator === "not_equals") return actual !== expected;
  if (rule.operator === "includes") return actual.split("|").includes(expected);
  if (rule.operator === "in") return expected.split("|").includes(actual);
  if (rule.operator === "not_in") return !expected.split("|").includes(actual);
  return false;
}

function isVisible(questionId: number, rules: any[], answers: AnswerMap) {
  const targetRules = rules.filter((r) => r.targetQuestionId === questionId);
  if (!targetRules.length) return true;
  let visible = true;
  for (const r of targetRules) {
    const match = ruleMatches(r, answers);
    if (r.action === "show") visible = match;
    if (r.action === "hide" && match) visible = false;
  }
  return visible;
}

function formatTime(value?: string | null) {
  if (!value) return "";
  const d = new Date(String(value).replace(" ", "T") + (String(value).includes("Z") ? "" : "Z"));
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
}

function dayLabel(value?: string | null) {
  if (!value) return "";
  const d = new Date(String(value).replace(" ", "T") + (String(value).includes("Z") ? "" : "Z"));
  if (Number.isNaN(d.getTime())) return String(value);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dd = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((start.getTime() - dd.getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short" });
}

function firstName(name?: string | null) {
  return String(name || "").trim().split(/\s+/)[0] || "there";
}

function Icon({ glyph, t, tone = "blue", size = 18 }: { glyph: string; t: Theme; tone?: "blue" | "green" | "amber" | "purple" | "muted"; size?: number }) {
  const foreground = tone === "green" ? t.green : tone === "amber" ? t.amber : tone === "purple" ? t.purple : tone === "muted" ? t.muted : "#5B91FF";
  const background = tone === "green" ? t.greenSoft : tone === "amber" ? t.amberSoft : tone === "purple" ? t.purpleSoft : tone === "muted" ? t.card2 : t.blueSoft;
  return <View style={{ width: 36, height: 36, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: background }}><Text style={{ color: foreground, fontSize: size, fontWeight: "800" }}>{glyph}</Text></View>;
}

function BookMark({ t, large = false }: { t: Theme; large?: boolean }) {
  return (
    <View style={[styles.bookMark, { backgroundColor: t.blueSoft }, large && { width: 72, height: 72, borderRadius: 20 }]}>
      <Image source={require("./assets/logo.png")} style={large ? { width: 46, height: 46 } : { width: 20, height: 20 }} resizeMode="contain" />
    </View>
  );
}

function PrimaryButton({ title, onPress, disabled = false, t, inverse = false, arrow = true }: any) {
  const backgroundColor = inverse ? t.card2 : t.blue;
  const borderColor = inverse ? t.borderStrong : t.blueDark;
  return (
    <View style={[styles.primaryButtonShell, { backgroundColor, borderColor }, disabled && styles.primaryButtonDisabled]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => [styles.primaryButton, pressed && !disabled && styles.primaryButtonPressed]}
      >
        <Text style={[styles.primaryButtonText, { color: inverse ? t.blue : t.white }]}>{title}</Text>
        {arrow ? <Text style={[styles.buttonArrow, { color: inverse ? t.blue : t.white }]}>→</Text> : null}
      </Pressable>
    </View>
  );
}

function secondsLabel(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "";
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function AudioEvidencePreview({ asset, t }: { asset: MediaAsset; t: Theme }) {
  const player = useAudioPlayer({ uri: asset.uri });
  const status = useAudioPlayerStatus(player);
  const toggle = async () => {
    if (status.playing) return player.pause();
    if (status.duration && status.currentTime >= status.duration - .1) await player.seekTo(0);
    player.play();
  };
  return <Pressable accessibilityRole="button" accessibilityLabel={status.playing ? "Pause audio preview" : "Play audio preview"} onPress={toggle} style={[styles.audioPreview, { backgroundColor: t.card2, borderColor: t.border }]}><View style={[styles.previewPlay, { backgroundColor: t.blue }]}><Text style={{ color: t.white, fontWeight: "900" }}>{status.playing ? "Ⅱ" : "▶"}</Text></View><View style={{ flex: 1 }}><Text style={{ color: t.text, fontWeight: "800", fontSize: 13 }}>{status.playing ? "Playing voice note" : "Play voice note"}</Text><Text style={[styles.smallMuted, { color: t.muted }]}>{secondsLabel(status.currentTime)}{status.duration ? ` / ${secondsLabel(status.duration)}` : ""}</Text></View></Pressable>;
}

function VideoEvidencePreview({ asset }: { asset: MediaAsset }) {
  const player = useVideoPlayer(asset.uri);
  return <VideoView player={player} style={styles.videoPreview} nativeControls contentFit="contain" />;
}

function CapturedEvidence({ type, asset, analysis, t }: { type: "photo" | "video" | "audio"; asset: MediaAsset; analysis?: MediaAnalysis; t: Theme }) {
  return <View style={[styles.mediaPreviewCard, { backgroundColor: t.card, borderColor: t.border }]}>
    {type === "photo" ? <Image source={{ uri: asset.uri }} style={styles.photoPreview} resizeMode="contain" accessibilityLabel="Captured photo preview" /> : null}
    {type === "video" ? <VideoEvidencePreview asset={asset} /> : null}
    {type === "audio" ? <AudioEvidencePreview asset={asset} t={t} /> : null}
    <View style={styles.previewStatusRow}><Text style={{ color: t.green, fontSize: 11, fontWeight: "800" }}>✓ Preview ready</Text><Text style={{ color: t.muted, fontSize: 11 }}>Capture again to replace</Text></View>
    {type !== "photo" && analysis ? <View style={[styles.transcriptCard, { backgroundColor: t.bg2, borderColor: t.border }]}>
      <Text style={{ color: t.text, fontWeight: "900", fontSize: 12 }}>Instant transcript</Text>
      {analysis.transcriptStatus === "processing" ? <View style={styles.analysisBusy}><ActivityIndicator size="small" color={t.blue} /><Text style={[styles.smallMuted, { color: t.muted }]}>Transcribing and scoring…</Text></View> : null}
      {analysis.transcriptStatus === "done" ? <Text style={{ color: t.text, fontSize: 13, lineHeight: 19 }}>{analysis.transcriptText}</Text> : null}
      {analysis.transcriptStatus === "pending" ? <Text style={[styles.smallMuted, { color: t.amber }]}>Offline preview only. Transcription and scoring will run when this entry syncs.</Text> : null}
      {analysis.transcriptStatus === "unavailable" ? <Text style={[styles.smallMuted, { color: t.muted }]}>Transcription unavailable. The recording is still saved and playable.</Text> : null}
      {analysis.transcriptStatus === "error" ? <Text style={[styles.smallMuted, { color: t.red }]}>The recording could not be transcribed. Capture it again or submit it for retry.</Text> : null}
      {analysis.transcriptStatus === "done" && analysis.scoreStatus === "done" ? <View style={styles.scoreRow}><View style={[styles.scorePill, { backgroundColor: t.blueSoft }]}><Text style={{ color: t.blue, fontWeight: "900" }}>{analysis.score}/100</Text></View><View style={{ flex: 1 }}><Text style={{ color: t.text, fontWeight: "800", fontSize: 12 }}>AI response-quality score</Text><Text style={[styles.smallMuted, { color: t.muted }]}>{analysis.scoreRationale}</Text></View></View> : null}
      {analysis.transcriptStatus === "done" && analysis.scoreStatus !== "done" ? <Text style={[styles.smallMuted, { color: t.muted }]}>AI score unavailable. This does not affect the saved transcript.</Text> : null}
    </View> : null}
  </View>;
}

function OutlineButton({ title, onPress, t }: any) {
  return <Pressable onPress={onPress} style={({ pressed }) => [styles.outlineButton, { borderColor: t.borderStrong, backgroundColor: t.card2 }, pressed && { opacity: .8 }]}><Text style={[styles.outlineButtonText, { color: t.text }]}>{title}</Text></Pressable>;
}

function AppFrame({ children, t, mode }: { children: React.ReactNode; t: Theme; mode: ThemeMode }) {
  return <View style={[styles.root, { backgroundColor: t.bg }]}><ScreenDoodleField color={t.blue} withBottom />{children}</View>;
}

function Brand({ t }: { t: Theme }) {
  return <View style={styles.brandRow}><Image source={require("./assets/logo.png")} style={{width:32,height:24}} resizeMode="contain" accessibilityLabel="Inicio logo" /><Text style={[styles.brandName, { color: t.text }]}>Inicio Diary</Text></View>;
}

function Card({ children, t, style }: { children: React.ReactNode; t: Theme; style?: any }) {
  return <View style={[styles.card, { backgroundColor: t.card, borderColor: t.border }, style]}>{children}</View>;
}

function SectionTitle({ children, t, action }: { children: React.ReactNode; t: Theme; action?: React.ReactNode }) {
  return <View style={styles.sectionHeading}><Text style={[styles.sectionTitle, { color: t.text }]}>{children}</Text>{action}</View>;
}

function StatusPill({ status, t }: { status: string; t: Theme }) {
  const s = String(status || "").toLowerCase();
  const green = s === "submitted" || s === "active" || s === "activated" || s === "live";
  const amber = s.includes("check") || s.includes("consent") || s.includes("review");
  const bg = green ? t.greenSoft : amber ? t.amberSoft : t.blueSoft;
  const fg = green ? t.green : amber ? t.amber : "#71A1FF";
  return <View style={[styles.pill, { backgroundColor: bg }]}><Text style={[styles.pillText, { color: fg }]}>{String(status || "").toUpperCase()}</Text></View>;
}

function ChoiceList({ options, value, onChange, t }: { options: string[][]; value: string; onChange: (v: string) => void; t: Theme }) {
  return <View style={{ gap: 8 }}>{options.map(([key, label]) => { const active = value === key; return <Pressable key={key} onPress={() => onChange(key)} style={[styles.choiceRow, { borderColor: active ? t.blue : t.border, backgroundColor: active ? t.blueSoft : t.card2 }]}><View style={[styles.radio, { borderColor: active ? t.blue : t.muted }, active && { borderWidth: 5 }]} /><Text style={[styles.choiceText, { color: t.text }]}>{label}</Text></Pressable>; })}</View>;
}

function FieldError({ message, t }: { message?: string; t: Theme }) { return message ? <Text style={{ color: t.red, fontSize: 12, marginTop: 4 }}>{message}</Text> : null; }

export default function App({ onSwitchToInterviewer }: { onSwitchToInterviewer: () => void }) {
  const [screen, setScreen] = useState<Screen>("loading");
  const [mode, setMode] = useState<ThemeMode>("light");
  const { setColorScheme: setNativeWindScheme } = useColorScheme();
  const t = mode === "dark" ? DARK : LIGHT;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [recoveryContact, setRecoveryContact] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [resetToken, setResetToken] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [enrolments, setEnrolments] = useState<MobileEnrolment[]>([]);
  const [selected, setSelected] = useState<MobileEnrolment | null>(null);
  const [home, setHome] = useState<any>(null);
  const [questionnaire, setQuestionnaire] = useState<any>(null);
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [otherText, setOtherText] = useState<OtherTextMap>({});
  const [media, setMedia] = useState<MediaMap>({});
  const [mediaAnalysis, setMediaAnalysis] = useState<MediaAnalysisMap>({});
  const [recordingQuestionId, setRecordingQuestionId] = useState<number | null>(null);
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recordingLock = useRef(false);
  const activeRecordingQuestion = useRef<number | null>(null);
  const [problems, setProblems] = useState<any[]>([]);
  const [videoScript, setVideoScript] = useState<{ prompts: any[]; secondsEach: number; truncated: boolean; totalFillable: number } | null>(null);
  const [standardVideoQuestion, setStandardVideoQuestion] = useState<any>(null);
  const exitPromptOpen = useRef(false);
  const [photoSource,setPhotoSource] = useState<{uri:string;headers:Record<string,string>}|undefined>();
  const [photoBusy,setPhotoBusy] = useState(false);
  const [profileForm, setProfileForm] = useState<ProfileForm>(EMPTY_PROFILE);
  const [profileErrors, setProfileErrors] = useState<Record<string, string>>({});
  const draftKey = selected ? `inicio.draft.${selected.respondent.id}` : "";

  async function toggleTheme() {
    const next = mode === "dark" ? "light" : "dark";
    setMode(next);
    setNativeWindScheme(next);
    await AsyncStorage.setItem(THEME_KEY, next);
  }

  async function loadMe() {
    const me = await api.me();
    await AsyncStorage.setItem("inicio.offline.enrolments",JSON.stringify(me.enrolments||[]));
    setEnrolments(me.enrolments || []);
    if ((me.enrolments || []).length === 1) await openStudy(me.enrolments[0], false);
    else setScreen("studies");
  }

  async function showProfilePhoto(profile:any) {
    const token=await getToken();
    setPhotoSource(profile?.hasPhoto&&token?{uri:`${API_BASE}/mobile/api/profile/photo?v=${encodeURIComponent(profile.photoUpdatedAt||'')}`,headers:{Authorization:`Bearer ${token}`}}:undefined);
  }
  async function uploadProfilePhoto() {
    if(photoBusy)return;
    try {
      const permission=await ImagePicker.requestMediaLibraryPermissionsAsync();
      if(!permission.granted){Alert.alert('Photo access needed','Allow photo access in device settings to choose your profile image.');return;}
      const picked=await ImagePicker.launchImageLibraryAsync({mediaTypes:['images'],allowsEditing:true,aspect:[1,1],quality:.65});
      if(picked.canceled||!picked.assets[0])return;
      const asset=picked.assets[0];
      if(asset.fileSize&&asset.fileSize>3*1024*1024){Alert.alert('Choose a smaller image','Profile images must be smaller than 3 MB.');return;}
      setPhotoBusy(true);
      const form=new FormData();form.append('photo',new ExpoFile(asset.uri));
      const result=await api.uploadProfilePhoto(form);await showProfilePhoto(result.profile);
    } catch(e:any){Alert.alert('Could not upload photo',e.message);}
    finally{setPhotoBusy(false);}
  }

  async function loadProfileGate() {
    const result = await api.profile();
    await showProfilePhoto(result.profile);
    if (result.required) {
      const p = result.profile;
      setProfileForm({
        name: p?.name || result.prefillName || "",
        location: p?.location || "",
        age: p?.age == null ? "" : String(p.age),
        gender: p?.gender || "",
        education_level: p?.educationLevel || "",
        occupation: p?.occupation || "",
        religion: p?.religion || "",
        marital_status: p?.maritalStatus || "",
        recontact_consent: p?.recontactConsent || "",
      });
      setProfileErrors({});
      setScreen("profileGate");
      return;
    }
    await loadMe();
  }

  useEffect(() => {
    (async () => {
      const savedTheme = await AsyncStorage.getItem(THEME_KEY);
      const resolved = savedTheme === "light" || savedTheme === "dark" ? savedTheme : "light";
      setMode(resolved);
      setNativeWindScheme(resolved);
      try {
        const remembered = await getRememberedSession();
        if (!remembered) { setScreen("login"); return; }
        if (remembered.expiresAt !== null && Date.now() > remembered.expiresAt) {
          await clearRememberedSession();
          setScreen("login");
          return;
        }
        if (!(await unlockWithDeviceSecurity())) { setScreen("login"); return; }
        await extendRememberedSession();
        await loadProfileGate();
      } catch(e:any) {
        if(!e.status&&await getToken()){const raw=await AsyncStorage.getItem('inicio.offline.enrolments');const cached=raw?JSON.parse(raw):[];setEnrolments(cached);if(cached.length===1)await openStudy(cached[0],false);else setScreen('studies');}
        else{await setToken(null);await AsyncStorage.removeItem('inicio.offline.enrolments');setScreen('login');}
      }
    })();
  }, []);

  // With nothing enrolled at all (rare — a fresh emulator, e.g.), there is no
  // device prompt to show, so let the remembered session through rather than
  // permanently locking the user out of a state we can't gate.
  async function unlockWithDeviceSecurity() {
    try {
      const level = await LocalAuthentication.getEnrolledLevelAsync();
      if (level === LocalAuthentication.SecurityLevel.NONE) return true;
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: "Unlock Inicio Diary",
        cancelLabel: "Use password instead",
        disableDeviceFallback: false,
      });
      return result.success;
    } catch { return true; }
  }

  async function toggleRememberMe() {
    const next = !rememberMe;
    if (next) {
      const level = await LocalAuthentication.getEnrolledLevelAsync().catch(() => LocalAuthentication.SecurityLevel.NONE);
      if (level === LocalAuthentication.SecurityLevel.NONE) {
        Alert.alert("Set up a device lock first", "To remember you securely for 30 days, add a PIN, pattern, password, or fingerprint/Face ID in your phone's settings.");
        return;
      }
    }
    setRememberMe(next);
  }

  async function login() {
    setError("");
    if (!username.trim() || !password) return setError("Enter your username and password.");
    setBusy(true);
    try {
      const result = await api.login(username.trim(), password);
      await setToken(result.token, { remember: rememberMe });
      if (rememberMe) await extendRememberedSession();
      setPassword("");
      await loadProfileGate();
    } catch (e: any) { setError(e.message || "Unable to sign in."); }
    finally { setBusy(false); }
  }

  function openPasswordRecovery() {
    setError("");
    setRecoveryCode("");
    setScreen("forgotPassword");
  }

  async function requestRecoveryCode() {
    setError("");
    if (!recoveryContact.trim()) return setError("Enter the phone number or email used for your invitation.");
    setBusy(true);
    try {
      const result = await api.requestCode(recoveryContact.trim());
      if (result.simulated) {
        return setError("Code delivery is not available yet. Use your original invitation link or contact the research team for help.");
      }
      setScreen("verifyLoginCode");
    } catch (e: any) { setError(e.message || "Unable to send a verification code."); }
    finally { setBusy(false); }
  }

  async function verifyRecoveryCode() {
    setError("");
    if (!recoveryCode.trim()) return setError("Enter the verification code we sent you.");
    setBusy(true);
    try {
      const result = await api.verifyCode(recoveryContact.trim(), recoveryCode.trim());
      setResetToken(result.resetToken);
      setRecoveryCode("");
      setNewPassword("");
      setConfirmNewPassword("");
      setScreen("setNewPassword");
    } catch (e: any) { setError(e.message || "Unable to verify that code."); }
    finally { setBusy(false); }
  }

  async function submitNewPassword() {
    setError("");
    if (newPassword.length < 8) return setError("Password must be at least 8 characters.");
    if (newPassword !== confirmNewPassword) return setError("The passwords do not match.");
    setBusy(true);
    try {
      const result = await api.resetPassword(resetToken, newPassword);
      await setToken(result.token, { remember: rememberMe });
      if (rememberMe) await extendRememberedSession();
      setPassword("");
      setResetToken("");
      setNewPassword("");
      setConfirmNewPassword("");
      await loadProfileGate();
    } catch (e: any) { setError(e.message || "Unable to reset your password."); }
    finally { setBusy(false); }
  }

  async function saveProfile() {
    setBusy(true); setProfileErrors({}); setError("");
    try { await api.saveProfile(profileForm); await loadMe(); }
    catch (e: any) { setProfileErrors(e.fields || {}); setError(e.message || "Please check your answers."); }
    finally { setBusy(false); }
  }

  async function logout() {
    setBusy(true);
    try { await api.logout(); } catch {}
    await setToken(null);
    await AsyncStorage.removeItem("inicio.offline.enrolments");
    setSelected(null); setHome(null); setEnrolments([]); setError(""); setScreen("login");
    setBusy(false);
  }

  async function openStudy(item: MobileEnrolment, setBusyState = true) {
    if (setBusyState) setBusy(true);
    setError("");
    try {
      let data;try{data=await api.home(item.respondent.id);await AsyncStorage.setItem(`inicio.home.${item.respondent.id}`,JSON.stringify(data));}catch(e:any){if(e.status)throw e;const cached=await AsyncStorage.getItem(`inicio.home.${item.respondent.id}`);if(!cached)throw e;data=JSON.parse(cached);}
      setSelected(item); setHome(data); setScreen("home");
    } catch (e: any) { Alert.alert("Could not open study", e.message); }
    finally { if (setBusyState) setBusy(false); }
  }

  async function acceptConsent() {
    if (!selected) return;
    setBusy(true);
    try { await api.consent(selected.respondent.id,home?.consent?.version); setHome(await api.home(selected.respondent.id)); }
    catch (e: any) { Alert.alert("Consent could not be saved", e.message); }
    finally { setBusy(false); }
  }

  function openDiaryModePicker() {
    setScreen("diaryMode");
  }

  const [participation,setParticipation]=useState<any>(null);
  const [closeoutAnswers,setCloseoutAnswers]=useState<Record<string,string>>({});
  async function openParticipation(target: "participation" | "rewards" = "participation"){if(!selected)return;try{setParticipation(await api.participation(selected.respondent.id));setScreen(target);}catch(e:any){Alert.alert("Connection needed",e.message);}}
  const [pendingEntries,setPendingEntries]=useState<DiaryPacket[]>([]);
  const [captureTime,setCaptureTime]=useState(new Date().toISOString());
  const [occurrenceTime,setOccurrenceTime]=useState(new Date().toISOString());
  const [participationKind,setParticipationKind]=useState('occasion');
  const [entryKey,setEntryKey]=useState(packetId());
  const [occasionNumber,setOccasionNumber]=useState(1);
  useEffect(()=>{if(screen!=='diary'||!draftKey)return;const timer=setTimeout(()=>AsyncStorage.setItem(draftKey,JSON.stringify({answers,otherText,media,mediaAnalysis,captureTime,occurrenceTime,entryKey,participationKind})).catch(()=>{}),300);return()=>clearTimeout(timer);},[answers,otherText,media,mediaAnalysis,captureTime,occurrenceTime,entryKey,participationKind,screen,draftKey]);
  async function reviewQueued(packet:DiaryPacket){
    if(packet.kind!=='standard')return;
    try{
      const q=await api.questionnaire(packet.respondentId);const evidence:MediaMap={};
      for(const m of packet.media){const id=m.field.split('_q_')[1];if(id)evidence[id]=await preserveMedia(m,`draft-${packet.respondentId}`);}
      const draft={answers:JSON.parse(packet.fields.answers_json||'{}'),otherText:JSON.parse(packet.fields.other_text_json||'{}'),media:evidence,mediaAnalysis:{},captureTime:packet.fields.capture_time,occurrenceTime:packet.fields.occurrence_time,entryKey:packetId(),participationKind:packet.fields.participation_kind||'occasion'};
      await AsyncStorage.setItem(`inicio.draft.${packet.respondentId}`,JSON.stringify(draft));
      await removeQueued(packet.respondentId,packet.id);
      setQuestionnaire(q);setAnswers(draft.answers);setOtherText(draft.otherText);setMedia(evidence);setMediaAnalysis({});setCaptureTime(draft.captureTime);setOccurrenceTime(draft.occurrenceTime);setEntryKey(draft.entryKey);setParticipationKind(draft.participationKind);setOccasionNumber(q.occasionNumber||1);setScreen('diary');setPendingEntries(await listQueue(packet.respondentId));
    }catch(e:any){Alert.alert('Could not open saved entry',e.message);}
  }
  async function refreshSync(manual=false){if(!selected)return;await syncQueue(selected.respondent.id,manual);setPendingEntries(await listQueue(selected.respondent.id));}
  useEffect(()=>{
    if(!selected)return;
    refreshSync().catch(()=>{});
    const timer=setInterval(()=>refreshSync().catch(()=>{}),30000);
    const listener=AppState.addEventListener('change',state=>{if(state==='active')refreshSync().catch(()=>{});});
    return()=>{clearInterval(timer);listener.remove();};
  },[selected?.respondent.id]);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const confirmExit = () => {
      if (exitPromptOpen.current) return;
      exitPromptOpen.current = true;
      Alert.alert("Close Inicio Diary?", "Your saved drafts and queued entries will remain on this device.", [
        { text: "Stay", style: "cancel", onPress: () => { exitPromptOpen.current = false; } },
        { text: "Close app", onPress: () => { exitPromptOpen.current = false; BackHandler.exitApp(); } },
      ], { cancelable: true, onDismiss: () => { exitPromptOpen.current = false; } });
    };
    const listener = BackHandler.addEventListener("hardwareBackPress", () => {
      if (busy || screen === "loading") return true;
      if (screen === "diaryVideo" || screen === "diaryQuestionVideo") return false;
      if (screen === "forgotPassword") { setError(""); setScreen("login"); return true; }
      if (screen === "verifyLoginCode") { setError(""); setScreen("forgotPassword"); return true; }
      if (screen === "setNewPassword") { setError(""); setScreen("verifyLoginCode"); return true; }
      if (screen === "entries" || screen === "activity" || screen === "profile" || screen === "sync") { setScreen("home"); return true; }
      if (screen === "participation" || screen === "rewards") { setScreen("profile"); return true; }
      if (screen === "diary") {
        if (recordingQuestionId !== null) { Alert.alert("Recording in progress", "Stop the voice recording before going back."); return true; }
        setScreen("diaryMode"); return true;
      }
      if (screen === "diaryMode" || screen === "diaryVideoDone") { setScreen("home"); return true; }
      if (screen === "home" && enrolments.length > 1) { setScreen("studies"); return true; }
      confirmExit();
      return true;
    });
    return () => listener.remove();
  }, [screen, busy, recordingQuestionId, enrolments.length]);

  async function startDiary() {
    if (!selected) return;
    setBusy(true); setProblems([]);
    try {
      const cacheKey=`inicio.questionnaire.${selected.respondent.id}`;
      let q;
      try{q=await api.questionnaire(selected.respondent.id);await AsyncStorage.setItem(cacheKey,JSON.stringify(q));}
      catch(e:any){if(e.status)throw e;const cached=await AsyncStorage.getItem(cacheKey);if(!cached)throw e;q=JSON.parse(cached);}
      setQuestionnaire(q);
      setOccasionNumber((q.occasionNumber||1)+(await listQueue(selected.respondent.id)).filter(p=>p.fields.practice!=='1').length);
      const saved = draftKey ? await AsyncStorage.getItem(draftKey) : null;
      const draft=saved?JSON.parse(saved):{};
      setAnswers(draft.answers||{});setOtherText(draft.otherText||{});setMedia(draft.media||{});setMediaAnalysis(draft.mediaAnalysis||{});setCaptureTime(draft.captureTime||new Date().toISOString());setOccurrenceTime(draft.occurrenceTime||new Date().toISOString());setEntryKey(draft.entryKey||packetId());setParticipationKind(draft.participationKind||'occasion');setScreen("diary");
    } catch (e: any) {
      if (e.profileRequired) await loadProfileGate();
      else Alert.alert("Diary unavailable", e.message);
    } finally { setBusy(false); }
  }

  async function startVideoDiary() {
    if (!selected) return;
    setBusy(true);
    try {
      const script = await api.videoScript(selected.respondent.id);
      setVideoScript(script);
      setScreen("diaryVideo");
    } catch (e: any) {
      if (e.profileRequired) await loadProfileGate();
      else Alert.alert("Video mode unavailable", e.message);
    } finally { setBusy(false); }
  }

  async function submitRecordedVideo(draft: VideoDraft) {
    if (!selected) throw new Error('Select your study before submitting.');
    const respondentId = selected.respondent.id;
    await enqueue({id:draft.id,respondentId,kind:'video',fields:{capture_time:draft.captureTime,occurrence_time:draft.captureTime,submit_time:new Date().toISOString()},media:[{uri:draft.uri,fileName:draft.fileName,mimeType:draft.mimeType,field:'video'}],state:'pending',attempts:0,createdAt:draft.captureTime});
    setVideoScript(null);setScreen('sync');
    refreshSync().catch(()=>{});
    api.home(respondentId).then(setHome).catch(()=>{});
  }

  async function saveDraft() {
    if (!draftKey) return;
    const durable:MediaMap={};for(const [id,asset] of Object.entries(media)){durable[id]=await preserveMedia({...asset,field:id},`draft-${selected?.respondent.id}`);}
    setMedia(durable);
    await AsyncStorage.setItem(draftKey, JSON.stringify({ answers, otherText, media:durable,mediaAnalysis,captureTime,occurrenceTime,entryKey,participationKind,savedAt: new Date().toISOString() }));
    Alert.alert("Draft saved", "Your answers are stored on this device. You can continue later.");
  }

  function setAnswer(id: number, value: string | string[]) {
    setAnswers((old) => ({ ...old, [String(id)]: value }));
    setProblems((old) => old.filter((p) => p.questionId !== id));
  }

  function setOtherSpecify(questionId: number, option: string, value: string) {
    setOtherText((old) => ({ ...old, [String(questionId)]: { ...(old[String(questionId)] || {}), [option]: value } }));
    setProblems((old) => old.filter((p) => p.questionId !== questionId));
  }

  async function analyseEvidence(q: any, asset: MediaAsset) {
    if (!selected || !["audio", "video"].includes(q.type)) return;
    const id = String(q.id);
    setMediaAnalysis((old) => ({ ...old, [id]: { transcriptStatus: "processing", scoreStatus: "processing" } }));
    try {
      const form = new FormData();
      form.append("question_id", id);
      form.append("media", new ExpoFile(asset.uri));
      const result = await api.analyseMedia(selected.respondent.id, form);
      setMediaAnalysis((old) => ({ ...old, [id]: result }));
    } catch (e: any) {
      const offline = !e.status;
      setMediaAnalysis((old) => ({
        ...old,
        [id]: {
          transcriptStatus: offline ? "pending" : "error",
          scoreStatus: "unavailable",
          scoreRationale: offline ? "Waiting for a connection." : (e.message || "Analysis failed."),
        },
      }));
    }
  }

  async function pickEvidence(q: any) {
    if (q.type === "video") {
      setStandardVideoQuestion(q);
      setScreen("diaryQuestionVideo");
      return;
    }
    try {
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: .82 } as any);
      if (!result.canceled && result.assets?.[0]) { const saved=await preserveMedia({...result.assets[0],field:String(q.id)},`draft-${selected?.respondent.id}`);setMedia((old) => ({ ...old, [String(q.id)]:saved }));setMediaAnalysis((old)=>{const next={...old};delete next[String(q.id)];return next;}); }
    } catch (e: any) { Alert.alert("Camera unavailable", e.message || "Could not open the camera."); }
  }

  async function startRecording(questionId: number) {
    if (recordingLock.current || activeRecordingQuestion.current !== null) return;
    recordingLock.current = true;
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        Alert.alert("Microphone permission needed", "Enable microphone access to record a voice note.");
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      const current = audioRecorder.getStatus();
      if (!current.canRecord) await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
      activeRecordingQuestion.current = questionId;
      setRecordingQuestionId(questionId);
    } catch (e: any) {
      try { if (audioRecorder.getStatus().canRecord) await audioRecorder.stop(); } catch {}
      Alert.alert("Microphone unavailable", e.message || "Could not start recording.");
    } finally {
      recordingLock.current = false;
    }
  }

  async function stopRecording(questionId: number) {
    if (recordingLock.current || activeRecordingQuestion.current !== questionId) return;
    recordingLock.current = true;
    try {
      await audioRecorder.stop();
      if (audioRecorder.uri) {
        const durable=await preserveMedia({uri:audioRecorder.uri,fileName:`voice-note-${questionId}.m4a`,mimeType:"audio/m4a",field:String(questionId)},`draft-${selected?.respondent.id}`);
        setMedia((old) => ({
          ...old,
          [String(questionId)]: durable,
        }));
        const question=questionnaire?.questions?.find((item:any)=>item.id===questionId);
        if(question)analyseEvidence(question,durable);
      }
    } catch (e: any) {
      Alert.alert("Recording failed", e.message || "Could not save the voice note.");
    } finally {
      activeRecordingQuestion.current = null;
      setRecordingQuestionId(null);
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(()=>{});
      recordingLock.current = false;
    }
  }

  async function submitDiary() {
    if (!selected || !questionnaire) return;
    setBusy(true); setProblems([]);
    try {
      if(!Number.isFinite(Date.parse(occurrenceTime)))throw new Error('Enter the occasion time as YYYY-MM-DDTHH:mm:ss with a timezone, for example Z for UTC.');
      const evidence=Object.entries(media).map(([id,asset])=>{const q=questionnaire.questions.find((q:any)=>String(q.id)===id);return {...asset,field:`${q?.type||'photo'}_q_${id}`,mimeType:asset.mimeType||(q?.type==='audio'?'audio/m4a':q?.type==='video'?'video/mp4':'image/jpeg')};});
      await enqueue({id:entryKey,respondentId:selected.respondent.id,kind:'standard',fields:{action:'submit',entry_mode:'standard',occurrence_time:occurrenceTime,capture_time:captureTime,submit_time:new Date().toISOString(),answers_json:JSON.stringify(answers),other_text_json:JSON.stringify(otherText),participation_kind:participationKind,practice:questionnaire.study.practiceRequired?'1':'0',occasion_number:String(occasionNumber)},media:evidence,state:'pending',attempts:0,createdAt:new Date().toISOString()});
      if(draftKey)await AsyncStorage.removeItem(draftKey);
      setAnswers({});setOtherText({});setMedia({});setMediaAnalysis({});setScreen('sync');await refreshSync();
      try{setHome(await api.home(selected.respondent.id));}catch{}
    } catch (e: any) {
      if (e.profileRequired) await loadProfileGate();
      else if (e.problems?.length) setProblems(e.problems);
      else Alert.alert("Could not submit", e.message);
    } finally { setBusy(false); }
  }

  const visibleQuestions = useMemo(() => questionnaire?.questions?.filter((q: any) => isVisible(q.id, questionnaire.rules || [], answers)&&(!q.everyNthOccasion||occasionNumber%q.everyNthOccasion===0)&&((q.fromHourUtc==null||q.toHourUtc==null)||((q.fromHourUtc<q.toHourUtc)?(new Date(occurrenceTime).getUTCHours()>=q.fromHourUtc&&new Date(occurrenceTime).getUTCHours()<q.toHourUtc):(new Date(occurrenceTime).getUTCHours()>=q.fromHourUtc||new Date(occurrenceTime).getUTCHours()<q.toHourUtc)))) || [], [questionnaire, answers,occurrenceTime,occasionNumber]);
  const records = home?.records || [];
  const submitted = records.filter((r: any) => r.status === "submitted" && !r.isPractice).length;
  const drafts = records.filter((r: any) => r.status === "draft").length;
  const respondentName = home?.respondent?.name || selected?.respondent?.name || "";

  if(screen==='rewards'&&participation)return <AppFrame t={t} mode={mode}><ScrollView contentContainerStyle={styles.page}><Pressable onPress={()=>setScreen('profile')}><Text style={{color:t.blue}}>← Back to profile</Text></Pressable><Text style={[styles.screenTitle,{color:t.text}]}>My rewards</Text><Text style={{color:t.muted}}>Rewards for {home?.study?.name||'this study'}.</Text>{participation.incentives.length?participation.incentives.map((reward:any,index:number)=><Card key={index} t={t}><Text style={{color:t.text,fontWeight:'700',fontSize:16}}>{reward.milestone==='onboarding'?'Getting started':reward.milestone==='closeout'?'Study completion':'Diary participation'}</Text><Text style={{color:t.blue,fontWeight:'800',fontSize:24,marginVertical:8}}>{reward.currency} {Number(reward.amount).toLocaleString()}</Text><Text style={{color:t.muted}}>{reward.status==='paid'?'Paid':reward.status==='eligible'?'Eligible · awaiting payment':reward.status==='held'?'On hold · under review':reward.status}</Text></Card>):<Card t={t}><Text style={{color:t.text,fontWeight:'700'}}>No rewards recorded yet</Text><Text style={{color:t.muted,marginTop:8}}>Your eligible study rewards will appear here when confirmed by the research team.</Text></Card>}</ScrollView></AppFrame>;
  if(screen==='participation'&&selected&&participation)return <AppFrame t={t} mode={mode}><ScrollView contentContainerStyle={styles.page}><Pressable onPress={()=>setScreen('profile')}><Text style={{color:t.blue}}>← Back to profile</Text></Pressable><Text style={[styles.screenTitle,{color:t.text}]}>Your participation</Text><Card t={t}><Text style={{color:t.text}}>Allow authorised client researchers to view your study photos, video and audio?</Text><ChoiceList t={t} options={[["yes","Yes, share study media"],["no","No, keep media with the research team"]]} value={participation.mediaConsent?'yes':'no'} onChange={async value=>{try{await api.mediaConsent(selected.respondent.id,value==='yes');await openParticipation();}catch(e:any){Alert.alert('Could not save',e.message);}}}/></Card>{participation.closeoutDue&&!participation.closeoutCompleted?<Card t={t}><Text style={{color:t.text,fontWeight:'700'}}>Final study validation</Text>{participation.questions.map((q:any)=><View key={q.code}><Text style={{color:t.text}}>{q.text}{q.required?' *':''}</Text>{q.type==='single'?<ChoiceList t={t} options={q.options.map((o:string)=>[o,o])} value={closeoutAnswers[q.code]||''} onChange={value=>setCloseoutAnswers(a=>({...a,[q.code]:value}))}/>:<TextInput value={closeoutAnswers[q.code]||''} onChangeText={value=>setCloseoutAnswers(a=>({...a,[q.code]:value}))} style={[styles.input,{color:t.text,borderColor:t.border}]} />}</View>)}<PrimaryButton t={t} title="Submit final validation" onPress={async()=>{try{await api.closeout(selected.respondent.id,closeoutAnswers);await openParticipation();}catch(e:any){Alert.alert('Check your answers',e.message);}}}/></Card>:null}{participation.closeoutCompleted?<Text style={{color:t.green}}>Final validation completed.</Text>:null}<Pressable onPress={()=>Alert.alert('Withdraw from this study?','You will stop participating. The research team will process your data according to the study retention policy.',[{text:'Keep participating',style:'cancel'},{text:'Withdraw',style:'destructive',onPress:async()=>{try{await api.withdraw(selected.respondent.id);await logout();}catch(e:any){Alert.alert('Could not withdraw',e.message);}}}])}><Text style={{color:t.red}}>Withdraw from study</Text></Pressable></ScrollView></AppFrame>;
  if(screen==='sync')return <AppFrame t={t} mode={mode}><ScrollView contentContainerStyle={styles.page}><Pressable onPress={()=>setScreen('home')}><Text style={{color:t.blue}}>← Back to diary</Text></Pressable><Text style={[styles.screenTitle,{color:t.text}]}>Saved on this device</Text><Text style={{color:t.muted}}>Entries remain here until the server confirms receipt. Pending entries retry while the app is open.</Text><PrimaryButton title="Retry sync" t={t} onPress={()=>refreshSync(true)} />{!pendingEntries.length?<Text style={{color:t.text}}>All queued entries have synced.</Text>:pendingEntries.map(p=><Card key={p.id} t={t}><Text style={{color:t.text}}>{p.fields.occurrence_time} · {p.kind}</Text><Text style={{color:t.muted}}>{p.state==='needs_attention'?'Needs attention':'Waiting to sync'} · {p.media.length} saved files</Text>{p.error?<Text style={{color:t.red}}>{p.error}</Text>:null}{p.state==='needs_attention'&&p.kind==='standard'?<Pressable onPress={()=>reviewQueued(p)}><Text style={{color:t.blue}}>Review and edit saved entry</Text></Pressable>:null}<Pressable onPress={()=>Alert.alert('Delete this saved entry?','This removes its answers and media from this device.',[{text:'Keep entry',style:'cancel'},{text:'Delete',style:'destructive',onPress:async()=>{await removeQueued(p.respondentId,p.id);await refreshSync();}}])}><Text style={{color:t.red}}>Delete saved entry</Text></Pressable></Card>)}</ScrollView></AppFrame>;

  if (screen === "loading") return <LogoLoader />;

  if (screen === "login") return <AppFrame t={t} mode={mode}><KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}><ScrollView contentContainerStyle={styles.loginWrap} keyboardShouldPersistTaps="handled"><LoginDoodleField color={t.blue} /><View style={styles.loginTop}><BookMark t={t} large /><Text style={[styles.loginTitle, { color: t.text }]}>Inicio Diary</Text><Text style={[styles.loginSubtitle, { color: t.muted }]}>Sign in to your consumption diary.</Text></View><View style={styles.loginFields}><Text style={[styles.label, { color: t.muted }]}>Username</Text><TextInput value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} placeholder="Your username" placeholderTextColor={t.subtle} style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.bg }]} /><View style={styles.passwordLabelRow}><Text style={[styles.label, { color: t.muted }]}>Password</Text><Pressable accessibilityRole="button" onPress={openPasswordRecovery} hitSlop={8}><Text style={[styles.forgotPasswordLink, { color: t.blue }]}>Forgotten password?</Text></Pressable></View><View style={[styles.inputShell, { borderColor: t.border, backgroundColor: t.bg }]}><TextInput value={password} onChangeText={setPassword} secureTextEntry={!showPassword} autoCapitalize="none" placeholder="Your password" placeholderTextColor={t.subtle} style={[styles.inputEmbedded, { color: t.text }]} /><Pressable accessibilityRole="button" accessibilityLabel={showPassword ? "Hide password" : "Show password"} onPress={() => setShowPassword((visible) => !visible)} hitSlop={6} style={styles.passwordToggle}><LineIcon name={showPassword ? "eyeSlash" : "eye"} size={20} color={t.muted} /></Pressable></View><Pressable accessibilityRole="checkbox" accessibilityState={{ checked: rememberMe }} accessibilityLabel="Remember me for 30 days" onPress={toggleRememberMe} style={styles.rememberRow} hitSlop={6}><View style={[styles.checkbox, { borderColor: rememberMe ? t.blue : t.border, backgroundColor: rememberMe ? t.blue : t.bg }]}>{rememberMe ? <LineIcon name="checkSmall" size={13} color={t.white} /> : null}</View><Text style={[styles.rememberText, { color: t.muted }]}>Remember me for 30 days</Text></Pressable>{error ? <Text style={{ color: t.red, fontSize: 12 }}>{error}</Text> : null}<PrimaryButton title={busy ? "Opening…" : "Open my diary"} onPress={login} disabled={busy} t={t} arrow={false} /></View><View style={[styles.firstTimeCard, { backgroundColor: t.card, borderColor: t.border }]}><Icon glyph="⌘" t={t} /><View style={{ flex: 1 }}><Text style={[styles.firstTimeTitle, { color: t.text }]}>First time here?</Text><Text style={[styles.firstTimeCopy, { color: t.muted }]}>Open the invitation link or scan the QR code you received to set up your login.</Text></View></View><Text style={[styles.secureText, { color: t.subtle }]}>Inicio Diary · Secure respondent access</Text></ScrollView></KeyboardAvoidingView></AppFrame>;

  if (screen === "forgotPassword") return <AppFrame t={t} mode={mode}><KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}><ScrollView contentContainerStyle={styles.recoveryWrap} keyboardShouldPersistTaps="handled"><LoginDoodleField color={t.blue} /><Pressable accessibilityRole="button" onPress={() => { setError(""); setScreen("login"); }}><Text style={[styles.backLink, { color: t.blue }]}>← Back to sign in</Text></Pressable><View style={styles.recoveryHeading}><View style={[styles.recoveryIcon, { backgroundColor: t.blueSoft }]}><LineIcon name="lock" size={26} color={t.blue} /></View><Text style={[styles.loginTitle, { color: t.text }]}>Forgotten password?</Text><Text style={[styles.recoveryCopy, { color: t.muted }]}>Enter the phone number or email used for your invitation. We’ll send a one-time code so you can set a new password.</Text></View><View style={styles.loginFields}><Text style={[styles.label, { color: t.muted }]}>Phone number or email</Text><TextInput value={recoveryContact} onChangeText={setRecoveryContact} autoCapitalize="none" autoCorrect={false} placeholder="Your phone number or email" placeholderTextColor={t.subtle} style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.bg }]} />{error ? <Text style={{ color: t.red, fontSize: 12, lineHeight: 17 }}>{error}</Text> : null}<PrimaryButton title={busy ? "Sending code…" : "Send verification code"} onPress={requestRecoveryCode} disabled={busy} t={t} arrow={false} /></View></ScrollView></KeyboardAvoidingView></AppFrame>;

  if (screen === "verifyLoginCode") return <AppFrame t={t} mode={mode}><KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}><ScrollView contentContainerStyle={styles.recoveryWrap} keyboardShouldPersistTaps="handled"><LoginDoodleField color={t.blue} /><Pressable accessibilityRole="button" onPress={() => { setError(""); setScreen("forgotPassword"); }}><Text style={[styles.backLink, { color: t.blue }]}>← Change phone number or email</Text></Pressable><View style={styles.recoveryHeading}><View style={[styles.recoveryIcon, { backgroundColor: t.blueSoft }]}><LineIcon name="mail" size={26} color={t.blue} /></View><Text style={[styles.loginTitle, { color: t.text }]}>Enter your code</Text><Text style={[styles.recoveryCopy, { color: t.muted }]}>Enter the verification code sent to {recoveryContact}.</Text></View><View style={styles.loginFields}><Text style={[styles.label, { color: t.muted }]}>Verification code</Text><TextInput value={recoveryCode} onChangeText={setRecoveryCode} keyboardType="number-pad" autoCapitalize="none" maxLength={6} placeholder="6-digit code" placeholderTextColor={t.subtle} style={[styles.input, styles.codeInput, { color: t.text, borderColor: t.border, backgroundColor: t.bg }]} />{error ? <Text style={{ color: t.red, fontSize: 12 }}>{error}</Text> : null}<PrimaryButton title={busy ? "Checking code…" : "Verify code"} onPress={verifyRecoveryCode} disabled={busy} t={t} arrow={false} /><Pressable accessibilityRole="button" disabled={busy} onPress={requestRecoveryCode} style={styles.resendButton}><Text style={[styles.forgotPasswordLink, { color: t.blue }]}>Send a new code</Text></Pressable></View></ScrollView></KeyboardAvoidingView></AppFrame>;

  if (screen === "setNewPassword") return <AppFrame t={t} mode={mode}><KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}><ScrollView contentContainerStyle={styles.recoveryWrap} keyboardShouldPersistTaps="handled"><LoginDoodleField color={t.blue} /><View style={styles.recoveryHeading}><View style={[styles.recoveryIcon, { backgroundColor: t.blueSoft }]}><LineIcon name="lock" size={26} color={t.blue} /></View><Text style={[styles.loginTitle, { color: t.text }]}>Set a new password</Text><Text style={[styles.recoveryCopy, { color: t.muted }]}>Choose a new password for your account. It must be at least 8 characters.</Text></View><View style={styles.loginFields}><Text style={[styles.label, { color: t.muted }]}>New password</Text><View style={[styles.inputShell, { borderColor: t.border, backgroundColor: t.bg }]}><TextInput value={newPassword} onChangeText={setNewPassword} secureTextEntry={!showNewPassword} autoCapitalize="none" placeholder="New password" placeholderTextColor={t.subtle} style={[styles.inputEmbedded, { color: t.text }]} /><Pressable accessibilityRole="button" accessibilityLabel={showNewPassword ? "Hide password" : "Show password"} onPress={() => setShowNewPassword((visible) => !visible)} hitSlop={6} style={styles.passwordToggle}><LineIcon name={showNewPassword ? "eyeSlash" : "eye"} size={20} color={t.muted} /></Pressable></View><Text style={[styles.label, { color: t.muted }]}>Confirm new password</Text><TextInput value={confirmNewPassword} onChangeText={setConfirmNewPassword} secureTextEntry={!showNewPassword} autoCapitalize="none" placeholder="Confirm new password" placeholderTextColor={t.subtle} style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.bg }]} />{error ? <Text style={{ color: t.red, fontSize: 12 }}>{error}</Text> : null}<PrimaryButton title={busy ? "Saving…" : "Save new password"} onPress={submitNewPassword} disabled={busy} t={t} arrow={false} /></View></ScrollView></KeyboardAvoidingView></AppFrame>;

  if (screen === "profileGate") return <AppFrame t={t} mode={mode}><KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}><ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled"><View style={styles.simpleTop}><Brand t={t} /><Pressable onPress={logout}><Text style={{ color: t.muted, fontWeight: "700" }}>Sign out</Text></Pressable></View><Text style={[styles.screenTitle, { color: t.text }]}>Your details</Text><Text style={[styles.screenCopy, { color: t.muted }]}>Complete your one-time Inicio Diary profile.</Text><Card t={t} style={{ gap: 10 }}><Text style={[styles.label, { color: t.muted }]}>Name</Text><TextInput value={profileForm.name} onChangeText={(v) => setProfileForm((p) => ({ ...p, name: v }))} style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.bg2 }]} /><FieldError message={profileErrors.name} t={t} /><Text style={[styles.label, { color: t.muted }]}>Where do you currently live?</Text><TextInput value={profileForm.location} onChangeText={(v) => setProfileForm((p) => ({ ...p, location: v }))} placeholder="City / state / area" placeholderTextColor={t.subtle} style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.bg2 }]} /><FieldError message={profileErrors.location} t={t} /><Text style={[styles.label, { color: t.muted }]}>Age</Text><TextInput value={profileForm.age} onChangeText={(v) => setProfileForm((p) => ({ ...p, age: v }))} keyboardType="number-pad" style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.bg2 }]} /><Text style={[styles.label, { color: t.muted }]}>Gender</Text><ChoiceList options={GENDERS} value={profileForm.gender} onChange={(v) => setProfileForm((p) => ({ ...p, gender: v }))} t={t} /><Text style={[styles.label, { color: t.muted }]}>Education</Text><ChoiceList options={EDUCATION} value={profileForm.education_level} onChange={(v) => setProfileForm((p) => ({ ...p, education_level: v }))} t={t} /><Text style={[styles.label, { color: t.muted }]}>Occupation</Text><TextInput value={profileForm.occupation} onChangeText={(v) => setProfileForm((p) => ({ ...p, occupation: v }))} style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.bg2 }]} /><Text style={[styles.label, { color: t.muted }]}>Religion</Text><TextInput value={profileForm.religion} onChangeText={(v) => setProfileForm((p) => ({ ...p, religion: v }))} style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.bg2 }]} /><Text style={[styles.label, { color: t.muted }]}>Marital status</Text><ChoiceList options={MARITAL} value={profileForm.marital_status} onChange={(v) => setProfileForm((p) => ({ ...p, marital_status: v }))} t={t} /><Text style={[styles.label, { color: t.muted }]}>May Inicio contact you about future research?</Text><ChoiceList options={[["yes", "Yes"], ["no", "No"]]} value={profileForm.recontact_consent} onChange={(v) => setProfileForm((p) => ({ ...p, recontact_consent: v }))} t={t} />{error ? <Text style={{ color: t.red, fontSize: 12 }}>{error}</Text> : null}<PrimaryButton title={busy ? "Saving…" : "Save profile & continue"} onPress={saveProfile} disabled={busy} t={t} /></Card></ScrollView></KeyboardAvoidingView></AppFrame>;

  if (screen === "studies") return <AppFrame t={t} mode={mode}><ScrollView contentContainerStyle={styles.page}><View style={styles.simpleTop}><Brand t={t} /><Pressable onPress={logout}><Text style={{ color: t.muted, fontWeight: "700" }}>Sign out</Text></Pressable></View><Text style={[styles.screenTitle, { color: t.text }]}>My studies</Text><Text style={[styles.screenCopy, { color: t.muted }]}>You’re taking part in {enrolments.length} {enrolments.length === 1 ? "study" : "studies"}.</Text>{enrolments.map((item) => <Pressable key={item.respondent.id} onPress={() => openStudy(item)}><Card t={t}><View style={styles.studyTitleRow}><Text style={[styles.studyName, { color: t.text }]}>{item.study.name}</Text><StatusPill status={item.respondent.consentStatus === "given" ? "active" : "consent needed"} t={t} /></View><Text style={[styles.studyMeta, { color: t.muted }]}>{[item.study.category ? `Household ${item.study.category.toLowerCase()} consumption` : null, item.study.market].filter(Boolean).join(" · ")}</Text><Text style={[styles.studyMeta, { color: t.muted }]}>{item.respondent.respondentCode} · {item.submittedCount} entries submitted</Text><View style={[styles.studyAction, { borderTopColor: t.border }]}><Text style={{ color: item.respondent.consentStatus === "given" ? "#66A0FF" : t.amber, fontWeight: "800" }}>{item.respondent.consentStatus === "given" ? "Open my diary" : "Read and agree to take part"} →</Text></View></Card></Pressable>)}</ScrollView></AppFrame>;

  if ((screen === "home" || screen === "entries" || screen === "activity" || screen === "profile") && selected && home) {
    const consentNeeded = home.respondent.consentStatus !== "given" && home.consent;
    const displayRecords: DisplayRecord[] = records.map((r: any) => ({
      id: r.id,
      time: formatTime(r.occurrenceTime || r.entryTime),
      day: dayLabel(r.occurrenceTime || r.entryTime),
      bucket: r.status === "submitted" ? "submitted" : r.status === "draft" ? "draft" : "review",
    }));
    const daysLogged = new Set(records.map((r: any) => dayLabel(r.occurrenceTime || r.entryTime))).size;
    const last14=Array.from({length:14},(_,i)=>{const day=new Date(Date.now()-(13-i)*86400000).toISOString().slice(0,10);return records.filter((r:any)=>r.status==='submitted'&&!r.isPractice&&String(r.occurrenceTime||r.entryTime).slice(0,10)===day).length;});
    const videoCount=records.filter((r:any)=>r.status==='submitted'&&!r.isPractice&&r.entryMode==='video').length;
    const voiceCount=records.filter((r:any)=>r.status==='submitted'&&!r.isPractice&&r.entryMode==='audio').length;
    const formCount=records.filter((r:any)=>r.status==='submitted'&&!r.isPractice&&r.entryMode==='standard').length;

    if (screen === "home")
      return (
        <HomeScreen
          firstName={firstName(respondentName)}
          studyName={home.study.name}
          consentNeeded={!!consentNeeded}
          consentBody={home.consent?.body}
          busy={busy}
          onAcceptConsent={acceptConsent}
          submittedCount={submitted}
          draftsCount={drafts}
          totalCount={records.length}
          recentRecords={displayRecords.slice(0, 2)}
          occasionRecords={displayRecords.slice(0, 4)}
          onStartDiary={openDiaryModePicker}
          onOpenStudies={() => setScreen("studies")}
          onViewAllEntries={() => setScreen("entries")}
          onNavigate={(key) => setScreen(key as Screen)}
        />
      );

    if (screen === "entries")
      return (
        <EntriesScreen
          onStartDiary={openDiaryModePicker}
          records={displayRecords}
          submittedCount={submitted}
          draftsCount={drafts}
          onNavigate={(key) => setScreen(key as Screen)}
          onToggleTheme={toggleTheme}
        />
      );

    if (screen === "activity")
      return (
        <ActivityScreen
          onStartDiary={openDiaryModePicker}
          submittedCount={submitted}
          daysLogged={daysLogged}
          last14Days={last14}
          formCount={formCount}
          videoCount={videoCount}
          voiceCount={voiceCount}
          onNavigate={(key) => setScreen(key as Screen)}
          onToggleTheme={toggleTheme}
        />
      );

    return (
      <ProfileScreen
        name={respondentName}
        respondentCode={home.respondent.respondentCode}
        studyName={home.study.name}
        activated={["active","activated"].includes(home.respondent.activationStatus)}
        busy={busy}
        onOpenStudies={() => setScreen("studies")}
        onSignOut={logout}
        onNavigate={(key) => setScreen(key as Screen)}
        onToggleTheme={toggleTheme}
        photoSource={photoSource}
        photoBusy={photoBusy}
        onUploadPhoto={uploadProfilePhoto}
        onOpenRewards={()=>openParticipation("rewards")}
        onOpenParticipation={()=>openParticipation()}
        onOpenSync={()=>setScreen("sync")}
        pendingCount={pendingEntries.length}
      />
    );
  }

  if (screen === "diaryMode" && selected)
    return (
      <AppFrame t={t} mode={mode}>
        <ScrollView contentContainerStyle={styles.page}>
          <Pressable onPress={() => setScreen("home")}><Text style={{ color: t.muted, fontSize: 14 }}>‹  Back</Text></Pressable>
          <Text style={[styles.screenTitle, { color: t.text }]}>How would you like to log this consumption?</Text>
          <Text style={[styles.screenCopy, { color: t.muted }]}>Choose Standard to answer the diary questions directly, or Video to record first — you're done as soon as you submit.</Text>
          <Pressable disabled={busy} onPress={startDiary}>
            <Card t={t} style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
              <Icon glyph="▤" t={t} tone="blue" />
              <View style={{ flex: 1 }}>
                <Text style={[styles.studyName, { color: t.text, fontSize: 15 }]}>Standard</Text>
                <Text style={[styles.smallMuted, { color: t.muted, marginTop: 3 }]}>Answer the configured diary questions directly. Audio questions are recorded and sent for transcription.</Text>
              </View>
              <Text style={{ color: t.subtle, fontSize: 20 }}>›</Text>
            </Card>
          </Pressable>
          <Pressable disabled={busy} onPress={startVideoDiary}>
            <Card t={t} style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
              <Icon glyph="◧" t={t} tone="purple" />
              <View style={{ flex: 1 }}>
                <Text style={[styles.studyName, { color: t.text, fontSize: 15 }]}>Video <Text style={{ color: t.purple, fontSize: 11, fontWeight: "800" }}>AI-assisted</Text></Text>
                <Text style={[styles.smallMuted, { color: t.muted, marginTop: 3 }]}>Read the prompts while recording with your front camera. Review your video, then submit.</Text>
              </View>
              <Text style={{ color: t.subtle, fontSize: 20 }}>›</Text>
            </Card>
          </Pressable>
        </ScrollView>
      </AppFrame>
    );

  if (screen === "diaryVideo" && selected && videoScript)
    return <AppFrame t={t} mode={mode}><VideoDiaryScreen mode={mode} respondentId={selected.respondent.id} script={videoScript} onBack={() => setScreen("diaryMode")} onSubmit={submitRecordedVideo} /></AppFrame>;

  if (screen === "diaryQuestionVideo" && selected && standardVideoQuestion)
    return <StandardVideoCaptureScreen
      mode={mode}
      respondentId={selected.respondent.id}
      questionId={standardVideoQuestion.id}
      questionText={standardVideoQuestion.text}
      onBack={() => { setStandardVideoQuestion(null); setScreen("diary"); }}
      onCaptured={(asset) => {
        const question = standardVideoQuestion;
        setMedia((old) => ({ ...old, [String(question.id)]: asset }));
        setMediaAnalysis((old) => { const next = { ...old }; delete next[String(question.id)]; return next; });
        setStandardVideoQuestion(null);
        setScreen("diary");
        analyseEvidence(question, asset);
      }}
    />;

  if (screen === "diary" && selected && questionnaire) return <AppFrame t={t} mode={mode}><KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}><View style={{ flex: 1 }}><ScrollView contentContainerStyle={[styles.page, { paddingBottom: 24 }]} keyboardShouldPersistTaps="handled"><Pressable onPress={() => setScreen("diaryMode")}><Text style={{ color: t.muted, fontSize: 14 }}>‹  Back</Text></Pressable><View style={styles.diaryTitleRow}><Text style={[styles.diaryStudyTitle, { color: t.text }]}>{questionnaire.study.name}</Text></View><Text style={[styles.qText, { color: t.text }]}>When did this occasion happen?</Text><TextInput accessibilityLabel="Occasion date and time with timezone" value={occurrenceTime} onChangeText={setOccurrenceTime} autoCapitalize="none" style={[styles.input,{color:t.text,borderColor:t.border}]} /><Text style={[styles.smallMuted,{color:t.muted}]}>Use YYYY-MM-DDTHH:mm:ssZ (UTC), or include your timezone offset. Back-entry window: {questionnaire.study.backEntryHours} hours.{questionnaire.study.practiceRequired?' This is a practice entry before handover.':''}</Text>{questionnaire.study.diaryMode==='hybrid'?<ChoiceList t={t} options={[["occasion","Consumption occasion"],["period_summary","Period summary"]]} value={participationKind} onChange={setParticipationKind}/>:null}<Text style={styles.aboutLabel}>ABOUT THIS OCCASION</Text>{visibleQuestions.map((q: any) => { const value = answers[String(q.id)]; const problem = problems.find((p) => p.questionId === q.id); return <View key={q.id} style={{ marginBottom: 15 }}><Text style={[styles.qText, { color: t.text }]}>{q.text}{q.required ? <Text style={{ color: t.red }}> *</Text> : null}</Text>{["date","time","rank","scale"].includes(q.type)?<View><Text style={{color:t.muted}}>{q.type==='rank'?`Rank every option using | between them: ${q.options.join(' | ')}`:q.type==='date'?'YYYY-MM-DD':q.type==='time'?'HH:mm (24-hour)':`Scale from ${q.minValue??'no minimum'} to ${q.maxValue??'no maximum'}`}</Text><TextInput value={String(value??'')} onChangeText={v=>setAnswer(q.id,v)} style={[styles.input,{color:t.text,borderColor:t.border}]} keyboardType={q.type==='scale'?'decimal-pad':'default'}/></View>:null}{q.type === "text" ? <TextInput value={String(value ?? "")} onChangeText={(v) => setAnswer(q.id, v)} multiline placeholder="Type your answer" placeholderTextColor={t.subtle} style={[styles.input, styles.textArea, { color: t.text, borderColor: t.border, backgroundColor: t.card }]} /> : null}{q.type === "numeric" ? <View style={styles.counterRow}><Pressable style={[styles.counterBtn, { borderColor: t.border }]} onPress={() => setAnswer(q.id, String(Math.max(0, Number(value || 0)-1)))}><Text style={{ color: t.muted, fontSize: 22 }}>−</Text></Pressable><Text style={{ color: t.text, fontSize: 18, fontWeight: "800", minWidth: 28, textAlign: "center" }}>{String(value || "0")}</Text><Pressable style={[styles.counterBtn, { borderColor: t.border }]} onPress={() => setAnswer(q.id, String(Number(value || 0)+1))}><Text style={{ color: t.muted, fontSize: 22 }}>+</Text></Pressable></View> : null}{q.type === "single" || q.type === "multi" ? <View style={{gap:8}}>{q.options.map((opt: string) => { const on = q.type === "single" ? value === opt : Array.isArray(value) && value.includes(opt); const requiresText = on && (q.otherSpecifyOptions || []).includes(opt); return <View key={opt} style={{gap:6}}><Pressable onPress={() => q.type === "single" ? setAnswer(q.id, opt) : setAnswer(q.id, on ? (value as string[]).filter((x) => x !== opt) : [...(Array.isArray(value) ? value : []), opt])} style={[styles.answerChip, { backgroundColor: on ? t.blueSoft : t.card, borderColor: on ? t.blue : t.border }]}><Text style={{ color: on ? t.blue : t.muted, fontWeight: "700", fontSize: 13 }}>{opt}</Text></Pressable>{requiresText?<TextInput accessibilityLabel={`Please specify ${opt}`} value={otherText[String(q.id)]?.[opt] || ""} onChangeText={(text)=>setOtherSpecify(q.id,opt,text)} placeholder="Please specify…" placeholderTextColor={t.subtle} style={[styles.input,{color:t.text,borderColor:t.blue,backgroundColor:t.card}]}/>:null}</View>; })}</View> : null}{(q.type === "photo" || q.type === "video") ? <Pressable onPress={() => pickEvidence(q)} style={[styles.evidenceCard, { backgroundColor: t.card, borderColor: t.border }]}><Icon glyph={q.type === "video" ? "◧" : "▧"} t={t} /><View style={{ flex: 1 }}><Text style={{ color: t.text, fontWeight: "800" }}>{media[String(q.id)] ? (q.type === "video" ? "Record video again" : "Take photo again") : (q.type === "video" ? "Record video" : "Take photo")}</Text><Text style={[styles.smallMuted, { color: t.muted }]}>Opens the in-app camera — no gallery uploads.</Text></View><Text style={{ color: t.muted, fontSize: 22 }}>›</Text></Pressable> : null}{q.type === "audio" ? <Pressable onPress={() => recordingQuestionId === q.id ? stopRecording(q.id) : startRecording(q.id)} style={[styles.evidenceCard, { backgroundColor: t.card, borderColor: recordingQuestionId === q.id ? t.red : t.border }]}><Icon glyph="♩" t={t} tone={recordingQuestionId === q.id ? undefined : "muted"} /><View style={{ flex: 1 }}><Text style={{ color: recordingQuestionId === q.id ? t.red : t.text, fontWeight: "800" }}>{recordingQuestionId === q.id ? "Recording… tap to stop" : media[String(q.id)] ? "Record voice note again" : "Tap to record voice note"}</Text><Text style={[styles.smallMuted, { color: t.muted }]}>Records a short voice note.</Text></View></Pressable> : null}{media[String(q.id)] ? <CapturedEvidence type={q.type} asset={media[String(q.id)]} analysis={mediaAnalysis[String(q.id)]} t={t} /> : null}{problem ? <Text style={{ color: t.red, fontSize: 12, marginTop: 4 }}>{problem.message}</Text> : null}</View>; })}</ScrollView><View style={[styles.diaryFooter, { backgroundColor: t.nav, borderTopColor: t.border }]}><Pressable onPress={saveDraft} style={[styles.footerSecondary, { borderColor: t.border }]}><Text style={{ color: t.text, fontWeight: "800" }}>Save Draft</Text></Pressable><Pressable disabled={busy} onPress={submitDiary} style={[styles.footerPrimary, { backgroundColor: t.blue }, busy && { opacity: .5 }]}><Text style={{ color: t.white, fontWeight: "800" }}>{busy ? "Submitting…" : "Submit Diary Entry"}</Text></Pressable></View></View></KeyboardAvoidingView></AppFrame>;

  return <AppFrame t={t} mode={mode}><View style={styles.center}><ActivityIndicator color={t.blue} /></View></AppFrame>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  page: { paddingHorizontal: 24, paddingTop: 20, paddingBottom: 24, gap: 12 },
  card: { borderWidth: 1, borderRadius: 18, padding: 14 },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  brandName: { fontSize: 15, fontWeight: "900", letterSpacing: .2 },
  bookMark: { width: 36, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  bookGlyph: { fontSize: 22, fontWeight: "900", marginTop: -2 },
  loginWrap: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 24, paddingBottom: 24, gap: 20, justifyContent: "center" },
  loginTop: { alignItems: "center" },
  loginTitle: { fontSize: 26, fontWeight: "900", marginTop: 12, letterSpacing: .2 },
  loginSubtitle: { fontSize: 13, marginTop: 4 },
  loginFields: { gap: 8, marginTop: 18 },
  label: { fontSize: 12, fontWeight: "700", marginTop: 2 },
  input: { height: 46, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, fontSize: 15 },
  passwordLabelRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 2 },
  forgotPasswordLink: { fontSize: 12, fontWeight: "800" },
  inputShell: { height: 46, borderWidth: 1, borderRadius: 12, flexDirection: "row", alignItems: "center", overflow: "hidden" },
  inputEmbedded: { flex: 1, height: "100%", paddingLeft: 14, paddingRight: 6, fontSize: 15 },
  passwordToggle: { width: 46, height: 46, alignItems: "center", justifyContent: "center" },
  rememberRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 4, paddingVertical: 4 },
  checkbox: { width: 20, height: 20, borderRadius: 5, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
  rememberText: { fontSize: 13, fontWeight: "600" },
  textArea: { height: 96, paddingTop: 12, textAlignVertical: "top" },
  primaryButtonShell: { width: "100%", minHeight: 48, borderRadius: 12, borderWidth: 1, marginTop: 2, overflow: "hidden", elevation: 2, shadowColor: "#091426", shadowOffset: { width: 0, height: 2 }, shadowOpacity: .12, shadowRadius: 4 },
  primaryButton: { width: "100%", minHeight: 46, borderRadius: 11, flexDirection: "row", alignItems: "center", justifyContent: "center", paddingHorizontal: 48, position: "relative" },
  primaryButtonDisabled: { opacity: .5 },
  primaryButtonPressed: { opacity: .84 },
  primaryButtonText: { fontSize: 15, fontWeight: "900", textAlign: "center" },
  buttonArrow: { position: "absolute", right: 18, top: 10, fontSize: 20, lineHeight: 24 },
  outlineButton: { minHeight: 44, borderRadius: 12, borderWidth: 1, alignItems: "center", justifyContent: "center", marginTop: 2 },
  outlineButtonText: { fontSize: 14, fontWeight: "800" },
  firstTimeCard: { borderWidth: 1, borderRadius: 14, padding: 12, flexDirection: "row", gap: 10, alignItems: "center", marginTop: 80 },
  firstTimeTitle: { fontSize: 12, fontWeight: "900" },
  firstTimeCopy: { fontSize: 11, lineHeight: 14, marginTop: 2 },
  secureText: { fontSize: 10, textAlign: "center", marginTop: 8 },
  recoveryWrap: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 28, paddingBottom: 28, justifyContent: "center", gap: 28 },
  backLink: { fontSize: 13, fontWeight: "800", alignSelf: "flex-start" },
  recoveryHeading: { alignItems: "center" },
  recoveryIcon: { width: 64, height: 64, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  recoveryCopy: { maxWidth: 340, fontSize: 13, lineHeight: 19, textAlign: "center", marginTop: 8 },
  recoveryNote: { fontSize: 11, lineHeight: 16, textAlign: "center", marginTop: 4 },
  codeInput: { textAlign: "center", fontSize: 20, fontWeight: "800", letterSpacing: 6 },
  resendButton: { minHeight: 40, alignItems: "center", justifyContent: "center" },
  simpleTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  screenTitle: { fontSize: 26, fontWeight: "900", letterSpacing: -.4 },
  screenCopy: { fontSize: 13, lineHeight: 18 },
  choiceRow: { minHeight: 42, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 10 },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5 },
  choiceText: { fontSize: 13, fontWeight: "700" },
  studyTitleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  studyName: { flex: 1, fontSize: 17, fontWeight: "900", lineHeight: 20 },
  studyMeta: { fontSize: 11.5, marginTop: 4 },
  studyAction: { borderTopWidth: 1, marginTop: 10, paddingTop: 9 },
  pill: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, alignSelf: "flex-start" },
  pillText: { fontSize: 9, fontWeight: "900", letterSpacing: .4 },
  homeBrand: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  bell: { width: 38, height: 34, borderRadius: 17, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  bellDot: { position: "absolute", right: 3, top: 2, width: 5, height: 5, borderRadius: 3, backgroundColor: "#1F5BFF" },
  homeHello: { fontSize: 25, fontWeight: "900", letterSpacing: -.5 },
  homeThanks: { fontSize: 13, marginTop: -7, marginBottom: 2 },
  selectedStudy: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10 },
  selectedStudyName: { fontSize: 15, fontWeight: "900" },
  smallMuted: { fontSize: 11, lineHeight: 14 },
  todayCard: { borderRadius: 20, padding: 16, overflow: "hidden", minHeight: 204 },
  todayBubbleOne: { position: "absolute", width: 100, height: 100, borderRadius: 50, backgroundColor: "rgba(255,255,255,.07)", right: -12, top: -22 },
  todayBubbleTwo: { position: "absolute", width: 68, height: 68, borderRadius: 34, borderWidth: 14, borderColor: "rgba(255,255,255,.08)", right: -5, top: 4 },
  todayHeading: { flexDirection: "row", alignItems: "center", gap: 10 },
  todayTitle: { color: "#FFFFFF", fontSize: 18, fontWeight: "900" },
  todayCopy: { color: "#DDE7FF", fontSize: 12.5, marginTop: 4 },
  logButton: { height: 44, borderRadius: 12, backgroundColor: "#FFFFFF", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 12, marginTop: 15 },
  logButtonText: { color: "#1C4ED8", fontSize: 15, fontWeight: "900" },
  todayStats: { borderTopWidth: 1, borderTopColor: "rgba(255,255,255,.22)", flexDirection: "row", gap: 62, paddingTop: 14, marginTop: 15 },
  todayStatNumber: { color: "#FFFFFF", fontSize: 21, fontWeight: "900" },
  todayStatLabel: { color: "#DDE7FF", fontSize: 10.5 },
  guideCard: { flexDirection: "row", gap: 10, alignItems: "center", paddingVertical: 10 },
  guideTitle: { fontSize: 14, fontWeight: "900" },
  sectionHeading: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 0 },
  sectionTitle: { fontSize: 14, fontWeight: "900" },
  activityRow: { minHeight: 44, flexDirection: "row", alignItems: "center" },
  activityTitle: { fontSize: 13, fontWeight: "800" },
  activityMeta: { fontSize: 10.5, marginTop: 2 },
  loggedCount: { fontSize: 12, fontWeight: "900" },
  occasionGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  occasionCard: { width: "48.7%", minHeight: 48, borderRadius: 18, borderWidth: 1, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12 },
  occasionTime: { fontSize: 11.5, fontWeight: "800" },
  occasionStatus: { fontSize: 9.5, marginTop: 1 },
  bottomNav: { height: 72, borderTopWidth: 1, flexDirection: "row", paddingBottom: Platform.OS === "ios" ? 8 : 0 },
  bottomNavItem: { flex: 1, alignItems: "center", justifyContent: "center", gap: 2 },
  navGlyph: { fontSize: 21, fontWeight: "700" },
  navLabel: { fontSize: 10.5, fontWeight: "600" },
  listHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  themeButton: { width: 42, height: 34, borderRadius: 12, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  filterRow: { flexDirection: "row", gap: 8 },
  filterActive: { borderRadius: 999, paddingHorizontal: 18, paddingVertical: 7 },
  filterActiveText: { color: "#FFFFFF", fontSize: 11.5, fontWeight: "900" },
  filterChip: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 18, paddingVertical: 7 },
  filterText: { fontSize: 11.5, fontWeight: "800" },
  diaryRow: { minHeight: 60, borderRadius: 17, borderWidth: 1, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 10 },
  diaryRowTitle: { fontSize: 13, fontWeight: "900" },
  statGrid: { flexDirection: "row", gap: 10 },
  bigStat: { fontSize: 23, fontWeight: "900", marginTop: 8 },
  bars: { height: 70, flexDirection: "row", gap: 6, alignItems: "flex-end", marginTop: 12 },
  bar: { flex: 1, borderRadius: 2 },
  progressLabel: { flexDirection: "row", justifyContent: "space-between" },
  progressName: { fontSize: 12, fontWeight: "800" },
  progressMeta: { fontSize: 10.5 },
  progressTrack: { height: 4, borderRadius: 2, marginTop: 5, overflow: "hidden" },
  profilePerson: { flexDirection: "row", gap: 12, alignItems: "center", marginBottom: 2 },
  avatar: { width: 48, height: 38, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  profileName: { fontSize: 16, fontWeight: "900" },
  profileInfoRow: { minHeight: 42, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  profileLabel: { fontSize: 12 },
  profileValue: { fontSize: 12, fontWeight: "800", maxWidth: "65%", textAlign: "right" },
  settingRow: { minHeight: 56, flexDirection: "row", alignItems: "center", gap: 10 },
  settingText: { flex: 1, fontSize: 13, fontWeight: "900" },
  profileFootnote: { fontSize: 10.5, lineHeight: 14 },
  diaryTitleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  diaryStudyTitle: { fontSize: 17, fontWeight: "900", flex: 1 },
  practicePill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  qText: { fontSize: 13.5, fontWeight: "800", marginBottom: 8 },
  timeCard: { height: 44, borderWidth: 1, borderRadius: 13, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14 },
  aboutLabel: { color: "#5D93FF", fontSize: 11, fontWeight: "900", letterSpacing: .9, marginTop: 2 },
  counterRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  counterBtn: { width: 40, height: 34, borderRadius: 10, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  answerChips: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  answerChip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 13, paddingVertical: 7 },
  evidenceCard: { borderWidth: 1, borderRadius: 14, minHeight: 58, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 10 },
  mediaPreviewCard: { borderWidth: 1, borderRadius: 14, padding: 10, gap: 9, marginTop: 8, overflow: "hidden" },
  photoPreview: { width: "100%", height: 210, borderRadius: 10, backgroundColor: "#101827" },
  videoPreview: { width: "100%", height: 230, borderRadius: 10, backgroundColor: "#101827" },
  audioPreview: { minHeight: 58, borderWidth: 1, borderRadius: 12, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 10 },
  previewPlay: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  previewStatusRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  transcriptCard: { borderWidth: 1, borderRadius: 12, padding: 11, gap: 8 },
  analysisBusy: { flexDirection: "row", alignItems: "center", gap: 8 },
  scoreRow: { flexDirection: "row", alignItems: "flex-start", gap: 9, marginTop: 2 },
  scorePill: { minWidth: 62, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6, alignItems: "center" },
  voiceRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  diaryFooter: { height: 72, borderTopWidth: 1, paddingHorizontal: 24, flexDirection: "row", alignItems: "center", gap: 10 },
  footerSecondary: { flex: 1, height: 44, borderRadius: 12, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  footerPrimary: { flex: 1.45, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
});
