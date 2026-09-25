import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./app.ts";
import { ClaudeBrain, DemoBrain, historyFor } from "./brain.ts";
import { Store } from "./store.ts";
import { Team } from "./team.ts";
import { classify } from "./uploads.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

describe("classify", () => {
  it("sorts files into what agents can read", () => {
    expect(classify("a.png", "image/png")).toBe("image");
    expect(classify("a.svg", "image/svg+xml")).toBe("other");
    expect(classify("report.pdf", "")).toBe("pdf");
    expect(classify("main.ts", "")).toBe("text");
    expect(classify("notes", "text/plain")).toBe("text");
    expect(classify("Dockerfile", "")).toBe("text");
    expect(classify("deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation")).toBe("other");
  });
});

describe("attachments in agent context", () => {
  it("sends images, PDFs and text as content blocks, and names files it can't read", () => {
    const store = new Store(null);
    const agent = store.workspace.agents[0];
    const dm = store.channel("c_dm_genny")!;
    const img = store.uploads.save({ name: "shot.png", type: "image/png", data: PNG });
    const pdf = store.uploads.save({ name: "brief.pdf", type: "application/pdf", data: Buffer.from("%PDF-1.4 test") });
    const code = store.uploads.save({ name: "app.ts", type: "", data: Buffer.from("export const x = 1;"), path: "src/app.ts" });
    const deck = store.uploads.save({ name: "deck.pptx", type: "application/octet-stream", data: Buffer.from("zip") });
    store.addMessage({ channelId: dm.id, authorKind: "human", authorId: "u_me", content: "Look at these", attachments: [img, pdf, code, deck] });

    const last = historyFor(store, agent, dm).at(-1)!;
    expect(last.role).toBe("user");
    const blocks = last.content as { type: string; title?: string; text?: string; source?: { type: string } }[];
    expect(blocks.map((b) => b.type)).toEqual(["image", "document", "document", "text"]);
    expect(blocks[1]).toMatchObject({ title: "brief.pdf", source: { type: "base64" } });
    expect(blocks[2]).toMatchObject({ title: "src/app.ts", source: { type: "text" } });
    expect(blocks[3].text).toContain('"deck.pptx"');
    expect(blocks[3].text).toContain("[You]: Look at these");
  });

  it("only mentions attachments on older messages by name", () => {
    const store = new Store(null);
    const agent = store.workspace.agents[0];
    const dm = store.channel("c_dm_genny")!;
    const img = store.uploads.save({ name: "old.png", type: "image/png", data: PNG });
    store.addMessage({ channelId: dm.id, authorKind: "human", authorId: "u_me", content: "", attachments: [img] });
    for (let i = 0; i < 12; i++) store.addMessage({ channelId: dm.id, authorKind: "human", authorId: "u_me", content: `msg ${i}` });
    const text = JSON.stringify(historyFor(store, agent, dm));
    expect(text).toContain("[Earlier attachment: old.png]");
    expect(text).not.toContain('"type":"image"');
  });
});

describe("model settings", () => {
  it("uses the conversation's choice, then the workspace default", () => {
    const store = new Store(null);
    const dm = store.channel("c_dm_genny")!;
    expect(store.modelFor(dm).model).toBe("claude-opus-5");
    store.setDefaultModel({ model: "claude-sonnet-5", effort: "low" });
    expect(store.modelFor(dm)).toEqual({ model: "claude-sonnet-5", effort: "low" });
    store.setChannelModel(dm.id, { model: "claude-opus-5-5" });
    expect(store.modelFor(dm)).toEqual({ model: "claude-opus-5-5", effort: "low" });
    store.setChannelModel(dm.id, { model: null });
    expect(store.modelFor(dm).model).toBe("claude-sonnet-5");
    expect(() => store.setChannelModel(dm.id, { model: "gpt-9" })).toThrow(/Unknown model/);
  });
});

describe("HTTP: uploads, messages with attachments, clearing", () => {
  it("uploads a file, attaches it, serves images inline and other files as downloads", async () => {
    const store = new Store(null);
    const team = new Team(store, new DemoBrain(store, 0));
    const app = createApp(store, team);

    const up = await request(app)
      .post("/api/uploads?name=pic.png&type=image%2Fpng")
      .set("Content-Type", "application/octet-stream")
      .send(PNG);
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ name: "pic.png", kind: "image", size: PNG.length });

    const img = await request(app).get(`/api/uploads/${up.body.id}`);
    expect(img.headers["content-type"]).toBe("image/png");
    expect(img.headers["content-disposition"]).toMatch(/^inline/);

    const html = await request(app)
      .post("/api/uploads?name=x.html&type=text%2Fhtml")
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("<script>alert(1)</script>"));
    const got = await request(app).get(`/api/uploads/${html.body.id}`);
    expect(got.headers["content-type"]).toBe("application/octet-stream");
    expect(got.headers["content-disposition"]).toMatch(/^attachment/);

    const sent = await request(app).post("/api/channels/c_dm_genny/messages").send({ content: "", attachmentIds: [up.body.id] });
    expect(sent.status).toBe(201);
    expect(sent.body.attachments[0].name).toBe("pic.png");
    await team.idle();
    expect(store.channelMessages("c_dm_genny").at(-1)!.content).toContain("pic.png");

    expect((await request(app).post("/api/channels/c_dm_genny/messages").send({ attachmentIds: ["nope"] })).status).toBe(400);
    expect((await request(app).get("/api/uploads/../../etc")).status).toBe(404);

    expect((await request(app).delete("/api/channels/c_dm_genny/messages")).status).toBe(204);
    expect(store.channelMessages("c_dm_genny")).toEqual([]);
  });
});

// ---- the request each model gets ------------------------------------------

