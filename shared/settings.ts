import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Host settings, edited on the plugin's settings screen. Plugin settings are plain JSON on the
 * daemon host, readable by anyone allowed to manage it, like a key in config.json.
 */
export const managedAgentsSettings = defineSettings({
  id: "managed-agents",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Anthropic API key. Empty means: use ANTHROPIC_API_KEY from the daemon environment. */
    apiKey: z.string().default(""),
    /** Hard spend cap per session, in USD, enforced by the Managed Agents API. */
    sessionBudgetUsd: z.number().positive().default(2),
  }),
});

export const SETTINGS_SCREEN_ID = "managed-agents";
