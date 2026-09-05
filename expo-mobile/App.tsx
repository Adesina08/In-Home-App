import "./global.css";
import React, { useEffect, useState } from "react";
import { View } from "react-native";
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

type AppMode = "respondent" | "interviewer";
const MODE_KEY = "inicio.appMode";

export default function App() {
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
    return <View className="flex-1 bg-[#FAF9F7]" />;
  }

  if (mode === "interviewer") {
    return <InterviewerApp onSwitchToRespondent={() => switchMode("respondent")} />;
  }
  return <AppRedesign onSwitchToInterviewer={() => switchMode("interviewer")} />;
}
