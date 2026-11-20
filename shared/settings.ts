import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Host settings. The API key is never stored here (settings are plain JSON, not a vault):
 * the provider reads ANTHROPIC_API_KEY from the session environment.
 */
export const managedAgentsSettings = defineSettings({
  id: "managed-agents",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Hard spend cap per session, in USD, enforced by the Managed Agents API. */
    sessionBudgetUsd: z.number().positive().default(2),
  }),
});
