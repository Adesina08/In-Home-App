import React from "react";
import { View, Text } from "react-native";
import { Screen, ResultCard, ResultIcon, PrimaryButton } from "./shared";

export function InterviewerBulkDoneScreen({
  studyName,
  outcome,
  onSeeRespondents,
  onInviteMore,
}: {
  studyName: string;
  outcome: { invited: number; failed: number; skipped: number; errors: string[] };
  onSeeRespondents: () => void;
  onInviteMore: () => void;
}) {
  const problems = outcome.failed + outcome.skipped;
  return (
    <Screen>
      <View className="flex-1 justify-center">
        <ResultCard>
          <ResultIcon icon="checkCircle" tone="green" />
          <Text className="font-disp-extrabold text-[19px] text-[#0F172A] dark:text-[#F8FAFC]">
            Invitations sent
          </Text>
          <Text className="my-2 text-center text-[12px] leading-[18px] text-[#64748B] dark:text-[#94A3B8]">
            {outcome.invited} people were invited to{" "}
            <Text className="font-sans-bold text-[#334155] dark:text-[#F8FAFC]">{studyName}</Text>.
            {problems ? ` ${problems} rows were skipped and need fixing.` : ""}
          </Text>

          {outcome.errors.length ? (
            <View className="mb-[18px] w-full rounded-xl border border-[#FDE9C4] bg-[#FFF9EF] px-3 py-[10px]">
              <Text className="mb-1 text-[10.5px] font-sans-bold text-[#B8860B]">
                {outcome.errors.length} problem{outcome.errors.length === 1 ? "" : "s"}
              </Text>
              {outcome.errors.slice(0, 5).map((e, i) => (
                <Text key={i} className="text-[10.5px] leading-[17px] text-[#8A6416]">
                  · {e}
                </Text>
              ))}
            </View>
          ) : (
            <View style={{ height: 6 }} />
          )}

          <Text className="mb-[18px] text-center text-[10px] leading-[15px] text-[#94A3B8]">
            Everyone invited now appears on the respondents list, marked "Invited" until they open their link and
            choose to take part.
          </Text>

          <View className="w-full gap-2">
            <PrimaryButton title="See the respondents" onPress={onSeeRespondents} icon="users" />
            <PrimaryButton title="Invite more" onPress={onInviteMore} icon="plus" inverse />
          </View>
        </ResultCard>
      </View>
    </Screen>
  );
}
