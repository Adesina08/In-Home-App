import "./global.css";
import React, { useEffect, useState } from "react";
import { SafeAreaProvider, SafeAreaView, initialWindowMetrics } from "react-native-safe-area-context";
import { useColorScheme } from "nativewind";
import { StatusBar } from "expo-status-bar";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  useFonts as useInterFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from "@expo-google-fonts/inter";
import {
  useFonts as useBricolageFonts,
  BricolageGrotesque_700Bold,
  BricolageGrotesque_800ExtraBold,
} from "@expo-google-fonts/bricolage-grotesque";
import {
  useFonts as useMonoFonts,
  IBMPlexMono_400Regular,
  IBMPlexMono_500Medium,
  IBMPlexMono_600SemiBold,
} from "@expo-google-fonts/ibm-plex-mono";
import AppRedesign from "./AppRedesign";
import InterviewerApp from "./InterviewerApp";
import { LogoLoader } from "./src/components/LogoLoader";

type AppMode = "respondent" | "interviewer";
const MODE_KEY = "inicio.appMode";

function AppContent() {
  const [interLoaded] = useInterFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold });
  const [bricolageLoaded] = useBricolageFonts({ BricolageGrotesque_700Bold, BricolageGrotesque_800ExtraBold });
  const [monoLoaded] = useMonoFonts({ IBMPlexMono_400Regular, IBMPlexMono_500Medium, IBMPlexMono_600SemiBold });

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

  if (!interLoaded || !bricolageLoaded || !monoLoaded || !mode) {
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
