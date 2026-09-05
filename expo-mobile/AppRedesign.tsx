import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import * as ImagePicker from "expo-image-picker";
import {
  useAudioRecorder,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from "expo-audio";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useColorScheme } from "nativewind";
import { api, getToken, MobileEnrolment, setToken } from "./src/api";
import { HomeScreen, DisplayRecord } from "./src/screens/Home";
import { EntriesScreen } from "./src/screens/Entries";
import { ActivityScreen } from "./src/screens/Activity";
import { ProfileScreen } from "./src/screens/Profile";

type ThemeMode = "dark" | "light";
type Screen =
  | "loading"
  | "login"
  | "profileGate"
  | "studies"
  | "home"
  | "entries"
  | "activity"
  | "profile"
  | "diary";
type AnswerMap = Record<string, string | string[]>;
type MediaAsset = { uri: string; fileName?: string | null; mimeType?: string | null };
type MediaMap = Record<string, MediaAsset>;
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

const padTop = Platform.OS === "android" ? RNStatusBar.currentHeight || 0 : 0;
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
  return <View style={[styles.bookMark, { backgroundColor: t.blueSoft }, large && { width: 64, height: 50, borderRadius: 14 }]}><Text style={[styles.bookGlyph, { color: "#5D93FF" }, large && { fontSize: 30 }]}>▭</Text></View>;
}

function PrimaryButton({ title, onPress, disabled = false, t, inverse = false, arrow = true }: any) {
  return <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.primaryButton, { backgroundColor: inverse ? t.card2 : t.blue }, disabled && { opacity: .5 }, pressed && !disabled && { opacity: .84 }]}><Text style={[styles.primaryButtonText, { color: inverse ? t.blue : t.white }]}>{title}</Text>{arrow ? <Text style={[styles.buttonArrow, { color: inverse ? t.blue : t.white }]}>→</Text> : null}</Pressable>;
}

function OutlineButton({ title, onPress, t }: any) {
  return <Pressable onPress={onPress} style={({ pressed }) => [styles.outlineButton, { borderColor: t.borderStrong, backgroundColor: t.card2 }, pressed && { opacity: .8 }]}><Text style={[styles.outlineButtonText, { color: t.text }]}>{title}</Text></Pressable>;
}

function AppFrame({ children, t, mode }: { children: React.ReactNode; t: Theme; mode: ThemeMode }) {
  return <View style={[styles.root, { backgroundColor: t.bg }]}><StatusBar style={mode === "dark" ? "light" : "dark"} />{children}</View>;
}