const bodies: Record<string, unknown>[] = [];
let server: http.Server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      bodies.push(JSON.parse(body));
      const events = [
        { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "x", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ];
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
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

describe("per-model requests", () => {
  async function requestFor(model: string, effort?: "low" | "high") {
    bodies.length = 0;
    const store = new Store(null);
    const researcher = store.hireAgent("researcher");
    const dm = store.workspace.channels.find((c) => c.kind === "dm" && c.agentIds[0] === researcher.id)!;
    store.setChannelModel(dm.id, { model, effort });
    store.addMessage({ channelId: dm.id, authorKind: "human", authorId: "u_me", content: "hi" });
    await new ClaudeBrain(store).reply(researcher, dm, { delta: () => {}, status: () => {} });
    return bodies[0] as Record<string, unknown> & { tools: { type?: string; name: string }[] };
  }

  it("Opus 5.5 gets adaptive thinking, the chosen effort, fallbacks and the newest web tools", async () => {
    const body = await requestFor("claude-opus-5-5", "high");
    expect(body).toMatchObject({ model: "claude-opus-5-5", thinking: { type: "adaptive" }, output_config: { effort: "high" }, fallbacks: "default" });
    expect(body.tools.map((t) => t.type).filter(Boolean)).toEqual(["web_search_20260209", "web_fetch_20260209"]);
  });

  it("Sonnet 5 skips fallbacks", async () => {
    const body = await requestFor("claude-sonnet-5");
    expect(body.model).toBe("claude-sonnet-5");
    expect(body).not.toHaveProperty("fallbacks");
    expect(body).not.toHaveProperty("output_config");
  });

  it("Haiku 4.5 gets no thinking or effort, and the older web tools", async () => {
    const body = await requestFor("claude-haiku-4-5", "low");
    expect(body).toMatchObject({ model: "claude-haiku-4-5", max_tokens: 32000 });
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("output_config");
    expect(body.tools.map((t) => t.type).filter(Boolean)).toEqual(["web_search_20250305", "web_fetch_20250910"]);
  });
});

describe("read-aloud text", async () => {
  const { speakableText } = await import("../web/src/voice.ts");
  it("drops markdown syntax and code blocks", () => {
    expect(speakableText("## Plan\n\n- **Ship** it\n- see [docs](https://x.y)\n\n```js\nlet a = 1\n```\nDone")).toBe(
      "Plan. Ship it see docs. (code block omitted) Done",
    );
  });
});

describe("speech chunking", async () => {
  const { chunkText } = await import("../web/src/voice.ts");
  it("splits on sentences and keeps chunks short", () => {
    const text = "One two three. Four five six! Seven eight nine? Ten.";
    expect(chunkText(text, 30)).toEqual(["One two three. Four five six!", "Seven eight nine? Ten."]);
    expect(chunkText("No punctuation here")).toEqual(["No punctuation here"]);
    expect(chunkText("x".repeat(2500)).map((c) => c.length)).toEqual([1000, 1000, 500]);
  });
});

describe("read-aloud punctuation", async () => {
  const { speakableText } = await import("../web/src/voice.ts");
  it("doesn't double up periods or read emoji", () => {
    expect(speakableText("Done.\n\n> 💡 Tip here")).toBe("Done. Tip here");
  });
});

describe("fallback voice choice", async () => {
  const { bestNaturalVoice } = await import("../web/src/voice.ts");
  it("prefers Premium/Enhanced voices in the user's language over compact or novelty ones", () => {
    const v = (name: string, lang = "en-US", isDefault = false) => ({ name, lang, default: isDefault, localService: true });
    const voices = [v("Samantha", "en-US", true), v("Zarvox"), v("Ava (Premium)"), v("Evan (Enhanced)"), v("Thomas", "fr-FR")];
    expect(bestNaturalVoice(voices)?.name).toBe("Ava (Premium)");
    expect(bestNaturalVoice([v("Samantha", "en-US", true), v("Zarvox")])?.name).toBe("Samantha");
  });
});

describe("speaking while a reply streams", async () => {
  const { sentenceBoundary } = await import("../web/src/voice.ts");
  it("cuts after complete sentences once there's enough text", () => {
    const t = "Sure thing. Here is the plan for the launch this week. And then";
    expect(sentenceBoundary(t, 0)).toBe(t.indexOf(" And"));
    expect(sentenceBoundary("Hi. Short.", 0)).toBe(0); // not enough yet
    expect(sentenceBoundary(t, t.indexOf(" And"))).toBe(t.indexOf(" And")); // nothing new finished
  });
  it("doesn't cut inside a code block", () => {
    const t = "Here is some code for you to try out now.\n\n```js\nlet a = 1. b = 2. more code here and here.\n";
    expect(sentenceBoundary(t, 0)).toBe(t.indexOf("```"));
  });
});

describe("voice turns", () => {
  it("ask for a short spoken-style reply and think fast unless a depth was chosen", async () => {
    const run = async (effort?: "high") => {
      bodies.length = 0;
      const store = new Store(null);
      const dm = store.channel("c_dm_genny")!;
      store.setChannelModel(dm.id, { model: "claude-opus-5-5", effort });
      store.addMessage({ channelId: dm.id, authorKind: "human", authorId: "u_me", content: "what's next?", viaVoice: true });
      await new ClaudeBrain(store).reply(store.workspace.agents[0], dm, { delta: () => {}, status: () => {} });
      return bodies[0] as { messages: { content: unknown }[]; output_config?: { effort: string } };
    };
    const quick = await run();
    expect(JSON.stringify(quick.messages.at(-1))).toContain("read aloud");
    expect(quick.output_config).toEqual({ effort: "low" });
    expect((await run("high")).output_config).toEqual({ effort: "high" });
  });
});
