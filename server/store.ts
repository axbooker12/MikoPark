import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  Agent,
  AuthorKind,
  Channel,
  MemoryItem,
  Message,
  ServerEvent,
  Task,
  TaskStatus,
  Workspace,
} from "../shared/types.ts";
import { GENNY_TEMPLATE_ID, findTemplate } from "./templates.ts";

interface DB {
  workspace: Workspace;
  messages: Message[];
}

export const newId = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;

function seed(): DB {
  const me = { id: "u_me", name: "You", avatar: "🙂" };
  const genny = findTemplate(GENNY_TEMPLATE_ID)!;
  const gennyAgent: Agent = {
    id: "a_genny",
    templateId: genny.id,
    name: genny.name,
    role: genny.role,
    avatar: genny.avatar,
    color: genny.color,
    instructions: genny.instructions,
    webSearch: genny.webSearch,
    builtIn: true,
    hiredAt: Date.now(),
  };
  const now = Date.now();
  const general: Channel = {
    id: "c_general",
    name: "general",
    topic: "Team-wide chat. @mention an agent to get its attention.",
    kind: "channel",
    humanIds: [me.id],
    agentIds: [gennyAgent.id],
    createdAt: now,
  };
  const gennyDm: Channel = {
    id: "c_dm_genny",
    name: gennyAgent.name,
    topic: "",
    kind: "dm",
    humanIds: [me.id],
    agentIds: [gennyAgent.id],
    createdAt: now,
  };
  return {
    workspace: {
      name: "MikoPark",
      me,
      humans: [me],
      agents: [gennyAgent],
      channels: [general, gennyDm],
      tasks: [],
      memory: [],
    },
    messages: [
      {
        id: newId("m"),
        channelId: gennyDm.id,
        authorKind: "agent",
        authorId: gennyAgent.id,
        content:
          "Hi, I'm **Genny** 👋 I help you build your AI team.\n\n" +
          "Tell me what's on your plate this week — a launch, a report, a codebase, outreach — and I'll suggest who to hire, " +
          "set up tasks, and hand work to the right teammates.\n\n" +
          "You can also open **Hire agents** in the sidebar to browse the marketplace yourself.",
        createdAt: now,
      },
    ],
  };
}

