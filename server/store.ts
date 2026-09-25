import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  Agent,
  AgentVoice,
  AuthorKind,
  Channel,
  MemoryItem,
  Message,
  ServerEvent,
  Task,
  TaskStatus,
  Voice,
  Workspace,
} from "../shared/types.ts";
import { GENNY_TEMPLATE_ID, LEGACY_NAMES, findTemplate } from "./templates.ts";
import { UploadStore } from "./uploads.ts";
import { VoiceSamples } from "./voices.ts";
import { DEFAULT_MODEL, EFFORTS, findModel, type Effort } from "../shared/models.ts";

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
    category: genny.category,
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
          `Hi, I'm **${genny.name}** 👋 I help you build your AI team.\n\n` +
          "Tell me what's on your plate this week — a launch, a report, a codebase, outreach — and I'll suggest who to hire, " +
          "set up tasks, and hand work to the right teammates.\n\n" +
          "You can also open **Visit departments** in the sidebar to browse specialists yourself.",
        createdAt: now,
      },
    ],
  };
}

/**
 * Agents hired under the old personal default names (Remy, Wren, …) take their role-based name,
 * unless someone renamed them or the new name is already taken.
 */
export function renameLegacyAgents(ws: Workspace) {
  for (const agent of ws.agents) {
    const legacy = LEGACY_NAMES[agent.templateId];
    const match = legacy && new RegExp(`^${legacy}(\\d*)$`).exec(agent.name);
    if (!match) continue;
    const name = findTemplate(agent.templateId)!.name + match[1];
    if (ws.agents.some((a) => a.name.toLowerCase() === name.toLowerCase())) continue;
    agent.name = name;
    for (const c of ws.channels) if (c.kind === "dm" && c.agentIds[0] === agent.id) c.name = name;
  }
}

/** Keeps each agent's color, disclaimer and notice in step with its template, so theme and wording updates reach hired agents. */
export function syncTemplateNotes(ws: Workspace) {
  for (const agent of ws.agents) {
    const t = findTemplate(agent.templateId);
    if (!t) continue;
    agent.color = t.color;
    agent.category = t.category;
    agent.disclaimer = t.disclaimer;
    agent.notice = t.notice;
  }
}

/** The model used when neither the conversation nor the workspace has picked one. */
export function serverDefaultModel(): string {
  const env = process.env.MIKOPARK_MODEL;
  return env && findModel(env) ? env : DEFAULT_MODEL;
}

/** Sets or clears (null) a model/effort choice after checking it's one we offer. */
function applyModelPatch(target: { model?: string; effort?: Effort }, patch: { model?: string | null; effort?: Effort | null }) {
  if (patch.model !== undefined) {
    if (patch.model !== null && !findModel(patch.model)) throw new Error(`Unknown model ${patch.model}`);
    if (patch.model === null) delete target.model;
    else target.model = patch.model;
  }
  if (patch.effort !== undefined) {
    if (patch.effort !== null && !EFFORTS.some((e) => e.id === patch.effort)) throw new Error(`Unknown effort ${patch.effort}`);
    if (patch.effort === null) delete target.effort;
    else target.effort = patch.effort;
  }
}

export class Store extends EventEmitter {
  private db: DB;
  private saveTimer: NodeJS.Timeout | null = null;

  readonly uploads: UploadStore;
  readonly voiceSamples: VoiceSamples;

  constructor(private file: string | null) {
    super();
    this.setMaxListeners(0);
    this.db = this.load();
    this.uploads = new UploadStore(file ? path.join(path.dirname(file), "uploads") : null);
    this.voiceSamples = new VoiceSamples(file ? path.join(path.dirname(file), "voices") : null);
  }

  private load(): DB {
    if (this.file && fs.existsSync(this.file)) {
      try {
        const db = JSON.parse(fs.readFileSync(this.file, "utf8")) as DB;
        // Workspaces saved before the guide became Benson still carry Genny's fairy avatar.
        const guide = db.workspace.agents.find((a) => a.builtIn);
        if (guide?.avatar === "🧚") guide.avatar = findTemplate(GENNY_TEMPLATE_ID)!.avatar;
        renameLegacyAgents(db.workspace);
        syncTemplateNotes(db.workspace);
        return db;
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
    if (t.id === GENNY_TEMPLATE_ID) {
      const guide = this.workspace.agents.find((a) => a.builtIn)?.name ?? t.name;
      throw new Error(`${guide} is already on your team`);
    }
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
      category: t.category,
      disclaimer: t.disclaimer,
      notice: t.notice,
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

  updateAgent(id: string, patch: Partial<Pick<Agent, "name" | "role" | "instructions" | "webSearch">> & { voice?: AgentVoice | null }): Agent {
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
    if (patch.voice !== undefined) {
      if (patch.voice === null) delete agent.voice;
      else if (patch.voice.kind === "custom" && this.voice(patch.voice.id)) agent.voice = { kind: "custom", id: patch.voice.id };
      else if (patch.voice.kind === "system" && typeof patch.voice.name === "string" && patch.voice.name.trim())
        agent.voice = { kind: "system", name: patch.voice.name.slice(0, 200) };
      else throw new Error("Unknown voice");
    }
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

  // ---- model settings ------------------------------------------------------

  /** The model and effort a conversation uses: its own choice, else the workspace default, else the server default. */
  modelFor(channel: Channel): { model: string; effort?: Effort } {
    const settings = this.workspace.settings ?? {};
    const model = [channel.model, settings.model].find((m) => m && findModel(m)) ?? serverDefaultModel();
    return { model, effort: channel.effort ?? settings.effort };
  }

  setChannelModel(channelId: string, patch: { model?: string | null; effort?: Effort | null }): Channel {
    const channel = this.channel(channelId);
    if (!channel) throw new Error("Channel not found");
    applyModelPatch(channel, patch);
    this.workspaceChanged();
    return channel;
  }

  setDefaultModel(patch: { model?: string | null; effort?: Effort | null }) {
    this.workspace.settings ??= {};
    applyModelPatch(this.workspace.settings, patch);
    this.workspaceChanged();
    return this.workspace.settings;
  }

  clearChannel(channelId: string) {
    if (!this.channel(channelId)) throw new Error("Channel not found");
    this.db.messages = this.db.messages.filter((m) => m.channelId !== channelId);
    this.persist();
    this.emitEvent({ type: "snapshot", workspace: this.workspace, messages: this.snapshotMessages(), mode: "live" });
  }

  // ---- voices ----------------------------------------------------------------

  voice(id: string) {
    return this.workspace.voices?.find((v) => v.id === id);
  }

  addVoice(name: string, fileName: string, data: Buffer): Voice {
    const voice = this.voiceSamples.save(name, fileName, data);
    (this.workspace.voices ??= []).push(voice);
    this.workspaceChanged();
    return voice;
  }

  renameVoice(id: string, name: string): Voice {
    const voice = this.voice(id);
    if (!voice) throw new Error("Voice not found");
    if (!name.trim()) throw new Error("Name is required");
    voice.name = name.trim().slice(0, 60);
    this.workspaceChanged();
    return voice;
  }

  removeVoice(id: string) {
    const voice = this.voice(id);
    if (!voice) return;
    this.workspace.voices = this.workspace.voices!.filter((v) => v.id !== id);
    for (const a of this.workspace.agents) if (a.voice?.kind === "custom" && a.voice.id === id) delete a.voice;
    this.voiceSamples.remove(voice);
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
