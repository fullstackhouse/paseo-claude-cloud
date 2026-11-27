import type Anthropic from "@anthropic-ai/sdk";
import type {
  ProviderEvent,
  ProviderPermissionResponse,
  ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import { describe, expect, it } from "vitest";
import type { McpBridge } from "./mcp-bridge.js";
import { ManagedSession } from "./session.js";

/** A stand-in for the Managed Agents API: a scripted event stream plus a log of sent events. */
function fakeClient(script: Array<Record<string, unknown>>, rejectFirstMessage?: string) {
  let rejection = rejectFirstMessage;
  const sent: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  let release: () => void = () => {};
  const done = new Promise<void>((resolve) => (release = resolve));
  const client = {
    beta: {
      sessions: {
        async update(_id: string, body: Record<string, unknown>) {
          updates.push(body);
          return {};
        },
        events: {
          async *list() {},
          async stream() {
            return (async function* () {
              for (const event of script) yield event;
              release();
              await new Promise(() => {}); // stay open like a live SSE stream
            })();
          },
          async send(_id: string, body: { events: Array<Record<string, unknown>> }) {
            if (rejection && body.events[0]?.type === "user.message") {
              const message = rejection;
              rejection = undefined;
              throw new Error(message);
            }
            sent.push(...body.events);
          },
        },
      },
    },
  } as unknown as Anthropic;
  return { client, sent, updates, done };
}

function fakeBridge(calls: Array<{ name: string; input: unknown }>): McpBridge {
  return {
    tools: [],
    identity(name) {
      const [server, tool] = name.split("__");
      return server && tool ? { server, tool } : null;
    },
    async call(name, input) {
      calls.push({ name, input });
      return { text: "A1 created", isError: false };
    },
    async close() {},
  };
}

interface RunOptions {
  toolPolicy?: ProviderSessionConfig["toolPolicy"];
  /** Answers every permission request Paseo would show. */
  answer?: (permissionId: string) => ProviderPermissionResponse;
  /** The API refuses the prompt's message with this error. */
  rejectFirstMessage?: string;
}

async function run(script: Array<Record<string, unknown>>, options: RunOptions = {}) {
  const events: ProviderEvent[] = [];
  const bridgeCalls: Array<{ name: string; input: unknown }> = [];
  const { client, sent, updates, done } = fakeClient(script, options.rejectFirstMessage);
  const session = new ManagedSession(
    client,
    "paseo-1",
    "sesn_1",
    { cwd: "/tmp", env: {}, mcpServers: {}, settings: {}, persist: true, toolPolicy: options.toolPolicy },
    fakeBridge(bridgeCalls),
    (event) => {
      events.push(event);
      if (event.type === "session.permission" && options.answer) {
        const response = options.answer(event.request.id);
        queueMicrotask(() => void session.respondToPermission(event.request.id, response));
      }
    },
    () => {},
  );
  await session.prompt({
    clientMessageId: "c1",
    delivery: "auto",
    input: { type: "message", content: [{ type: "text", text: "fix the bug" }] },
  });
  session.startStreaming();
  await done;
  await new Promise((resolve) => setTimeout(resolve, 10));
  await session.stop();
  return { events, sent, updates, bridgeCalls };
}

const items = (events: ProviderEvent[]) =>
  events.flatMap((event) => (event.type === "timeline.item" ? [event.item] : []));

describe("ManagedSession", () => {
  it("runs a turn: prompt, streamed text, tool call, completion", async () => {
    const { events, sent } = await run([
      { type: "session.status_running", id: "e1" },
      { type: "event_start", event: { type: "agent.message", id: "m1" } },
      { type: "event_delta", event_id: "m1", delta: { type: "content_delta", index: 0, content: { type: "text", text: "Look" } } },
      { type: "agent.message", id: "m1", content: [{ type: "text", text: "Looking at it" }] },
      { type: "agent.tool_use", id: "t1", name: "bash", input: { command: "ls" }, evaluated_permission: "allow" },
      { type: "agent.tool_result", id: "r1", tool_use_id: "t1", content: [{ type: "text", text: "src" }] },
      { type: "session.status_idle", id: "e2", stop_reason: { type: "end_turn" } },
    ]);

    expect(sent[0]).toMatchObject({ type: "user.message", content: [{ type: "text", text: "fix the bug" }] });
    expect(items(events).map((item) => [item.type, item.id])).toEqual([
      ["user_message", expect.stringMatching(/^user:/)],
      ["assistant_message", "m1"],
      ["assistant_message", "m1"],
      ["tool_call", "t1"],
      ["tool_call", "t1"],
    ]);
    expect(items(events).at(-1)).toMatchObject({
      status: "completed",
      detail: { type: "shell", command: "ls", output: "src" },
    });
    const turns = events.filter((event) => event.type === "session.turn").map((event) => event.state);
    expect(turns).toEqual(["started", "completed"]);
  });

  it("turns an `ask` tool call into a Paseo permission request", async () => {
    const { events } = await run([
      { type: "agent.tool_use", id: "t1", name: "bash", input: { command: "rm -rf build" }, evaluated_permission: "ask" },
      { type: "session.status_idle", id: "e1", stop_reason: { type: "requires_action", event_ids: ["t1"] } },
    ]);
    const permission = events.find((event) => event.type === "session.permission");
    expect(permission).toMatchObject({ request: { id: "t1", name: "bash", kind: "tool" } });
    expect(events.some((event) => event.type === "session.turn" && event.state !== "started")).toBe(false);
  });

  it("runs a host tool the tool policy preapproves without asking", async () => {
    const { events, sent, bridgeCalls } = await run(
      [{ type: "agent.custom_tool_use", id: "c1", name: "asks__ask_create", input: { kind: "question", title: "Ship it?" } }],
      { toolPolicy: { preapproved: [{ kind: "mcp", server: "asks", tool: "ask_create" }] } },
    );
    expect(events.some((event) => event.type === "session.permission")).toBe(false);
    expect(bridgeCalls).toEqual([{ name: "asks__ask_create", input: { kind: "question", title: "Ship it?" } }]);
    expect(sent.at(-1)).toMatchObject({
      type: "user.custom_tool_result",
      custom_tool_use_id: "c1",
      content: [{ type: "text", text: "A1 created" }],
      is_error: false,
    });
  });

  it("asks before running a host tool the tool policy does not preapprove", async () => {
    const allowed = await run(
      [{ type: "agent.custom_tool_use", id: "c1", name: "status__status_set", input: { state: "done" } }],
      { toolPolicy: { preapproved: [{ kind: "mcp", server: "asks", tool: "ask_create" }] }, answer: () => ({ behavior: "allow" }) },
    );
    expect(allowed.events.find((event) => event.type === "session.permission")).toMatchObject({
      // Claude's MCP tool name, so plugins' permission hooks recognize their own tools.
      request: { id: "c1", name: "mcp__status__status_set", kind: "tool" },
    });
    expect(allowed.bridgeCalls).toEqual([{ name: "status__status_set", input: { state: "done" } }]);
    // The approval is local: nothing is sent to the cloud session but the tool result.
    expect(allowed.sent.some((event) => event.type === "user.tool_confirmation")).toBe(false);

    const denied = await run(
      [{ type: "agent.custom_tool_use", id: "c1", name: "status__status_set", input: { state: "done" } }],
      { answer: () => ({ behavior: "deny", message: "Not now" }) },
    );
    expect(denied.bridgeCalls).toEqual([]);
    expect(denied.sent.at(-1)).toMatchObject({
      type: "user.custom_tool_result",
      custom_tool_use_id: "c1",
      content: [{ type: "text", text: "Not now" }],
      is_error: true,
    });
  });

  it("keeps the turn open on the cap card and offers caps above what was spent", async () => {
    const { events, updates } = await run([
      { type: "session.usage", id: "u1", usage: { list_cost: { amount: "612", currency: "USD" } } },
      { type: "session.status_idle", id: "e1", stop_reason: { type: "budget_reached" } },
    ]);
    expect(events.find((event) => event.type === "session.notice")).toMatchObject({
      notice: { title: "Session budget reached" },
    });
    expect(events.filter((event) => event.type === "session.turn").map((event) => event.state)).toEqual(["started"]);
    const permission = events.find((event) => event.type === "session.permission");
    expect(permission).toMatchObject({ request: { id: "budget:e1", kind: "other" } });
    const actions = permission?.type === "session.permission" ? permission.request.actions : [];
    expect(actions?.map((action) => action.label)).toEqual(["Raise to $10.00", "Raise to $20.00", "Raise to $50.00", "Leave paused"]);
    expect(updates).toEqual([]);
  });

  it("raises the session's cap through the API when the user picks a cap", async () => {
    const { updates } = await run([{ type: "session.status_idle", id: "e1", stop_reason: { type: "budget_reached" } }], {
      answer: (id) => (id === "budget:e1" ? { behavior: "allow", selectedActionId: "raise:1000" } : { behavior: "deny" }),
    });
    expect(updates).toEqual([{ budget: { type: "limit", max_list_cost: { amount: "1000", currency: "USD" } } }]);
  });

  it("takes the first cap on a plain allow with no action picked", async () => {
    const { updates } = await run([{ type: "session.status_idle", id: "e1", stop_reason: { type: "budget_reached" } }], {
      answer: () => ({ behavior: "allow" }),
    });
    expect(updates).toEqual([{ budget: { type: "limit", max_list_cost: { amount: "500", currency: "USD" } } }]);
  });

  it("leaves the session paused and fails the turn when the user declines", async () => {
    const { events, updates } = await run([{ type: "session.status_idle", id: "e1", stop_reason: { type: "budget_reached" } }], {
      answer: () => ({ behavior: "deny", selectedActionId: "keep-paused" }),
    });
    expect(updates).toEqual([]);
    const tail = events.filter((event) => event.type === "session.permission_resolved" || event.type === "session.turn");
    expect(tail.map((event) => (event.type === "session.turn" ? event.state : event.type))).toEqual([
      "started",
      "session.permission_resolved",
      "failed",
    ]);
  });

  it("continues the same turn when a raised cap resumes the session", async () => {
    const { events } = await run([
      { type: "session.status_idle", id: "e1", stop_reason: { type: "budget_reached" } },
      { type: "session.status_running", id: "e2" },
      { type: "agent.message", id: "m1", content: [{ type: "text", text: "Continuing" }] },
      { type: "session.status_idle", id: "e3", stop_reason: { type: "end_turn" } },
    ]);
    const turns = events.flatMap((event) => (event.type === "session.turn" ? [[event.turnId.split("-")[0], event.state]] : []));
    expect(turns).toEqual([
      ["turn", "started"],
      ["turn", "completed"],
    ]);
  });

  it("offers the cap when a paused session refuses a message, then delivers it", async () => {
    const { events, sent, updates } = await run([], {
      rejectFirstMessage:
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"session budget reached: consumed list cost has met `budget.max_list_cost`"}}',
      answer: () => ({ behavior: "allow", selectedActionId: "raise:1000" }),
    });
    expect(events.find((event) => event.type === "session.permission")).toMatchObject({ request: { kind: "other" } });
    expect(events.find((event) => event.type === "session.prompt_result")).toMatchObject({ result: { type: "turn" } });
    expect(updates).toEqual([{ budget: { type: "limit", max_list_cost: { amount: "1000", currency: "USD" } } }]);
    expect(sent).toEqual([{ type: "user.message", content: [{ type: "text", text: "fix the bug" }] }]);
  });

  it("fails the prompt on any other refused message", async () => {
    const { events } = await run([], { rejectFirstMessage: "500 overloaded" });
    expect(events.find((event) => event.type === "session.prompt_result")).toMatchObject({
      result: { type: "failed", error: { message: "500 overloaded" } },
    });
    expect(events.some((event) => event.type === "session.permission")).toBe(false);
  });

  it("does not mistake its own prompt's status_running for a resume", async () => {
    const { events } = await run([
      { type: "session.status_running", id: "e1" },
      { type: "session.status_idle", id: "e2", stop_reason: { type: "end_turn" } },
    ]);
    const turns = events.filter((event) => event.type === "session.turn").map((event) => event.state);
    expect(turns).toEqual(["started", "completed"]);
  });
});
