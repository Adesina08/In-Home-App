import React, { useEffect, useState } from "react";
import { View, ActivityIndicator, Alert } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as Sharing from "expo-sharing";
import { File, Paths } from "expo-file-system";
import * as Clipboard from "expo-clipboard";
import { interviewerApi, getInterviewerToken, setInterviewerToken, Dashboard, DashboardRespondent } from "./src/interviewerApi";
import { InterviewerLoginScreen } from "./src/screens/interviewer/Login";
import { InterviewerDashboardScreen } from "./src/screens/interviewer/Dashboard";
import { RegisterWizardScreen, RegisterForm } from "./src/screens/interviewer/RegisterWizard";
import { InterviewerActivatedScreen } from "./src/screens/interviewer/Activated";
import { InterviewerHeldScreen } from "./src/screens/interviewer/Held";
import { InterviewerShareScreen } from "./src/screens/interviewer/Share";
import { InterviewerBulkUploadScreen } from "./src/screens/interviewer/BulkUpload";
import { InterviewerBulkReviewScreen } from "./src/screens/interviewer/BulkReview";
import { InterviewerBulkDoneScreen } from "./src/screens/interviewer/BulkDone";

type Screen = "loading" | "login" | "dashboard" | "register" | "activated" | "held" | "share" | "bulkUpload" | "bulkReview" | "bulkDone";

