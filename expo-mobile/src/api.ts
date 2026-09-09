import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";

export const API_BASE = (process.env.EXPO_PUBLIC_API_URL || "https://in-home-app-e8dkcnc7eefjgycv.francecentral-01.azurewebsites.net").replace(/\/$/, "");
const TOKEN_KEY = "inicio.mobile.token";
const REMEMBER_EXPIRY_KEY = "inicio.mobile.remember.expiresAt";
export const REMEMBER_WINDOW_DAYS = 30;

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
  hasPhoto?: boolean;
  photoUpdatedAt?: string | null;
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

// expo-secure-store has no real web implementation (its web shim is missing
// methods like deleteValueWithKeyAsync entirely), so persisting the auth
// token there on web either throws or silently fails to save — breaking
// every authenticated request afterwards. AsyncStorage is a real, working
// implementation on web; native (iOS/Android) keeps using SecureStore so the
// token stays in the platform keychain there.
async function storageGet(key: string) {
  if (Platform.OS === "web") return AsyncStorage.getItem(key);
  return SecureStore.getItemAsync(key);
}
async function storageSet(key: string, value: string) {
  if (Platform.OS === "web") return AsyncStorage.setItem(key, value);
  return SecureStore.setItemAsync(key, value);
}
async function storageDelete(key: string) {
  if (Platform.OS === "web") return AsyncStorage.removeItem(key);
  return SecureStore.deleteItemAsync(key);
}

// When "Remember me" isn't on, the token lives only in this module-level
// variable so it disappears when the app process is killed — the next
// launch finds nothing persisted and falls back to full login, per design.
let memoryToken: string | null = null;

export async function getToken() {
  if (memoryToken) return memoryToken;
  return storageGet(TOKEN_KEY);
}

export async function setToken(token: string | null, options: { remember?: boolean } = {}) {
  memoryToken = null;
  if (!token) {
    await Promise.all([storageDelete(TOKEN_KEY), storageDelete(REMEMBER_EXPIRY_KEY)]);
    return;
  }
  if (options.remember) {
    await storageSet(TOKEN_KEY, token);
  } else {
    memoryToken = token;
    await Promise.all([storageDelete(TOKEN_KEY), storageDelete(REMEMBER_EXPIRY_KEY)]);
  }
}

// A persisted token means the user checked "Remember me" (or, for a token
// saved before this feature existed, is on the legacy always-on session —
// treated the same way so it gets gated onto the new model on next launch).
export async function getRememberedSession() {
  const token = await storageGet(TOKEN_KEY);
  if (!token) return null;
  const expiresAtRaw = await storageGet(REMEMBER_EXPIRY_KEY);
  return { token, expiresAt: expiresAtRaw ? Number(expiresAtRaw) : null };
}

export async function extendRememberedSession() {
  const expiresAt = Date.now() + REMEMBER_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  await storageSet(REMEMBER_EXPIRY_KEY, String(expiresAt));
  return expiresAt;
}

export async function clearRememberedSession() {
  await Promise.all([storageDelete(TOKEN_KEY), storageDelete(REMEMBER_EXPIRY_KEY)]);
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
  submissionReceipt:(id:number,key:string)=>request<any>(`/mobile/api/respondents/${id}/submissions/${encodeURIComponent(key)}`),
  participation:(id:number)=>request<any>(`/mobile/api/respondents/${id}/participation`),
  closeout:(id:number,answers:Record<string,string>)=>request<any>(`/mobile/api/respondents/${id}/closeout`,{method:'POST',body:JSON.stringify({answers})}),
  mediaConsent:(id:number,given:boolean)=>request<any>(`/mobile/api/respondents/${id}/media-consent`,{method:'POST',body:JSON.stringify({given})}),
  withdraw:(id:number)=>request<any>(`/mobile/api/respondents/${id}/withdraw`,{method:'POST'}),
  health: () => request<{ ok: boolean }>("/mobile/api/health"),
  login: (username: string, password: string) => request<{ token: string; account: any }>("/mobile/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  requestCode: (contact: string) => request<{ ok: boolean; simulated: boolean; ttlMinutes: number; bypassed?: boolean; token?: string }>("/mobile/api/auth/request-code", { method: "POST", body: JSON.stringify({ contact }) }),
  verifyCode: (contact: string, code: string) => request<{ resetToken: string; expiresAt: string }>("/mobile/api/auth/verify", { method: "POST", body: JSON.stringify({ contact, code }) }),
  resetPassword: (resetToken: string, password: string) => request<{ token: string; account: any }>("/mobile/api/auth/reset-password", { method: "POST", body: JSON.stringify({ resetToken, password }) }),
  diaryLinkLogin: (value: string) => request<{ token: string }>("/mobile/api/auth/diary-link", { method: "POST", body: JSON.stringify({ url: value }) }),
  logout: () => request<{ ok: boolean }>("/mobile/api/auth/logout", { method: "POST" }),
  me: () => request<{ account: any; linkOnly: boolean; enrolments: MobileEnrolment[] }>("/mobile/api/me"),
  uploadProfilePhoto: (form: FormData) => request<{profile:RespondentProfile}>("/mobile/api/profile/photo", {method:"POST",body:form}),
  profile: () => request<{ profile: RespondentProfile | null; required: boolean; prefillName: string }>("/mobile/api/profile"),
  saveProfile: (values: any) => request<{ profile: RespondentProfile; required: boolean }>("/mobile/api/profile", { method: "PUT", body: JSON.stringify(values) }),
  home: (respondentId: number) => request<any>(`/mobile/api/respondents/${respondentId}/home`),
  consent: (respondentId: number,version:number) => request<{ ok: boolean }>(`/mobile/api/respondents/${respondentId}/consent`, { method: "POST", body: JSON.stringify({consent_version:version}) }),
  questionnaire: (respondentId: number) => request<any>(`/mobile/api/respondents/${respondentId}/questionnaire`),
  analyseMedia: (respondentId: number, form: FormData) => request<any>(`/mobile/api/respondents/${respondentId}/diary/media-analysis`, { method: "POST", body: form }),
  submitDiary: (respondentId: number, form: FormData) => request<{ recordId: number; status: string }>(`/mobile/api/respondents/${respondentId}/diary`, { method: "POST", body: form }),
  videoScript: (respondentId: number) => request<{ prompts: any[]; secondsEach: number; truncated: boolean; totalFillable: number }>(`/mobile/api/respondents/${respondentId}/diary/video-script`),
  analyzeVideo: (respondentId: number, form: FormData) => request<{ recordId: number; status: string }>(`/mobile/api/respondents/${respondentId}/diary/analyze-video`, { method: "POST", body: form }),
};
