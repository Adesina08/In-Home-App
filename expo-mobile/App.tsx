import "./global.css";
import React, { useEffect, useState } from "react";
import { SafeAreaProvider, SafeAreaView, initialWindowMetrics } from "react-native-safe-area-context";
import { useColorScheme } from "nativewind";
import { StatusBar } from "expo-status-bar";
import { useFonts } from "expo-font";
import AsyncStorage from "@react-native-async-storage/async-storage";
import AppRedesign from "./AppRedesign";
import InterviewerApp from "./InterviewerApp";
import { LogoLoader } from "./src/components/LogoLoader";

type AppMode = "respondent" | "interviewer";
const MODE_KEY = "inicio.appMode";

function AppContent() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular: require("@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf"),
    Inter_600SemiBold: require("@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf"),
    Inter_700Bold: require("@expo-google-fonts/inter/700Bold/Inter_700Bold.ttf"),
    BricolageGrotesque_700Bold: require("@expo-google-fonts/bricolage-grotesque/700Bold/BricolageGrotesque_700Bold.ttf"),
    BricolageGrotesque_800ExtraBold: require("@expo-google-fonts/bricolage-grotesque/800ExtraBold/BricolageGrotesque_800ExtraBold.ttf"),
    IBMPlexMono_400Regular: require("@expo-google-fonts/ibm-plex-mono/400Regular/IBMPlexMono_400Regular.ttf"),
    IBMPlexMono_600SemiBold: require("@expo-google-fonts/ibm-plex-mono/600SemiBold/IBMPlexMono_600SemiBold.ttf"),
  });

  // Respondent and interviewer are different login entities (respondent_accounts
  // vs staff users) with their own bearer tokens (src/api.ts vs
  // src/interviewerApi.ts), so "switching" doesn't merge the two into one
  // session — it just remembers which UI to show, and each mode keeps its own
  // token so switching back doesn't force a re-login.
  const [mode, setMode] = useState<AppMode | null>(null);

  useEffect(() => {
    (async () => {
      const saved = await AsyncStorage.getItem(MODE_KEY);
      setMode(saved === "interviewer" ? "interviewer" : "respondent");
    })();
  }, []);

  async function switchMode(next: AppMode) {
    setMode(next);
    await AsyncStorage.setItem(MODE_KEY, next);
  }

  if (!fontsLoaded || !mode) {
    return <LogoLoader />;
  }

  if (mode === "interviewer") {
    return <InterviewerApp onSwitchToRespondent={() => switchMode("respondent")} />;
  }
  return <AppRedesign onSwitchToInterviewer={() => switchMode("interviewer")} />;
}

function SafeApp() {
  const { colorScheme } = useColorScheme();
  const dark = colorScheme === 'dark';
  return <SafeAreaView edges={['top', 'right', 'bottom', 'left']} style={{flex:1,backgroundColor:dark?'#0A1628':'#FAF9F7'}}><StatusBar style={dark?'light':'dark'} /><AppContent /></SafeAreaView>;
}
export default function App() {
  return <SafeAreaProvider initialMetrics={initialWindowMetrics}><SafeApp /></SafeAreaProvider>;
}
