import express, { type NextFunction, type Request, type Response } from "express";
import type { ServerEvent } from "../shared/types.ts";
import type { Store } from "./store.ts";
import type { Team } from "./team.ts";
import { TEMPLATES } from "./templates.ts";

export function createApp(store: Store, team: Team) {
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
    send({ type: "snapshot", workspace: store.workspace, messages: store.snapshotMessages(), mode: team.mode });
    const onEvent = (event: ServerEvent) =>
      send(event.type === "snapshot" ? { ...event, mode: team.mode } : event);
    store.on("event", onEvent);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(ping);
      store.off("event", onEvent);
    });
  });

  api.get("/templates", (_req, res) => res.json(TEMPLATES.filter((t) => t.id !== "genny")));

  api.post("/channels/:id/messages", (req, res) => {
    res.status(201).json(team.postHumanMessage(req.params.id, String(req.body?.content ?? "")));
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
    const { name, role, instructions, webSearch } = req.body ?? {};
    res.json(store.updateAgent(req.params.id, { name, role, instructions, webSearch }));
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