function Brand({ t }: { t: Theme }) {
  return <View style={styles.brandRow}><View style={{ width: 22, alignItems: "center" }}><Text style={{ color: "#5D93FF", fontSize: 19 }}>▭</Text></View><Text style={[styles.brandName, { color: t.text }]}>Inicio Diary</Text></View>;
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
  const [enrolments, setEnrolments] = useState<MobileEnrolment[]>([]);
  const [selected, setSelected] = useState<MobileEnrolment | null>(null);
  const [home, setHome] = useState<any>(null);
  const [questionnaire, setQuestionnaire] = useState<any>(null);
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [media, setMedia] = useState<MediaMap>({});
  const [recordingQuestionId, setRecordingQuestionId] = useState<number | null>(null);
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [problems, setProblems] = useState<any[]>([]);
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
    setEnrolments(me.enrolments || []);
    if ((me.enrolments || []).length === 1) await openStudy(me.enrolments[0], false);
    else setScreen("studies");
  }

  async function loadProfileGate() {
    const result = await api.profile();
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
        if (await getToken()) await loadProfileGate();
        else setScreen("login");
      } catch {
        await setToken(null);
        setScreen("login");
      }
    })();
  }, []);

  async function login() {
    setError("");
    if (!username.trim() || !password) return setError("Enter your username and password.");
    setBusy(true);
    try {
      const result = await api.login(username.trim(), password);
      await setToken(result.token);
      setPassword("");
      await loadProfileGate();
    } catch (e: any) { setError(e.message || "Unable to sign in."); }
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
    setSelected(null); setHome(null); setEnrolments([]); setError(""); setScreen("login");
    setBusy(false);
  }

  async function openStudy(item: MobileEnrolment, setBusyState = true) {
    if (setBusyState) setBusy(true);
    setError("");
    try {
      const data = await api.home(item.respondent.id);
      setSelected(item); setHome(data); setScreen("home");
    } catch (e: any) { Alert.alert("Could not open study", e.message); }
    finally { if (setBusyState) setBusy(false); }
  }

  async function acceptConsent() {
    if (!selected) return;
    setBusy(true);
    try { await api.consent(selected.respondent.id); setHome(await api.home(selected.respondent.id)); }
    catch (e: any) { Alert.alert("Consent could not be saved", e.message); }
    finally { setBusy(false); }
  }

  async function startDiary() {
    if (!selected) return;
    setBusy(true); setProblems([]);
    try {
      const q = await api.questionnaire(selected.respondent.id);
      setQuestionnaire(q);
      const saved = draftKey ? await AsyncStorage.getItem(draftKey) : null;
      if (saved) { try { setAnswers(JSON.parse(saved).answers || {}); } catch { setAnswers({}); } } else setAnswers({});
      setMedia({}); setScreen("diary");
    } catch (e: any) {
      if (e.profileRequired) await loadProfileGate();
      else Alert.alert("Diary unavailable", e.message);
    } finally { setBusy(false); }
  }

  async function saveDraft() {
    if (!draftKey) return;
    await AsyncStorage.setItem(draftKey, JSON.stringify({ answers, savedAt: new Date().toISOString() }));
    Alert.alert("Draft saved", "Your answers are stored on this device. You can continue later.");
  }

  function setAnswer(id: number, value: string | string[]) {
    setAnswers((old) => ({ ...old, [String(id)]: value }));
    setProblems((old) => old.filter((p) => p.questionId !== id));
  }

  async function pickEvidence(q: any) {
    try {
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: q.type === "video" ? ["videos"] : ["images"], quality: .82, videoMaxDuration: 45 } as any);
      if (!result.canceled && result.assets?.[0]) setMedia((old) => ({ ...old, [String(q.id)]: result.assets[0] }));
    } catch (e: any) { Alert.alert("Camera unavailable", e.message || "Could not open the camera."); }
  }

  async function startRecording(questionId: number) {
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        Alert.alert("Microphone permission needed", "Enable microphone access to record a voice note.");
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
      setRecordingQuestionId(questionId);
    } catch (e: any) {
      Alert.alert("Microphone unavailable", e.message || "Could not start recording.");
    }
  }

  async function stopRecording(questionId: number) {
    if (recordingQuestionId !== questionId) return;
    try {
      await audioRecorder.stop();
      if (audioRecorder.uri) {
        setMedia((old) => ({
          ...old,
          [String(questionId)]: { uri: audioRecorder.uri as string, fileName: `voice-note-${questionId}.m4a`, mimeType: "audio/m4a" },
        }));
      }
    } catch (e: any) {
      Alert.alert("Recording failed", e.message || "Could not save the voice note.");
    } finally {
      setRecordingQuestionId(null);
    }
  }

  async function submitDiary() {
    if (!selected || !questionnaire) return;
    setBusy(true); setProblems([]);
    try {
      const form = new FormData();
      form.append("action", "submit"); form.append("entry_mode", "standard"); form.append("occurrence_time", new Date().toISOString().slice(0, 19)); form.append("answers_json", JSON.stringify(answers));
      Object.entries(media).forEach(([questionId, asset]) => {
        const q = questionnaire.questions.find((x: any) => String(x.id) === questionId);
        const defaultExt = q?.type === "video" ? "mp4" : q?.type === "audio" ? "m4a" : "jpg";
        const defaultType = q?.type === "video" ? "video/mp4" : q?.type === "audio" ? "audio/m4a" : "image/jpeg";
        const ext = asset.fileName?.split(".").pop() || defaultExt;
        const type = asset.mimeType || defaultType;
        form.append(`${q?.type || "photo"}_q_${questionId}`, { uri: asset.uri, name: asset.fileName || `evidence-${questionId}.${ext}`, type } as any);
      });
      await api.submitDiary(selected.respondent.id, form);
      if (draftKey) await AsyncStorage.removeItem(draftKey);
      setAnswers({}); setMedia({}); setHome(await api.home(selected.respondent.id)); setScreen("home");
      Alert.alert("Diary submitted", "Your entry has been saved securely.");
    } catch (e: any) {
      if (e.profileRequired) await loadProfileGate();
      else if (e.problems?.length) setProblems(e.problems);
      else Alert.alert("Could not submit", e.message);
    } finally { setBusy(false); }
  }

  const visibleQuestions = useMemo(() => questionnaire?.questions?.filter((q: any) => isVisible(q.id, questionnaire.rules || [], answers)) || [], [questionnaire, answers]);
  const records = home?.records || [];
  const submitted = records.filter((r: any) => r.status === "submitted" && !r.isPractice).length;
  const drafts = records.filter((r: any) => r.status === "draft").length;
  const respondentName = home?.respondent?.name || selected?.respondent?.name || "";

  if (screen === "loading") return <AppFrame t={t} mode={mode}><View style={styles.center}><ActivityIndicator size="large" color={t.blue} /></View></AppFrame>;

  if (screen === "login") return <AppFrame t={t} mode={mode}><KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}><ScrollView contentContainerStyle={styles.loginWrap} keyboardShouldPersistTaps="handled"><View style={styles.loginTop}><BookMark t={t} large /><Text style={[styles.loginTitle, { color: t.text }]}>Inicio Diary</Text><Text style={[styles.loginSubtitle, { color: t.muted }]}>Sign in to your consumption diary.</Text></View><View style={styles.loginFields}><Text style={[styles.label, { color: t.muted }]}>Username</Text><TextInput value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} placeholder="Your username" placeholderTextColor={t.subtle} style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.bg }]} /><Text style={[styles.label, { color: t.muted }]}>Password</Text><TextInput value={password} onChangeText={setPassword} secureTextEntry placeholder="Your password" placeholderTextColor={t.subtle} style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.bg }]} />{error ? <Text style={{ color: t.red, fontSize: 12 }}>{error}</Text> : null}<PrimaryButton title={busy ? "Opening…" : "Open my diary"} onPress={login} disabled={busy} t={t} arrow={false} /></View><View style={[styles.firstTimeCard, { backgroundColor: t.card, borderColor: t.border }]}><Icon glyph="⌘" t={t} /><View style={{ flex: 1 }}><Text style={[styles.firstTimeTitle, { color: t.text }]}>First time here?</Text><Text style={[styles.firstTimeCopy, { color: t.muted }]}>Open the invitation link or scan the QR code you received to set up your login.</Text></View></View><Text style={[styles.secureText, { color: t.subtle }]}>Inicio Diary · Secure respondent access</Text></ScrollView></KeyboardAvoidingView></AppFrame>;

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
    const last14 = Array.from({ length: 14 }, (_, i) => Math.max(1, ((i * 7 + submitted * 3) % 5) + 1));
    const videoCount = Math.max(records.length ? 1 : 0, Math.round(submitted * 0.3));
    const voiceCount = Math.max(records.length ? 1 : 0, Math.round(submitted * 0.15));
    const formCount = Math.max(0, submitted - videoCount - voiceCount) || submitted;

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
          onStartDiary={startDiary}
          onOpenStudies={() => setScreen("studies")}
          onViewAllEntries={() => setScreen("entries")}
          onNavigate={(key) => setScreen(key as Screen)}
        />
      );

    if (screen === "entries")
      return (
        <EntriesScreen
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
        activated={home.respondent.consentStatus === "given"}
        busy={busy}
        onOpenStudies={() => setScreen("studies")}
        onSignOut={logout}
        onNavigate={(key) => setScreen(key as Screen)}
        onToggleTheme={toggleTheme}
        onSwitchToInterviewer={onSwitchToInterviewer}
      />
    );
  }

  if (screen === "diary" && selected && questionnaire) return <AppFrame t={DARK} mode="dark"><KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}><View style={{ flex: 1 }}><ScrollView contentContainerStyle={[styles.page, { paddingBottom: 90 }]} keyboardShouldPersistTaps="handled"><Pressable onPress={() => setScreen("home")}><Text style={{ color: DARK.muted, fontSize: 14 }}>‹  Back</Text></Pressable><View style={styles.diaryTitleRow}><Text style={[styles.diaryStudyTitle, { color: DARK.text }]}>{questionnaire.study.name}</Text></View><Text style={[styles.qText, { color: DARK.text }]}>When did this occasion happen?</Text><View style={[styles.timeCard, { borderColor: DARK.border, backgroundColor: DARK.card }]}><Text style={{ color: "#5D93FF" }}>□</Text><Text style={{ color: DARK.text, fontWeight: "700" }}>Today, {new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</Text></View><Text style={[styles.smallMuted, { color: DARK.muted }]}>You can log something that happened up to 4h ago.</Text><Text style={styles.aboutLabel}>ABOUT THIS OCCASION</Text>{visibleQuestions.map((q: any) => { const value = answers[String(q.id)]; const problem = problems.find((p) => p.questionId === q.id); return <View key={q.id} style={{ marginBottom: 15 }}><Text style={[styles.qText, { color: DARK.text }]}>{q.text}{q.required ? <Text style={{ color: DARK.red }}> *</Text> : null}</Text>{q.type === "text" ? <TextInput value={String(value ?? "")} onChangeText={(v) => setAnswer(q.id, v)} multiline placeholder="Type your answer" placeholderTextColor={DARK.subtle} style={[styles.input, styles.textArea, { color: DARK.text, borderColor: DARK.border, backgroundColor: DARK.card }]} /> : null}{q.type === "numeric" ? <View style={styles.counterRow}><Pressable style={[styles.counterBtn, { borderColor: DARK.border }]} onPress={() => setAnswer(q.id, String(Math.max(0, Number(value || 0)-1)))}><Text style={{ color: DARK.muted, fontSize: 22 }}>−</Text></Pressable><Text style={{ color: DARK.text, fontSize: 18, fontWeight: "800", minWidth: 28, textAlign: "center" }}>{String(value || "0")}</Text><Pressable style={[styles.counterBtn, { borderColor: DARK.border }]} onPress={() => setAnswer(q.id, String(Number(value || 0)+1))}><Text style={{ color: DARK.muted, fontSize: 22 }}>+</Text></Pressable></View> : null}{q.type === "single" || q.type === "multi" ? <View style={styles.answerChips}>{q.options.map((opt: string) => { const on = q.type === "single" ? value === opt : Array.isArray(value) && value.includes(opt); return <Pressable key={opt} onPress={() => q.type === "single" ? setAnswer(q.id, opt) : setAnswer(q.id, on ? (value as string[]).filter((x) => x !== opt) : [...(Array.isArray(value) ? value : []), opt])} style={[styles.answerChip, { backgroundColor: on ? DARK.blueSoft : DARK.card, borderColor: on ? DARK.blue : DARK.border }]}><Text style={{ color: on ? "#9EBBFF" : DARK.muted, fontWeight: "700", fontSize: 13 }}>{opt}</Text></Pressable>; })}</View> : null}{(q.type === "photo" || q.type === "video") ? <Pressable onPress={() => pickEvidence(q)} style={[styles.evidenceCard, { backgroundColor: DARK.card, borderColor: DARK.border }]}><Icon glyph={q.type === "video" ? "◧" : "▧"} t={DARK} /><View style={{ flex: 1 }}><Text style={{ color: DARK.text, fontWeight: "800" }}>{q.type === "video" ? "Record video" : "Take photo"}</Text><Text style={[styles.smallMuted, { color: DARK.muted }]}>Opens your camera — no gallery photos.</Text></View><Text style={{ color: DARK.muted, fontSize: 22 }}>›</Text></Pressable> : null}{q.type === "audio" ? <Pressable onPressIn={() => startRecording(q.id)} onPressOut={() => stopRecording(q.id)} style={[styles.evidenceCard, { backgroundColor: DARK.card, borderColor: recordingQuestionId === q.id ? DARK.red : DARK.border }]}><Icon glyph="♩" t={DARK} tone={recordingQuestionId === q.id ? undefined : "muted"} /><View style={{ flex: 1 }}><Text style={{ color: recordingQuestionId === q.id ? DARK.red : DARK.text, fontWeight: "800" }}>{recordingQuestionId === q.id ? "Recording… release to stop" : "Press and hold to record"}</Text><Text style={[styles.smallMuted, { color: DARK.muted }]}>Records a short voice note.</Text></View></Pressable> : null}{media[String(q.id)] ? <Text style={{ color: DARK.green, marginTop: 6, fontSize: 11 }}>✓ Evidence captured</Text> : null}{problem ? <Text style={{ color: DARK.red, fontSize: 12, marginTop: 4 }}>{problem.message}</Text> : null}</View>; })}</ScrollView><View style={[styles.diaryFooter, { backgroundColor: DARK.nav, borderTopColor: DARK.border }]}><Pressable onPress={saveDraft} style={[styles.footerSecondary, { borderColor: DARK.border }]}><Text style={{ color: DARK.text, fontWeight: "800" }}>Save Draft</Text></Pressable><Pressable disabled={busy} onPress={submitDiary} style={[styles.footerPrimary, { backgroundColor: DARK.blue }, busy && { opacity: .5 }]}><Text style={{ color: DARK.white, fontWeight: "800" }}>{busy ? "Submitting…" : "Submit Diary Entry"}</Text></Pressable></View></View></KeyboardAvoidingView></AppFrame>;

  return <AppFrame t={t} mode={mode}><View style={styles.center}><ActivityIndicator color={t.blue} /></View></AppFrame>;
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingTop: padTop },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  page: { paddingHorizontal: 24, paddingTop: 18, paddingBottom: 34, gap: 12 },
  card: { borderWidth: 1, borderRadius: 18, padding: 14 },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  brandName: { fontSize: 15, fontWeight: "900", letterSpacing: .2 },
  bookMark: { width: 36, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  bookGlyph: { fontSize: 22, fontWeight: "900", marginTop: -2 },
  loginWrap: { minHeight: "100%", paddingHorizontal: 28, paddingTop: 70, paddingBottom: 24, justifyContent: "space-between" },
  loginTop: { alignItems: "center" },
  loginTitle: { fontSize: 26, fontWeight: "900", marginTop: 12, letterSpacing: .2 },
  loginSubtitle: { fontSize: 13, marginTop: 4 },
  loginFields: { gap: 8, marginTop: 18 },
  label: { fontSize: 12, fontWeight: "700", marginTop: 2 },
  input: { height: 46, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, fontSize: 15 },
  textArea: { height: 96, paddingTop: 12, textAlignVertical: "top" },
  primaryButton: { minHeight: 46, borderRadius: 12, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 12, paddingHorizontal: 18, marginTop: 2 },
  primaryButtonText: { fontSize: 15, fontWeight: "900" },
  buttonArrow: { fontSize: 20, marginTop: -2 },
  outlineButton: { minHeight: 44, borderRadius: 12, borderWidth: 1, alignItems: "center", justifyContent: "center", marginTop: 2 },
  outlineButtonText: { fontSize: 14, fontWeight: "800" },
  firstTimeCard: { borderWidth: 1, borderRadius: 14, padding: 12, flexDirection: "row", gap: 10, alignItems: "center", marginTop: 80 },
  firstTimeTitle: { fontSize: 12, fontWeight: "900" },
  firstTimeCopy: { fontSize: 11, lineHeight: 14, marginTop: 2 },
  secureText: { fontSize: 10, textAlign: "center", marginTop: 8 },
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
  voiceRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  diaryFooter: { height: 72, borderTopWidth: 1, paddingHorizontal: 24, flexDirection: "row", alignItems: "center", gap: 10 },
  footerSecondary: { flex: 1, height: 44, borderRadius: 12, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  footerPrimary: { flex: 1.45, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
});
