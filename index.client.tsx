import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ManagedAgentsSettingsScreen } from "./client/settings-screen";
import { SETTINGS_SCREEN_ID } from "./shared/settings";

export default function contribute(client: PluginClientContext) {
  const remove = client.addSettingsScreen({
    id: SETTINGS_SCREEN_ID,
    title: "Claude (cloud)",
    icon: "Cloud",
    Component: ManagedAgentsSettingsScreen,
  });
  return () => remove();
}
