import React from "react";
import { View, Text, ScrollView } from "react-native";
import { Icon } from "../../icons";
import { Screen, BackRow, TitleBlock, PrimaryButton } from "./shared";

type ReviewRow = { rowNumber: number; name: string; contact: string; status: string; note: string; changed: boolean };

function initials(name: string) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1]?.[0] || "")).toUpperCase();
}

const STATUS_PILL: Record<string, { label: string; bg: string; color: string }> = {
  ok: { label: "Invite", bg: "#E6F4EA", color: "#1E7E34" },
  invalid: { label: "Fix", bg: "#FFF4E5", color: "#B8860B" },
  duplicate: { label: "Duplicate", bg: "#FFF4E5", color: "#B8860B" },
  already: { label: "On study", bg: "#F1F5F9", color: "#64748B" },
  skipped: { label: "Skipped", bg: "#F1F5F9", color: "#64748B" },
};

export function InterviewerBulkReviewScreen({
  filename,
  rows,
  summary,
  onBack,
  onSend,
  busy,
}: {
  filename: string;
  rows: ReviewRow[];
  summary: { total: number; ok: number; reformatted: number };
  onBack: () => void;
  onSend: () => void;
  busy: boolean;
}) {
  const needFixing = summary.total - summary.ok;

  return (
    <Screen>
      <BackRow label="Upload a different list" onPress={onBack} />
      <View className="mb-[9px]">
        <Text className="text-[9.5px] font-sans-bold uppercase tracking-[0.6px] text-[#2E5395] dark:text-[#7EAEDA]">
          Recruitment · Step 3
        </Text>
        <TitleBlock title="Check before sending" subtitle={`${filename} · ${summary.total} rows. Nothing sent yet.`} />
      </View>

      <View className="mb-[9px] flex-row gap-[7px]">
        <View className="flex-1 items-center rounded-[14px] border border-[#BEE8CE] bg-white px-2 py-2 dark:bg-[#0F2038]">
          <Text className="text-[9px] font-sans-bold uppercase text-[#1E7E34]">Will be invited</Text>
          <Text className="mt-[3px] font-mono-semibold text-[19px] text-[#0F172A] dark:text-[#F8FAFC]">
            {summary.ok}
          </Text>
        </View>
        <View className="flex-1 items-center rounded-[14px] border border-[#E2E8F0] bg-white px-2 py-2 dark:border-[#1B3556] dark:bg-[#0F2038]">
          <Text className="text-[9px] font-sans-bold uppercase text-[#94A3B8]">Need fixing</Text>
          <Text className="mt-[3px] font-mono-semibold text-[19px] text-[#0F172A] dark:text-[#F8FAFC]">
            {needFixing}
          </Text>
        </View>
      </View>

      {summary.reformatted ? (
        <View className="mb-[9px] flex-row items-start gap-[7px] rounded-[11px] border border-[#BFDBFE] bg-[#EFF6FF] px-[9px] py-2">
          <Icon name="warning" size={13} color="#1D4ED8" strokeWidth={1.9} />
          <Text className="flex-1 text-[9px] leading-[13px] text-[#1D4ED8]">
            <Text className="font-sans-bold">{summary.reformatted} numbers</Text> were rewritten to international
            format. Check a couple before sending.
          </Text>
        </View>
      ) : null}

      <ScrollView
        className="flex-1 rounded-2xl border border-[#E2E8F0] bg-white px-3 dark:border-[#1B3556] dark:bg-[#0F2038]"
        showsVerticalScrollIndicator={false}
      >
        {rows.map((row, i) => {
          const pill = STATUS_PILL[row.status] || STATUS_PILL.invalid;
          return (
            <View
              key={row.rowNumber}
              className="flex-row items-center gap-2 py-[7px]"
              style={i > 0 ? { borderTopWidth: 1, borderTopColor: "#F1F5F9" } : null}
            >
              <View className="h-[26px] w-[26px] items-center justify-center rounded-full bg-[#F1F5F9] dark:bg-[#1B3556]">
                <Text className="text-[10px] font-sans-bold text-[#475569] dark:text-[#94A3B8]">
                  {row.name ? initials(row.name) : "?"}
                </Text>
              </View>
              <View className="min-w-0 flex-1">
                <Text className="text-[11.5px] font-sans-semibold text-[#1E293B] dark:text-[#F8FAFC]" numberOfLines={1}>
                  {row.name || `Row ${row.rowNumber}`}
                </Text>
                <Text className="font-mono text-[9px] text-[#94A3B8]" numberOfLines={1}>
                  {row.contact || row.note || "No number found"}
                </Text>
              </View>
              <View className="rounded-full px-[7px] py-[2px]" style={{ backgroundColor: pill.bg }}>
                <Text
                  style={{ color: pill.color }}
                  className="text-[9px] font-sans-bold uppercase tracking-[0.15px]"
                >
                  {pill.label}
                </Text>
              </View>
            </View>
          );
        })}
      </ScrollView>

      <View style={{ height: 10 }} />
      <PrimaryButton title={`Invite ${summary.ok} people`} onPress={onSend} icon="chat" disabled={!summary.ok} loading={busy} />
    </Screen>
  );
}
