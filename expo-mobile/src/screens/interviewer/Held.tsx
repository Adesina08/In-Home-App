import React from "react";
import { View, Text } from "react-native";
import { Screen, ResultCard, ResultIcon, PrimaryButton } from "./shared";

export function InterviewerHeldScreen({
  name,
  code,
  holds,
  onRegisterAnother,
  onMyRespondents,
}: {
  name: string;
  code: string;
  holds: Array<{ reason?: string; flagType?: string }>;
  onRegisterAnother: () => void;
  onMyRespondents: () => void;
}) {
  return (
    <Screen>
      <View className="flex-1 justify-center">
        <ResultCard>
          <ResultIcon icon="warning" tone="amber" />
          <Text className="font-disp-extrabold text-[18px] text-[#0F172A] dark:text-[#F8FAFC]">Held for Review</Text>
          <Text className="my-2 text-center text-[12px] leading-[18px] text-[#64748B] dark:text-[#94A3B8]">
            <Text className="font-sans-bold text-[#334155] dark:text-[#F8FAFC]">{name}</Text> was saved as{" "}
            <Text className="font-sans-bold text-[#334155] dark:text-[#F8FAFC]">{code}</Text>, but their diary hasn't
            been activated yet. Nothing is lost — the research team reviews this and activates them.
          </Text>

          {holds.length ? (
            <View className="mb-4 w-full gap-2">
              {holds.map((h, i) => (
                <View key={i} className="rounded-xl border border-[#FDE9C4] bg-[#FFF9EF] px-3 py-[10px]">
                  <Text className="mb-[3px] text-[9.5px] font-sans-bold uppercase tracking-[0.3px] text-[#B8860B]">
                    {h.flagType ? h.flagType.replace(/_/g, " ") : "Possible duplicate"}
                  </Text>
                  <Text className="text-[11.5px] leading-[15px] text-[#334155] dark:text-[#F8FAFC]">
                    {h.reason || "This entry needs a research team review before it can be activated."}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}

          <View className="mb-[18px] w-full rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-[10px] dark:border-[#1B3556] dark:bg-[#081222]">
            <Text className="mb-[2px] text-[10.5px] font-sans-bold text-[#334155] dark:text-[#F8FAFC]">
              What to do now
            </Text>
            <Text className="text-[10.5px] leading-[15px] text-[#64748B] dark:text-[#94A3B8]">
              If this is genuinely a different person, tell the research team so they can release the hold. Otherwise,
              no action is needed.
            </Text>
          </View>

          <View className="w-full gap-2">
            <PrimaryButton title="Register Another" onPress={onRegisterAnother} icon="plus" />
            <PrimaryButton title="My Respondents" onPress={onMyRespondents} icon="users" inverse />
          </View>
        </ResultCard>
      </View>
    </Screen>
  );
}
