import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { GITHUB_MCP_SERVER, ensureGitHubVault } from "./github.js";
import { sessionTools } from "./provider.js";
import type { ResourceState } from "./state.js";

const EMPTY: ResourceState = {
  agentId: "agent_1",
  environmentId: "env_1",
  environmentAllowsMcp: true,
  vaultId: null,
  githubCredentialId: null,
  githubTokenFingerprint: null,
};

function fakeVaults() {
  const calls: Array<[string, ...unknown[]]> = [];
  const client = {
    beta: {
      vaults: {
        async create(body: unknown) {
          calls.push(["vault.create", body]);
          return { id: "vlt_1" };
        },
        credentials: {
          async create(vaultId: string, body: unknown) {
            calls.push(["credential.create", vaultId, body]);
            return { id: "vcrd_1" };
          },
          async update(credentialId: string, body: unknown) {
            calls.push(["credential.update", credentialId, body]);
            return { id: credentialId };
          },
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

describe("GitHub vault", () => {
  it("creates the vault and a bearer credential for GitHub's MCP server on first use", async () => {
    const { client, calls } = fakeVaults();
    const state = await ensureGitHubVault(client, "github_pat_one", EMPTY);
    expect(state).toMatchObject({ vaultId: "vlt_1", githubCredentialId: "vcrd_1" });
    expect(state.githubTokenFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(state)).not.toContain("github_pat_one");
    expect(calls.map((call) => call[0])).toEqual(["vault.create", "credential.create"]);
    expect(calls[1]?.[2]).toMatchObject({
      auth: { type: "static_bearer", mcp_server_url: GITHUB_MCP_SERVER.url, token: "github_pat_one" },
    });
  });

  it("leaves the vault alone when the token is unchanged", async () => {
    const first = await ensureGitHubVault(fakeVaults().client, "github_pat_one", EMPTY);
    const { client, calls } = fakeVaults();
    expect(await ensureGitHubVault(client, "github_pat_one", first)).toEqual(first);
    expect(calls).toEqual([]);
  });

  it("replaces the stored token when it changes", async () => {
    const first = await ensureGitHubVault(fakeVaults().client, "github_pat_one", EMPTY);
    const { client, calls } = fakeVaults();
    const next = await ensureGitHubVault(client, "github_pat_two", first);
    expect(next.githubTokenFingerprint).not.toBe(first.githubTokenFingerprint);
    expect(calls).toEqual([
      ["credential.update", "vcrd_1", { vault_id: "vlt_1", auth: { type: "static_bearer", token: "github_pat_two" } }],
    ]);
  });
});

describe("session tools", () => {
  it("adds GitHub's MCP toolset only when a GitHub token is configured", () => {
    const types = (github: boolean) => sessionTools("auto", [], github).map((tool) => tool.type);
    expect(types(false)).not.toContain("mcp_toolset");
    expect(sessionTools("ask", [], true)[0]).toEqual({
      type: "mcp_toolset",
      mcp_server_name: "github",
      default_config: { enabled: true, permission_policy: { type: "always_ask" } },
    });
  });
});
