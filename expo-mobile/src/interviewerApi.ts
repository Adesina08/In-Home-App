import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { API_BASE } from "./api";

const TOKEN_KEY = "inicio.mobile.interviewer.token";

// Kept as a separate token from the respondent session (src/api.ts) so
// switching modes doesn't force a re-login every time — an interviewer who
// also has a respondent enrolment (or vice versa) can hold both sessions at
// once, same as being signed into two accounts in two different apps.
export async function getInterviewerToken() {
  if (Platform.OS === "web") return AsyncStorage.getItem(TOKEN_KEY);
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function setInterviewerToken(token: string | null) {
  if (Platform.OS === "web") {
    if (token) await AsyncStorage.setItem(TOKEN_KEY, token);
    else await AsyncStorage.removeItem(TOKEN_KEY);
    return;
  }
  if (token) await SecureStore.setItemAsync(TOKEN_KEY, token);
  else await SecureStore.deleteItemAsync(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getInterviewerToken();
  const headers = new Headers(init.headers || {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (!(init.body instanceof FormData) && init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  let payload: any = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    const error: any = new Error(payload?.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload as T;
}

export type InterviewerUser = { id: number; name: string; email: string; role: string };
export type DashboardRespondent = {
  id: number;
  respondentCode: string;
  name: string | null;
  contact: string | null;
  activationStatus: string;
  consentStatus: string;
  createdAt: string;
  uniqueToken: string;
  studyId: number;
  studyName: string;
};
export type Dashboard = {
  interviewer: InterviewerUser;
  studies: Array<{ id: number; name: string; market: string | null; category: string | null }>;
  mine: DashboardRespondent[];
  counts: { registered: number; activated: number; pending: number };
};

export const interviewerApi = {
  login: (email: string, password: string) =>
    request<{ token: string; expiresAt: string; user: InterviewerUser }>("/mobile/api/interviewer/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request<{ ok: boolean }>("/mobile/api/interviewer/auth/logout", { method: "POST" }),
  dashboard: () => request<Dashboard>("/mobile/api/interviewer/dashboard"),
  respondent: (id: number) =>
    request<{ respondent: any; diaryUrl: string; qr: string | null; messagingLive: boolean }>(`/mobile/api/interviewer/respondents/${id}`),
  sendLink: (id: number) =>
    request<{ ok: boolean; simulated: boolean; message: string }>(`/mobile/api/interviewer/respondents/${id}/send-link`, { method: "POST" }),
  register: (body: {
    study_id: number;
    name: string;
    contact: string;
    eligible: boolean;
    consent_given: boolean;
    preferred_channel: string;
    practice: boolean;
  }) =>
    request<
      | { screenedOut: true; message: string }
      | { held: true; code: string; name: string; respondentId: number; holds: any[] }
      | { activated: true; code: string; token: string; respondentId: number; diaryUrl: string; qr: string | null }
    >("/mobile/api/interviewer/register", { method: "POST", body: JSON.stringify(body) }),
  bulkMeta: (studyId: number) =>
    request<{ study: any; defaultCountryCode: string; messagingLive: boolean }>(`/mobile/api/interviewer/studies/${studyId}/bulk/meta`),
  bulkTemplateUrl: (studyId: number) => `${API_BASE}/mobile/api/interviewer/studies/${studyId}/bulk/template`,
  bulkReview: async (studyId: number, fileUri: string, fileName: string, countryCode: string) => {
    const form = new FormData();
    form.append("country_code", countryCode);
    form.append("roster", { uri: fileUri, name: fileName, type: "text/csv" } as any);
    return request<{ filename: string; countryCode: string; rows: any[]; summary: any }>(
      `/mobile/api/interviewer/studies/${studyId}/bulk/review`,
      { method: "POST", body: form }
    );
  },
  bulkSend: (studyId: number, rows: Array<{ name: string; phone: string }>, countryCode: string) =>
    request<{ outcome: { invited: number; failed: number; skipped: number; errors: string[] } }>(
      `/mobile/api/interviewer/studies/${studyId}/bulk/send`,
      { method: "POST", body: JSON.stringify({ rows, country_code: countryCode }) }
    ),
};
