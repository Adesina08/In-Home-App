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
import AsyncStorage from "@react-native-async-storage/async-storage";
import { api, getToken, MobileEnrolment, setToken } from "./src/api";
import { colors } from "./src/theme";

type Screen = "loading" | "login" | "verify" | "studies" | "home" | "diary";
type AnswerMap = Record<string, string | string[]>;
type MediaMap = Record<string, ImagePicker.ImagePickerAsset>;

const padTop = Platform.OS === "android" ? RNStatusBar.currentHeight || 0 : 0;

function Button({ title, onPress, secondary = false, danger = false, disabled = false }: any) {
  return (
    <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.button, secondary && styles.buttonSecondary, danger && styles.buttonDanger, disabled && { opacity: 0.5 }, pressed && !disabled && { opacity: 0.82 }]}>
      <Text style={[styles.buttonText, secondary && styles.buttonSecondaryText]}>{title}</Text>
    </Pressable>
  );
}

function Card({ children, style }: any) {
  return <View style={[styles.card, style]}>{children}</View>;
}

function Header({ title, subtitle, onBack, action }: any) {
  return (
    <View style={styles.header}>
      <View style={styles.headerRow}>
        {onBack ? <Pressable onPress={onBack} style={styles.back}><Text style={styles.backText}>‹</Text></Pressable> : null}
        <View style={{ flex: 1 }}><Text style={styles.headerTitle}>{title}</Text>{subtitle ? <Text style={styles.headerSub}>{subtitle}</Text> : null}</View>
        {action}
      </View>
    </View>
  );
}

function AppShell({ children }: any) {
  return (
    <View style={styles.root}>
      <StatusBar style="light" backgroundColor={colors.navy} />
      <View style={styles.brandBar}>
        <View style={styles.brandMark}><Text style={styles.brandMarkText}>I</Text></View>
        <View><Text style={styles.brandName}>INICIO</Text><Text style={styles.brandTag}>In-Home Consumption</Text></View>
      </View>
      {children}
    </View>
  );
}

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

