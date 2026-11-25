import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createManagedAgentsProvider } from "./server/dist/provider.mjs";
import { managedAgentsSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(managedAgentsSettings);
  server.registerProvider(
    createManagedAgentsProvider({
      settings,
      log: (message) => console.error(`[managed-agents] ${message}`),
    }),
  );
  return () => {};
}
