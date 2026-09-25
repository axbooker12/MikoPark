import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./app.ts";
import { DemoBrain } from "./brain.ts";
import { Store } from "./store.ts";
import { Team } from "./team.ts";
import { VoiceEngine } from "./voices.ts";

const PORT = 5000 + Math.floor(Math.random() * 900);
let engine: ChildProcess;

beforeAll(async () => {
  // The real Python engine in fake mode: same HTTP contract, a test tone instead of a model.
  engine = spawn("python3", [path.join(import.meta.dirname, "..", "voice-engine", "server.py")], {
    env: { ...process.env, VOICE_ENGINE_FAKE: "1", VOICE_ENGINE_PORT: String(PORT) },
    stdio: "ignore",
  });
  const e = new VoiceEngine(`http://127.0.0.1:${PORT}`);
  for (let i = 0; i < 50 && !(await e.status()).running; i++) await new Promise((r) => setTimeout(r, 100));
});

afterAll(() => engine?.kill());

function setup(url = `http://127.0.0.1:${PORT}`) {
  const store = new Store(null);
  const app = createApp(store, new Team(store, new DemoBrain(store, 0)), new VoiceEngine(url));
  return { store, app };
}

const SAMPLE = Buffer.from("ID3 pretend mp3 bytes");

describe("voices", () => {
  it("uploads a sample, assigns it to an agent, and speaks through the engine", async () => {
    const { store, app } = setup();
    const up = await request(app)
      .post("/api/voices?name=Benson&file=Benson%20-%20Eleven%20labs.mp3")
      .set("Content-Type", "application/octet-stream")
      .send(SAMPLE);
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ name: "Benson", ext: "mp3", size: SAMPLE.length });

    const benson = store.workspace.agents[0];
    expect((await request(app).patch(`/api/agents/${benson.id}`).send({ voice: { kind: "custom", id: up.body.id } })).status).toBe(200);
    expect(benson.voice).toEqual({ kind: "custom", id: up.body.id });

    expect((await request(app).get("/api/tts/status")).body).toMatchObject({ running: true, model: "fake" });
    const tts = await request(app).post("/api/tts").send({ voiceId: up.body.id, text: "Hi, I'm Benson." }).buffer(true);
    expect(tts.status).toBe(200);
    expect(tts.headers["content-type"]).toBe("audio/wav");
    expect(Buffer.from(tts.body).subarray(0, 4).toString()).toBe("RIFF");

    const sample = await request(app).get(`/api/voices/${up.body.id}/sample`).buffer(true);
    expect(Buffer.from(sample.body)).toEqual(SAMPLE);

    // Removing the voice unassigns it.
    expect((await request(app).delete(`/api/voices/${up.body.id}`)).status).toBe(204);
    expect(benson.voice).toBeUndefined();
    expect(store.workspace.voices).toEqual([]);
  });

  it("rejects non-audio files and unknown voices", async () => {
    const { store, app } = setup();
    const bad = await request(app).post("/api/voices?name=x&file=notes.txt").set("Content-Type", "application/octet-stream").send(Buffer.from("hi"));
    expect(bad.status).toBe(400);
    const benson = store.workspace.agents[0];
    expect((await request(app).patch(`/api/agents/${benson.id}`).send({ voice: { kind: "custom", id: "nope" } })).status).toBe(400);
    expect((await request(app).patch(`/api/agents/${benson.id}`).send({ voice: { kind: "system", name: "Samantha" } })).status).toBe(200);
    expect(benson.voice).toEqual({ kind: "system", name: "Samantha" });
  });

  it("reports 503 when the engine isn't running, so the browser can fall back", async () => {
    const { app } = setup("http://127.0.0.1:1");
    const up = await request(app).post("/api/voices?name=V&file=v.wav").set("Content-Type", "application/octet-stream").send(SAMPLE);
    expect((await request(app).get("/api/tts/status")).body).toEqual({ running: false });
    expect((await request(app).post("/api/tts").send({ voiceId: up.body.id, text: "hello" })).status).toBe(503);
  });
});
