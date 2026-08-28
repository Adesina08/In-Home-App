import * as SecureStore from "expo-secure-store";

export const API_BASE = (process.env.EXPO_PUBLIC_API_URL || "https://in-home-app-e8dkcnc7eefjgycv.francecentral-01.azurewebsites.net").replace(/\/$/, "");
const TOKEN_KEY = "inicio.mobile.token";

export type MobileEnrolment = {
  respondent: {
    id: number;
    respondentCode: string;
    name: string | null;
    activationStatus: string;
    consentStatus: string;
    preferredChannel: string | null;
    studyId: number;
  };
  study: {
    id: number;
    name: string;
    status: string;
    diaryMode: string | null;
    market: string | null;
    category: string | null;
  };
  submittedCount: number;
};

export type RespondentProfile = {
  id: number;
  name: string | null;
  location: string | null;
  age: number | null;
  gender: string | null;
  educationLevel: string | null;
  occupation: string | null;
  religion: string | null;
  maritalStatus: string | null;
  recontactConsent: string | null;
  completed: boolean;
  completedAt: string | null;
  updatedAt: string | null;
};

export async function getToken() {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function setToken(token: string | null) {
  if (token) await SecureStore.setItemAsync(TOKEN_KEY, token);
  else await SecureStore.deleteItemAsync(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getToken();
  const headers = new Headers(init.headers || {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (!(init.body instanceof FormData) && init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  let payload: any = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    const error: any = new Error(payload?.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.problems = payload?.problems || [];
    error.fields = payload?.fields || {};
    error.profileRequired = !!payload?.profileRequired;
    throw error;
  }
  return payload as T;
}

export const api = {
  health: () => request<{ ok: boolean }>("/api/mobile/health"),
  requestCode: (contact: string) => request<{ ok: boolean; simulated: boolean; ttlMinutes: number }>("/api/mobile/auth/request-code", { method: "POST", body: JSON.stringify({ contact }) }),
  verifyCode: (contact: string, code: string) => request<{ token: string }>("/api/mobile/auth/verify", { method: "POST", body: JSON.stringify({ contact, code }) }),
  diaryLinkLogin: (value: string) => request<{ token: string }>("/api/mobile/auth/diary-link", { method: "POST", body: JSON.stringify({ url: value }) }),
  logout: () => request<{ ok: boolean }>("/api/mobile/auth/logout", { method: "POST" }),
  me: () => request<{ account: any; linkOnly: boolean; enrolments: MobileEnrolment[] }>("/api/mobile/me"),
  profile: () => request<{ profile: RespondentProfile | null; required: boolean; prefillName: string }>("/api/mobile/profile"),
  saveProfile: (values: any) => request<{ profile: RespondentProfile; required: boolean }>("/api/mobile/profile", { method: "PUT", body: JSON.stringify(values) }),
  home: (respondentId: number) => request<any>(`/api/mobile/respondents/${respondentId}/home`),
  consent: (respondentId: number) => request<{ ok: boolean }>(`/api/mobile/respondents/${respondentId}/consent`, { method: "POST", body: "{}" }),
  questionnaire: (respondentId: number) => request<any>(`/api/mobile/respondents/${respondentId}/questionnaire`),
  submitDiary: (respondentId: number, form: FormData) => request<{ recordId: number; status: string }>(`/api/mobile/respondents/${respondentId}/diary`, { method: "POST", body: form }),
};
