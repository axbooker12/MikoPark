import { describe, expect, it } from "vitest";
import request from "supertest";
import type { Agent, Channel } from "../shared/types.ts";
import { createApp } from "./app.ts";
import { DemoBrain, historyFor, runTool, type Brain, type TurnSink } from "./brain.ts";
import { findMentionedAgents } from "./mentions.ts";
import { Store, renameLegacyAgents, syncTemplateNotes } from "./store.ts";
import { TEMPLATES } from "./templates.ts";
import { CATEGORIES } from "../shared/types.ts";
import { Team } from "./team.ts";

/** A brain that replies with a fixed script per agent name, recording who was asked. */
class ScriptedBrain implements Brain {
  readonly mode = "demo" as const;
  calls: { agent: string; channel: string; extra?: string }[] = [];
  constructor(private script: Record<string, string>) {}
  async reply(agent: Agent, channel: Channel, sink: TurnSink, extra?: string) {
    this.calls.push({ agent: agent.name, channel: channel.name, extra });
    sink.delta(this.script[agent.name] ?? `hi from ${agent.name}`);
  }
}

function setup(script: Record<string, string> = {}) {
  const store = new Store(null);
  const brain = new ScriptedBrain(script);
  const team = new Team(store, brain);
  return { store, brain, team };
}

describe("findMentionedAgents", () => {
  const agents = [{ name: "Kai" }, { name: "Wren" }, { name: "Remy2" }] as Agent[];
  it("matches names case-insensitively, deduplicated, in order", () => {
    expect(findMentionedAgents("@wren then @Kai and @WREN", agents).map((a) => a.name)).toEqual(["Wren", "Kai"]);
  });
  it("ignores emails and unknown names", () => {
    expect(findMentionedAgents("mail kai@example.com or @nobody", agents)).toEqual([]);
  });
  it("does not match a prefix of a longer name", () => {
    expect(findMentionedAgents("@Remy2 but not @Remy", agents).map((a) => a.name)).toEqual(["Remy2"]);
  });
});

describe("Team routing", () => {
  it("replies in a DM without a mention", async () => {
    const { store, brain, team } = setup();
    team.postHumanMessage("c_dm_genny", "hello");
    await team.idle();
    expect(brain.calls.map((c) => c.agent)).toEqual(["Benson"]);
    const msgs = store.channelMessages("c_dm_genny");
    expect(msgs.at(-1)).toMatchObject({ authorKind: "agent", content: "hi from Benson", streaming: false });
  });

  it("only replies in a channel when mentioned", async () => {
    const { brain, team } = setup();
    team.postHumanMessage("c_general", "morning all");
    await team.idle();
    expect(brain.calls).toEqual([]);
    team.postHumanMessage("c_general", "@Benson help");
    await team.idle();
    expect(brain.calls.map((c) => c.agent)).toEqual(["Benson"]);
  });

  it("hands off between agents via @mentions, adding them to the channel", async () => {
    const { store, brain, team } = setup({ Benson: "Over to @SoftwareEngineer", SoftwareEngineer: "Done. @Benson fyi" });
    const kai = store.hireAgent("engineer");
    const ch = store.createChannel("build", "", [store.workspace.agents[0].id]);
    team.postHumanMessage(ch.id, "@Benson please build it");
    await team.idle();
    expect(brain.calls.map((c) => c.agent)).toEqual(["Benson", "SoftwareEngineer", "Benson", "SoftwareEngineer"]);
    expect(store.channel(ch.id)!.agentIds).toContain(kai.id);
  });

  it("caps hand-off chains", async () => {
    const { brain, team, store } = setup({ Benson: "@SoftwareEngineer", SoftwareEngineer: "@Benson" });
    store.hireAgent("engineer");
    team.postHumanMessage("c_general", "@Benson go");
    await team.idle();
    expect(brain.calls.length).toBe(4); // human→Benson, then 3 hops
  });

  it("runs a task and moves it to review", async () => {
    const { store, brain, team } = setup({ SoftwareEngineer: "Here is the code." });
    const kai = store.hireAgent("engineer");
    const task = store.createTask({ title: "Write a script", assigneeAgentId: kai.id, createdBy: { kind: "human", id: "u_me" } });
    await team.startTask(task.id);
    expect(brain.calls[0].extra).toContain("Write a script");
    expect(store.task(task.id)).toMatchObject({ status: "review", result: "Here is the code." });
  });
});

describe("agent tools", () => {
  it("creates and assigns tasks, saves memory, hires", () => {
    const store = new Store(null);
    const genny = store.workspace.agents[0];
    const general = store.channel("c_general")!;
    expect(runTool(store, genny, general, "hire_agent", { template_id: "writer" })).toContain("Hired ContentWriter");
    runTool(store, genny, general, "create_task", { title: "Draft post", assignee: "@contentwriter" });
    expect(store.workspace.tasks[0].assigneeAgentId).toBe(store.workspace.agents[1].id);
    runTool(store, genny, general, "save_memory", { fact: "Tone: friendly" });
    expect(store.workspace.memory[0].content).toBe("Tone: friendly");
    expect(runTool(store, genny, general, "create_task", { title: "x", assignee: "Nobody" })).toMatch(/No teammate/);
  });
});

