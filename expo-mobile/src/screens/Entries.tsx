import React from "react";
import { View, Text, Pressable } from "react-native";
import { useColorScheme } from "nativewind";
import { Icon, IconName } from "../icons";
import { TabBar } from "../components/TabBar";
import type { DisplayRecord } from "./Home";

function FilterPill({ label, count, active }: { label: string; count: number; active?: boolean }) {
  return (
    <View
      className={
        active
          ? "flex-row items-center gap-[5px] rounded-full bg-[#1D4ED8] px-3 py-[6px]"
          : "flex-row items-center gap-[5px] rounded-full border border-[#E2E8F0] bg-white px-3 py-[6px] dark:border-[#1B3556] dark:bg-[#0F2038]"
      }
    >
      <Text
        className={
          active
            ? "text-[11px] font-sans-semibold text-white"
            : "text-[11px] font-sans-semibold text-[#94A3B8]"
        }
      >
        {label}
      </Text>
      <Text className={active ? "font-mono text-[11px] text-white" : "font-mono text-[11px] text-[#94A3B8]"}>
        {count}
      </Text>
    </View>
  );
}

function EntryPill({ label, isDark, tone }: { label: string; isDark: boolean; tone: "green" | "amber" | "blue" }) {
  const map = {
    green: { bg: isDark ? "rgba(4,120,87,0.18)" : "#ECFDF5", color: isDark ? "#34D399" : "#047857" },
    amber: { bg: isDark ? "rgba(180,83,9,0.18)" : "#FEF6E7", color: isDark ? "#FBBF24" : "#B45309" },
    blue: { bg: isDark ? "rgba(29,78,216,0.18)" : "#EFF4FF", color: isDark ? "#93C5FD" : "#1D4ED8" },
  }[tone];
  return (
    <View className="rounded-full px-2 py-[2px]" style={{ backgroundColor: map.bg }}>
      <Text style={{ color: map.color }} className="text-[9.5px] font-sans-bold uppercase tracking-[0.2px]">
        {label}
      </Text>
    </View>
  );
}

const BUCKET_META: Record<
  DisplayRecord["bucket"],
  { icon: IconName; iconTone: "blue" | "amber"; pillLabel: string; pillTone: "green" | "amber" | "blue"; sub: (r: DisplayRecord) => string }
> = {
  submitted: { icon: "document", iconTone: "blue", pillLabel: "Submitted", pillTone: "green", sub: () => "Submitted" },
  review: { icon: "videoCamera", iconTone: "amber", pillLabel: "Being checked", pillTone: "amber", sub: () => "Being checked" },
  draft: { icon: "mic", iconTone: "blue", pillLabel: "Draft", pillTone: "blue", sub: () => "No items attached" },
};

function EntryRow({ isDark, record }: { isDark: boolean; record: DisplayRecord }) {
  const meta = BUCKET_META[record.bucket];
  const iconColor = meta.iconTone === "blue" ? (isDark ? "#60A5FA" : "#1D4ED8") : isDark ? "#FBBF24" : "#B45309";
  const iconBg =
    meta.iconTone === "blue"
      ? isDark
        ? "rgba(29,78,216,0.18)"
        : "#EFF4FF"
      : isDark
      ? "rgba(180,83,9,0.18)"
      : "#FEF6E7";
  return (
    <View
      className="flex-row items-center gap-[10px] rounded-2xl border border-[#E2E8F0] bg-white px-3 py-[10px] dark:border-[#1B3556] dark:bg-[#0F2038]"
      style={record.bucket === "review" ? { borderLeftWidth: 3, borderLeftColor: "#B45309" } : null}
    >
      <View className="h-[30px] w-[30px] items-center justify-center rounded-[9px]" style={{ backgroundColor: iconBg }}>
        <Icon name={meta.icon} size={15} color={iconColor} strokeWidth={1.75} />
      </View>
      <View className="min-w-0 flex-1">
        <Text className="font-mono-semibold text-[11px] text-[#0F172A] dark:text-[#F8FAFC]">
          {record.day}, {record.time}
        </Text>
        <Text className="mt-[1px] text-[10px] text-[#94A3B8]">{meta.sub(record)}</Text>
      </View>
      <EntryPill label={meta.pillLabel} isDark={isDark} tone={meta.pillTone} />
    </View>
  );
}

export function EntriesScreen({
  records,
  submittedCount,
  draftsCount,
  onNavigate,
  onToggleTheme,
}: {
  records: DisplayRecord[];
  submittedCount: number;
  draftsCount: number;
  onNavigate?: (key: string) => void;
  onToggleTheme: () => void;
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === "dark";

  return (
    <View className="flex-1 bg-[#FAF9F7] dark:bg-[#0A1628]">
      <View className="h-[18px] shrink-0" />
      <View className="flex-1 gap-3 px-[18px] pb-4">
        <View className="flex-row items-center justify-between">
          <Text
            className="font-disp-extrabold text-[20px] text-[#0F172A] dark:text-[#F8FAFC]"
            style={{ letterSpacing: -0.2 }}
          >
            My diary
          </Text>
          <Pressable
            onPress={onToggleTheme}
            className="h-7 w-7 items-center justify-center rounded-[9px] border border-[#E2E8F0] bg-white dark:border-[#1B3556] dark:bg-[#0F2038]"
          >
            <Icon name="search" size={14} color="#94A3B8" strokeWidth={1.75} />
          </Pressable>
        </View>

        <View className="flex-row gap-[7px]">
          <FilterPill label="All" count={records.length} active />
          <FilterPill label="Submitted" count={submittedCount} />
          <FilterPill label="Drafts" count={draftsCount} />
        </View>

        {records.length > 0 ? (
          <View className="flex-1 gap-2">
            {records.map((r) => (
              <EntryRow key={r.id} isDark={isDark} record={r} />
            ))}
          </View>
        ) : (
          <Text className="text-[11px] text-[#64748B] dark:text-[#94A3B8]">
            No diary entries yet — they'll show up here once you log an occasion.
          </Text>
        )}
      </View>
      <TabBar active="entries" onNavigate={onNavigate} />
    </View>
  );
}