export default function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [contact, setContact] = useState("");
  const [code, setCode] = useState("");
  const [diaryLink, setDiaryLink] = useState("");
  const [loginMode, setLoginMode] = useState<"otp" | "link">("otp");
  const [simulated, setSimulated] = useState(false);
  const [enrolments, setEnrolments] = useState<MobileEnrolment[]>([]);
  const [selected, setSelected] = useState<MobileEnrolment | null>(null);
  const [home, setHome] = useState<any>(null);
  const [questionnaire, setQuestionnaire] = useState<any>(null);
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [media, setMedia] = useState<MediaMap>({});
  const [problems, setProblems] = useState<any[]>([]);

  const draftKey = selected ? `inicio.draft.${selected.respondent.id}` : "";

  async function loadMe() {
    const me = await api.me();
    setEnrolments(me.enrolments || []);
    setScreen("studies");
  }

  useEffect(() => {
    (async () => {
      try {
        if (await getToken()) await loadMe();
        else setScreen("login");
      } catch {
        await setToken(null);
        setScreen("login");
      }
    })();
  }, []);

  async function requestCode() {
    setError("");
    if (!contact.trim()) return setError("Enter the phone number or email you used for INICIO.");
    setBusy(true);
    try {
      const result = await api.requestCode(contact.trim());
      setSimulated(result.simulated);
      setScreen("verify");
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function verifyCode() {
    setError("");
    setBusy(true);
    try {
      const result = await api.verifyCode(contact.trim(), code.trim());
      await setToken(result.token);
      setCode("");
      await loadMe();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function signInWithLink() {
    setError("");
    if (!diaryLink.trim()) return setError("Paste the personal diary link you received from INICIO.");
    setBusy(true);
    try {
      const result = await api.diaryLinkLogin(diaryLink.trim());
      await setToken(result.token);
      setDiaryLink("");
      await loadMe();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function logout() {
    setBusy(true);
    try { await api.logout(); } catch {}
    await setToken(null);
    setSelected(null); setHome(null); setEnrolments([]); setError(""); setScreen("login");
    setBusy(false);
  }

  async function openStudy(item: MobileEnrolment) {
    setBusy(true); setError("");
    try {
      const data = await api.home(item.respondent.id);
      setSelected(item); setHome(data); setScreen("home");
    } catch (e: any) { Alert.alert("Could not open study", e.message); }
    finally { setBusy(false); }
  }

  async function acceptConsent() {
    if (!selected) return;
    setBusy(true);
    try {
      await api.consent(selected.respondent.id);
      const data = await api.home(selected.respondent.id);
      setHome(data);
    } catch (e: any) { Alert.alert("Consent could not be saved", e.message); }
    finally { setBusy(false); }
  }

  async function startDiary() {
    if (!selected) return;
    setBusy(true); setProblems([]);
    try {
      const q = await api.questionnaire(selected.respondent.id);
      setQuestionnaire(q);
      const saved = draftKey ? await AsyncStorage.getItem(draftKey) : null;
      if (saved) {
        try { setAnswers(JSON.parse(saved).answers || {}); } catch { setAnswers({}); }
      } else setAnswers({});
      setMedia({});
      setScreen("diary");
    } catch (e: any) { Alert.alert("Diary unavailable", e.message); }
    finally { setBusy(false); }
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

  async function pickEvidence(q: any, camera = false) {
    try {
      const options: any = { mediaTypes: q.type === "video" ? ["videos"] : ["images"], quality: 0.82, videoMaxDuration: 45 };
      const result = camera ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
      if (!result.canceled && result.assets?.[0]) setMedia((old) => ({ ...old, [String(q.id)]: result.assets[0] }));
    } catch (e: any) { Alert.alert("Evidence unavailable", e.message || "Could not open the camera or library."); }
  }

  async function submitDiary() {
    if (!selected || !questionnaire) return;
    setBusy(true); setProblems([]);
    try {
      const form = new FormData();
      form.append("action", "submit");
      form.append("entry_mode", "standard");
      form.append("occurrence_time", new Date().toISOString().slice(0, 19));
      form.append("answers_json", JSON.stringify(answers));
      Object.entries(media).forEach(([questionId, asset]) => {
        const q = questionnaire.questions.find((x: any) => String(x.id) === questionId);
        const ext = asset.fileName?.split(".").pop() || (q?.type === "video" ? "mp4" : "jpg");
        const type = asset.mimeType || (q?.type === "video" ? "video/mp4" : "image/jpeg");
        form.append(`${q?.type || "photo"}_q_${questionId}`, { uri: asset.uri, name: asset.fileName || `evidence-${questionId}.${ext}`, type } as any);
      });
      const result = await api.submitDiary(selected.respondent.id, form);
      if (draftKey) await AsyncStorage.removeItem(draftKey);
      setAnswers({}); setMedia({});
      const data = await api.home(selected.respondent.id);
      setHome(data); setScreen("home");
      Alert.alert(result.status === "screened_out" ? "Thank you" : "Diary submitted", result.status === "screened_out" ? "The study has recorded your response." : "Your entry has been saved securely.");
    } catch (e: any) {
      if (e.problems?.length) setProblems(e.problems);
      else Alert.alert("Could not submit", e.message);
    } finally { setBusy(false); }
  }

  const visibleQuestions = useMemo(() => questionnaire?.questions?.filter((q: any) => isVisible(q.id, questionnaire.rules || [], answers)) || [], [questionnaire, answers]);

  if (screen === "loading") return <AppShell><View style={styles.center}><ActivityIndicator size="large" color={colors.blue} /><Text style={styles.loadingText}>Opening INICIO…</Text></View></AppShell>;

  if (screen === "login") return (
    <AppShell>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.authWrap} keyboardShouldPersistTaps="handled">
          <Text style={styles.heroEyebrow}>WELCOME</Text>
          <Text style={styles.heroTitle}>Your consumption diary, in one place.</Text>
          <Text style={styles.heroCopy}>Sign in to see your studies, complete diary entries and upload evidence securely.</Text>
          <Card style={styles.authCard}>
            <View style={styles.segment}>
              <Pressable onPress={() => { setLoginMode("otp"); setError(""); }} style={[styles.segmentItem, loginMode === "otp" && styles.segmentActive]}><Text style={[styles.segmentText, loginMode === "otp" && styles.segmentTextActive]}>Phone / email</Text></Pressable>
              <Pressable onPress={() => { setLoginMode("link"); setError(""); }} style={[styles.segmentItem, loginMode === "link" && styles.segmentActive]}><Text style={[styles.segmentText, loginMode === "link" && styles.segmentTextActive]}>Diary link</Text></Pressable>
            </View>
            {loginMode === "otp" ? <>
              <Text style={styles.fieldLabel}>Phone number or email</Text>
              <TextInput value={contact} onChangeText={setContact} autoCapitalize="none" keyboardType="email-address" placeholder="e.g. +234… or name@email.com" placeholderTextColor="#9AA8BA" style={styles.input} />
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <Button title={busy ? "Sending…" : "Send verification code"} onPress={requestCode} disabled={busy} />
            </> : <>
              <Text style={styles.fieldLabel}>Personal INICIO diary link</Text>
              <TextInput value={diaryLink} onChangeText={setDiaryLink} autoCapitalize="none" placeholder="https://…/r/your-token" placeholderTextColor="#9AA8BA" style={styles.input} />
              <Text style={styles.helpText}>Use this if an interviewer gave you a personal diary link and you do not have an INICIO account.</Text>
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <Button title={busy ? "Opening…" : "Open my diary"} onPress={signInWithLink} disabled={busy} />
            </>}
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </AppShell>
  );

  if (screen === "verify") return (
    <AppShell>
      <Header title="Verify your account" subtitle={contact} onBack={() => { setError(""); setScreen("login"); }} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
          <Card>
            <Text style={styles.cardTitle}>Enter your 6-digit code</Text>
            <Text style={styles.cardCopy}>{simulated ? "This deployment is using simulated messaging. Ask the study team for the test code from the message log." : "We sent a one-time code to the contact above."}</Text>
            <TextInput value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} placeholder="000000" placeholderTextColor="#A0AEC0" style={[styles.input, styles.codeInput]} />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Button title={busy ? "Checking…" : "Verify & continue"} onPress={verifyCode} disabled={busy || code.length < 6} />
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </AppShell>
  );

  if (screen === "studies") return (
    <AppShell>
      <Header title="My studies" subtitle="Choose a study to continue" action={<Pressable onPress={logout}><Text style={styles.headerAction}>Sign out</Text></Pressable>} />
      <ScrollView contentContainerStyle={styles.page}>
        {enrolments.map((item) => (
          <Pressable key={item.respondent.id} onPress={() => openStudy(item)}>
            <Card style={styles.studyCard}>
              <View style={styles.studyTop}><View style={[styles.statusDot, { backgroundColor: item.study.status === "live" ? colors.green : colors.amber }]} /><Text style={styles.studyStatus}>{item.study.status.toUpperCase()}</Text></View>
              <Text style={styles.studyName}>{item.study.name}</Text>
              <Text style={styles.studyMeta}>{[item.study.market, item.study.category, item.study.diaryMode ? `${item.study.diaryMode} diary` : null].filter(Boolean).join(" · ")}</Text>
              <View style={styles.studyBottom}><Text style={styles.countBig}>{item.submittedCount}</Text><Text style={styles.countLabel}>submitted entries</Text><Text style={styles.chevron}>›</Text></View>
            </Card>
          </Pressable>
        ))}
        {!enrolments.length ? <Card><Text style={styles.cardTitle}>No studies yet</Text><Text style={styles.cardCopy}>When you are enrolled in an INICIO study it will appear here.</Text></Card> : null}
      </ScrollView>
    </AppShell>
  );

  if (screen === "home" && selected && home) {
    const submitted = home.records.filter((r: any) => r.status === "submitted" && !r.isPractice).length;
    const drafts = home.records.filter((r: any) => r.status === "draft").length;
    const consentNeeded = home.respondent.consentStatus !== "given" && home.consent;
    return (
      <AppShell>
        <Header title={home.study.name} subtitle={[home.study.market, home.study.diaryMode ? `${home.study.diaryMode} diary` : null].filter(Boolean).join(" · ")} onBack={() => setScreen("studies")} />
        <ScrollView contentContainerStyle={styles.page}>
          <View style={styles.welcome}><Text style={styles.heroEyebrow}>YOUR STUDY</Text><Text style={styles.welcomeTitle}>Hi {home.respondent.name?.split(" ")[0] || home.respondent.respondentCode}</Text><Text style={styles.welcomeCopy}>Keep your diary up to date while the occasion is still fresh.</Text></View>
          {consentNeeded ? <Card style={{ borderColor: "#F2C966" }}><Text style={styles.cardTitle}>Consent required</Text><Text style={styles.cardCopy}>{home.consent.body}</Text><Button title={busy ? "Saving…" : "I agree and want to take part"} onPress={acceptConsent} disabled={busy} /></Card> : null}
          <Card style={styles.todayCard}>
            <View style={{ flex: 1 }}><Text style={styles.todayLabel}>TODAY'S DIARY</Text><Text style={styles.todayTitle}>{drafts ? "You have a draft to continue" : "Log a consumption occasion"}</Text><Text style={styles.cardCopy}>Answer the study questions and add photo/video evidence where useful.</Text></View>
            <Button title={drafts ? "Continue diary" : "Start diary"} onPress={startDiary} disabled={!!consentNeeded || busy} />
          </Card>
          <View style={styles.statRow}><Card style={styles.statCard}><Text style={styles.statNumber}>{submitted}</Text><Text style={styles.statLabel}>Submitted</Text></Card><Card style={styles.statCard}><Text style={styles.statNumber}>{drafts}</Text><Text style={styles.statLabel}>Drafts</Text></Card></View>
          {home.study.inviteBrief ? <Card><Text style={styles.cardTitle}>Study guide</Text><Text style={styles.cardCopy}>{home.study.inviteBrief}</Text></Card> : null}
          <Text style={styles.sectionTitle}>Recent activity</Text>
          <Card style={{ paddingVertical: 4 }}>
            {home.records.slice(0, 8).map((r: any, idx: number) => <View key={r.id} style={[styles.recordRow, idx > 0 && styles.recordBorder]}><View style={[styles.recordIcon, r.status === "submitted" ? styles.recordGood : styles.recordDraft]}><Text>{r.status === "submitted" ? "✓" : "•"}</Text></View><View style={{ flex: 1 }}><Text style={styles.recordTitle}>{r.status === "submitted" ? "Diary submitted" : r.status === "draft" ? "Draft saved" : "Diary record"}</Text><Text style={styles.recordMeta}>{r.occurrenceTime || r.entryTime || r.periodLabel}</Text></View><Text style={styles.recordStatus}>{r.status}</Text></View>)}
            {!home.records.length ? <Text style={[styles.cardCopy, { padding: 16 }]}>No diary entries yet.</Text> : null}
          </Card>
        </ScrollView>
      </AppShell>
    );
  }

  if (screen === "diary" && selected && questionnaire) return (
    <AppShell>
      <Header title="New diary entry" subtitle={questionnaire.study.name} onBack={() => setScreen("home")} action={<Pressable onPress={saveDraft}><Text style={styles.headerAction}>Save draft</Text></Pressable>} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
          <Card style={{ backgroundColor: colors.blueSoft, borderColor: "#CFE0FF" }}><Text style={styles.cardTitle}>Tell us about the occasion</Text><Text style={styles.cardCopy}>Required questions are marked with *. Evidence can still be submitted later if your camera or connection fails.</Text></Card>
          {visibleQuestions.map((q: any, index: number) => {
            const problem = problems.find((p) => p.questionId === q.id);
            const value = answers[String(q.id)];
            return <Card key={q.id} style={[styles.questionCard, problem && { borderColor: colors.red }]}>
              <Text style={styles.qNumber}>QUESTION {index + 1}{q.section ? ` · ${String(q.section).toUpperCase()}` : ""}</Text>
              <Text style={styles.qText}>{q.text}{q.required ? <Text style={{ color: colors.red }}> *</Text> : null}</Text>
              {q.type === "text" ? <TextInput value={String(value ?? "")} onChangeText={(v) => setAnswer(q.id, v)} multiline placeholder="Type your answer" placeholderTextColor="#A1ADBD" style={[styles.input, styles.textArea]} /> : null}
              {q.type === "numeric" ? <TextInput value={String(value ?? "")} onChangeText={(v) => setAnswer(q.id, v)} keyboardType="decimal-pad" placeholder={q.minValue != null || q.maxValue != null ? `${q.minValue ?? ""}${q.maxValue != null ? ` – ${q.maxValue}` : "+"}` : "Enter a number"} placeholderTextColor="#A1ADBD" style={styles.input} /> : null}
              {q.type === "single" ? <View style={styles.options}>{q.options.map((opt: string) => <Pressable key={opt} onPress={() => setAnswer(q.id, opt)} style={[styles.option, value === opt && styles.optionSelected]}><View style={[styles.radio, value === opt && styles.radioSelected]} /><Text style={[styles.optionText, value === opt && styles.optionTextSelected]}>{opt}</Text></Pressable>)}</View> : null}
              {q.type === "multi" ? <View style={styles.options}>{q.options.map((opt: string) => { const arr = Array.isArray(value) ? value : []; const on = arr.includes(opt); return <Pressable key={opt} onPress={() => setAnswer(q.id, on ? arr.filter((x) => x !== opt) : [...arr, opt])} style={[styles.option, on && styles.optionSelected]}><View style={[styles.checkbox, on && styles.checkboxSelected]}><Text style={{ color: "white", fontSize: 10 }}>{on ? "✓" : ""}</Text></View><Text style={[styles.optionText, on && styles.optionTextSelected]}>{opt}</Text></Pressable>; })}</View> : null}
              {(q.type === "photo" || q.type === "video") ? <View><View style={styles.mediaRow}><Button title={q.type === "video" ? "Record video" : "Take photo"} onPress={() => pickEvidence(q, true)} /><Button title="Choose from device" secondary onPress={() => pickEvidence(q, false)} /></View>{media[String(q.id)] ? <Text style={styles.mediaChosen}>✓ Evidence selected: {media[String(q.id)].fileName || "camera capture"}</Text> : <Text style={styles.helpText}>Optional if your camera or upload is unavailable; QC can review missing evidence.</Text>}</View> : null}
              {q.type === "audio" ? <View style={styles.nativeNote}><Text style={styles.nativeNoteTitle}>Voice evidence</Text><Text style={styles.helpText}>Native audio recording is the next capability pass. You can submit this entry now; evidence questions do not block submission.</Text></View> : null}
              {problem ? <Text style={styles.error}>{problem.message}</Text> : null}
            </Card>;
          })}
          <View style={{ gap: 10 }}><Button title={busy ? "Submitting…" : "Submit diary"} onPress={submitDiary} disabled={busy} /><Button title="Save on this device" secondary onPress={saveDraft} /></View>
        </ScrollView>
      </KeyboardAvoidingView>
    </AppShell>
  );

  return <AppShell><View style={styles.center}><ActivityIndicator color={colors.blue} /></View></AppShell>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, paddingTop: padTop },
  brandBar: { height: 66, backgroundColor: colors.navy, paddingHorizontal: 20, flexDirection: "row", alignItems: "center", gap: 11 },
  brandMark: { width: 36, height: 36, borderRadius: 11, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center" },
  brandMarkText: { color: "white", fontSize: 20, fontWeight: "900" }, brandName: { color: "white", fontSize: 19, fontWeight: "800", letterSpacing: 0.7 }, brandTag: { color: "#BCD0E7", fontSize: 10 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 }, loadingText: { color: colors.muted },
  header: { backgroundColor: colors.navy, paddingHorizontal: 18, paddingBottom: 17 }, headerRow: { flexDirection: "row", alignItems: "center", gap: 10 }, headerTitle: { color: "white", fontSize: 21, fontWeight: "800" }, headerSub: { color: "#BFD0E5", fontSize: 12, marginTop: 2 }, headerAction: { color: "white", fontSize: 12, fontWeight: "800", padding: 8 }, back: { width: 36, height: 36, borderRadius: 10, backgroundColor: "rgba(255,255,255,.09)", alignItems: "center", justifyContent: "center" }, backText: { color: "white", fontSize: 28, marginTop: -4 },
  page: { padding: 16, gap: 13, paddingBottom: 42 }, authWrap: { padding: 20, paddingTop: 38, paddingBottom: 40 }, heroEyebrow: { color: colors.blue, fontSize: 11, fontWeight: "900", letterSpacing: 1.7 }, heroTitle: { color: colors.text, fontSize: 32, lineHeight: 38, fontWeight: "900", marginTop: 8, letterSpacing: -0.8 }, heroCopy: { color: colors.muted, fontSize: 15, lineHeight: 22, marginTop: 12, marginBottom: 24 },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 17, padding: 17 }, authCard: { gap: 13 }, cardTitle: { color: colors.text, fontSize: 17, fontWeight: "800" }, cardCopy: { color: colors.muted, fontSize: 13, lineHeight: 20, marginTop: 5, marginBottom: 12 }, fieldLabel: { color: colors.text, fontSize: 12, fontWeight: "800", marginBottom: -5 }, input: { minHeight: 50, borderWidth: 1, borderColor: "#D6E0EC", borderRadius: 12, backgroundColor: "#FBFCFE", paddingHorizontal: 14, color: colors.text, fontSize: 16 }, textArea: { minHeight: 104, textAlignVertical: "top", paddingTop: 13 }, codeInput: { textAlign: "center", fontSize: 27, letterSpacing: 8, fontWeight: "800" }, error: { color: colors.red, fontSize: 12, marginTop: 8 }, helpText: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 7 },
  button: { minHeight: 49, paddingHorizontal: 16, borderRadius: 12, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center" }, buttonText: { color: "white", fontSize: 14, fontWeight: "800" }, buttonSecondary: { backgroundColor: "white", borderWidth: 1, borderColor: "#C9D6E6" }, buttonSecondaryText: { color: colors.navy }, buttonDanger: { backgroundColor: colors.red },
  segment: { flexDirection: "row", padding: 4, backgroundColor: "#EEF3F8", borderRadius: 11, marginBottom: 4 }, segmentItem: { flex: 1, paddingVertical: 9, alignItems: "center", borderRadius: 8 }, segmentActive: { backgroundColor: "white" }, segmentText: { color: colors.muted, fontSize: 12, fontWeight: "700" }, segmentTextActive: { color: colors.navy },
  studyCard: { marginBottom: 12 }, studyTop: { flexDirection: "row", alignItems: "center", gap: 6 }, statusDot: { width: 7, height: 7, borderRadius: 99 }, studyStatus: { color: colors.muted, fontSize: 10, fontWeight: "900", letterSpacing: 1 }, studyName: { color: colors.text, fontSize: 19, fontWeight: "800", marginTop: 10 }, studyMeta: { color: colors.muted, fontSize: 12, marginTop: 5 }, studyBottom: { marginTop: 17, paddingTop: 14, borderTopWidth: 1, borderTopColor: "#EEF2F6", flexDirection: "row", alignItems: "baseline" }, countBig: { color: colors.blue, fontSize: 23, fontWeight: "900" }, countLabel: { color: colors.muted, fontSize: 11, marginLeft: 7 }, chevron: { marginLeft: "auto", color: colors.blue, fontSize: 27 },
  welcome: { paddingHorizontal: 2, marginBottom: 3 }, welcomeTitle: { color: colors.text, fontSize: 28, fontWeight: "900", marginTop: 5 }, welcomeCopy: { color: colors.muted, fontSize: 13, marginTop: 5 }, todayCard: { gap: 8 }, todayLabel: { color: colors.blue, fontSize: 10, fontWeight: "900", letterSpacing: 1.3 }, todayTitle: { color: colors.text, fontSize: 19, fontWeight: "800", marginTop: 5 }, statRow: { flexDirection: "row", gap: 12 }, statCard: { flex: 1 }, statNumber: { fontSize: 28, color: colors.text, fontWeight: "900" }, statLabel: { color: colors.muted, fontSize: 11, marginTop: 4 }, sectionTitle: { color: colors.text, fontSize: 15, fontWeight: "800", marginTop: 6 },
  recordRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 13, paddingVertical: 12 }, recordBorder: { borderTopWidth: 1, borderTopColor: "#EEF2F6" }, recordIcon: { width: 30, height: 30, borderRadius: 9, alignItems: "center", justifyContent: "center" }, recordGood: { backgroundColor: colors.greenSoft }, recordDraft: { backgroundColor: colors.amberSoft }, recordTitle: { color: colors.text, fontSize: 12, fontWeight: "800" }, recordMeta: { color: colors.muted, fontSize: 10, marginTop: 3 }, recordStatus: { color: colors.muted, fontSize: 10, textTransform: "capitalize" },
  questionCard: { gap: 10 }, qNumber: { color: colors.blue, fontSize: 9, fontWeight: "900", letterSpacing: 1.1 }, qText: { color: colors.text, fontSize: 16, lineHeight: 22, fontWeight: "800" }, options: { gap: 8 }, option: { minHeight: 46, borderWidth: 1, borderColor: "#D9E2ED", borderRadius: 11, flexDirection: "row", alignItems: "center", paddingHorizontal: 13, gap: 10 }, optionSelected: { borderColor: colors.blue, backgroundColor: colors.blueSoft }, optionText: { color: colors.text, fontSize: 13, flex: 1 }, optionTextSelected: { color: colors.navy, fontWeight: "800" }, radio: { width: 18, height: 18, borderRadius: 99, borderWidth: 2, borderColor: "#AAB7C8" }, radioSelected: { borderWidth: 5, borderColor: colors.blue }, checkbox: { width: 19, height: 19, borderRadius: 5, borderWidth: 1.5, borderColor: "#AAB7C8", alignItems: "center", justifyContent: "center" }, checkboxSelected: { backgroundColor: colors.blue, borderColor: colors.blue }, mediaRow: { gap: 8 }, mediaChosen: { marginTop: 8, color: colors.green, fontSize: 11, fontWeight: "700" }, nativeNote: { backgroundColor: "#F5F7FA", padding: 12, borderRadius: 10 }, nativeNoteTitle: { color: colors.text, fontWeight: "800", fontSize: 12 },
});
