import React, { useState } from "react";
import { View, Text, TextInput, Pressable, Image, KeyboardAvoidingView, Platform } from "react-native";
import { Icon } from "../../icons";
import { PrimaryButton } from "./shared";

export function InterviewerLoginScreen({
  onLogin,
  busy,
  error,
  onSwitchToRespondent,
}: {
  onLogin: (email: string, password: string) => void;
  busy: boolean;
  error: string;
  onSwitchToRespondent: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  return (
    <KeyboardAvoidingView
      className="flex-1 bg-[#FAF9F7] dark:bg-[#0A1628]"
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View className="flex-1 justify-center gap-5 px-6">
        <View className="items-center gap-3">
          <View className="h-24 w-24 items-center justify-center rounded-[28px] bg-[#EEF2FA] dark:bg-[rgba(29,78,216,0.18)]">
            <Image source={require("../../../assets/logo.png")} className="h-16 w-16" resizeMode="contain" />
          </View>
          <View className="items-center">
            <Text className="font-disp-extrabold text-[22px] text-[#0F172A] dark:text-[#F8FAFC]">
              Fieldwork Sign In
            </Text>
            <Text className="mt-[3px] text-[12px] text-[#64748B] dark:text-[#94A3B8]">
              For interviewers registering respondents in person.
            </Text>
          </View>
        </View>

        <View className="gap-3">
          <View>
            <Text className="mb-[5px] text-[10.5px] font-sans-semibold text-[#64748B]">Email</Text>
            <View className="h-11 flex-row items-center rounded-xl border border-[#CBD5E1] bg-white px-3 dark:border-[#1B3556] dark:bg-[#0F2038]">
              <Icon name="mail" size={16} color="#94A3B8" strokeWidth={1.75} />
              <TextInput
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                placeholder="you@inicio.demo"
                placeholderTextColor="#94A3B8"
                className="ml-2 flex-1 text-[13px] text-[#0F172A] dark:text-[#F8FAFC]"
              />
            </View>
          </View>
          <View>
            <Text className="mb-[5px] text-[10.5px] font-sans-semibold text-[#64748B]">Password</Text>
            <View className="h-11 flex-row items-center rounded-xl border border-[#CBD5E1] bg-white px-3 dark:border-[#1B3556] dark:bg-[#0F2038]">
              <Icon name="lock" size={16} color="#94A3B8" strokeWidth={1.75} />
              <TextInput
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword}
                placeholder="Your password"
                placeholderTextColor="#94A3B8"
                className="ml-2 flex-1 text-[13px] text-[#0F172A] dark:text-[#F8FAFC]"
              />
              <Pressable onPress={() => setShowPassword((v) => !v)} hitSlop={8}>
                <Icon name={showPassword ? "eyeSlash" : "eye"} size={16} color="#94A3B8" strokeWidth={1.75} />
              </Pressable>
            </View>
          </View>
          {error ? <Text className="text-[12px] text-[#A63244]">{error}</Text> : null}
          <PrimaryButton title={busy ? "Signing in…" : "Sign in"} onPress={() => onLogin(email, password)} loading={busy} />
        </View>

        <Pressable onPress={onSwitchToRespondent} className="items-center">
          <Text className="text-[12px] font-sans-semibold text-[#1D4ED8] dark:text-[#60A5FA]">
            I'm a respondent — switch to diary mode
          </Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
