import React from "react";
import { View, Text, Pressable } from "react-native";
import { Icon, IconName } from "../icons";

const TABS: Array<{ key: string; label: string; icon: IconName; strokeWidth: number }> = [
  { key: "home", label: "Home", icon: "navHome", strokeWidth: 1.9 },
  { key: "entries", label: "Diary", icon: "document", strokeWidth: 1.75 },
  { key: "activity", label: "Activity", icon: "navChart", strokeWidth: 1.9 },
  { key: "profile", label: "Profile", icon: "navUser", strokeWidth: 1.9 },
];

export function TabBar({ active, onNavigate }: { active: string; onNavigate?: (key: string) => void }) {
  return (
    <View className="h-[58px] shrink-0 flex-row items-center justify-around border-t border-[#E2E8F0] bg-white dark:border-[#1B3556] dark:bg-[#0F2038]">
      {TABS.map((tab) => {
        const isActive = tab.key === active;
        const color = isActive ? "#1D4ED8" : "#94A3B8";
        return (
          <Pressable
            key={tab.key}
            className="items-center gap-[3px]"
            onPress={() => onNavigate?.(tab.key)}
            hitSlop={10}
          >
            <Icon name={tab.icon} size={18} color={color} strokeWidth={tab.strokeWidth} />
            <Text style={{ color }} className="text-[9px] font-sans-semibold">
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
