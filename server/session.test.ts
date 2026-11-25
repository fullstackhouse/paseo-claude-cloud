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
function fakeClient(script: Array<Record<string, unknown>>) {
  const sent: Array<Record<string, unknown>> = [];
  let release: () => void = () => {};
  const done = new Promise<void>((resolve) => (release = resolve));
  const client = {
    beta: {
      sessions: {
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
            sent.push(...body.events);
          },
        },
      },
    },
  } as unknown as Anthropic;
  return { client, sent, done };
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
}

async function run(script: Array<Record<string, unknown>>, options: RunOptions = {}) {
  const events: ProviderEvent[] = [];
  const bridgeCalls: Array<{ name: string; input: unknown }> = [];
  const { client, sent, done } = fakeClient(script);
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
  return { events, sent, bridgeCalls };
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
      request: { id: "c1", name: "status__status_set", kind: "tool" },
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

  it("fails the turn and warns when the budget is reached", async () => {
    const { events } = await run([{ type: "session.status_idle", id: "e1", stop_reason: { type: "budget_reached" } }]);
    expect(events.find((event) => event.type === "session.notice")).toMatchObject({
      notice: { title: "Session budget reached" },
    });
    expect(events.filter((event) => event.type === "session.turn").at(-1)).toMatchObject({ state: "failed" });
  });
});
