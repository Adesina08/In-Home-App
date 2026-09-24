import React from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useColorScheme } from "nativewind";
import { Icon } from "../icons";

export type RewardStatus = "in_progress" | "under_review" | "eligible" | "processing" | "paid" | "held";

export type RewardItem = {
  ledgerId: number | string | null;
  ruleId: number | string | null;
  milestone: "onboarding" | "participation" | "closeout";
  amount: number;
  currency: string;
  status: RewardStatus;
  requiredPeriods: number;
  completedPeriods: number;
  submittedPeriods: number;
  cadence: string;
  paidAt: string | null;
  paymentReference: string | null;
  holdReason: string | null;
  active: boolean;
};

export type RewardSummary = {
  currency: string;
  potential: number;
  eligible: number;
  processing: number;
  paid: number;
  held: number;
};

export type RewardsData = {
  rewards: RewardItem[];
  summary: RewardSummary[];
  cadence?: string;
  lastUpdated?: string;
  celebration?: RewardCelebrationData | null;
};

export type RewardCelebrationData = {
  headline: string;
  message: string;
  primaryColor: string;
  accentColor: string;
  durationMs: number;
  amount: number;
  currency: string;
  items: { ledgerId: number | string; version: number; milestone: string; amount: number; currency: string; status: string }[];
};

const money = (currency: string, amount: number) => `${currency} ${Number(amount || 0).toLocaleString()}`;
const cadenceWord = (value: string) => value === "daily" ? "daily" : value === "monthly" ? "monthly" : "weekly";

function rewardTitle(reward: RewardItem) {
  if (reward.milestone === "onboarding") return "Getting started";
  if (reward.milestone === "closeout") return "Final study completion";
  return `${reward.requiredPeriods} valid ${cadenceWord(reward.cadence)} participation ${reward.requiredPeriods === 1 ? "period" : "periods"}`;
}

function statusMeta(status: RewardStatus, isDark: boolean) {
  const map = {
    in_progress: { label: "In progress", color: isDark ? "#93C5FD" : "#1D4ED8", bg: isDark ? "rgba(29,78,216,.2)" : "#EFF4FF" },
    under_review: { label: "Under review", color: isDark ? "#FBBF24" : "#B45309", bg: isDark ? "rgba(180,83,9,.2)" : "#FEF6E7" },
    eligible: { label: "Eligible · awaiting payment", color: isDark ? "#34D399" : "#047857", bg: isDark ? "rgba(4,120,87,.2)" : "#ECFDF5" },
    processing: { label: "With finance · payment processing", color: isDark ? "#93C5FD" : "#1D4ED8", bg: isDark ? "rgba(29,78,216,.2)" : "#EFF4FF" },
    paid: { label: "Paid", color: isDark ? "#34D399" : "#047857", bg: isDark ? "rgba(4,120,87,.2)" : "#ECFDF5" },
    held: { label: "On hold · under review", color: isDark ? "#FCA5A5" : "#B91C1C", bg: isDark ? "rgba(185,28,28,.2)" : "#FEF2F2" },
  };
  return map[status] || map.in_progress;
}

