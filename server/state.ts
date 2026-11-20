import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** IDs of the agent and environment created on first use. Server code cannot write settings. */
export interface ResourceState {
  agentId: string | null;
  environmentId: string | null;
}

function stateFile(): string {
  const home = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  return join(home, "plugin-data", "paseo-managed-agents", "state.json");
}

export async function readState(): Promise<ResourceState> {
  try {
    const parsed = JSON.parse(await readFile(stateFile(), "utf8")) as Partial<ResourceState>;
    return { agentId: parsed.agentId ?? null, environmentId: parsed.environmentId ?? null };
  } catch {
    return { agentId: null, environmentId: null };
  }
}

export async function writeState(state: ResourceState): Promise<void> {
  const file = stateFile();
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}
