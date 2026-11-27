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

/**
 * Hosts `gh` talks to. The vault substitutes GH_TOKEN only on these; log downloads redirect to
 * signed Actions/Azure URLs that need no token but must be reachable.
 */
export const GITHUB_API_HOSTS = ["api.github.com", "uploads.github.com"];
export const GITHUB_HOSTS = [...GITHUB_API_HOSTS, "*.actions.githubusercontent.com", "*.blob.core.windows.net"];

/**
 * Stores the token in the plugin's vault twice, replacing it when it changed: as a bearer for
 * GitHub's MCP server, and as GH_TOKEN for `gh` in the sandbox. The sandbox only sees a placeholder;
 * the real value is substituted on requests to the GitHub API hosts. Returns the new state.
 */
export async function ensureGitHubVault(
  client: Anthropic,
  token: string,
  state: ResourceState,
): Promise<ResourceState> {
  const fingerprint = createHash("sha256").update(token).digest("hex");
  let { vaultId, githubCredentialId, ghTokenCredentialId } = state;
  if (!vaultId) {
    vaultId = (await client.beta.vaults.create({ display_name: "paseo-claude-cloud" })).id;
    githubCredentialId = null;
    ghTokenCredentialId = null;
  }
  const changed = fingerprint !== state.githubTokenFingerprint;
  if (!githubCredentialId) {
    githubCredentialId = (
      await client.beta.vaults.credentials.create(vaultId, {
        display_name: "GitHub (Paseo Claude cloud)",
        auth: { type: "static_bearer", mcp_server_url: GITHUB_MCP_SERVER.url, token },
      })
    ).id;
  } else if (changed) {
    await client.beta.vaults.credentials.update(githubCredentialId, {
      vault_id: vaultId,
      auth: { type: "static_bearer", token },
    });
  }
  const networking = { type: "limited" as const, allowed_hosts: GITHUB_API_HOSTS };
  if (!ghTokenCredentialId) {
    ghTokenCredentialId = (
      await client.beta.vaults.credentials.create(vaultId, {
        display_name: "GH_TOKEN (Paseo Claude cloud)",
        auth: { type: "environment_variable", secret_name: "GH_TOKEN", secret_value: token, networking, injection_location: { header: true } },
      })
    ).id;
  } else if (changed) {
    await client.beta.vaults.credentials.update(ghTokenCredentialId, {
      vault_id: vaultId,
      auth: { type: "environment_variable", secret_value: token, networking },
    });
  }
  return { ...state, vaultId, githubCredentialId, ghTokenCredentialId, githubTokenFingerprint: fingerprint };
}

export const GITHUB_SYSTEM = `gh is installed and authenticated through GH_TOKEN (a placeholder the proxy
swaps for the real token on GitHub API calls; never print or copy it). Push your branch with git, then
open the pull request with \`gh pr create\` (or the github MCP tools). Open it against the repository's
default branch unless told otherwise; for a stacked PR pass --base <parent branch> and push the parent first.
After pushing, follow CI yourself: \`gh pr checks <n> --watch\`, read failures with
\`gh run view <run> --log-failed\`, fix and push again until the checks pass.`;
