import type Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import type { ResourceState } from "./state.js";

/**
 * GitHub's remote MCP server, used for opening PRs. `git push` already works through the
 * github_repository resource's git proxy, but that proxy does not authenticate api.github.com, and
 * the sandbox has no gh. Anthropic keeps the token in the vault and adds it to the MCP requests;
 * the sandbox never sees it.
 */
export const GITHUB_MCP_SERVER = { type: "url" as const, name: "github", url: "https://api.githubcopilot.com/mcp/" };

/** Stores the token in the plugin's vault, replacing it when it changed. Returns the vault ID. */
export async function ensureGitHubVault(
  client: Anthropic,
  token: string,
  state: ResourceState,
): Promise<ResourceState> {
  const fingerprint = createHash("sha256").update(token).digest("hex");
  let { vaultId, githubCredentialId } = state;
  if (!vaultId) {
    vaultId = (await client.beta.vaults.create({ display_name: "paseo-claude-cloud" })).id;
    githubCredentialId = null;
  }
  if (!githubCredentialId) {
    githubCredentialId = (
      await client.beta.vaults.credentials.create(vaultId, {
        display_name: "GitHub (Paseo Claude cloud)",
        auth: { type: "static_bearer", mcp_server_url: GITHUB_MCP_SERVER.url, token },
      })
    ).id;
  } else if (fingerprint !== state.githubTokenFingerprint) {
    await client.beta.vaults.credentials.update(githubCredentialId, {
      vault_id: vaultId,
      auth: { type: "static_bearer", token },
    });
  }
  return { ...state, vaultId, githubCredentialId, githubTokenFingerprint: fingerprint };
}

export const GITHUB_SYSTEM = `To open a pull request, push your branch with git, then use the github MCP
tools (create_pull_request, and the others for labels, comments and reviews). Open it against the
repository's default branch unless told otherwise. gh is not installed and api.github.com is not
authenticated in this sandbox; use the github tools for anything beyond git.`;
