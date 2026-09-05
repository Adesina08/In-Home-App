import React from "react";
import { View, Text, Pressable } from "react-native";
import { useColorScheme } from "nativewind";
import { Icon, IconName } from "../icons";
import { TabBar } from "../components/TabBar";

function StatCard({
  icon,
  iconBg,
  iconColor,
  value,
  label,
}: {
  icon: IconName;
  iconBg: string;
  iconColor: string;
  value: string | number;
  label: string;
}) {
  return (
    <View className="flex-1 rounded-[18px] border border-[#E2E8F0] bg-white p-3 dark:border-[#1B3556] dark:bg-[#0F2038]">
      <View
        className="mb-2 h-[26px] w-[26px] items-center justify-center rounded-lg"
        style={{ backgroundColor: iconBg }}
      >
        <Icon name={icon} size={13} color={iconColor} strokeWidth={1.75} />
      </View>
      <Text className="font-mono-semibold text-[22px] text-[#0F172A] dark:text-[#F8FAFC]">{value}</Text>
      <Text className="mt-[1px] text-[10px] text-[#94A3B8]">{label}</Text>
    </View>
  );
}

function BreakdownRow({ label, stat, pct, fill }: { label: string; stat: string; pct: number; fill: string }) {
  return (
    <View>
      <View className="mb-1 flex-row items-baseline justify-between">
        <Text className="text-[11px] font-sans-semibold text-[#0F172A] dark:text-[#F8FAFC]">{label}</Text>
        <Text className="font-mono text-[10px] text-[#94A3B8]">{stat}</Text>
      </View>
      <View className="h-[6px] overflow-hidden rounded-full bg-[#F1F5F9] dark:bg-[#081222]">
        <View className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: fill }} />
      </View>
    </View>
  );
}

export function ActivityScreen({
  submittedCount,
  daysLogged,
  last14Days,
  formCount,
  videoCount,
  voiceCount,
  onNavigate,
  onToggleTheme,
}: {
  submittedCount: number;
  daysLogged: number;
  last14Days: number[];
  formCount: number;
  videoCount: number;
  voiceCount: number;
  onNavigate?: (key: string) => void;
  onToggleTheme: () => void;
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === "dark";
  const blueIcon = isDark ? "#60A5FA" : "#1D4ED8";
  const blueIconBg = isDark ? "rgba(29,78,216,0.18)" : "#EFF4FF";
  const amberIcon = isDark ? "#FBBF24" : "#B45309";
  const amberIconBg = isDark ? "rgba(180,83,9,0.18)" : "#FEF6E7";
  const purple = isDark ? "#c084fc" : "#7C3AED";
  const green = isDark ? "#34D399" : "#047857";

  const loggingTotal = formCount + videoCount + voiceCount || 1;
  const formPct = Math.round((formCount / loggingTotal) * 100);
  const videoPct = Math.round((videoCount / loggingTotal) * 100);
  const voicePct = Math.max(0, 100 - formPct - videoPct);
  const maxBar = Math.max(1, ...last14Days);

  return (
    <View className="flex-1 bg-[#FAF9F7] dark:bg-[#0A1628]">
      <View className="h-[18px] shrink-0" />
      <View className="flex-1 gap-[13px] px-[18px] pb-4">
        <View className="flex-row items-center justify-between">
          <Text
            className="font-disp-extrabold text-[20px] text-[#0F172A] dark:text-[#F8FAFC]"
            style={{ letterSpacing: -0.2 }}
          >
            Activity
          </Text>
          <Pressable
            onPress={onToggleTheme}
            className="h-7 w-7 items-center justify-center rounded-[9px] border border-[#E2E8F0] bg-white dark:border-[#1B3556] dark:bg-[#0F2038]"
          >
            <Icon name="search" size={14} color="#94A3B8" strokeWidth={1.75} />
          </Pressable>
        </View>

        <View className="flex-row gap-[9px]">
          <StatCard icon="megaphone" iconBg={blueIconBg} iconColor={blueIcon} value={submittedCount} label="Entries submitted" />
          <StatCard icon="flame" iconBg={amberIconBg} iconColor={amberIcon} value={daysLogged} label="Days you logged" />
        </View>

        <View className="rounded-[18px] border border-[#E2E8F0] bg-white p-[14px] dark:border-[#1B3556] dark:bg-[#0F2038]">
          <Text className="mb-[2px] text-[12.5px] font-sans-bold text-[#0F172A] dark:text-[#F8FAFC]">
            Your last 14 days
          </Text>
          <Text className="mb-3 text-[10px] leading-[13.5px] text-[#94A3B8]">
            Each bar is one day. Taller means more occasions logged.
          </Text>
          <View className="h-16 flex-row items-end gap-1">
            {last14Days.map((v, i) => (
              <View
                key={i}
                className="flex-1 rounded-t-[3px] bg-[#1D4ED8]"
                style={{ height: `${Math.max(6, (v / maxBar) * 100)}%` }}
              />
            ))}
          </View>
        </View>

        <View className="flex-1 rounded-[18px] border border-[#E2E8F0] bg-white p-[14px] dark:border-[#1B3556] dark:bg-[#0F2038]">
          <Text className="mb-[11px] text-[12.5px] font-sans-bold text-[#0F172A] dark:text-[#F8FAFC]">
            How you log
          </Text>
          <View className="gap-[11px]">
            <BreakdownRow label="Form" stat={`${formCount} · ${formPct}%`} pct={formPct} fill="#1D4ED8" />
            <BreakdownRow label="Video" stat={`${videoCount} · ${videoPct}%`} pct={videoPct} fill={purple} />
            <BreakdownRow label="Voice note" stat={`${voiceCount} · ${voicePct}%`} pct={voicePct} fill={green} />
          </View>
        </View>
      </View>
      <TabBar active="activity" onNavigate={onNavigate} />
    </View>
  );
}
