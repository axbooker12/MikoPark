import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeBrain } from "./brain.ts";
import { Store } from "./store.ts";
import { Team } from "./team.ts";

// A fake Messages API: first call asks for the save_memory tool, second call answers in text.
const requests: Record<string, unknown>[] = [];
let server: http.Server;

function sse(events: object[]) {
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

const message = (id: string) => ({
  id,
  type: "message",
  role: "assistant",
  model: "claude-opus-5",
  content: [],
  stop_reason: null,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 0 },
});

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (requests.length === 1) {
        res.end(
          sse([
            { type: "message_start", message: message("msg_1") },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Noted." } },
            { type: "content_block_stop", index: 0 },
            { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "save_memory", input: {} } },
            { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"fact": "Launch is Friday"}' } },
            { type: "content_block_stop", index: 1 },
            { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } },
            { type: "message_stop" },
          ]),
        );
      } else {
        res.end(
          sse([
            { type: "message_start", message: message("msg_2") },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Saved it — @Kai can you prep the demo?" } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
            { type: "message_stop" },
          ]),
        );
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ANTHROPIC_API_KEY = "test-key";
});

afterAll(() => {
  server.close();
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_API_KEY;
});

describe("ClaudeBrain", () => {
  it("streams text, runs workspace tools, loops, and echoes the assistant turn back", async () => {
    const store = new Store(null);
    const genny = store.workspace.agents[0];
    const dm = store.channel("c_dm_genny")!;
    store.addMessage({ channelId: dm.id, authorKind: "human", authorId: "u_me", content: "Remember: launch is Friday" });

    let text = "";
    const statuses: (string | null)[] = [];
    await new ClaudeBrain(store).reply(genny, dm, { delta: (d) => (text += d), status: (s) => statuses.push(s) });

    expect(text).toBe("Noted.\n\nSaved it — @Kai can you prep the demo?");
    expect(statuses).toContain("Saving to team memory…");
    expect(store.workspace.memory.map((m) => m.content)).toEqual(["Launch is Friday"]);

    expect(requests).toHaveLength(2);
    const first = requests[0] as { model: string; tools: { name: string }[]; fallbacks: string; thinking: object };
    expect(first.model).toBe("claude-opus-5");
    expect(first.fallbacks).toBe("default");
    expect(first.thinking).toEqual({ type: "adaptive" });
    expect(first.tools.map((t) => t.name)).toEqual(["create_task", "update_task", "save_memory", "list_marketplace", "hire_agent"]);

    const second = requests[1] as { messages: { role: string; content: unknown }[] };
    const [assistant, toolResult] = second.messages.slice(-2);
    expect(assistant.role).toBe("assistant");
    expect(toolResult).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Saved to shared memory." }],
    });
  });

  it("drives a full team turn through the Team router", async () => {
    requests.length = 0;
    const store = new Store(null);
    const team = new Team(store, new ClaudeBrain(store));
    team.postHumanMessage("c_dm_genny", "hi");
    await team.idle();
    const last = store.channelMessages("c_dm_genny").at(-1)!;
    expect(last).toMatchObject({ authorKind: "agent", streaming: false });
    expect(last.content).toContain("Saved it");
  });
});