export function RewardsScreen({
  studyName,
  data,
  pendingCount,
  refreshing,
  onBack,
  onRefresh,
}: {
  studyName: string;
  data: RewardsData;
  pendingCount: number;
  refreshing: boolean;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === "dark";
  const muted = isDark ? "#94A3B8" : "#64748B";
  const text = isDark ? "#F8FAFC" : "#0F172A";
  const border = isDark ? "#1B3556" : "#E2E8F0";
  const card = isDark ? "#0F2038" : "#FFFFFF";
  const summary = data.summary[0];

  return (
    <ScrollView
      className="flex-1 bg-[#FAF9F7] dark:bg-[#0A1628]"
      contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 16, paddingBottom: 30, gap: 14 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#1D4ED8" />}
    >
      <Pressable accessibilityRole="button" onPress={onBack} className="min-h-[44px] flex-row items-center gap-2">
        <Icon name="chevronLeft" size={17} color="#1D4ED8" strokeWidth={2} />
        <Text className="text-[12px] font-sans-semibold text-[#1D4ED8] dark:text-[#60A5FA]">Back to profile</Text>
      </Pressable>

      <View>
        <Text className="font-disp-extrabold text-[25px] text-[#0F172A] dark:text-[#F8FAFC]">My rewards</Text>
        <Text className="mt-1 text-[11.5px] text-[#64748B] dark:text-[#94A3B8]">{studyName}</Text>
      </View>

      {summary ? (
        <View className="overflow-hidden rounded-[20px] bg-[#1D4ED8] p-4">
          <View className="absolute -right-8 -top-8 h-28 w-28 rounded-full border-[14px] border-white opacity-10" />
          <Text className="text-[10px] font-sans-bold uppercase tracking-[.6px] text-blue-100">Eligible now</Text>
          <Text className="mt-1 font-mono-semibold text-[28px] text-white">{money(summary.currency, Number(summary.eligible || 0) + Number(summary.processing || 0))}</Text>
          <Text className="mt-1 text-[10.5px] text-blue-100">{summary.processing ? `${money(summary.currency, summary.processing)} is currently with the finance team` : "Awaiting finance processing by the research team"}</Text>
          <View className="mt-4 flex-row gap-3 border-t border-blue-400 pt-3">
            <View className="flex-1"><Text className="font-mono-semibold text-[15px] text-white">{money(summary.currency, summary.paid)}</Text><Text className="text-[9px] text-blue-100">Paid to you</Text></View>
            <View className="flex-1"><Text className="font-mono-semibold text-[15px] text-white">{money(summary.currency, summary.potential)}</Text><Text className="text-[9px] text-blue-100">Total available</Text></View>
          </View>
        </View>
      ) : null}

      {pendingCount > 0 ? (
        <View className="flex-row gap-2 rounded-2xl border p-3" style={{ borderColor: border, backgroundColor: card }}>
          <Icon name="upload" size={16} color="#B45309" />
          <Text className="flex-1 text-[10.5px] leading-[15px]" style={{ color: muted }}>{pendingCount} saved {pendingCount === 1 ? "entry is" : "entries are"} still waiting to sync. Unsynced entries do not count toward rewards yet.</Text>
        </View>
      ) : null}

      {data.rewards.length ? (
        <View className="gap-3">
          <Text className="text-[12.5px] font-sans-bold" style={{ color: text }}>Reward milestones</Text>
          {data.rewards.map((reward, index) => {
            const meta = statusMeta(reward.status, isDark);
            const progress = reward.requiredPeriods > 0 ? Math.min(1, reward.completedPeriods / reward.requiredPeriods) : 0;
            return (
              <View key={`${reward.ruleId ?? "history"}-${index}`} className="rounded-2xl border p-4" style={{ borderColor: border, backgroundColor: card }}>
                <View className="flex-row items-start justify-between gap-3">
                  <View className="min-w-0 flex-1"><Text className="text-[13px] font-sans-bold" style={{ color: text }}>{rewardTitle(reward)}</Text><Text className="mt-1 text-[10px]" style={{ color: muted }}>Additional reward</Text></View>
                  <Text className="font-mono-semibold text-[16px] text-[#1D4ED8] dark:text-[#60A5FA]">{money(reward.currency, reward.amount)}</Text>
                </View>
                <View className="mt-3 self-start rounded-full px-2 py-1" style={{ backgroundColor: meta.bg }}><Text className="text-[9px] font-sans-bold uppercase" style={{ color: meta.color }}>{meta.label}</Text></View>

                {reward.milestone === "participation" && ["in_progress", "under_review"].includes(reward.status) ? (
                  <View className="mt-3">
                    <View className="mb-1 flex-row justify-between"><Text className="text-[10px]" style={{ color: muted }}>{reward.completedPeriods} of {reward.requiredPeriods} valid periods</Text><Text className="font-mono text-[10px]" style={{ color: muted }}>{Math.round(progress * 100)}%</Text></View>
                    <View className="h-2 overflow-hidden rounded-full" style={{ backgroundColor: isDark ? "#1B3556" : "#E2E8F0" }}><View className="h-full rounded-full bg-[#1D4ED8]" style={{ width: `${progress * 100}%` }} /></View>
                    {reward.status === "under_review" ? <Text className="mt-2 text-[10px]" style={{ color: muted }}>You submitted enough periods, but one or more entries are still being reviewed.</Text> : null}
                  </View>
                ) : null}

                {reward.milestone === "closeout" ? <Text className="mt-3 text-[10.5px] leading-[15px]" style={{ color: muted }}>Complete the final validation after reaching {reward.requiredPeriods} valid participation {reward.requiredPeriods === 1 ? "period" : "periods"}.</Text> : null}
                {reward.holdReason ? <Text className="mt-3 text-[10.5px] leading-[15px]" style={{ color: meta.color }}>{reward.holdReason}</Text> : null}
                {reward.paidAt ? <Text className="mt-3 text-[10px]" style={{ color: muted }}>Paid {String(reward.paidAt).slice(0, 10)}{reward.paymentReference ? ` · Reference ${reward.paymentReference}` : ""}</Text> : null}
                {!reward.active ? <Text className="mt-2 text-[9.5px]" style={{ color: muted }}>Historical reward · no longer available to earn</Text> : null}
              </View>
            );
          })}
        </View>
      ) : (
        <View className="rounded-2xl border p-4" style={{ borderColor: border, backgroundColor: card }}>
          <Text className="text-[13px] font-sans-bold" style={{ color: text }}>No financial reward configured</Text>
          <Text className="mt-2 text-[10.5px] leading-[15px]" style={{ color: muted }}>This study currently has no reward milestones. If that changes, the confirmed amounts and requirements will appear here.</Text>
        </View>
      )}

      <View className="rounded-2xl border p-4" style={{ borderColor: border, backgroundColor: card }}>
        <View className="flex-row items-center gap-2"><Icon name="question" size={16} color="#1D4ED8" /><Text className="text-[12px] font-sans-bold" style={{ color: text }}>How rewards work</Text></View>
        <Text className="mt-2 text-[10.5px] leading-[16px]" style={{ color: muted }}>Only entries received by Inicio and accepted for the required calendar period count. Eligible rewards are paid outside the app by the research team, then recorded here. Multiple uploads in one period do not create extra milestone credit.</Text>
        {data.lastUpdated ? <Text className="mt-3 text-[9px]" style={{ color: muted }}>Last confirmed {String(data.lastUpdated).replace(" ", " · ").slice(0, 18)} UTC</Text> : null}
      </View>
    </ScrollView>
  );
}
