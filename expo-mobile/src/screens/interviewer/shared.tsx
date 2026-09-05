import React from "react";
import { View, Text, Pressable, ActivityIndicator, TextInput } from "react-native";
import { useColorScheme } from "nativewind";
import { Icon, IconName } from "../../icons";

// The I_* artboards this persona is built from ship light-theme only (no
// "...Light" pair like the Respondent screens). Dark values below are
// inferred from the same swap the Respondent screens use (bg #FAF9F7->#0A1628,
// card #fff->#0F2038, border #E2E8F0->#1B3556, text #0F172A->#F8FAFC) for
// consistency with the rest of the app — not copied from a dark reference.
export function useInterviewerTheme() {
  const { colorScheme } = useColorScheme();
  return colorScheme === "dark";
}

export function Screen({ children }: { children: React.ReactNode }) {
  return (
    <View className="flex-1 bg-[#FAF9F7] dark:bg-[#0A1628]">
      <View className="h-[18px] shrink-0" />
      <View className="flex-1 px-[18px] pb-4">{children}</View>
    </View>
  );
}

export function BackRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} className="mb-3 flex-row items-center gap-[5px] self-start">
      <Icon name="chevronLeft" size={12} color="#64748B" strokeWidth={2} />
      <Text className="text-[10.5px] font-sans-semibold text-[#64748B]">{label}</Text>
    </Pressable>
  );
}

export function StepTracker({ step, total, label }: { step: number; total: number; label: string }) {
  return (
    <View className="mb-3">
      <View className="mb-[6px] flex-row items-center justify-between">
        <Text className="text-[10px] font-sans-bold uppercase tracking-[0.4px] text-[#2E5395] dark:text-[#7EAEDA]">
          Step {step} of {total}
        </Text>
        <Text className="text-[10px] font-sans-semibold text-[#94A3B8]">{label}</Text>
      </View>
      <View className="flex-row gap-[5px]">
        {Array.from({ length: total }, (_, i) =>
          i < step ? (
            <View key={i} className="h-1 flex-1 rounded-full bg-[#1D4ED8]" />
          ) : (
            <View key={i} className="h-1 flex-1 rounded-full bg-[#E2E8F0] dark:bg-[#1B3556]" />
          )
        )}
      </View>
    </View>
  );
}

export function TitleBlock({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <View className="mb-3">
      <Text
        className="font-disp-extrabold text-[20px] text-[#0F172A] dark:text-[#F8FAFC]"
        style={{ letterSpacing: -0.2 }}
      >
        {title}
      </Text>
      <Text className="mt-[3px] text-[11.5px] leading-[15.5px] text-[#64748B] dark:text-[#94A3B8]">{subtitle}</Text>
    </View>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: any }) {
  return (
    <View
      className="rounded-[18px] border border-[#E2E8F0] bg-white p-4 dark:border-[#1B3556] dark:bg-[#0F2038]"
      style={style}
    >
      {children}
    </View>
  );
}

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return <Text className="mb-[5px] text-[10.5px] font-sans-semibold text-[#64748B]">{children}</Text>;
}

export function TextField({
  value,
  onChangeText,
  placeholder,
  keyboardType,
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  keyboardType?: "default" | "phone-pad" | "number-pad";
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor="#94A3B8"
      keyboardType={keyboardType}
      className="rounded-[11px] border border-[#CBD5E1] bg-white px-3 py-[10px] text-[13px] text-[#0F172A] dark:border-[#1B3556] dark:bg-[#0F2038] dark:text-[#F8FAFC]"
    />
  );
}

export function RadioRow({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-[9px] rounded-xl border px-[13px] py-[11px]"
      style={{
        borderColor: selected ? "#1D4ED8" : undefined,
        borderWidth: selected ? 1.5 : 1,
        backgroundColor: selected ? "rgba(29,78,216,0.08)" : undefined,
      }}
    >
      <View
        className="h-[17px] w-[17px] items-center justify-center rounded-full border-[1.5px]"
        style={{ borderColor: selected ? "#1D4ED8" : "#CBD5E1", backgroundColor: selected ? "#1D4ED8" : "transparent" }}
      >
        {selected ? <Icon name="checkSmall" size={9} color="#fff" strokeWidth={3} /> : null}
      </View>
      <Text
        className="text-[12.5px]"
        style={{ fontWeight: selected ? "700" : "600", color: selected ? "#1E3A8A" : "#64748B" }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function CheckRow({ label, checked, onPress }: { label: string; checked: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} className="flex-row items-center gap-2">
      <View
        className="h-4 w-4 items-center justify-center rounded-[5px] border-[1.5px]"
        style={{ borderColor: checked ? "#1D4ED8" : "#CBD5E1", backgroundColor: checked ? "#1D4ED8" : "transparent" }}
      >
        {checked ? <Icon name="checkSmall" size={9} color="#fff" strokeWidth={3} /> : null}
      </View>
      <Text className="flex-1 text-[11.5px] leading-[15px] text-[#475569] dark:text-[#94A3B8]">{label}</Text>
    </Pressable>
  );
}

export function PrimaryButton({
  title,
  onPress,
  icon,
  disabled,
  loading,
  inverse,
}: {
  title: string;
  onPress: () => void;
  icon?: IconName;
  disabled?: boolean;
  loading?: boolean;
  inverse?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      className="h-[46px] flex-row items-center justify-center gap-[7px] rounded-2xl"
      style={{
        backgroundColor: inverse ? "transparent" : "#1D4ED8",
        borderWidth: inverse ? 1 : 0,
        borderColor: "#CBD5E1",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {loading ? (
        <ActivityIndicator color={inverse ? "#1D4ED8" : "#fff"} />
      ) : (
        <>
          <Text className="text-[13.5px] font-sans-bold" style={{ color: inverse ? "#1F3864" : "#fff" }}>
            {title}
          </Text>
          {icon ? <Icon name={icon} size={15} color={inverse ? "#1F3864" : "#fff"} strokeWidth={2} /> : null}
        </>
      )}
    </Pressable>
  );
}

export function ResultCard({ children }: { children: React.ReactNode }) {
  return (
    <View className="items-center rounded-[20px] border border-[#E2E8F0] bg-white p-[22px] dark:border-[#1B3556] dark:bg-[#0F2038]">
      {children}
    </View>
  );
}

export function ResultIcon({ icon, tone }: { icon: IconName; tone: "green" | "amber" }) {
  return (
    <View
      className="mb-3 h-[52px] w-[52px] items-center justify-center rounded-full"
      style={{ backgroundColor: tone === "green" ? "#E6F4EA" : "#FFF4E5" }}
    >
      <Icon name={icon} size={26} color={tone === "green" ? "#1E7E34" : "#B8860B"} strokeWidth={1.75} />
    </View>
  );
}
