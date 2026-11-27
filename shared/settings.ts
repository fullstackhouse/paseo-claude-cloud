import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Host settings, edited on the plugin's settings screen. Plugin settings are plain JSON on the
 * daemon host, readable by anyone allowed to manage it, like a key in config.json.
 */
export const managedAgentsSettings = defineSettings({
  id: "claude-cloud",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Anthropic API key. Empty means: use ANTHROPIC_API_KEY from the daemon environment. */
    apiKey: z.string().default(""),
    /**
     * GitHub token for pushing and opening PRs from the cloud. Kept in a Managed Agents vault and
     * used only for GitHub's MCP server; empty means the agent hands changes back as a patch only.
     */
    githubToken: z.string().default(""),
    /** Hard spend cap per session, in USD, enforced by the Managed Agents API. */
    sessionBudgetUsd: z.number().positive().default(10),
    /**
     * Extra hosts the sandbox may reach, beyond package registries and GitHub, e.g. `*.example.dev`
     * for PR previews. Bare hostnames or `*.` wildcards.
     */
    allowedHosts: z.array(z.string()).default([]),
  }),
});

export const SETTINGS_SCREEN_ID = "claude-cloud";
