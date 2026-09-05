import React from "react";
import { View, Text, Pressable, ScrollView, RefreshControl } from "react-native";
import { Icon } from "../../icons";
import { Screen, PrimaryButton } from "./shared";
import type { Dashboard, DashboardRespondent } from "../../interviewerApi";

function initials(name: string | null) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1]?.[0] || "")).toUpperCase();
}

const STATUS_META: Record<string, { label: string; bg: string; color: string } | null> = {
  active: { label: "Activated", bg: "#E6F4EA", color: "#1E7E34" },
  activated: { label: "Activated", bg: "#E6F4EA", color: "#1E7E34" },
  disqualified: { label: "Disqualified", bg: "#FDECEC", color: "#A63244" },
};

export function InterviewerDashboardScreen({
  data,
  refreshing,
  onRefresh,
  onRegister,
  onBulkInvite,
  onOpenRespondent,
  onSwitchMode,
}: {
  data: Dashboard | null;
  refreshing: boolean;
  onRefresh: () => void;
  onRegister: () => void;
  onBulkInvite: () => void;
  onOpenRespondent: (r: DashboardRespondent) => void;
  onSwitchMode: () => void;
}) {
  const mine = data?.mine || [];
  const counts = data?.counts || { registered: 0, activated: 0, pending: 0 };

  return (
    <Screen>
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ gap: 14 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <View className="flex-row items-center justify-between">
          <View>
            <Text className="text-[10.5px] font-sans-bold uppercase tracking-[0.6px] text-[#2E5395] dark:text-[#7EAEDA]">
              Fieldwork
            </Text>
            <Text
              className="font-disp-extrabold text-[21px] text-[#0F172A] dark:text-[#F8FAFC]"
              style={{ letterSpacing: -0.2 }}
            >
              My Respondents
            </Text>
          </View>
          <Pressable
            onPress={onSwitchMode}
            className="h-[38px] w-[38px] items-center justify-center rounded-full border border-[#E2E8F0] bg-white dark:border-[#1B3556] dark:bg-[#0F2038]"
          >
            <Icon name="switchRole" size={17} color="#64748B" strokeWidth={1.9} />
          </Pressable>
        </View>

        <View className="flex-row gap-2">
          {[
            { value: counts.registered, label: "Registered", color: "#0F172A" },
            { value: counts.activated, label: "Activated", color: "#047857" },
            { value: counts.pending, label: "Pending", color: "#B45309" },
          ].map((s) => (
            <View
              key={s.label}
              className="flex-1 items-center rounded-[20px] border border-[#E2E8F0] bg-white py-[10px] dark:border-[#1B3556] dark:bg-[#0F2038]"
            >
              <Text className="font-mono-semibold text-[19px]" style={{ color: s.color }}>
                {s.value}
              </Text>
              <Text className="mt-[1px] text-[9.5px] text-[#64748B] dark:text-[#94A3B8]">{s.label}</Text>
            </View>
          ))}
        </View>

        <PrimaryButton title="Register Respondent" onPress={onRegister} icon="plus" />

        <Pressable
          onPress={onBulkInvite}
          className="flex-row items-start gap-[10px] rounded-[20px] border border-[#E2E8F0] bg-white p-3 dark:border-[#1B3556] dark:bg-[#0F2038]"
        >
          <View className="h-[30px] w-[30px] items-center justify-center rounded-[9px] bg-[#EEF2FA] dark:bg-[rgba(29,78,216,0.18)]">
            <Icon name="upload" size={16} color="#254680" strokeWidth={1.75} />
          </View>
          <View className="min-w-0 flex-1">
            <Text className="text-[12.5px] font-sans-bold text-[#1E293B] dark:text-[#F8FAFC]">
              Invite a group of people
            </Text>
            <Text className="mt-[2px] text-[11px] leading-[15px] text-[#64748B] dark:text-[#94A3B8]">
              Upload a list and text everyone an invite.
            </Text>
          </View>
          <View className="mt-[6px]">
            <Icon name="chevronRight" size={15} color="#94A3B8" strokeWidth={1.9} />
          </View>
        </Pressable>

        <View className="flex-row items-baseline justify-between">
          <Text className="text-[14.5px] font-sans-bold text-[#0F172A] dark:text-[#F8FAFC]">My respondents</Text>
        </View>

        <View className="gap-2">
          {mine.map((r) => {
            const meta = STATUS_META[r.activationStatus] || null;
            return (
              <Pressable
                key={r.id}
                onPress={() => onOpenRespondent(r)}
                className="flex-row items-center gap-[10px] rounded-[20px] border border-[#E2E8F0] bg-white p-3 dark:border-[#1B3556] dark:bg-[#0F2038]"
              >
                <View className="h-[34px] w-[34px] items-center justify-center rounded-full bg-[#F1F5F9] dark:bg-[#1B3556]">
                  <Text className="text-[11px] font-sans-bold text-[#475569] dark:text-[#94A3B8]">
                    {initials(r.name)}
                  </Text>
                </View>
                <View className="min-w-0 flex-1">
                  <Text className="text-[13px] font-sans-semibold text-[#1E293B] dark:text-[#F8FAFC]" numberOfLines={1}>
                    {r.name || r.respondentCode}
                  </Text>
                  <Text className="font-mono text-[10.5px] text-[#94A3B8]" numberOfLines={1}>
                    {r.respondentCode} · {r.studyName}
                  </Text>
                </View>
                {meta ? (
                  <View className="rounded-full px-[9px] py-[3px]" style={{ backgroundColor: meta.bg }}>
                    <Text
                      style={{ color: meta.color }}
                      className="text-[10.5px] font-sans-bold uppercase tracking-[0.2px]"
                    >
                      {meta.label}
                    </Text>
                  </View>
                ) : (
                  <Text className="text-[11.5px] font-sans-bold text-[#1D4ED8] dark:text-[#60A5FA]">Hand over →</Text>
                )}
              </Pressable>
            );
          })}
          {!mine.length ? (
            <Text className="py-4 text-center text-[12px] text-[#64748B] dark:text-[#94A3B8]">
              No respondents registered yet.
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </Screen>
  );
}