describe("historyFor", () => {
  it("maps own messages to assistant turns and others to named user turns", () => {
    const store = new Store(null);
    const genny = store.workspace.agents[0];
    const dm = store.channel("c_dm_genny")!;
    store.addMessage({ channelId: dm.id, authorKind: "human", authorId: "u_me", content: "hi" });
    const h = historyFor(store, genny, dm);
    expect(h[0]).toEqual({ role: "user", content: "(conversation start)" });
    expect(h[1].role).toBe("assistant");
    expect(h[2]).toEqual({ role: "user", content: "[You]: hi" });
  });
});

describe("HTTP API", () => {
  it("hires agents, posts messages and rejects bad input", async () => {
    const store = new Store(null);
    const team = new Team(store, new DemoBrain(store, 0));
    const app = createApp(store, team);
    const hired = await request(app).post("/api/agents").send({ templateId: "researcher" });
    expect(hired.status).toBe(201);
    expect(hired.body.name).toBe("ResearchAnalyst");
    const dm = store.workspace.channels.find((c) => c.kind === "dm" && c.agentIds[0] === hired.body.id)!;
    expect((await request(app).post(`/api/channels/${dm.id}/messages`).send({ content: "find competitors" })).status).toBe(201);
    await team.idle();
    expect(store.channelMessages(dm.id).at(-1)!.content).toContain("demo mode");
    expect((await request(app).post("/api/agents").send({ templateId: "nope" })).status).toBe(400);
    expect((await request(app).delete("/api/agents/a_genny")).status).toBe(400);
  });
});

describe("marketplace templates", () => {
  it("hires the Search Engine Strategist under its role name, with web access", () => {
    const store = new Store(null);
    const a = store.hireAgent("search-strategist");
    expect(a).toMatchObject({ name: "SearchEngineStrategist", role: "Search Engine Strategist", webSearch: true });
    expect(a.instructions).toContain("Never apologize");
    expect(findMentionedAgents("@searchenginestrategist audit this", store.workspace.agents)).toEqual([a]);
  });
});

describe("legacy agent names", () => {
  it("renames agents still using an old default name, keeping numbering and custom names", () => {
    const store = new Store(null);
    const a = store.hireAgent("writer");
    const b = store.hireAgent("writer");
    const c = store.hireAgent("engineer");
    a.name = "Wren";
    b.name = "Wren2";
    c.name = "Linus"; // renamed by a person — leave alone
    renameLegacyAgents(store.workspace);
    expect([a.name, b.name, c.name]).toEqual(["ContentWriter", "ContentWriter2", "Linus"]);
    expect(store.workspace.channels.find((ch) => ch.kind === "dm" && ch.agentIds[0] === a.id)!.name).toBe("ContentWriter");
  });
});

describe("legal agents and categories", () => {
  it("hires both legal agents with their disclaimer and confidentiality notice", () => {
    const store = new Store(null);
    const counsel = store.hireAgent("legal-counsel");
    const para = store.hireAgent("paralegal");
    expect([counsel.name, para.name]).toEqual(["LegalCounsel", "Paralegal"]);
    expect([counsel.category, para.category, store.workspace.agents[0].category]).toEqual(["Legal", "Legal", "Leadership"]);
    for (const a of [counsel, para]) {
      expect(a.disclaimer).toMatch(/not legal advice/i);
      expect(a.notice).toMatch(/Confidentiality/);
    }
  });
  it("refreshes notes on saved agents and leaves others without them", () => {
    const store = new Store(null);
    const counsel = store.hireAgent("legal-counsel");
    const writer = store.hireAgent("writer");
    counsel.disclaimer = "old wording";
    syncTemplateNotes(store.workspace);
    expect(counsel.disclaimer).toMatch(/not legal advice/i);
    expect(writer.disclaimer).toBeUndefined();
  });
  it("puts every marketplace agent in a known category", () => {
    for (const t of TEMPLATES.filter((t) => t.id !== "genny")) expect(CATEGORIES).toContain(t.category);
  });
});

describe("removed voice features", () => {
  it("clears calls, call notes and voice settings from a saved workspace", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mp-")), "workspace.json");
    const seeded = new Store(null);
    const ws = JSON.parse(JSON.stringify(seeded.workspace));
    ws.agents[0].voice = { kind: "custom", id: "v1" };
    ws.voices = [{ id: "v1", name: "Benson" }];
    ws.channels.push({ id: "call_1", kind: "call", name: "Call with Benson", topic: "", humanIds: [], agentIds: [], createdAt: 1 });
    const messages = [
      { id: "m1", channelId: "call_1", authorKind: "human", authorId: "u_me", content: "hi", createdAt: 1 },
      { id: "m2", channelId: "c_dm_genny", authorKind: "system", authorId: "system", content: "📞 Call", callId: "call_1", createdAt: 2 },
      { id: "m3", channelId: "c_dm_genny", authorKind: "human", authorId: "u_me", content: "keep me", createdAt: 3 },
    ];
    fs.writeFileSync(file, JSON.stringify({ workspace: ws, messages }));

    const store = new Store(file);
    expect(store.channel("call_1")).toBeUndefined();
    expect(store.channelMessages("c_dm_genny").map((m) => m.content)).toEqual(["keep me"]);
    expect(store.workspace.agents[0]).not.toHaveProperty("voice");
    expect(store.workspace).not.toHaveProperty("voices");
  });
});
