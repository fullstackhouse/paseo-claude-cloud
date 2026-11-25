import type Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import type { ResourceState } from "./state.js";

/**
 * GitHub's remote MCP server. The agent pushes and opens PRs through it, because a vault
 * environment variable cannot authenticate `git push`: git sends credentials base64-encoded, which
 * hides the placeholder the vault substitutes. Anthropic keeps the token in the vault and adds it
 * to the MCP requests; the sandbox never sees it.
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

export const GITHUB_SYSTEM = `You can push and open pull requests through the github MCP tools
(for example create_branch, push_files and create_pull_request). Push to a new branch, never to the
default branch, and open the PR against the repository's default branch unless told otherwise. git push
and gh auth do not work in this sandbox; use the github tools. Still write the patch and call the sync
tool so the user can review the change locally.`;
