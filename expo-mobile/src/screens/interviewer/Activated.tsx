import React from "react";
import { View, Text, Image } from "react-native";
import { Screen, ResultCard, ResultIcon, PrimaryButton } from "./shared";

export function InterviewerActivatedScreen({
  code,
  diaryUrl,
  qr,
  onSendLink,
  onRegisterAnother,
  sending,
}: {
  code: string;
  diaryUrl: string;
  qr: string | null;
  onSendLink: () => void;
  onRegisterAnother: () => void;
  sending: boolean;
}) {
  return (
    <Screen>
      <View className="flex-1 justify-center">
        <ResultCard>
          <ResultIcon icon="checkCircle" tone="green" />
          <Text className="font-disp-extrabold text-[18px] text-[#0F172A] dark:text-[#F8FAFC]">
            Respondent Activated
          </Text>
          <Text className="my-2 text-center text-[11.5px] leading-[17px] text-[#64748B] dark:text-[#94A3B8]">
            Code <Text className="font-sans-bold text-[#334155] dark:text-[#F8FAFC]">{code}</Text> is now active. Have
            the respondent scan below with their own phone — it opens their diary and sets their Face ID / fingerprint
            lock.
          </Text>

          {qr ? (
            <View className="mb-[10px] h-[172px] w-[172px] items-center justify-center rounded-2xl border border-[#E2E8F0] bg-white p-[10px] dark:border-[#1B3556]">
              <Image source={{ uri: qr }} style={{ width: "100%", height: "100%" }} resizeMode="contain" />
            </View>
          ) : null}
          <Text className="mb-3 text-[9.5px] text-[#94A3B8]">
            Must be their own phone — the lock is tied to that device.
          </Text>

          <View className="mb-4 w-full rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC] px-[10px] py-2 dark:border-[#1B3556] dark:bg-[#081222]">
            <Text className="font-mono text-[9.5px] text-[#475569] dark:text-[#94A3B8]" numberOfLines={1}>
              {diaryUrl}
            </Text>
          </View>

          <View className="w-full gap-2">
            <PrimaryButton title="Send them the link" onPress={onSendLink} icon="chat" loading={sending} />
            <PrimaryButton title="Register Another" onPress={onRegisterAnother} icon="plus" inverse />
          </View>
        </ResultCard>
      </View>
    </Screen>
  );
}
