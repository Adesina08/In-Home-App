import React, { useState } from "react";
import { View, Text, ScrollView, KeyboardAvoidingView, Platform } from "react-native";
import { Screen, BackRow, StepTracker, TitleBlock, Card, FieldLabel, TextField, RadioRow, CheckRow, PrimaryButton } from "./shared";

export type RegisterForm = {
  studyId: number;
  studyName: string;
  eligible: boolean | null;
  consentGiven: boolean;
  name: string;
  contact: string;
  channel: "app" | "whatsapp";
  practice: boolean;
};

const CONSENT_TEXT =
  "This study asks about the respondent's everyday consumption habits over the study period. Participation is entirely voluntary — they can stop taking part at any time. Photos and answers are kept confidential and used only for research purposes. They will not be identified in any published report.";

export function RegisterWizardScreen({
  studies,
  onCancel,
  onSubmit,
  busy,
}: {
  studies: Array<{ id: number; name: string }>;
  onCancel: () => void;
  onSubmit: (form: RegisterForm) => void;
  busy: boolean;
}) {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<RegisterForm>({
    studyId: studies[0]?.id || 0,
    studyName: studies[0]?.name || "",
    eligible: null,
    consentGiven: false,
    name: "",
    contact: "",
    channel: "app",
    practice: false,
  });

  const back = () => (step === 1 ? onCancel() : setStep((s) => s - 1));
  const next = () => setStep((s) => Math.min(5, s + 1));

  return (
    <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Screen>
        <BackRow label={step === 1 ? "Cancel" : "Back"} onPress={back} />

        {step === 1 && (
          <>
            <StepTracker step={1} total={5} label="Prescreen" />
            <TitleBlock title="Confirm eligibility" subtitle="Check the respondent fits this study before going further." />
            <Card style={{ gap: 14 }}>
              <View>
                <FieldLabel>Study</FieldLabel>
                <View className="rounded-[11px] border border-[#CBD5E1] bg-white px-3 py-[10px] dark:border-[#1B3556] dark:bg-[#0F2038]">
                  <Text className="text-[13px] text-[#0F172A] dark:text-[#F8FAFC]">{form.studyName || "No open studies"}</Text>
                </View>
              </View>
              <View>
                <FieldLabel>Does the respondent meet this study's eligibility criteria?</FieldLabel>
                <View className="mt-2 gap-2">
                  <RadioRow label="Yes, eligible" selected={form.eligible === true} onPress={() => setForm((f) => ({ ...f, eligible: true }))} />
                  <RadioRow label="Not eligible" selected={form.eligible === false} onPress={() => setForm((f) => ({ ...f, eligible: false }))} />
                </View>
              </View>
            </Card>
            <View className="flex-1" />
            <PrimaryButton title="Continue to Consent" onPress={next} icon="arrowRight" disabled={form.eligible === null} />
          </>
        )}

        {step === 2 && (
          <>
            <StepTracker step={2} total={5} label="Consent" />
            <TitleBlock title="Capture consent" subtitle="Read this aloud, or let the respondent read it themselves." />
            <Card style={{ gap: 14, flex: 1 }}>
              <ScrollView className="min-h-0 flex-1 rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-3 dark:border-[#1B3556] dark:bg-[#081222]">
                <Text className="text-[11.5px] leading-[17px] text-[#475569] dark:text-[#94A3B8]">{CONSENT_TEXT}</Text>
              </ScrollView>
              <CheckRow
                label="Respondent has given consent (read aloud / shown above)"
                checked={form.consentGiven}
                onPress={() => setForm((f) => ({ ...f, consentGiven: !f.consentGiven }))}
              />
            </Card>
            <PrimaryButton title="Continue to Register" onPress={next} icon="arrowRight" disabled={!form.consentGiven} />
          </>
        )}

        {step === 3 && (
          <>
            <StepTracker step={3} total={5} label="Register" />
            <TitleBlock title="Respondent details" subtitle="Capture their name and a phone number to reach them." />
            <Card style={{ gap: 14 }}>
              <View>
                <FieldLabel>Full name</FieldLabel>
                <TextField value={form.name} onChangeText={(v) => setForm((f) => ({ ...f, name: v }))} placeholder="Full name" />
              </View>
              <View>
                <FieldLabel>Phone number</FieldLabel>
                <TextField
                  value={form.contact}
                  onChangeText={(v) => setForm((f) => ({ ...f, contact: v }))}
                  placeholder="0803 555 0142"
                  keyboardType="phone-pad"
                />
                <Text className="mt-[5px] text-[9.5px] leading-[13px] text-[#94A3B8]">
                  Written the way they say it — we'll format it correctly.
                </Text>
              </View>
            </Card>
            <View className="flex-1" />
            <PrimaryButton
              title="Continue to Verify"
              onPress={next}
              icon="arrowRight"
              disabled={!form.name.trim() || !form.contact.trim()}
            />
          </>
        )}

        {step === 4 && (
          <>
            <StepTracker step={4} total={5} label="Verify" />
            <TitleBlock title="Verify details" subtitle="Double-check everything before activating." />
            <Card>
              <SummaryRow label="Name" value={form.name} first />
              <SummaryRow label="Phone" value={form.contact} mono />
              <SummaryRow label="Study" value={form.studyName} />
            </Card>
            <View style={{ height: 12 }} />
            <Card style={{ gap: 12 }}>
              <View>
                <FieldLabel>Diary channel</FieldLabel>
                <View className="flex-row gap-2">
                  {(["app", "whatsapp"] as const).map((ch) => (
                    <RadioRow
                      key={ch}
                      label={ch === "app" ? "App / Web" : "WhatsApp"}
                      selected={form.channel === ch}
                      onPress={() => setForm((f) => ({ ...f, channel: ch }))}
                    />
                  ))}
                </View>
              </View>
              <CheckRow
                label="Mark first entry as a practice entry"
                checked={form.practice}
                onPress={() => setForm((f) => ({ ...f, practice: !f.practice }))}
              />
            </Card>
            <View className="flex-1" />
            <PrimaryButton title="Continue to Activate" onPress={next} icon="arrowRight" />
          </>
        )}

        {step === 5 && (
          <>
            <StepTracker step={5} total={5} label="Activate" />
            <TitleBlock title="Ready to activate" subtitle="This creates their diary and generates a respondent code." />
            <Card>
              <SummaryRow label="Name" value={form.name} first />
              <SummaryRow label="Study" value={form.studyName} />
              <SummaryRow label="Channel" value={form.channel === "app" ? "App / Web" : "WhatsApp"} />
              <SummaryRow label="Eligibility" value="Eligible" tone="green" />
              <SummaryRow label="Consent" value="Given" tone="green" />
            </Card>
            <View className="flex-1" />
            <PrimaryButton title="Activate Respondent" onPress={() => onSubmit(form)} icon="checkCircle" loading={busy} />
          </>
        )}
      </Screen>
    </KeyboardAvoidingView>
  );
}

function SummaryRow({
  label,
  value,
  first,
  mono,
  tone,
}: {
  label: string;
  value: string;
  first?: boolean;
  mono?: boolean;
  tone?: "green";
}) {
  return (
    <View
      className="flex-row items-center justify-between py-2"
      style={!first ? { borderTopWidth: 1, borderTopColor: "#F1F5F9" } : null}
    >
      <Text className="text-[11px] text-[#94A3B8]">{label}</Text>
      <Text
        className={mono ? "font-mono text-[12px]" : "text-[12.5px] font-sans-semibold"}
        style={{ color: tone === "green" ? "#1E7E34" : "#1E293B", fontWeight: tone === "green" ? "700" : undefined }}
      >
        {value}
      </Text>
    </View>
  );
}
