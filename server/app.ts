import express, { type NextFunction, type Request, type Response } from "express";
import type { ServerEvent } from "../shared/types.ts";
import { serverDefaultModel, type Store } from "./store.ts";
import type { Team } from "./team.ts";
import { TEMPLATES } from "./templates.ts";
import { MAX_UPLOAD_BYTES } from "./uploads.ts";
import { MAX_SAMPLE_BYTES, VoiceEngine, VoiceEngineDown } from "./voices.ts";

export function createApp(store: Store, team: Team, voiceEngine = new VoiceEngine()) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  const api = express.Router();

  // Live updates over Server-Sent Events: a snapshot first, then incremental events.
  api.get("/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event: ServerEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: "snapshot", workspace: store.workspace, messages: store.snapshotMessages(), mode: team.mode, defaultModel: serverDefaultModel() });
    const onEvent = (event: ServerEvent) =>
      send(event.type === "snapshot" ? { ...event, mode: team.mode, defaultModel: serverDefaultModel() } : event);
    store.on("event", onEvent);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(ping);
      store.off("event", onEvent);
    });
  });

  api.get("/templates", (_req, res) => res.json(TEMPLATES.filter((t) => t.id !== "genny")));

  api.post("/channels/:id/messages", (req, res) => {
    const ids = Array.isArray(req.body?.attachmentIds) ? req.body.attachmentIds.map(String) : [];
    res.status(201).json(team.postHumanMessage(req.params.id, String(req.body?.content ?? ""), ids));
  });

  api.delete("/channels/:id/messages", (req, res) => {
    store.clearChannel(req.params.id);
    res.status(204).end();
  });

  api.patch("/channels/:id/model", (req, res) => {
    res.json(store.setChannelModel(req.params.id, { model: req.body?.model, effort: req.body?.effort }));
  });

  api.patch("/settings/model", (req, res) => {
    res.json(store.setDefaultModel({ model: req.body?.model, effort: req.body?.effort }));
  });

  // Uploads: the raw file is the body; name, type and folder path ride in the query string.
  api.post("/uploads", express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), (req, res) => {
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const meta = store.uploads.save({
      name: String(req.query.name ?? "file"),
      type: String(req.query.type ?? req.headers["content-type"] ?? ""),
      data,
      path: req.query.path ? String(req.query.path) : undefined,
    });
    res.status(201).json(meta);
  });

  api.get("/uploads/:id", (req, res) => {
    const file = store.uploads.read(req.params.id);
    if (!file) return void res.status(404).json({ error: "File not found" });
    // Only raster images display inline; everything else downloads, so an uploaded HTML or SVG can't run in the app.
    const inline = file.meta.kind === "image";
    res.setHeader("Content-Type", inline ? file.meta.type : "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.meta.name)}`);
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.end(file.data);
  });

  api.post("/channels", (req, res) => {
    const { name, topic, agentIds } = req.body ?? {};
    res.status(201).json(store.createChannel(String(name ?? ""), String(topic ?? ""), Array.isArray(agentIds) ? agentIds : []));
  });

  api.put("/channels/:id/members", (req, res) => {
    res.json(store.setChannelMembers(req.params.id, Array.isArray(req.body?.agentIds) ? req.body.agentIds : []));
  });

  api.post("/agents", (req, res) => {
    res.status(201).json(store.hireAgent(String(req.body?.templateId ?? ""), req.body?.name));
  });

  api.patch("/agents/:id", (req, res) => {
    const { name, role, instructions, webSearch, voice } = req.body ?? {};
    res.json(store.updateAgent(req.params.id, { name, role, instructions, webSearch, voice }));
  });

  // ---- voices ----------------------------------------------------------------

  api.post("/voices", express.raw({ type: () => true, limit: MAX_SAMPLE_BYTES }), (req, res) => {
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    res.status(201).json(store.addVoice(String(req.query.name ?? ""), String(req.query.file ?? ""), data));
  });

  api.patch("/voices/:id", (req, res) => {
    res.json(store.renameVoice(req.params.id, String(req.body?.name ?? "")));
  });

  api.delete("/voices/:id", (req, res) => {
    store.removeVoice(req.params.id);
    res.status(204).end();
  });

  api.get("/voices/:id/sample", (req, res) => {
    const voice = store.voice(req.params.id);
    if (!voice) return void res.status(404).json({ error: "Voice not found" });
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.sendFile(store.voiceSamples.pathFor(voice));
  });

  api.get("/tts/status", async (_req, res) => {
    res.json(await voiceEngine.status());
  });

  // Speaks text in a custom voice via the local engine. 503 means "use the built-in voice instead".
  api.post("/tts", async (req, res) => {
    const voice = store.voice(String(req.body?.voiceId ?? ""));
    const text = String(req.body?.text ?? "").trim().slice(0, 1000);
    if (!voice) return void res.status(404).json({ error: "Voice not found" });
    if (!text) return void res.status(400).json({ error: "Nothing to say" });
    try {
      const audio = await voiceEngine.speak(text, store.voiceSamples.pathFor(voice));
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Cache-Control", "no-store");
      res.end(audio);
    } catch (err) {
      res.status(err instanceof VoiceEngineDown ? 503 : 502).json({ error: (err as Error).message });
    }
  });

  api.delete("/agents/:id", (req, res) => {
    store.fireAgent(req.params.id);
    res.status(204).end();
  });

  api.post("/tasks", (req, res) => {
    const { title, description, assigneeAgentId, channelId } = req.body ?? {};
    const task = store.createTask({
      title: String(title ?? ""),
      description: String(description ?? ""),
      assigneeAgentId: assigneeAgentId || null,
      channelId: channelId || null,
      createdBy: { kind: "human", id: store.workspace.me.id },
    });
    res.status(201).json(task);
  });

  api.patch("/tasks/:id", (req, res) => {
    const allowed = ["title", "description", "status", "assigneeAgentId", "result"] as const;
    const patch = Object.fromEntries(allowed.filter((k) => k in (req.body ?? {})).map((k) => [k, req.body[k]]));
    res.json(store.updateTask(req.params.id, patch));
  });

  api.post("/tasks/:id/run", (req, res) => {
    void team.startTask(req.params.id);
    res.status(202).json(store.task(req.params.id));
  });

  api.delete("/tasks/:id", (req, res) => {
    store.deleteTask(req.params.id);
    res.status(204).end();
  });

  api.post("/memory", (req, res) => {
    res.status(201).json(store.addMemory(String(req.body?.content ?? ""), { kind: "human", id: store.workspace.me.id }));
  });

  api.delete("/memory/:id", (req, res) => {
    store.deleteMemory(req.params.id);
    res.status(204).end();
  });

  api.post("/reset", (_req, res) => {
    store.reset();
    res.status(204).end();
  });

  api.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(400).json({ error: err.message });
  });

  app.use("/api", api);
  return app;
}
