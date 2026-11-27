import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { GITHUB_API_HOSTS, GITHUB_MCP_SERVER, ensureGitHubVault } from "./github.js";
import { sessionTools } from "./provider.js";
import type { ResourceState } from "./state.js";

const EMPTY: ResourceState = {
  agentId: "agent_1",
  environmentId: "env_1",
  environmentAllowsMcp: true,
  vaultId: null,
  githubCredentialId: null,
  ghTokenCredentialId: null,
  githubTokenFingerprint: null,
  environmentConfigFingerprint: null,
};

function fakeVaults() {
  const calls: Array<[string, ...unknown[]]> = [];
  let created = 0;
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
            return { id: `vcrd_${++created}` };
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
  it("creates the vault, a bearer for GitHub's MCP server and GH_TOKEN for gh on first use", async () => {
    const { client, calls } = fakeVaults();
    const state = await ensureGitHubVault(client, "github_pat_one", EMPTY);
    expect(state).toMatchObject({ vaultId: "vlt_1", githubCredentialId: "vcrd_1", ghTokenCredentialId: "vcrd_2" });
    expect(state.githubTokenFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(state)).not.toContain("github_pat_one");
    expect(calls.map((call) => call[0])).toEqual(["vault.create", "credential.create", "credential.create"]);
    expect(calls[1]?.[2]).toMatchObject({
      auth: { type: "static_bearer", mcp_server_url: GITHUB_MCP_SERVER.url, token: "github_pat_one" },
    });
    // The token is substituted only on GitHub API requests, never readable in the sandbox.
    expect(calls[2]?.[2]).toMatchObject({
      auth: {
        type: "environment_variable",
        secret_name: "GH_TOKEN",
        secret_value: "github_pat_one",
        networking: { type: "limited", allowed_hosts: GITHUB_API_HOSTS },
      },
    });
  });

  it("adds GH_TOKEN to a vault created before gh support", async () => {
    const first = await ensureGitHubVault(fakeVaults().client, "github_pat_one", EMPTY);
    const { client, calls } = fakeVaults();
    const next = await ensureGitHubVault(client, "github_pat_one", { ...first, ghTokenCredentialId: null });
    expect(calls.map((call) => call[0])).toEqual(["credential.create"]);
    expect(next.ghTokenCredentialId).toBe("vcrd_1");
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
      [
        "credential.update",
        "vcrd_2",
        {
          vault_id: "vlt_1",
          auth: { type: "environment_variable", secret_value: "github_pat_two", networking: { type: "limited", allowed_hosts: GITHUB_API_HOSTS } },
        },
      ],
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
