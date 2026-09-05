import React from "react";
import { View, Text, Pressable } from "react-native";
import { useColorScheme } from "nativewind";
import { Icon, IconName } from "../icons";
import { TabBar } from "../components/TabBar";

function Row({
  children,
  last,
  onPress,
}: {
  children: React.ReactNode;
  last?: boolean;
  onPress?: () => void;
}) {
  const Wrapper = onPress ? Pressable : View;
  return (
    <>
      <Wrapper className="flex-row items-center gap-[10px] px-[14px] py-[11px]" onPress={onPress}>
        {children}
      </Wrapper>
      {!last && <View className="h-px bg-[#E2E8F0] dark:bg-[#1B3556]" style={{ marginHorizontal: 14 }} />}
    </>
  );
}

function NavRow({
  icon,
  label,
  isDark,
  last,
  onPress,
}: {
  icon: IconName;
  label: string;
  isDark: boolean;
  last?: boolean;
  onPress?: () => void;
}) {
  return (
    <Row last={last} onPress={onPress}>
      <View
        className="h-[26px] w-[26px] items-center justify-center rounded-lg"
        style={{ backgroundColor: isDark ? "rgba(29,78,216,0.18)" : "#EFF4FF" }}
      >
        <Icon name={icon} size={13} color={isDark ? "#60A5FA" : "#1D4ED8"} strokeWidth={1.75} />
      </View>
      <Text className="flex-1 text-xs font-sans-semibold text-[#0F172A] dark:text-[#F8FAFC]">{label}</Text>
      <Icon name="chevronRight" size={13} color="#64748B" strokeWidth={1.9} />
    </Row>
  );
}

function initials(name: string) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1]?.[0] || "")).toUpperCase();
}

export function ProfileScreen({
  name,
  respondentCode,
  studyName,
  activated,
  busy,
  onOpenStudies,
  onSignOut,
  onNavigate,
  onToggleTheme,
  onSwitchToInterviewer,
}: {
  name: string;
  respondentCode: string;
  studyName: string;
  activated: boolean;
  busy: boolean;
  onOpenStudies: () => void;
  onSignOut: () => void;
  onNavigate?: (key: string) => void;
  onToggleTheme: () => void;
  onSwitchToInterviewer: () => void;
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === "dark";

  return (
    <View className="flex-1 bg-[#FAF9F7] dark:bg-[#0A1628]">
      <View className="h-[18px] shrink-0" />
      <View className="flex-1 gap-[13px] px-[18px] pb-4">
        <Text
          className="font-disp-extrabold text-[20px] text-[#0F172A] dark:text-[#F8FAFC]"
          style={{ letterSpacing: -0.2 }}
        >
          Profile
        </Text>

        <View className="flex-row items-center gap-3">
          <View
            className="h-[52px] w-[52px] items-center justify-center rounded-full"
            style={{ backgroundColor: isDark ? "rgba(29,78,216,0.2)" : "#EFF4FF" }}
          >
            <Text className="font-disp text-[17px] font-bold" style={{ color: isDark ? "#93C5FD" : "#1D4ED8" }}>
              {initials(name)}
            </Text>
          </View>
          <View className="min-w-0">
            <Text className="text-[15px] font-sans-bold text-[#0F172A] dark:text-[#F8FAFC]">{name}</Text>
            <Text className="mt-[1px] font-mono text-[11px] text-[#94A3B8]">{respondentCode}</Text>
          </View>
        </View>

        <View className="rounded-[18px] border border-[#E2E8F0] bg-white dark:border-[#1B3556] dark:bg-[#0F2038]">
          <Row>
            <Text className="flex-1 text-[11.5px] text-[#94A3B8]">Study</Text>
            <Text className="text-[11.5px] font-sans-semibold text-[#0F172A] dark:text-[#F8FAFC]" numberOfLines={1}>
              {studyName}
            </Text>
          </Row>
          <Row>
            <Text className="flex-1 text-[11.5px] text-[#94A3B8]">Status</Text>
            <View
              className="rounded-full px-2 py-[2px]"
              style={{
                backgroundColor: activated
                  ? isDark
                    ? "rgba(4,120,87,0.18)"
                    : "#ECFDF5"
                  : isDark
                  ? "rgba(180,83,9,0.18)"
                  : "#FEF6E7",
              }}
            >
              <Text
                style={{ color: activated ? (isDark ? "#34D399" : "#047857") : isDark ? "#FBBF24" : "#B45309" }}
                className="text-[9.5px] font-sans-bold uppercase tracking-[0.2px]"
              >
                {activated ? "Activated" : "Pending"}
              </Text>
            </View>
          </Row>
          <Row last>
            <Text className="flex-1 text-[11.5px] text-[#94A3B8]">Reminders</Text>
            <Text className="text-[11.5px] font-sans-semibold text-[#0F172A] dark:text-[#F8FAFC]">
              On this device
            </Text>
          </Row>
        </View>

        <View className="rounded-[18px] border border-[#E2E8F0] bg-white dark:border-[#1B3556] dark:bg-[#0F2038]">
          <Row onPress={onToggleTheme}>
            <View
              className="h-[26px] w-[26px] items-center justify-center rounded-lg"
              style={{ backgroundColor: isDark ? "rgba(29,78,216,0.18)" : "#EFF4FF" }}
            >
              <Icon name="search" size={13} color={isDark ? "#60A5FA" : "#1D4ED8"} strokeWidth={1.75} />
            </View>
            <Text className="flex-1 text-xs font-sans-semibold text-[#0F172A] dark:text-[#F8FAFC]">Dark mode</Text>
            <View className="h-[21px] w-9 rounded-full" style={{ backgroundColor: isDark ? "#1D4ED8" : "#E2E8F0" }}>
              <View
                className="absolute top-[2px] h-[17px] w-[17px] rounded-full bg-white"
                style={isDark ? { right: 2 } : { left: 2, boxShadow: "0px 1px 2px rgba(16,28,51,0.15)" }}
              />
            </View>
          </Row>
          <NavRow icon="question" label="Help & study guide" isDark={isDark} />
          <NavRow icon="document" label="My other studies" isDark={isDark} onPress={onOpenStudies} />
          <NavRow icon="switchRole" label="Switch to Interviewer mode" isDark={isDark} onPress={onSwitchToInterviewer} last />
        </View>

        <Text className="text-[10px] leading-[14.5px] text-[#64748B]">
          To stop taking part or have your information deleted, contact the research team — the address is in the
          consent wording you agreed to.
        </Text>

        <Pressable
          disabled={busy}
          onPress={onSignOut}
          className="h-11 items-center justify-center rounded-xl border border-[#E2E8F0] bg-white dark:border-[#1B3556] dark:bg-[#0F2038]"
          style={busy ? { opacity: 0.6 } : null}
        >
          <Text className="text-[13px] font-sans-bold text-[#0F172A] dark:text-[#F8FAFC]">
            {busy ? "Signing out…" : "Sign out"}
          </Text>
        </Pressable>
      </View>
      <TabBar active="profile" onNavigate={onNavigate} />
    </View>
  );
}