export class Store extends EventEmitter {
  private db: DB;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private file: string | null) {
    super();
    this.setMaxListeners(0);
    this.db = this.load();
  }

  private load(): DB {
    if (this.file && fs.existsSync(this.file)) {
      try {
        return JSON.parse(fs.readFileSync(this.file, "utf8")) as DB;
      } catch (err) {
        console.warn(`Could not read ${this.file}, starting fresh:`, err);
      }
    }
    return seed();
  }

  private persist() {
    if (!this.file) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      fs.mkdirSync(path.dirname(this.file!), { recursive: true });
      const clean: DB = {
        ...this.db,
        messages: this.db.messages.map((m) => ({ ...m, streaming: false, status: undefined })),
      };
      fs.writeFileSync(this.file!, JSON.stringify(clean, null, 2));
    }, 250);
  }

  emitEvent(event: ServerEvent) {
    this.emit("event", event);
  }

  private workspaceChanged() {
    this.persist();
    this.emitEvent({ type: "workspace", workspace: this.workspace });
  }

  get workspace(): Workspace {
    return this.db.workspace;
  }

  snapshotMessages(): Record<string, Message[]> {
    const out: Record<string, Message[]> = {};
    for (const m of this.db.messages) (out[m.channelId] ??= []).push(m);
    return out;
  }

  reset() {
    this.db = seed();
    this.persist();
    this.emitEvent({ type: "snapshot", workspace: this.workspace, messages: this.snapshotMessages(), mode: "live" });
  }

  // ---- lookups -------------------------------------------------------------

  agent(id: string) {
    return this.workspace.agents.find((a) => a.id === id);
  }
  channel(id: string) {
    return this.workspace.channels.find((c) => c.id === id);
  }
  task(id: string) {
    return this.workspace.tasks.find((t) => t.id === id);
  }
  authorName(kind: AuthorKind, id: string): string {
    if (kind === "agent") return this.agent(id)?.name ?? "Former agent";
    if (kind === "human") return this.workspace.humans.find((h) => h.id === id)?.name ?? "Someone";
    return "System";
  }
  channelMessages(channelId: string, limit = 40): Message[] {
    return this.db.messages.filter((m) => m.channelId === channelId).slice(-limit);
  }

  // ---- messages ------------------------------------------------------------

  addMessage(input: Omit<Message, "id" | "createdAt">): Message {
    const message: Message = { ...input, id: newId("m"), createdAt: Date.now() };
    this.db.messages.push(message);
    this.persist();
    this.emitEvent({ type: "message", message });
    return message;
  }

  appendToMessage(messageId: string, delta: string) {
    const m = this.db.messages.find((x) => x.id === messageId);
    if (!m) return;
    m.content += delta;
    this.emitEvent({ type: "message_delta", channelId: m.channelId, messageId, delta });
  }

  setMessageStatus(messageId: string, status: string | null) {
    const m = this.db.messages.find((x) => x.id === messageId);
    if (!m) return;
    m.status = status ?? undefined;
    this.emitEvent({ type: "message_status", channelId: m.channelId, messageId, status });
  }

  finishMessage(messageId: string, patch: Partial<Message> = {}) {
    const m = this.db.messages.find((x) => x.id === messageId);
    if (!m) return;
    Object.assign(m, patch, { streaming: false, status: undefined });
    this.persist();
    this.emitEvent({ type: "message", message: m });
  }

  // ---- agents --------------------------------------------------------------

  hireAgent(templateId: string, customName?: string): Agent {
    const t = findTemplate(templateId);
    if (!t) throw new Error(`Unknown template "${templateId}"`);
    if (t.id === GENNY_TEMPLATE_ID) throw new Error("Genny is already on your team");
    const taken = new Set(this.workspace.agents.map((a) => a.name.toLowerCase()));
    let name = (customName?.trim() || t.name).replace(/\s+/g, "");
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${t.name}${i}`;

    const agent: Agent = {
      id: newId("a"),
      templateId: t.id,
      name,
      role: t.role,
      avatar: t.avatar,
      color: t.color,
      instructions: t.instructions,
      webSearch: t.webSearch,
      hiredAt: Date.now(),
    };
    this.workspace.agents.push(agent);
    const me = this.workspace.me.id;
    this.workspace.channels.push({
      id: newId("c"),
      name: agent.name,
      topic: "",
      kind: "dm",
      humanIds: [me],
      agentIds: [agent.id],
      createdAt: Date.now(),
    });
    const general = this.workspace.channels.find((c) => c.id === "c_general");
    if (general && !general.agentIds.includes(agent.id)) general.agentIds.push(agent.id);
    this.workspaceChanged();
    return agent;
  }

  updateAgent(id: string, patch: Partial<Pick<Agent, "name" | "role" | "instructions" | "webSearch">>): Agent {
    const agent = this.agent(id);
    if (!agent) throw new Error("Agent not found");
    if (patch.name !== undefined) {
      const name = patch.name.trim().replace(/\s+/g, "");
      if (!name) throw new Error("Name is required");
      const clash = this.workspace.agents.some((a) => a.id !== id && a.name.toLowerCase() === name.toLowerCase());
      if (clash) throw new Error(`Another teammate is already called ${name}`);
      agent.name = name;
      for (const c of this.workspace.channels) if (c.kind === "dm" && c.agentIds[0] === id) c.name = name;
    }
    if (patch.role !== undefined) agent.role = patch.role;
    if (patch.instructions !== undefined) agent.instructions = patch.instructions;
    if (patch.webSearch !== undefined) agent.webSearch = patch.webSearch;
    this.workspaceChanged();
    return agent;
  }

  fireAgent(id: string) {
    const agent = this.agent(id);
    if (!agent) throw new Error("Agent not found");
    if (agent.builtIn) throw new Error(`${agent.name} is built in and can't be removed`);
    const ws = this.workspace;
    ws.agents = ws.agents.filter((a) => a.id !== id);
    const dmIds = new Set(ws.channels.filter((c) => c.kind === "dm" && c.agentIds.includes(id)).map((c) => c.id));
    ws.channels = ws.channels.filter((c) => !dmIds.has(c.id));
    for (const c of ws.channels) c.agentIds = c.agentIds.filter((a) => a !== id);
    for (const t of ws.tasks) if (t.assigneeAgentId === id) t.assigneeAgentId = null;
    this.db.messages = this.db.messages.filter((m) => !dmIds.has(m.channelId));
    this.workspaceChanged();
  }

  // ---- channels ------------------------------------------------------------

  createChannel(name: string, topic: string, agentIds: string[]): Channel {
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "");
    if (!slug) throw new Error("Channel name is required");
    if (this.workspace.channels.some((c) => c.kind === "channel" && c.name === slug)) {
      throw new Error(`#${slug} already exists`);
    }
    const channel: Channel = {
      id: newId("c"),
      name: slug,
      topic,
      kind: "channel",
      humanIds: [this.workspace.me.id],
      agentIds: agentIds.filter((id) => this.agent(id)),
      createdAt: Date.now(),
    };
    this.workspace.channels.push(channel);
    this.workspaceChanged();
    return channel;
  }

  setChannelMembers(channelId: string, agentIds: string[]): Channel {
    const channel = this.channel(channelId);
    if (!channel) throw new Error("Channel not found");
    if (channel.kind === "dm") throw new Error("Direct messages have fixed members");
    channel.agentIds = agentIds.filter((id) => this.agent(id));
    this.workspaceChanged();
    return channel;
  }

  // ---- tasks ---------------------------------------------------------------

  createTask(input: {
    title: string;
    description?: string;
    assigneeAgentId?: string | null;
    channelId?: string | null;
    createdBy: { kind: AuthorKind; id: string };
  }): Task {
    if (!input.title.trim()) throw new Error("Task title is required");
    const now = Date.now();
    const task: Task = {
      id: newId("t"),
      title: input.title.trim(),
      description: input.description?.trim() ?? "",
      status: "todo",
      assigneeAgentId: input.assigneeAgentId && this.agent(input.assigneeAgentId) ? input.assigneeAgentId : null,
      channelId: input.channelId ?? null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    this.workspace.tasks.push(task);
    this.workspaceChanged();
    return task;
  }

  updateTask(
    id: string,
    patch: Partial<{ title: string; description: string; status: TaskStatus; assigneeAgentId: string | null; result: string; channelId: string | null }>,
  ): Task {
    const task = this.task(id);
    if (!task) throw new Error("Task not found");
    Object.assign(task, patch, { updatedAt: Date.now() });
    this.workspaceChanged();
    return task;
  }

  deleteTask(id: string) {
    this.workspace.tasks = this.workspace.tasks.filter((t) => t.id !== id);
    this.workspaceChanged();
  }

  // ---- shared memory -------------------------------------------------------

  addMemory(content: string, source: { kind: AuthorKind; id: string }): MemoryItem {
    if (!content.trim()) throw new Error("Memory can't be empty");
    const item: MemoryItem = { id: newId("mem"), content: content.trim(), source, createdAt: Date.now() };
    this.workspace.memory.push(item);
    this.workspaceChanged();
    return item;
  }

  deleteMemory(id: string) {
    this.workspace.memory = this.workspace.memory.filter((m) => m.id !== id);
    this.workspaceChanged();
  }
}
