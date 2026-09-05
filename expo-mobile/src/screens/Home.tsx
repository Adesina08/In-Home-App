import React from "react";
import { View, Text, Pressable } from "react-native";
import { useColorScheme } from "nativewind";
import { Icon } from "../icons";
import { TabBar } from "../components/TabBar";

export type DisplayRecord = {
  id: number | string;
  time: string;
  day: string;
  bucket: "submitted" | "draft" | "review";
};

function Pill({ label, isDark, tone }: { label: string; isDark: boolean; tone: "green" | "blue" | "amber" }) {
  const map = {
    green: { bg: isDark ? "rgba(4,120,87,0.18)" : "#ECFDF5", color: isDark ? "#34D399" : "#047857" },
    blue: { bg: isDark ? "rgba(29,78,216,0.18)" : "#EFF4FF", color: isDark ? "#93C5FD" : "#1D4ED8" },
    amber: { bg: isDark ? "rgba(180,83,9,0.18)" : "#FEF6E7", color: isDark ? "#FBBF24" : "#B45309" },
  }[tone];
  return (
    <View className="rounded-full px-2 py-[2px]" style={{ backgroundColor: map.bg }}>
      <Text style={{ color: map.color }} className="text-[9.5px] font-sans-bold uppercase tracking-[0.2px]">
        {label}
      </Text>
    </View>
  );
}

const BUCKET_META = {
  submitted: { icon: "document" as const, activityLabel: "Diary submitted", pillLabel: "Submitted", pillTone: "green" as const },
  draft: { icon: "mic" as const, activityLabel: "Draft saved", pillLabel: "Draft", pillTone: "blue" as const },
  review: { icon: "videoCamera" as const, activityLabel: "Being reviewed", pillLabel: "Being checked", pillTone: "amber" as const },
};

function OccasionCard({
  isDark,
  record,
}: {
  isDark: boolean;
  record: DisplayRecord;
}) {
  const meta = BUCKET_META[record.bucket];
  const blueIcon = isDark ? "#60A5FA" : "#1D4ED8";
  const purpleIcon = isDark ? "#c084fc" : "#7C3AED";
  const iconColor = record.bucket === "submitted" ? blueIcon : record.bucket === "review" ? purpleIcon : "#94A3B8";
  const dashed = record.bucket === "draft";
  const amberEdge = record.bucket === "review";
  return (
    <View
      className="flex-row items-center gap-[7px] rounded-2xl border border-[#E2E8F0] bg-white px-[9px] py-[7px] dark:border-[#1B3556] dark:bg-[#0F2038]"
      style={[
        amberEdge ? { borderLeftWidth: 3, borderLeftColor: "#B45309" } : null,
        dashed
          ? { borderStyle: "dashed", borderColor: isDark ? "#1B3556" : "#CBD5E1", backgroundColor: "transparent" }
          : null,
      ]}
    >
      <Icon name={meta.icon} size={13} color={iconColor} strokeWidth={1.75} />
      <View className="min-w-0">
        <Text className="font-mono text-[10px] text-[#0F172A] dark:text-[#F8FAFC]">{record.time}</Text>
        <Text className="text-[9px] text-[#94A3B8] dark:text-[#64748B]">{meta.pillLabel}</Text>
      </View>
    </View>
  );
}

