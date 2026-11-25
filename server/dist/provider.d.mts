// Types for the esbuild bundle of ../provider.ts. Paseo's plugin compiler follows type imports
// into dependencies and rejects the Anthropic SDK's speculative undici type paths, so the
// server entry imports this pre-bundled module instead of the SDK directly.
import type { PluginSettings } from "@getpaseo/plugin/server";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import type { managedAgentsSettings } from "../../shared/settings";

export declare function createManagedAgentsProvider(deps: {
  settings: PluginSettings<(typeof managedAgentsSettings)["schema"]>;
  log: (message: string) => void;
}): ProviderRegistration;
