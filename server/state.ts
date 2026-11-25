import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * IDs of the Managed Agents resources created on first use. Server code cannot write settings,
 * so they live in the plugin's data directory.
 */
export interface ResourceState {
  agentId: string | null;
  environmentId: string | null;
  /** Whether the environment lets the agent reach its MCP servers (GitHub). */
  environmentAllowsMcp: boolean;
  /** Vault holding the GitHub credential, and a fingerprint of the token stored in it. */
  vaultId: string | null;
  githubCredentialId: string | null;
  githubTokenFingerprint: string | null;
}

const EMPTY: ResourceState = {
  agentId: null,
  environmentId: null,
  environmentAllowsMcp: false,
  vaultId: null,
  githubCredentialId: null,
  githubTokenFingerprint: null,
};

function stateFile(): string {
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  return join(home, "plugin-data", "paseo-claude-cloud", "state.json");
}

export async function readState(): Promise<ResourceState> {
  try {
    const parsed = JSON.parse(await readFile(stateFile(), "utf8")) as Partial<ResourceState>;
    return { ...EMPTY, ...parsed };
  } catch {
    return { ...EMPTY };
  }
}

export async function writeState(state: ResourceState): Promise<void> {
  const file = stateFile();
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}