export function HomeScreen({
  firstName,
  studyName,
  consentNeeded,
  consentBody,
  busy,
  onAcceptConsent,
  submittedCount,
  draftsCount,
  totalCount,
  recentRecords,
  occasionRecords,
  onStartDiary,
  onOpenStudies,
  onViewAllEntries,
  onNavigate,
}: {
  firstName: string;
  studyName: string;
  consentNeeded: boolean;
  consentBody?: string;
  busy: boolean;
  onAcceptConsent: () => void;
  submittedCount: number;
  draftsCount: number;
  totalCount: number;
  recentRecords: DisplayRecord[];
  occasionRecords: DisplayRecord[];
  onStartDiary: () => void;
  onOpenStudies: () => void;
  onViewAllEntries: () => void;
  onNavigate?: (key: string) => void;
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === "dark";
  const blueIcon = isDark ? "#60A5FA" : "#1D4ED8";
  const muted = isDark ? "#94A3B8" : "#64748B";
  const chevronMuted = isDark ? "#64748B" : "#94A3B8";
  const greenIcon = isDark ? "#34D399" : "#047857";

  return (
    <View className="flex-1 bg-[#FAF9F7] dark:bg-[#0A1628]">
      <View className="h-[18px] shrink-0" />
      <View className="flex-1 gap-[9px] px-[18px] pb-4">
        {/* Header */}
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-[6px]">
            <View className="h-5 w-5 items-center justify-center rounded-[6px] bg-[#EFF4FF] dark:bg-[rgba(29,78,216,0.2)]">
              <Icon name="book" size={12} color={blueIcon} strokeWidth={1.9} />
            </View>
            <Text className="font-disp-extrabold text-[12.5px] text-[#0F172A] dark:text-[#F8FAFC]">
              Inicio Diary
            </Text>
          </View>
          <View className="h-[26px] w-[26px] items-center justify-center rounded-full border border-[#E2E8F0] bg-white dark:border-[#1B3556] dark:bg-[#0F2038]">
            <Icon name="bell" size={13} color={muted} strokeWidth={1.75} />
            <View className="absolute right-0 top-0 h-[7px] w-[7px] rounded-full border-[1.5px] border-[#FAF9F7] bg-[#2563EB] dark:border-[#0A1628]" />
          </View>
        </View>

        {/* Greeting */}
        <View>
          <View className="flex-row items-center gap-[7px]">
            <Text
              className="font-disp-extrabold text-[21px] text-[#0F172A] dark:text-[#F8FAFC]"
              style={{ letterSpacing: -0.2 }}
            >
              Hi {firstName}
            </Text>
            <Icon name="wave" size={17} color={blueIcon} strokeWidth={1.9} />
          </View>
          <Text className="mt-[1px] text-[11.5px] text-[#64748B] dark:text-[#94A3B8]">
            Thanks for being part of this study.
          </Text>
        </View>

        {/* Study selector card */}
        <Pressable
          onPress={onOpenStudies}
          className="flex-row items-center gap-[10px] rounded-2xl border border-[#E2E8F0] bg-white px-3 py-[10px] dark:border-[#1B3556] dark:bg-[#0F2038]"
        >
          <View className="h-[30px] w-[30px] items-center justify-center rounded-[9px] bg-[#EFF4FF] dark:bg-[rgba(29,78,216,0.18)]">
            <Icon name="document" size={15} color={blueIcon} strokeWidth={1.75} />
          </View>
          <View className="min-w-0 flex-1">
            <Text className="text-[12.5px] font-sans-bold text-[#0F172A] dark:text-[#F8FAFC]" numberOfLines={1}>
              {studyName}
            </Text>
            <Text className="mt-[1px] text-[10px] text-[#64748B] dark:text-[#94A3B8]">Study selected</Text>
          </View>
          <Icon name="chevronRight" size={14} color={chevronMuted} strokeWidth={1.9} />
        </Pressable>

        {/* Consent banner */}
        {consentNeeded ? (
          <View className="rounded-2xl border border-[#B45309] bg-white p-3 dark:bg-[#0F2038]">
            <Text className="text-[12.5px] font-sans-bold text-[#0F172A] dark:text-[#F8FAFC]">Consent required</Text>
            {consentBody ? (
              <Text className="mt-[6px] text-[11.5px] leading-[16px] text-[#64748B] dark:text-[#94A3B8]">
                {consentBody}
              </Text>
            ) : null}
            <Pressable
              disabled={busy}
              onPress={onAcceptConsent}
              className="mt-[10px] h-[38px] flex-row items-center justify-center gap-[6px] rounded-xl bg-[#1D4ED8]"
              style={busy ? { opacity: 0.6 } : null}
            >
              <Text className="text-[13px] font-sans-bold text-white">
                {busy ? "Saving…" : "I agree — continue"}
              </Text>
            </Pressable>
          </View>
        ) : null}

        {/* Today's diary hero */}
        <View className="overflow-hidden rounded-[20px] px-4 pb-3 pt-[14px]" style={{ backgroundColor: "#1D4ED8" }}>
          <View
            className="absolute -right-[30px] -top-[30px] h-[100px] w-[100px] rounded-full"
            style={{ borderWidth: 14, borderColor: "rgba(255,255,255,0.08)" }}
          />
          <View className="mb-[6px] flex-row items-center gap-[7px]">
            <View
              className="h-[22px] w-[22px] items-center justify-center rounded-[7px]"
              style={{ backgroundColor: "rgba(255,255,255,0.16)" }}
            >
              <Icon name="archive" size={12} color="#fff" strokeWidth={1.9} />
            </View>
            <Text className="font-disp text-[15px] font-bold text-white">Today's diary</Text>
          </View>
          <Text className="mb-[10px] text-[11.5px] leading-[15.5px]" style={{ color: "rgba(255,255,255,0.82)" }}>
            Log everything you consume today.
          </Text>
          <Pressable
            disabled={consentNeeded || busy}
            onPress={onStartDiary}
            className="mb-[11px] h-[38px] flex-row items-center justify-center gap-[6px] rounded-xl bg-white"
            style={consentNeeded || busy ? { opacity: 0.6 } : null}
          >
            <Text className="text-[13px] font-sans-bold text-[#1D4ED8]">Log consumption</Text>
            <Icon name="arrowRight" size={13} color="#1D4ED8" strokeWidth={2.1} />
          </Pressable>
          <View className="mb-[9px] h-px" style={{ backgroundColor: "rgba(255,255,255,0.18)" }} />
          <View className="flex-row gap-5">
            <View>
              <Text className="font-mono-semibold text-[17px] text-white">{submittedCount}</Text>
              <Text className="text-[9.5px]" style={{ color: "rgba(255,255,255,0.75)" }}>
                Submitted entries
              </Text>
            </View>
            <View>
              <Text className="font-mono-semibold text-[17px] text-white">{draftsCount}</Text>
              <Text className="text-[9.5px]" style={{ color: "rgba(255,255,255,0.75)" }}>
                Drafts
              </Text>
            </View>
          </View>
        </View>

        {/* Study guide card */}
        <View className="flex-row items-center gap-[10px] rounded-2xl border border-[#E2E8F0] bg-white px-3 py-[9px] dark:border-[#1B3556] dark:bg-[#0F2038]">
          <View className="h-[26px] w-[26px] items-center justify-center rounded-lg bg-[#ECFDF5] dark:bg-[rgba(4,120,87,0.18)]">
            <Icon name="book" size={13} color={greenIcon} strokeWidth={1.75} />
          </View>
          <View className="flex-1">
            <Text className="text-[11.5px] font-sans-semibold text-[#0F172A] dark:text-[#F8FAFC]">Study guide</Text>
            <Text className="mt-[1px] text-[10px] text-[#64748B] dark:text-[#94A3B8]">
              Learn how to record entries accurately.
            </Text>
          </View>
          <Icon name="chevronRight" size={13} color={chevronMuted} strokeWidth={1.9} />
        </View>

        {/* Recent activity */}
        {recentRecords.length > 0 ? (
          <View>
            <View className="mb-[6px] flex-row items-baseline justify-between">
              <Text className="text-[12.5px] font-sans-bold text-[#0F172A] dark:text-[#F8FAFC]">Recent activity</Text>
              <Pressable onPress={onViewAllEntries}>
                <Text className="text-[10.5px] font-sans-semibold text-[#1D4ED8] dark:text-[#60A5FA]">View all</Text>
              </Pressable>
            </View>
            <View className="flex-row gap-[9px]">
              <View className="items-center pt-[1px]">
                {recentRecords.map((r, i) => {
                  const meta = BUCKET_META[r.bucket];
                  const tint =
                    r.bucket === "submitted"
                      ? { bg: isDark ? "rgba(4,120,87,0.2)" : "#ECFDF5", color: greenIcon }
                      : r.bucket === "review"
                      ? { bg: isDark ? "rgba(180,83,9,0.2)" : "#FEF6E7", color: isDark ? "#FBBF24" : "#B45309" }
                      : { bg: isDark ? "rgba(29,78,216,0.2)" : "#EFF4FF", color: blueIcon };
                  return (
                    <React.Fragment key={r.id}>
                      <View
                        className="h-[18px] w-[18px] items-center justify-center rounded-full"
                        style={{ backgroundColor: tint.bg }}
                      >
                        <Icon
                          name={r.bucket === "submitted" ? "checkCircle" : "pencil"}
                          size={10}
                          color={tint.color}
                          strokeWidth={2.2}
                        />
                      </View>
                      {i < recentRecords.length - 1 ? (
                        <View className="my-[2px] w-px flex-1 bg-[#E2E8F0] dark:bg-[#1B3556]" />
                      ) : null}
                    </React.Fragment>
                  );
                })}
              </View>
              <View className="min-w-0 flex-1 gap-[9px]">
                {recentRecords.map((r) => {
                  const meta = BUCKET_META[r.bucket];
                  return (
                    <View key={r.id} className="flex-row items-center justify-between gap-[6px]">
                      <View className="min-w-0">
                        <Text className="text-[11.5px] font-sans-semibold text-[#0F172A] dark:text-[#F8FAFC]">
                          {meta.activityLabel}
                        </Text>
                        <Text className="font-mono text-[9.5px] text-[#94A3B8] dark:text-[#64748B]">
                          {r.day}, {r.time}
                        </Text>
                      </View>
                      <Pill label={meta.pillLabel} isDark={isDark} tone={meta.pillTone} />
                    </View>
                  );
                })}
              </View>
            </View>
          </View>
        ) : null}

        {/* Occasions header */}
        <View className="flex-row items-center justify-between">
          <Text className="text-[10.5px] text-[#64748B] dark:text-[#94A3B8]">Your occasions</Text>
          <Text className="font-mono-semibold text-[11.5px] text-[#0F172A] dark:text-[#F8FAFC]">
            {totalCount} logged
          </Text>
        </View>

        {/* Occasions grid */}
        {occasionRecords.length > 0 ? (
          <View className="flex-row flex-wrap gap-[7px]">
            {occasionRecords.map((r) => (
              <View key={r.id} className="w-[47.5%]">
                <OccasionCard isDark={isDark} record={r} />
              </View>
            ))}
          </View>
        ) : (
          <Text className="text-[11px] text-[#64748B] dark:text-[#94A3B8]">
            No occasions logged yet — start with today's diary above.
          </Text>
        )}
      </View>
      <TabBar active="home" onNavigate={onNavigate} />
    </View>
  );
}
