import { Linking, Platform } from "react-native";
import Constants from "expo-constants";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { API_BASE } from "./api";

// The Build Android APK workflow publishes the APK and its manifest side by
// side; every build carries a higher versionCode and the same release key, so
// the downloaded APK installs over this one as an update (no uninstall).
const MANIFEST_URL = `${API_BASE}/public/downloads/inicio-diary.json`;
export const APK_URL = `${API_BASE}/public/downloads/inicio-diary.apk`;
const SNOOZE_KEY = "inicio.update.snoozed";
const SNOOZE_MS = 24 * 60 * 60 * 1000;

export type AvailableUpdate = { version: string; versionCode: number; bytes?: number };

export function installedVersionCode(): number | null {
  const code = Number(Constants.expoConfig?.android?.versionCode);
  return Number.isInteger(code) && code > 0 ? code : null;
}

export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  if (Platform.OS !== "android" || __DEV__) return null;
  const installed = installedVersionCode();
  if (!installed) return null;
  try {
    const res = await fetch(MANIFEST_URL, { headers: { "Cache-Control": "no-cache" } });
    if (!res.ok) return null;
    const manifest = await res.json();
    const versionCode = Number(manifest?.versionCode);
    if (!Number.isInteger(versionCode) || versionCode <= installed) return null;
    const snoozed = JSON.parse((await AsyncStorage.getItem(SNOOZE_KEY)) || "null");
    if (snoozed?.versionCode === versionCode && Date.now() - snoozed.at < SNOOZE_MS) return null;
    return { version: String(manifest.version || ""), versionCode, bytes: Number(manifest.bytes) || undefined };
  } catch {
    // Offline or server unreachable: try again on the next launch/foreground.
    return null;
  }
}

export async function snoozeUpdate(update: AvailableUpdate) {
  await AsyncStorage.setItem(SNOOZE_KEY, JSON.stringify({ versionCode: update.versionCode, at: Date.now() }));
}

// Hands the APK to the browser, which downloads it; opening the download shows
// Android's "Do you want to update this app?" installer with data preserved.
export function installUpdate() {
  return Linking.openURL(APK_URL);
}
