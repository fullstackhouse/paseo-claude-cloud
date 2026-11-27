import { describe, expect, it } from "vitest";
import { consoleSessionUrl, createManagedAgentsProvider } from "./provider.js";

describe("Claude (cloud) provider", () => {
  it("accepts Paseo's tool policy so agents created by the host can start", async () => {
    const settings = {
      read: async () => ({ status: "ready" as const, revision: "1", values: { apiKey: "", githubToken: "", sessionBudgetUsd: 2 } }),
      subscribe: () => () => {},
    };
    const provider = createManagedAgentsProvider({ settings, log: () => {} });
    const connection = await provider.connect({
      versions: [1],
      capabilities: ["prompt.message", "permission", "permission.tool_policy", "session.persistence"],
    });
    expect(connection.capabilities).toContain("permission.tool_policy");
    await connection.close();
  });

  it("links a session to its page in its Claude Console workspace", () => {
    expect(consoleSessionUrl("sesn_017tU1gFAaQjSGZ7t5UZZEka", "wrkspc_011CZkZaBF1tNoB5wlCeusgy")).toBe(
      "https://platform.claude.com/workspaces/wrkspc_011CZkZaBF1tNoB5wlCeusgy/sessions/sesn_017tU1gFAaQjSGZ7t5UZZEka",
    );
  });

  it("falls back to the default workspace when the API names none", () => {
    expect(consoleSessionUrl("sesn_1", null)).toBe("https://platform.claude.com/workspaces/default/sessions/sesn_1");
  });
});
