import { describe, expect, it } from "vitest";
import request from "supertest";
import type { Agent, Channel } from "../shared/types.ts";
import { createApp } from "./app.ts";
import { historyFor, type Brain, type TurnSink } from "./brain.ts";
import { Store } from "./store.ts";
import { Team } from "./team.ts";

class EchoBrain implements Brain {
  readonly mode = "demo" as const;
  async reply(_a: Agent, _c: Channel, sink: TurnSink) {
    sink.delta("Sure, happy to help.");
  }
}

function setup() {
  const store = new Store(null);
  const team = new Team(store, new EchoBrain());
  return { store, team, app: createApp(store, team) };
}

describe("voice calls", () => {
  it("runs a call as its own conversation, saves the transcript, and notes it in the chat", async () => {
    const { store, team, app } = setup();
    const call = (await request(app).post("/api/calls").send({ channelId: "c_dm_genny" })).body as Channel;
    expect(call).toMatchObject({ kind: "call", parentId: "c_dm_genny", name: "Call with Benson" });

    await request(app).post(`/api/channels/${call.id}/messages`).send({ content: "What's on today?", viaVoice: true });
    await team.idle();
    expect(store.channelMessages(call.id).map((m) => m.content)).toEqual(["What's on today?", "Sure, happy to help."]);
    // Nothing from the call lands in the chat itself while it's going.
    expect(store.channelMessages("c_dm_genny").some((m) => m.content.includes("What's on today"))).toBe(false);

    const ended = (await request(app).post(`/api/calls/${call.id}/end`)).body.call as Channel;
    expect(ended.endedAt).toBeGreaterThan(0);
    const note = store.channelMessages("c_dm_genny").at(-1)!;
    expect(note).toMatchObject({ authorKind: "system", callId: call.id });
    expect(note.content).toContain(`#/transcripts/${call.id}`);

    const txt = await request(app).get(`/api/calls/${call.id}/transcript.txt`);
    expect(txt.headers["content-disposition"]).toMatch(/^attachment/);
    expect(txt.text).toContain("You: What's on today?");
    expect(txt.text).toContain("Benson: Sure, happy to help.");

    // The call is over: no more messages.
    expect((await request(app).post(`/api/channels/${call.id}/messages`).send({ content: "hello?" })).status).toBe(400);
  });

  it("leaves no transcript when nobody spoke", async () => {
    const { store, app } = setup();
    const call = (await request(app).post("/api/calls").send({ channelId: "c_dm_genny" })).body as Channel;
    expect((await request(app).post(`/api/calls/${call.id}/end`)).body.call).toBeNull();
    expect(store.channel(call.id)).toBeUndefined();
  });

  it("gives the agent the chat before the call, and the call in later chats", async () => {
    const { store, team } = setup();
    const agent = store.workspace.agents[0];
    store.addMessage({ channelId: "c_dm_genny", authorKind: "human", authorId: "u_me", content: "Remember the Q3 launch." });
    const call = store.startCall("c_dm_genny");
    const during = JSON.stringify(historyFor(store, agent, call));
    expect(during).toContain("Remember the Q3 launch.");

    team.postHumanMessage(call.id, "Let's move it to Friday.", [], { viaVoice: true });
    await team.idle();
    store.endCall(call.id);
    const after = JSON.stringify(historyFor(store, agent, store.channel("c_dm_genny")!));
    expect(after).toContain("Transcript of an earlier voice call");
    expect(after).toContain("Let's move it to Friday.");
  });

  it("deletes a transcript and its note", async () => {
    const { store, team, app } = setup();
    const call = store.startCall("c_dm_genny");
    team.postHumanMessage(call.id, "hi", [], { viaVoice: true });
    await team.idle();
    store.endCall(call.id);
    expect((await request(app).delete(`/api/calls/${call.id}`)).status).toBe(204);
    expect(store.channel(call.id)).toBeUndefined();
    expect(store.channelMessages("c_dm_genny").some((m) => m.callId === call.id)).toBe(false);
  });

  it("only starts calls from a DM", async () => {
    const { app } = setup();
    expect((await request(app).post("/api/calls").send({ channelId: "c_general" })).status).toBe(400);
  });
});
