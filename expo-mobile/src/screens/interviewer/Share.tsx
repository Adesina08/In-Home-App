import React from "react";
import { View, Text, Pressable, Image } from "react-native";
import { Icon } from "../../icons";
import { Screen, BackRow } from "./shared";

export function InterviewerShareScreen({
  name,
  respondentCode,
  studyName,
  contact,
  diaryUrl,
  qr,
  onBack,
  onCopyLink,
  onSendLink,
  sending,
  copied,
}: {
  name: string;
  respondentCode: string;
  studyName: string;
  contact: string | null;
  diaryUrl: string;
  qr: string | null;
  onBack: () => void;
  onCopyLink: () => void;
  onSendLink: () => void;
  sending: boolean;
  copied: boolean;
}) {
  return (
    <Screen>
      <BackRow label="My Respondents" onPress={onBack} />
      <View className="flex-1 gap-[10px] rounded-[20px] border border-[#E2E8F0] bg-white p-4 dark:border-[#1B3556] dark:bg-[#0F2038]">
        <View className="items-center">
          <Text className="text-[9.5px] font-sans-bold uppercase tracking-[0.6px] text-[#2E5395] dark:text-[#7EAEDA]">
            Fieldwork
          </Text>
          <Text className="mt-[1px] font-disp-extrabold text-[16px] text-[#0F172A] dark:text-[#F8FAFC]">{name}</Text>
          <Text className="mt-[1px] font-mono text-[10px] text-[#64748B] dark:text-[#94A3B8]">
            {respondentCode} · {studyName}
          </Text>
        </View>

        <View className="items-center">
          {qr ? (
            <View className="mb-2 h-[118px] w-[118px] rounded-xl border border-[#E2E8F0] p-2 dark:border-[#1B3556]">
              <Image source={{ uri: qr }} style={{ width: "100%", height: "100%" }} resizeMode="contain" />
            </View>
          ) : null}
          <Text className="text-[10.5px] font-sans-semibold text-[#334155] dark:text-[#F8FAFC]">
            Scan with their own phone's camera.
          </Text>
        </View>

        <View className="border-t border-[#E2E8F0] pt-[10px] dark:border-[#1B3556]">
          <Text className="mb-[5px] text-[9px] font-sans-bold uppercase tracking-[0.6px] text-[#94A3B8]">
            Their link
          </Text>
          <View className="mb-[6px] rounded-[9px] border border-[#E2E8F0] bg-[#F8FAFC] px-[9px] py-[7px] dark:border-[#1B3556] dark:bg-[#081222]">
            <Text className="font-mono text-[9px] text-[#475569] dark:text-[#94A3B8]" numberOfLines={2}>
              {diaryUrl}
            </Text>
          </View>
          <Pressable
            onPress={onCopyLink}
            className="h-8 flex-row items-center justify-center gap-[6px] rounded-[11px] border border-[#CBD5E1] bg-white dark:border-[#1B3556] dark:bg-[#0F2038]"
          >
            <Icon name="document" size={13} color="#334155" strokeWidth={1.75} />
            <Text className="text-[11px] font-sans-semibold text-[#334155] dark:text-[#F8FAFC]">
              {copied ? "Copied!" : "Copy link"}
            </Text>
          </Pressable>
        </View>

        <View className="border-t border-[#E2E8F0] pt-[10px] dark:border-[#1B3556]">
          <Text className="mb-[5px] text-[9px] font-sans-bold uppercase tracking-[0.6px] text-[#94A3B8]">
            Send it to their phone
          </Text>
          <Text className="mb-[7px] text-[10px] leading-[14px] text-[#64748B] dark:text-[#94A3B8]">
            Texts <Text className="font-sans-bold text-[#334155] dark:text-[#F8FAFC]">{contact || "—"}</Text> the number
            on file.
          </Text>
          <Pressable
            onPress={onSendLink}
            disabled={sending}
            className="h-9 flex-row items-center justify-center gap-[6px] rounded-[11px] bg-[#1D4ED8]"
            style={sending ? { opacity: 0.6 } : null}
          >
            <Icon name="chat" size={13} color="#fff" strokeWidth={1.9} />
            <Text className="text-[12px] font-sans-bold text-white">{sending ? "Sending…" : "Send the link"}</Text>
          </Pressable>
        </View>
      </View>
    </Screen>
  );
}
