import React, { useState } from "react";
import { View, Text, Pressable } from "react-native";
import { Icon } from "../../icons";
import { Screen, BackRow, TitleBlock, Card, FieldLabel, TextField, PrimaryButton } from "./shared";

export function InterviewerBulkUploadScreen({
  studyName,
  defaultCountryCode,
  messagingLive,
  onBack,
  onDownloadTemplate,
  onPickFile,
  onCheckList,
  fileName,
  busy,
}: {
  studyName: string;
  defaultCountryCode: string;
  messagingLive: boolean;
  onBack: () => void;
  onDownloadTemplate: () => void;
  onPickFile: () => void;
  onCheckList: (countryCode: string) => void;
  fileName: string | null;
  busy: boolean;
}) {
  const [countryCode, setCountryCode] = useState(defaultCountryCode || "+234");

  return (
    <Screen>
      <BackRow label="Back to respondents" onPress={onBack} />
      <View className="mb-[10px]">
        <Text className="text-[9.5px] font-sans-bold uppercase tracking-[0.6px] text-[#2E5395] dark:text-[#7EAEDA]">
          Recruitment
        </Text>
        <TitleBlock title="Invite a group" subtitle={`Upload a list and text everyone an invite to ${studyName}.`} />
      </View>

      {!messagingLive ? (
        <View className="mb-[10px] flex-row items-start gap-[7px] rounded-[11px] border border-[#FDE9C4] bg-[#FFF9EF] px-[10px] py-[9px]">
          <Icon name="warning" size={14} color="#B8860B" strokeWidth={1.9} />
          <Text className="flex-1 text-[9.5px] leading-[13px] text-[#8A6416]">
            Texting isn't connected yet — you can still upload and check a list.
          </Text>
        </View>
      ) : null}

      <Card style={{ marginBottom: 10 }}>
        <View className="flex-row items-start gap-[10px]">
          <View className="h-[22px] w-[22px] items-center justify-center rounded-lg bg-[#EEF2FA] dark:bg-[rgba(29,78,216,0.18)]">
            <Text className="text-[11px] font-sans-bold text-[#254680] dark:text-[#7EAEDA]">1</Text>
          </View>
          <View className="min-w-0 flex-1">
            <Text className="mb-[3px] text-[12.5px] font-sans-bold text-[#1E293B] dark:text-[#F8FAFC]">
              Get the template
            </Text>
            <Text className="mb-2 text-[10.5px] leading-[14px] text-[#64748B] dark:text-[#94A3B8]">
              Two columns: name and phone.
            </Text>
            <Pressable
              onPress={onDownloadTemplate}
              className="h-8 flex-row items-center gap-[6px] self-start rounded-[10px] border border-[#CBD5E1] bg-white px-3 dark:border-[#1B3556] dark:bg-[#0F2038]"
            >
              <Icon name="download" size={13} color="#334155" strokeWidth={1.75} />
              <Text className="text-[11px] font-sans-semibold text-[#334155] dark:text-[#F8FAFC]">
                Download template
              </Text>
            </Pressable>
          </View>
        </View>
      </Card>

      <Card style={{ flex: 1 }}>
        <View className="flex-1 flex-row items-start gap-[10px]">
          <View className="h-[22px] w-[22px] items-center justify-center rounded-lg bg-[#EEF2FA] dark:bg-[rgba(29,78,216,0.18)]">
            <Text className="text-[11px] font-sans-bold text-[#254680] dark:text-[#7EAEDA]">2</Text>
          </View>
          <View className="min-w-0 flex-1 gap-2">
            <Text className="text-[12.5px] font-sans-bold text-[#1E293B] dark:text-[#F8FAFC]">Upload your list</Text>
            <View>
              <FieldLabel>If a number has no country code, assume</FieldLabel>
              <TextField value={countryCode} onChangeText={setCountryCode} placeholder="+234" keyboardType="phone-pad" />
            </View>
            <View>
              <FieldLabel>Your filled-in list</FieldLabel>
              <Pressable
                onPress={onPickFile}
                className="items-center rounded-[11px] border-[1.5px] border-dashed border-[#CBD5E1] px-2 py-3"
              >
                <Icon name="upload" size={18} color="#94A3B8" strokeWidth={1.6} />
                <Text className="mt-1 text-[10px] text-[#94A3B8]">{fileName || "Tap to choose a file"}</Text>
              </Pressable>
            </View>
            <PrimaryButton
              title="Check the list"
              onPress={() => onCheckList(countryCode)}
              icon="arrowRight"
              disabled={!fileName}
              loading={busy}
            />
          </View>
        </View>
      </Card>
    </Screen>
  );
}