export default function InterviewerApp({ onSwitchToRespondent }: { onSwitchToRespondent: () => void }) {
  const [screen, setScreen] = useState<Screen>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [activatedResult, setActivatedResult] = useState<{ respondentId: number; code: string; diaryUrl: string; qr: string | null } | null>(null);
  const [heldResult, setHeldResult] = useState<{ name: string; code: string; holds: any[] } | null>(null);
  const [shareRespondent, setShareRespondent] = useState<DashboardRespondent | null>(null);
  const [shareData, setShareData] = useState<{ diaryUrl: string; qr: string | null } | null>(null);
  const [copied, setCopied] = useState(false);
  const [sendingLink, setSendingLink] = useState(false);

  const [bulkStudyId, setBulkStudyId] = useState<number | null>(null);
  const [bulkStudyName, setBulkStudyName] = useState("");
  const [bulkMeta, setBulkMeta] = useState<{ defaultCountryCode: string; messagingLive: boolean } | null>(null);
  const [bulkFile, setBulkFile] = useState<{ uri: string; name: string } | null>(null);
  const [bulkReview, setBulkReview] = useState<{ filename: string; rows: any[]; summary: any; countryCode: string } | null>(null);
  const [bulkOutcome, setBulkOutcome] = useState<{ invited: number; failed: number; skipped: number; errors: string[] } | null>(null);

  useEffect(() => {
    (async () => {
      const token = await getInterviewerToken();
      if (!token) return setScreen("login");
      try {
        const data = await interviewerApi.dashboard();
        setDashboard(data);
        setScreen("dashboard");
      } catch {
        await setInterviewerToken(null);
        setScreen("login");
      }
    })();
  }, []);

  async function loadDashboard(refresh = false) {
    if (refresh) setRefreshing(true);
    try {
      const data = await interviewerApi.dashboard();
      setDashboard(data);
    } catch (e: any) {
      Alert.alert("Could not load", e.message);
    } finally {
      if (refresh) setRefreshing(false);
    }
  }

  async function login(email: string, password: string) {
    setError("");
    if (!email.trim() || !password) return setError("Enter your email and password.");
    setBusy(true);
    try {
      const result = await interviewerApi.login(email.trim(), password);
      await setInterviewerToken(result.token);
      await loadDashboard();
      setScreen("dashboard");
    } catch (e: any) {
      setError(e.message || "Unable to sign in.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRegisterSubmit(form: RegisterForm) {
    setBusy(true);
    try {
      const result = await interviewerApi.register({
        study_id: form.studyId,
        name: form.name,
        contact: form.contact,
        eligible: !!form.eligible,
        consent_given: form.consentGiven,
        preferred_channel: form.channel,
        practice: form.practice,
      });
      if ("held" in result && result.held) {
        setHeldResult({ name: result.name, code: result.code, holds: result.holds || [] });
        setScreen("held");
      } else if ("activated" in result && result.activated) {
        setActivatedResult({ respondentId: result.respondentId, code: result.code, diaryUrl: result.diaryUrl, qr: result.qr });
        setScreen("activated");
      } else if ("screenedOut" in result) {
        Alert.alert("Not eligible", result.message);
        setScreen("dashboard");
      }
      loadDashboard();
    } catch (e: any) {
      Alert.alert("Could not register respondent", e.message);
    } finally {
      setBusy(false);
    }
  }

  async function openShare(r: DashboardRespondent) {
    setShareRespondent(r);
    setShareData(null);
    setCopied(false);
    setScreen("share");
    try {
      const data = await interviewerApi.respondent(r.id);
      setShareData({ diaryUrl: data.diaryUrl, qr: data.qr });
    } catch (e: any) {
      Alert.alert("Could not load respondent", e.message);
    }
  }

  async function sendLinkFor(id: number) {
    setSendingLink(true);
    try {
      const result = await interviewerApi.sendLink(id);
      Alert.alert(result.simulated ? "Not actually sent" : "Sent", result.message);
    } catch (e: any) {
      Alert.alert("Could not send link", e.message);
    } finally {
      setSendingLink(false);
    }
  }

  async function openBulkUpload(studyId: number, studyName: string) {
    setBulkStudyId(studyId);
    setBulkStudyName(studyName);
    setBulkFile(null);
    setBulkMeta(null);
    setScreen("bulkUpload");
    try {
      const meta = await interviewerApi.bulkMeta(studyId);
      setBulkMeta({ defaultCountryCode: meta.defaultCountryCode, messagingLive: meta.messagingLive });
    } catch (e: any) {
      Alert.alert("Could not load", e.message);
    }
  }

  async function downloadTemplate() {
    if (!bulkStudyId) return;
    try {
      const url = interviewerApi.bulkTemplateUrl(bulkStudyId);
      const destination = new File(Paths.cache, "inicio-invite-template.csv");
      const file = await File.downloadFileAsync(url, destination, { idempotent: true });
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { mimeType: "text/csv" });
      else Alert.alert("Template saved", file.uri);
    } catch (e: any) {
      Alert.alert("Could not get template", e.message || "Please try again.");
    }
  }

  async function pickRosterFile() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ["text/csv", "text/comma-separated-values", "application/vnd.ms-excel", "*/*"],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]) return;
      setBulkFile({ uri: result.assets[0].uri, name: result.assets[0].name });
    } catch (e: any) {
      Alert.alert("Could not open file picker", e.message);
    }
  }

  async function checkList(countryCode: string) {
    if (!bulkStudyId || !bulkFile) return;
    setBusy(true);
    try {
      const result = await interviewerApi.bulkReview(bulkStudyId, bulkFile.uri, bulkFile.name, countryCode);
      setBulkReview({ filename: result.filename, rows: result.rows, summary: result.summary, countryCode });
      setScreen("bulkReview");
    } catch (e: any) {
      Alert.alert("Could not read that file", e.message);
    } finally {
      setBusy(false);
    }
  }

  async function sendInvites() {
    if (!bulkStudyId || !bulkReview) return;
    setBusy(true);
    try {
      const invitable = bulkReview.rows.filter((r) => r.status === "ok");
      const result = await interviewerApi.bulkSend(
        bulkStudyId,
        invitable.map((r) => ({ name: r.name, phone: r.contact })),
        bulkReview.countryCode
      );
      setBulkOutcome(result.outcome);
      setScreen("bulkDone");
      loadDashboard();
    } catch (e: any) {
      Alert.alert("Could not send invites", e.message);
    } finally {
      setBusy(false);
    }
  }

  if (screen === "loading") {
    return (
      <View className="flex-1 items-center justify-center bg-[#FAF9F7] dark:bg-[#0A1628]">
        <ActivityIndicator size="large" color="#1D4ED8" />
      </View>
    );
  }

  if (screen === "login") {
    return (
      <InterviewerLoginScreen onLogin={login} busy={busy} error={error} onSwitchToRespondent={onSwitchToRespondent} />
    );
  }

  if (screen === "dashboard") {
    return (
      <InterviewerDashboardScreen
        data={dashboard}
        refreshing={refreshing}
        onRefresh={() => loadDashboard(true)}
        onRegister={() => setScreen("register")}
        onBulkInvite={() => {
          const study = dashboard?.studies?.[0];
          if (study) openBulkUpload(study.id, study.name);
        }}
        onOpenRespondent={openShare}
        onSwitchMode={onSwitchToRespondent}
      />
    );
  }

  if (screen === "register") {
    return (
      <RegisterWizardScreen
        studies={(dashboard?.studies || []).map((s) => ({ id: s.id, name: s.name }))}
        onCancel={() => setScreen("dashboard")}
        onSubmit={handleRegisterSubmit}
        busy={busy}
      />
    );
  }

  if (screen === "activated" && activatedResult) {
    return (
      <InterviewerActivatedScreen
        code={activatedResult.code}
        diaryUrl={activatedResult.diaryUrl}
        qr={activatedResult.qr}
        sending={sendingLink}
        onSendLink={() => sendLinkFor(activatedResult.respondentId)}
        onRegisterAnother={() => setScreen("register")}
      />
    );
  }

  if (screen === "held" && heldResult) {
    return (
      <InterviewerHeldScreen
        name={heldResult.name}
        code={heldResult.code}
        holds={heldResult.holds}
        onRegisterAnother={() => setScreen("register")}
        onMyRespondents={() => setScreen("dashboard")}
      />
    );
  }

  if (screen === "share" && shareRespondent) {
    return (
      <InterviewerShareScreen
        name={shareRespondent.name || shareRespondent.respondentCode}
        respondentCode={shareRespondent.respondentCode}
        studyName={shareRespondent.studyName}
        contact={shareRespondent.contact}
        diaryUrl={shareData?.diaryUrl || ""}
        qr={shareData?.qr || null}
        copied={copied}
        sending={sendingLink}
        onBack={() => setScreen("dashboard")}
        onCopyLink={async () => {
          if (!shareData?.diaryUrl) return;
          await Clipboard.setStringAsync(shareData.diaryUrl);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
        onSendLink={() => sendLinkFor(shareRespondent.id)}
      />
    );
  }

  if (screen === "bulkUpload") {
    return (
      <InterviewerBulkUploadScreen
        studyName={bulkStudyName}
        defaultCountryCode={bulkMeta?.defaultCountryCode || "+234"}
        messagingLive={!!bulkMeta?.messagingLive}
        fileName={bulkFile?.name || null}
        busy={busy}
        onBack={() => setScreen("dashboard")}
        onDownloadTemplate={downloadTemplate}
        onPickFile={pickRosterFile}
        onCheckList={checkList}
      />
    );
  }

  if (screen === "bulkReview" && bulkReview) {
    return (
      <InterviewerBulkReviewScreen
        filename={bulkReview.filename}
        rows={bulkReview.rows}
        summary={bulkReview.summary}
        busy={busy}
        onBack={() => setScreen("bulkUpload")}
        onSend={sendInvites}
      />
    );
  }

  if (screen === "bulkDone" && bulkOutcome) {
    return (
      <InterviewerBulkDoneScreen
        studyName={bulkStudyName}
        outcome={bulkOutcome}
        onSeeRespondents={() => setScreen("dashboard")}
        onInviteMore={() => bulkStudyId && openBulkUpload(bulkStudyId, bulkStudyName)}
      />
    );
  }

  return (
    <View className="flex-1 items-center justify-center bg-[#FAF9F7] dark:bg-[#0A1628]">
      <ActivityIndicator color="#1D4ED8" />
    </View>
  );
}
