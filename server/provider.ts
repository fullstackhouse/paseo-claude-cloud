import Anthropic from "@anthropic-ai/sdk";
import {
  negotiateProviderCapabilities,
  type ProviderConfigState,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderPersistence,
  type ProviderRegistration,
  type ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import type { PluginSettings } from "@getpaseo/plugin/server";
import { SETTINGS_SCREEN_ID, type managedAgentsSettings } from "../shared/settings.js";
import { readState, writeState } from "./state.js";

type PluginSettingsHandle = PluginSettings<(typeof managedAgentsSettings)["schema"]>;
import { createMcpBridge, type BridgedTool } from "./mcp-bridge.js";
import { readGitHubToken, readRepo } from "./repo.js";
import { ManagedSession, PATCH_FILE, REPO_MOUNT, SYNC_TOOL } from "./session.js";

const CAPABILITIES = [
  "prompt.message",
  "prompt.steer",
  "session.persistence",
  "permission",
  // Preapproved host MCP tools run without a prompt; see ManagedSession.approveCustomTool.
  "permission.tool_policy",
] as const;

const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
];
const MODES = [
  { id: "auto", label: "Auto", description: "Anthropic's classifier approves safe tool calls; unclear ones ask you" },
  { id: "ask", label: "Ask", description: "Every sandbox tool call asks you first" },
];
const DEFAULT_MODEL = "claude-opus-5-5";
const DEFAULT_MODE = "auto";

const AGENT_SYSTEM = `You work in a cloud sandbox on a clone of the user's repository at ${REPO_MOUNT}.
You cannot push to GitHub. To hand your changes back, write the full diff of the working tree against the
starting commit (\`git -C ${REPO_MOUNT} add -A && git -C ${REPO_MOUNT} diff --cached HEAD\`) to
/mnt/session/outputs/${PATCH_FILE}, then call the ${SYNC_TOOL} tool. Do this whenever you finish a change.`;

const MISSING_KEY =
  "Needs an Anthropic API key: Settings → Providers → Claude (cloud) → Configure, or ANTHROPIC_API_KEY in the daemon environment.";

/** The key from the plugin's settings screen wins; the daemon environment is the fallback. */
async function resolveApiKey(
  settings: PluginSettingsHandle,
  env: Readonly<Record<string, string>>,
): Promise<string | undefined> {
  const current = await settings.read();
  const fromSettings = current.status === "ready" ? current.values.apiKey.trim() : "";
  return fromSettings || env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || undefined;
}

interface Deps {
  settings: PluginSettingsHandle;
  log: (message: string) => void;
}

/** `settingsScreen` arrives in a newer plugin SDK; older hosts ignore it. */
type RegistrationWithSettings = ProviderRegistration & { settingsScreen?: string };

export function createManagedAgentsProvider(deps: Deps): RegistrationWithSettings {
  return {
    // Paseo shows a Configure button on this provider's Settings → Providers row.
    settingsScreen: SETTINGS_SCREEN_ID,
    id: "claude-cloud",
    label: "Claude (cloud)",
    description: "Claude Managed Agents API: runs in Anthropic's cloud sandbox, billed at API rates",
    icon: "icon.svg",
    async status() {
      return (await resolveApiKey(deps.settings, {}))
        ? { available: true }
        : { available: false, diagnostic: MISSING_KEY };
    },
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Provider protocol version 1 is required");
      return createConnection(negotiateProviderCapabilities(request.capabilities, CAPABILITIES), deps);
    },
  };
}

