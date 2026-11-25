import { describe, expect, it } from "vitest";
import { createManagedAgentsProvider } from "./provider.js";

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
});
