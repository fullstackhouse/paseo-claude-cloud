import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ProviderMcpServerConfig } from "@getpaseo/plugin/server/provider";

/**
 * Exposes the host's MCP servers (asks, status, …) to a cloud agent as Managed Agents
 * custom tools. The cloud container cannot reach the daemon, so tool calls come back over the
 * session event stream and this bridge runs them locally.
 */

/** Servers whose tools act on the local workspace and make no sense for a cloud agent. */
const SKIPPED_SERVERS = new Set(["paseo"]);
const TOOL_NAME_MAX = 64;

export interface BridgedTool {
  /** Name the cloud agent sees: `<server>__<tool>`. */
  name: string;
  server: string;
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpBridge {
  tools: BridgedTool[];
  call(name: string, input: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  /** The host MCP server and tool behind a bridged tool name. */
  identity(name: string): { server: string; tool: string } | null;
  close(): Promise<void>;
}

export async function createMcpBridge(
  servers: Readonly<Record<string, ProviderMcpServerConfig>>,
  session: { cwd: string; env: Readonly<Record<string, string>> },
  log: (message: string) => void,
): Promise<McpBridge> {
  const clients = new Map<string, Client>();
  const tools: BridgedTool[] = [];

  for (const [server, config] of Object.entries(servers)) {
    if (SKIPPED_SERVERS.has(server) || config.type === "sse") continue;
    try {
      const client = new Client({ name: "paseo-claude-cloud", version: "0.0.0" });
      await client.connect(
        config.type === "stdio"
          ? new StdioClientTransport({
              command: config.command,
              args: config.args ?? [],
              // Stdio tool servers identify the calling agent from the agent's own environment
              // (PASEO_AGENT_ID) and working directory, as if the agent had spawned them.
              cwd: session.cwd,
              env: { ...(process.env as Record<string, string>), ...session.env, ...config.env },
            })
          : new StreamableHTTPClientTransport(new URL(config.url), {
              requestInit: { headers: config.headers ?? {} },
            }),
      );
      clients.set(server, client);
      const listed = await client.listTools();
      for (const tool of listed.tools) {
        const name = `${server}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_");
        if (name.length > TOOL_NAME_MAX) continue;
        tools.push({
          name,
          server,
          tool: tool.name,
          description: tool.description ?? tool.name,
          inputSchema: tool.inputSchema as Record<string, unknown>,
        });
      }
    } catch (error) {
      log(`MCP server "${server}" unavailable to the cloud agent: ${String(error)}`);
    }
  }

  return {
    tools,
    identity(name) {
      const tool = tools.find((candidate) => candidate.name === name);
      return tool ? { server: tool.server, tool: tool.tool } : null;
    },
    async call(name, input) {
      const tool = tools.find((candidate) => candidate.name === name);
      const client = tool && clients.get(tool.server);
      if (!tool || !client) return { text: `Unknown tool: ${name}`, isError: true };
      try {
        const result = await client.callTool({ name: tool.tool, arguments: input });
        const content = Array.isArray(result.content) ? result.content : [];
        const text = content
          .map((part) => (part.type === "text" ? part.text : JSON.stringify(part)))
          .join("\n");
        return { text: text || "(no output)", isError: result.isError === true };
      } catch (error) {
        return { text: String(error), isError: true };
      }
    },
    async close() {
      await Promise.allSettled([...clients.values()].map((client) => client.close()));
    },
  };
}
