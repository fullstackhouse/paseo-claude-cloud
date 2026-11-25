import { useRef, useState } from "react";
import { useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  type SettingsInputHandle,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { managedAgentsSettings } from "../shared/settings";



export function ManagedAgentsSettingsScreen() {
  const settings = useSettings(managedAgentsSettings);
  const keyInput = useRef<SettingsInputHandle>(null);
  const budgetInput = useRef<SettingsInputHandle>(null);
  const [error, setError] = useState<string | null>(null);

  if (settings.status === "loading") return <Text>Loading…</Text>;
  if (settings.status === "error") return <Text>{String(settings.error)}</Text>;
  if (settings.status === "invalid") return <Text>{settings.error}</Text>;

  const { values, revision } = settings;

  async function save() {
    const key = keyInput.current?.getText().trim() ?? values.apiKey;
    const budgetText = budgetInput.current?.getText().trim() ?? String(values.sessionBudgetUsd);
    const budget = Number(budgetText);
    if (!Number.isFinite(budget) || budget <= 0) {
      setError("Enter a spend cap above $0, e.g. 2 or 5.50.");
      return;
    }
    setError(null);
    await settings.save({ ...values, apiKey: key, sessionBudgetUsd: budget }, revision);
  }

  return (
    <SettingsSection title="Claude (cloud)">
      <SettingsCard>
        <SettingsInput
          ref={keyInput}
          label="Anthropic API key"
          hint={
            values.apiKey
              ? "Saved. Leave as is, or paste a new key."
              : "Billed at API rates, not your Claude subscription. Empty: uses ANTHROPIC_API_KEY from the daemon."
          }
          placeholder="sk-ant-…"
          initialValue={values.apiKey}
          secureTextEntry
          onChangeText={() => {}}
        />
        <SettingsInput
          ref={budgetInput}
          label="Spend cap per session (USD)"
          hint="A session pauses once it has cost this much. Applies to new sessions."
          initialValue={String(values.sessionBudgetUsd)}
          onChangeText={() => {}}
          error={error ?? undefined}
        />
        <SettingsAction
          label={settings.saveError ? `Save failed: ${String(settings.saveError)}` : "Save changes"}
          actionLabel={settings.saving ? "Saving…" : "Save"}
          disabled={settings.saving}
          onPress={() => void save()}
        />
      </SettingsCard>
      <SettingsRow label="Where keys are stored">
        <Text>Plugin settings are plain JSON on this host, like config.json.</Text>
      </SettingsRow>
    </SettingsSection>
  );
}
