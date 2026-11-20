import type Anthropic from "@anthropic-ai/sdk";
import type {
  ProviderEvent,
  ProviderPermissionResponse,
  ProviderPrompt,
  ProviderSessionConfig,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import type { McpBridge } from "./mcp-bridge.js";
import { applyPatch } from "./repo.js";

type StreamEvent = Anthropic.Beta.Sessions.BetaManagedAgentsStreamSessionEvents;
type SessionEvent = Anthropic.Beta.Sessions.BetaManagedAgentsSessionEvent;

export const REPO_MOUNT = "/workspace/repo";
export const SYNC_TOOL = "sync_changes_to_local";
export const PATCH_FILE = "changes.patch";
const RECONNECT_DELAY_MS = 1_000;

interface ToolCallState {
  name: string;
  input: Record<string, unknown>;
}

/**
 * One Paseo agent backed by one Managed Agents session. Owns the event stream, maps events to
 * Paseo timeline items, and answers custom tool calls (host MCP tools, local file sync).
 */
export class ManagedSession {
  private readonly seen = new Set<string>();
  private readonly toolCalls = new Map<string, ToolCallState>();
  private readonly previews = new Map<string, string>();
  private activeTurnId: string | null = null;
  private turnCounter = 0;
  private interruptRequested = false;
  private appliedPatch: string | null = null;
  private stopped = false;
  private streamAbort: AbortController | null = null;

  constructor(
    private readonly client: Anthropic,
    readonly paseoSessionId: string,
    readonly managedSessionId: string,
    private readonly config: ProviderSessionConfig,
    private readonly bridge: McpBridge,
    private readonly emit: (event: ProviderEvent) => void,
    private readonly log: (message: string) => void,
  ) {}

  /** Replays stored events into the timeline without acting on them. */
  async replay(): Promise<void> {
    for await (const event of this.client.beta.sessions.events.list(this.managedSessionId)) {
      this.seen.add(event.id);
      this.render(event, { replay: true });
    }
  }

  /** Marks existing events as seen so the live stream does not repeat them. */
  async skipHistory(): Promise<void> {
    for await (const event of this.client.beta.sessions.events.list(this.managedSessionId)) {
      this.seen.add(event.id);
    }
  }

  startStreaming(): void {
    void this.streamLoop();
  }

  async prompt(prompt: ProviderPrompt): Promise<void> {
    if (prompt.input.type !== "message") {
      this.promptFailed(prompt, "Commands are not supported by Managed Agents sessions");
      return;
    }
    const text = prompt.input.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n");
    if (prompt.delivery === "steer" && this.activeTurnId) {
      // Messages queue on a running session, so steering is a plain send.
      await this.send([{ type: "user.message", content: [{ type: "text", text }] }]);
      this.emit({
        type: "session.prompt_result",
        sessionId: this.paseoSessionId,
        clientMessageId: prompt.clientMessageId,
        result: { type: "steer", turnId: this.activeTurnId },
      });
      return;
    }
    const turnId = `turn-${++this.turnCounter}-${Date.now()}`;
    this.emit({
      type: "timeline.item",
      sessionId: this.paseoSessionId,
      item: { type: "user_message", id: `user:${turnId}`, text, clientMessageId: prompt.clientMessageId },
    });
    try {
      await this.send([{ type: "user.message", content: [{ type: "text", text }] }]);
    } catch (error) {
      this.promptFailed(prompt, errorMessage(error));
      return;
    }
    this.activeTurnId = turnId;
    this.interruptRequested = false;
    this.emit({
      type: "session.prompt_result",
      sessionId: this.paseoSessionId,
      clientMessageId: prompt.clientMessageId,
      result: { type: "turn", turnId },
    });
    this.emit({ type: "session.turn", sessionId: this.paseoSessionId, turnId, state: "started" });
  }

  async interrupt(): Promise<void> {
    this.interruptRequested = true;
    await this.send([{ type: "user.interrupt" }]);
  }

  async respondToPermission(toolUseId: string, response: ProviderPermissionResponse): Promise<void> {
    await this.send([
      response.behavior === "allow"
        ? { type: "user.tool_confirmation", tool_use_id: toolUseId, result: "allow" }
        : {
            type: "user.tool_confirmation",
            tool_use_id: toolUseId,
            result: "deny",
            deny_message: response.message ?? null,
          },
    ]);
    this.emit({ type: "session.permission_resolved", sessionId: this.paseoSessionId, permissionId: toolUseId });
    if (response.behavior === "deny" && response.interrupt) await this.interrupt();
  }

  /** Stops following the session. The cloud session stays available for a later resume. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.streamAbort?.abort();
    await this.bridge.close();
  }

  private async streamLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        this.streamAbort = new AbortController();
        const stream = await this.client.beta.sessions.events.stream(
          this.managedSessionId,
          { event_deltas: ["agent.message"] },
          { signal: this.streamAbort.signal },
        );
        // Stream first, then catch up on anything that happened while disconnected.
        await this.catchUp();
        for await (const event of stream) {
          if (this.stopped) return;
          await this.handleLive(event);
        }
      } catch (error) {
        if (this.stopped) return;
        this.log(`event stream dropped, reconnecting: ${errorMessage(error)}`);
      }
      if (this.stopped) return;
      await sleep(RECONNECT_DELAY_MS);
    }
  }

  private async catchUp(): Promise<void> {
    for await (const event of this.client.beta.sessions.events.list(this.managedSessionId)) {
      if (!this.seen.has(event.id)) await this.handleLive(event);
    }
  }

  private async handleLive(event: StreamEvent | SessionEvent): Promise<void> {
    if (event.type === "event_start") {
      if (event.event.type === "agent.message") this.previews.set(event.event.id, "");
      return;
    }
    if (event.type === "event_delta") {
      const previous = this.previews.get(event.event_id);
      if (previous === undefined || event.delta.content.type !== "text") return;
      const text = previous + event.delta.content.text;
      this.previews.set(event.event_id, text);
      this.emitItem({ type: "assistant_message", id: event.event_id, text });
      return;
    }
    if (!("id" in event) || this.seen.has(event.id)) return;
    this.seen.add(event.id);
    this.render(event, { replay: false });
    await this.act(event);
  }

  /** Timeline rendering, shared by live events and replay. */
  private render(event: StreamEvent | SessionEvent, { replay }: { replay: boolean }): void {
    switch (event.type) {
      case "user.message":
        // Live prompts are rendered optimistically with their clientMessageId.
        if (replay) this.emitItem({ type: "user_message", id: event.id, text: textOf(event.content) });
        return;
      case "agent.message":
        this.previews.delete(event.id);
        this.emitItem({ type: "assistant_message", id: event.id, text: textOf(event.content) });
        return;
      case "agent.tool_use":
      case "agent.mcp_tool_use":
      case "agent.custom_tool_use": {
        const input = event.input as Record<string, unknown>;
        this.toolCalls.set(event.id, { name: event.name, input });
        this.emitTool(event.id, "running", null);
        return;
      }
      case "agent.tool_result":
        this.emitTool(event.tool_use_id, event.is_error ? "failed" : "completed", textOf(event.content ?? []));
        return;
      case "agent.mcp_tool_result":
        this.emitTool(event.mcp_tool_use_id, event.is_error ? "failed" : "completed", textOf(event.content ?? []));
        return;
      case "user.custom_tool_result":
        this.emitTool(event.custom_tool_use_id, event.is_error ? "failed" : "completed", textOf(event.content ?? []));
        return;
      case "agent.thread_context_compacted":
        this.emitItem({ type: "compaction", id: event.id, status: "completed", trigger: "auto" });
        return;
      case "session.error":
        this.emitItem({ type: "error", id: event.id, message: describeError(event.error) });
        return;
      default:
        return;
    }
  }

  /** Side effects for live events: permissions, custom tools, turn lifecycle. */
  private async act(event: StreamEvent | SessionEvent): Promise<void> {
    switch (event.type) {
      case "agent.tool_use":
      case "agent.mcp_tool_use":
        if (event.evaluated_permission === "ask") {
          this.emit({
            type: "session.permission",
            sessionId: this.paseoSessionId,
            request: {
              id: event.id,
              name: event.name,
              kind: "tool",
              title: `Allow ${event.name} in the cloud sandbox?`,
              input: event.input as Record<string, never>,
              detail: toolDetail(event.name, event.input as Record<string, unknown>, null),
            },
          });
        }
        return;
      case "agent.custom_tool_use":
        await this.runCustomTool(event.id, event.name, event.input as Record<string, unknown>);
        return;
      case "session.usage":
        this.emit({
          type: "session.usage",
          sessionId: this.paseoSessionId,
          usage: {
            inputTokens: event.usage.input_tokens,
            cachedInputTokens: event.usage.cache_read_input_tokens,
            outputTokens: event.usage.output_tokens,
            totalCostUsd: event.usage.list_cost ? Number(event.usage.list_cost.amount) : undefined,
          },
        });
        return;
      case "session.status_idle":
        this.onIdle(event.stop_reason);
        return;
      case "session.status_terminated":
        this.finishTurn("failed", "The cloud session ended");
        this.emit({ type: "session.closed", sessionId: this.paseoSessionId });
        this.stopped = true;
        return;
      default:
        return;
    }
  }

  private onIdle(stopReason: Anthropic.Beta.Sessions.BetaManagedAgentsSessionStatusIdleEvent["stop_reason"]): void {
    switch (stopReason.type) {
      case "requires_action":
        return; // waiting on a permission or a custom tool result
      case "end_turn":
        this.finishTurn(this.interruptRequested ? "canceled" : "completed");
        return;
      case "budget_reached":
        this.emit({
          type: "session.notice",
          sessionId: this.paseoSessionId,
          notice: {
            id: `budget-${Date.now()}`,
            severity: "warning",
            title: "Session budget reached",
            description: "The cloud agent paused at its spend cap. Raise the cap in the plugin settings for new sessions.",
          },
        });
        this.finishTurn("failed", "Session budget reached");
        return;
      default:
        this.finishTurn("failed", `The agent stopped: ${stopReason.type}`);
    }
  }

  private finishTurn(state: "completed" | "failed" | "canceled", message?: string): void {
    const turnId = this.activeTurnId;
    if (!turnId) return;
    this.activeTurnId = null;
    this.interruptRequested = false;
    this.emit({
      type: "session.turn",
      sessionId: this.paseoSessionId,
      turnId,
      state,
      ...(state === "failed" && message ? { error: { message } } : {}),
    });
  }

  private async runCustomTool(id: string, name: string, input: Record<string, unknown>): Promise<void> {
    const result = name === SYNC_TOOL ? await this.syncChanges() : await this.bridge.call(name, input);
    await this.send([
      {
        type: "user.custom_tool_result",
        custom_tool_use_id: id,
        content: [{ type: "text", text: result.text }],
        is_error: result.isError,
      },
    ]);
  }

  /** Downloads the patch the agent wrote to its outputs and applies it to the local worktree. */
  private async syncChanges(): Promise<{ text: string; isError: boolean }> {
    try {
      const patch = await this.downloadPatch();
      if (patch === null) {
        return { text: `No ${PATCH_FILE} found in /mnt/session/outputs. Write it first.`, isError: true };
      }
      // Each patch is the full diff against the starting commit, so undo the previous one first.
      if (this.appliedPatch) await applyPatch(this.config.cwd, this.appliedPatch, { reverse: true });
      const stat = await applyPatch(this.config.cwd, patch);
      this.appliedPatch = patch;
      return { text: stat ? `Applied locally:\n${stat}` : "Patch applied; no changes.", isError: false };
    } catch (error) {
      return { text: `Applying the patch locally failed: ${errorMessage(error)}`, isError: true };
    }
  }

  private async downloadPatch(): Promise<string | null> {
    // Output files appear a few seconds after the agent writes them.
    for (let attempt = 0; attempt < 5; attempt++) {
      const files = await this.client.beta.files.list({
        scope_id: this.managedSessionId,
        betas: ["managed-agents-2026-04-01"],
      });
      const newest = files.data
        .filter((file) => file.filename === PATCH_FILE)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      if (newest) {
        const response = await this.client.beta.files.download(newest.id);
        return await response.text();
      }
      await sleep(1_500);
    }
    return null;
  }

  private emitTool(
    id: string,
    status: "running" | "completed" | "failed",
    output: string | null,
  ): void {
    const call = this.toolCalls.get(id) ?? { name: "tool", input: {} };
    const detail = toolDetail(call.name, call.input, output);
    this.emitItem(
      status === "failed"
        ? { type: "tool_call", id, callId: id, name: call.name, detail, status, error: output ?? "failed" }
        : { type: "tool_call", id, callId: id, name: call.name, detail, status, error: null },
    );
  }

  private emitItem(item: Extract<ProviderEvent, { type: "timeline.item" }>["item"]): void {
    this.emit({ type: "timeline.item", sessionId: this.paseoSessionId, item });
  }

  private promptFailed(prompt: ProviderPrompt, message: string): void {
    this.emit({
      type: "session.prompt_result",
      sessionId: this.paseoSessionId,
      clientMessageId: prompt.clientMessageId,
      result: { type: "failed", error: { message } },
    });
  }

  private async send(events: Anthropic.Beta.Sessions.EventSendParams["events"]): Promise<void> {
    await this.client.beta.sessions.events.send(this.managedSessionId, { events });
  }
}

function toolDetail(name: string, input: Record<string, unknown>, output: string | null): ProviderToolCallDetail {
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : undefined);
  switch (name) {
    case "bash":
      return { type: "shell", command: str("command") ?? "", ...(output !== null ? { output } : {}) };
    case "read":
      return { type: "read", filePath: str("file_path") ?? str("path") ?? "", ...(output !== null ? { content: output } : {}) };
    case "write":
      return { type: "write", filePath: str("file_path") ?? str("path") ?? "", content: str("content") };
    case "edit":
      return {
        type: "edit",
        filePath: str("file_path") ?? str("path") ?? "",
        oldString: str("old_string"),
        newString: str("new_string"),
      };
    case "grep":
    case "glob":
      return { type: "search", query: str("pattern") ?? "", toolName: name, ...(output !== null ? { content: output } : {}) };
    default:
      return { type: "unknown", input: input as never, output: output };
  }
}

function textOf(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : []))
    .join("\n");
}

function describeError(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return JSON.stringify(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