function createConnection(capabilities: readonly string[], deps: Deps): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, ManagedSession>();
  let closed = false;
  const emit = (event: ProviderEvent) => {
    if (!closed) for (const listener of listeners) listener(event);
  };
  const fail = (requestId: string, error: unknown) =>
    emit({ type: "request.failed", requestId, error: { message: error instanceof Error ? error.message : String(error) } });

  async function dispatch(input: ProviderInput): Promise<void> {
    switch (input.type) {
      case "catalog":
        emit({
          type: "catalog",
          requestId: input.requestId,
          catalog: { models: MODELS, modes: MODES, defaultModel: DEFAULT_MODEL, defaultMode: DEFAULT_MODE },
        });
        return;
      case "sessions":
        emit({ type: "sessions", requestId: input.requestId, sessions: [] });
        return;
      case "session.open":
        try {
          const session = await openSession(input, emit, deps);
          sessions.set(input.sessionId, session);
        } catch (error) {
          fail(input.requestId, error);
        }
        return;
      case "session.prompt":
        await requireSession(input.sessionId).prompt(input.prompt);
        return;
      case "session.interrupt":
        try {
          await requireSession(input.sessionId).interrupt();
          emit({ type: "request.completed", requestId: input.requestId });
        } catch (error) {
          fail(input.requestId, error);
        }
        return;
      case "session.permission":
        await requireSession(input.sessionId).respondToPermission(input.permissionId, input.response);
        return;
      case "session.close": {
        await sessions.get(input.sessionId)?.stop();
        sessions.delete(input.sessionId);
        emit({ type: "session.closed", sessionId: input.sessionId });
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      default:
        if ("requestId" in input) fail(input.requestId, new Error(`Unsupported: ${input.type}`));
    }
  }

  function requireSession(sessionId: string): ManagedSession {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    return session;
  }

  return {
    version: 1,
    capabilities,
    async send(input) {
      if (closed) throw new Error("Provider connection is closed");
      queueMicrotask(() => {
        dispatch(input).catch((error) => deps.log(`${input.type} failed: ${String(error)}`));
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled([...sessions.values()].map((session) => session.stop()));
      sessions.clear();
      listeners.clear();
    },
  };
}

async function openSession(
  input: Extract<ProviderInput, { type: "session.open" }>,
  emit: (event: ProviderEvent) => void,
  deps: Deps,
): Promise<ManagedSession> {
  const { config } = input;
  const apiKey = await resolveApiKey(deps.settings, config.env);
  if (!apiKey) throw new Error(MISSING_KEY);
  const client = new Anthropic({ apiKey });
  const bridge = await createMcpBridge(config.mcpServers, { cwd: config.cwd, env: config.env }, deps.log);
  const model = config.model ?? DEFAULT_MODEL;
  const mode = config.mode ?? DEFAULT_MODE;

  let managedSessionId = persistedSessionId(input.persistence);
  if (!managedSessionId) {
    const { agentId, environmentId, budgetUsd } = await ensureResources(client, deps.settings);
    const repo = await readRepo(config.cwd);
    managedSessionId = (
      await client.beta.sessions.create({
        agent: {
          type: "agent_with_overrides",
          id: agentId,
          model,
          system: [AGENT_SYSTEM, config.systemPrompt].filter(Boolean).join("\n\n"),
          tools: sessionTools(mode, bridge.tools),
        },
        environment_id: environmentId,
        title: config.title ?? `Paseo: ${repo.url.split("/").slice(-1)[0]}@${repo.branch}`,
        budget: { type: "limit", max_list_cost: { amount: String(Math.round(budgetUsd * 100)), currency: "USD" } },
        resources: [
          {
            type: "github_repository",
            url: repo.url,
            mount_path: REPO_MOUNT,
            authorization_token: await readGitHubToken(config.env),
            checkout: { type: "branch", name: repo.branch },
          },
        ],
        metadata: { paseo_session_id: input.sessionId },
      })
    ).id;
  }

  const session = new ManagedSession(client, input.sessionId, managedSessionId, config, bridge, emit, deps.log);
  const persistence: ProviderPersistence = { version: 1, data: { managedSessionId } };
  emit({
    type: "session.opened",
    requestId: input.requestId,
    sessionId: input.sessionId,
    capabilities: CAPABILITIES,
    restoration: "core",
    persistence,
    title: config.title,
    cwd: config.cwd,
  });
  emit({ type: "session.config", sessionId: input.sessionId, config: configState(model, mode) });
  if (input.persistence && input.history === "replay") await session.replay();
  else await session.skipHistory();
  session.startStreaming();
  emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
  return session;
}

function sessionTools(mode: string, bridged: BridgedTool[]) {
  return [
    {
      type: "agent_toolset_20260401" as const,
      default_config: {
        enabled: true,
        permission_policy: { type: mode === "ask" ? ("always_ask" as const) : ("auto" as const) },
      },
      configs: [
        { name: "web_fetch" as const, enabled: false },
        { name: "web_search" as const, enabled: false },
      ],
    },
    {
      type: "custom" as const,
      name: SYNC_TOOL,
      description: `Copy your changes to the user's local worktree. Write /mnt/session/outputs/${PATCH_FILE} first.`,
      input_schema: { type: "object" as const, properties: {} },
    },
    ...bridged.map((tool) => ({
      type: "custom" as const,
      name: tool.name,
      description: tool.description.slice(0, 1024),
      input_schema: stripSchemaMeta(tool.inputSchema),
    })),
  ];
}

/** Creates the agent and environment on first use and remembers their IDs. */
async function ensureResources(client: Anthropic, settings: PluginSettingsHandle) {
  const current = await settings.read();
  const budgetUsd = current.status === "ready" ? current.values.sessionBudgetUsd : 2;
  const state = await readState();
  let { agentId, environmentId } = state;
  if (!environmentId) {
    environmentId = (
      await client.beta.environments.create({
        name: "paseo-claude-cloud",
        config: { type: "cloud", networking: { type: "limited", allow_package_managers: true, allow_mcp_servers: false } },
      })
    ).id;
  }
  if (!agentId) {
    agentId = (
      await client.beta.agents.create({
        name: "Paseo cloud agent",
        model: DEFAULT_MODEL,
        tools: sessionTools(DEFAULT_MODE, []),
      })
    ).id;
  }
  if (agentId !== state.agentId || environmentId !== state.environmentId) {
    await writeState({ agentId, environmentId });
  }
  return { agentId, environmentId, budgetUsd };
}

function configState(model: string, mode: string): ProviderConfigState {
  return { model, mode, models: MODELS, modes: MODES, thinkingOptions: [], settings: [] };
}

function persistedSessionId(persistence: ProviderPersistence | undefined): string | null {
  const data = persistence?.data;
  if (data && typeof data === "object" && !Array.isArray(data) && typeof data.managedSessionId === "string") {
    return data.managedSessionId;
  }
  return null;
}

function stripSchemaMeta(schema: Record<string, unknown>) {
  const { $schema: _ignored, ...rest } = schema;
  return { type: "object" as const, ...rest };
}

export type { ProviderSessionConfig };
