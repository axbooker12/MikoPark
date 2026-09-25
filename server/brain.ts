import Anthropic from "@anthropic-ai/sdk";
import type { Agent, Channel } from "../shared/types.ts";
import type { Store } from "./store.ts";
import { FOLLOW_UP_PREFIX, MAX_REPLY_PARAGRAPHS } from "../shared/followup.ts";
import { TEMPLATES } from "./templates.ts";

type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaToolUnion = Anthropic.Beta.Messages.BetaToolUnion;
type BetaContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type BetaToolResultBlockParam = Anthropic.Beta.Messages.BetaToolResultBlockParam;

export interface TurnSink {
  delta(text: string): void;
  status(status: string | null): void;
}

export interface Brain {
  readonly mode: "live" | "demo";
  /** Produce one agent reply in `channel`; `extra` is an additional instruction (e.g. a task brief). */
  reply(agent: Agent, channel: Channel, sink: TurnSink, extra?: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Prompt construction (shared by live mode and tests)
// ---------------------------------------------------------------------------

export function systemPrompt(store: Store, agent: Agent, channel: Channel): { stable: string; context: string } {
  const ws = store.workspace;
  const stable = [
    `You are ${agent.name}, the ${agent.role} on the "${ws.name}" team — a workspace where humans and AI agents work together in chat.`,
    agent.instructions,
    "",
    "How this workspace works:",
    "- Messages from others arrive prefixed with the author's name in brackets, e.g. \"[Alex]: …\". Never add such a prefix to your own replies.",
    "- To hand work to a teammate or ask them something, @mention them by name (e.g. @Kai) in your reply; they'll pick it up after you finish. Only mention a teammate when you actually need them to act, and never mention yourself.",
    "- Use create_task / update_task to keep the shared task board accurate, and save_memory for durable facts the whole team should remember (preferences, decisions, brand voice). Don't save trivia.",
    "- Deliver finished work (the draft, the table, the code) rather than describing what you would do. Use markdown.",
    "",
    "Reply length and format (this applies to every chat reply):",
    `- Keep each reply to ${MAX_REPLY_PARAGRAPHS} short paragraphs at most; two is usually enough. A list or table counts as a paragraph, and a list has at most 5 items.`,
    "- Lead with the answer. Don't restate the question, and don't end with a recap.",
    "- If the latest message is from a human and asks you a question, end your reply with a line of its own that reads exactly:",
    `  ${FOLLOW_UP_PREFIX} <the specific subtopic you'd expand on>?`,
    `  For example: "${FOLLOW_UP_PREFIX} pricing for the top 3 competitors?". Name one concrete subtopic, not the whole question. Leave the line out when you weren't asked a question.`,
    "- If they reply asking for more information, go deeper on that subtopic, still within the same length limit.",
  ].join("\n");

  const teammates = ws.agents
    .filter((a) => a.id !== agent.id)
    .map((a) => `- @${a.name} — ${a.role}${channel.agentIds.includes(a.id) ? " (in this conversation)" : ""}`);
  const humans = ws.humans.map((h) => `- ${h.name}`);
  const openTasks = ws.tasks
    .filter((t) => t.status !== "done")
    .map((t) => {
      const who = t.assigneeAgentId ? store.agent(t.assigneeAgentId)?.name ?? "unassigned" : "unassigned";
      return `- [${t.id}] ${t.title} — ${t.status}, ${who}`;
    });
  const memory = ws.memory.map((m) => `- ${m.content}`);
  const where =
    channel.kind === "dm"
      ? "You are in a direct message with a human teammate. Teammates can't see DMs, so @mentions here won't reach them — use create_task to hand off work instead."
      : `You are in the #${channel.name} channel${channel.topic ? ` (topic: ${channel.topic})` : ""}.`;

  const context = [
    where,
    "",
    "Humans on the team:",
    ...humans,
    "",
    "AI teammates:",
    ...(teammates.length ? teammates : [`- (none yet — ${ws.agents.find((a) => a.builtIn)?.name ?? "the guide"} can hire some)`]),
    "",
    "Shared team memory:",
    ...(memory.length ? memory : ["- (empty)"]),
    "",
    "Open tasks:",
    ...(openTasks.length ? openTasks : ["- (none)"]),
  ].join("\n");
  return { stable, context };
}

/** Converts channel history into alternating user/assistant turns from `agent`'s point of view. */
export function historyFor(store: Store, agent: Agent, channel: Channel, extra?: string): BetaMessageParam[] {
  const turns: { role: "user" | "assistant"; text: string }[] = [];
  for (const m of store.channelMessages(channel.id)) {
    if (m.streaming || !m.content.trim()) continue;
    const mine = m.authorKind === "agent" && m.authorId === agent.id;
    const text = mine ? m.content : `[${store.authorName(m.authorKind, m.authorId)}]: ${m.content}`;
    const role = mine ? "assistant" : "user";
    const last = turns.at(-1);
    if (last && last.role === role) last.text += `\n\n${text}`;
    else turns.push({ role, text });
  }
  if (extra) {
    const last = turns.at(-1);
    if (last && last.role === "user") last.text += `\n\n${extra}`;
    else turns.push({ role: "user", text: extra });
  }
  if (turns[0]?.role === "assistant") turns.unshift({ role: "user", text: "(conversation start)" });
  if (turns.length === 0 || turns.at(-1)!.role === "assistant") {
    turns.push({ role: "user", text: "(Continue — reply to the conversation above.)" });
  }
  return turns.map((t) => ({ role: t.role, content: t.text }));
}

// ---------------------------------------------------------------------------
// Workspace tools the agents can call
// ---------------------------------------------------------------------------

const TOOLS: Anthropic.Beta.Messages.BetaTool[] = [
  {
    name: "create_task",
    description: "Add a task to the team's shared task board, optionally assigning it to an AI teammate by name.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short imperative title" },
        description: { type: "string", description: "What done looks like" },
        assignee: { type: "string", description: "Name of the AI teammate to assign, e.g. Kai. Omit to leave unassigned." },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "update_task",
    description: "Update a task on the board: change its status, reassign it, or record a one-line result summary.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        status: { type: "string", enum: ["todo", "in_progress", "review", "done"] },
        assignee: { type: "string", description: "Teammate name to reassign to" },
        result: { type: "string", description: "One-line summary of the outcome" },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
  {
    name: "save_memory",
    description: "Save a durable fact to the team's shared memory so every teammate can use it later.",
    input_schema: {
      type: "object",
      properties: { fact: { type: "string" } },
      required: ["fact"],
      additionalProperties: false,
    },
  },
];

const HIRING_TOOLS: Anthropic.Beta.Messages.BetaTool[] = [
  {
    name: "list_marketplace",
    description: "List the agent roles available to hire from the marketplace.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "hire_agent",
    description: "Hire an agent from the marketplace onto the team. Only do this when the human has agreed to the hire.",
    input_schema: {
      type: "object",
      properties: {
        template_id: { type: "string", description: "Marketplace id from list_marketplace" },
        name: { type: "string", description: "Optional custom name (single word)" },
      },
      required: ["template_id"],
      additionalProperties: false,
    },
  },
];

const TOOL_STATUS: Record<string, string> = {
  create_task: "Adding a task…",
  update_task: "Updating the task board…",
  save_memory: "Saving to team memory…",
  list_marketplace: "Browsing the marketplace…",
  hire_agent: "Hiring a teammate…",
  web_search: "Searching the web…",
  web_fetch: "Reading a page…",
};

function agentByName(store: Store, name: unknown) {
  if (typeof name !== "string") return undefined;
  const n = name.replace(/^@/, "").toLowerCase();
  return store.workspace.agents.find((a) => a.name.toLowerCase() === n);
}

export function runTool(store: Store, agent: Agent, channel: Channel, name: string, input: Record<string, unknown>): string {
  const by = { kind: "agent" as const, id: agent.id };
  switch (name) {
    case "create_task": {
      const assignee = agentByName(store, input.assignee);
      if (input.assignee && !assignee) return `No teammate named ${String(input.assignee)}. Task not created.`;
      const t = store.createTask({
        title: String(input.title ?? ""),
        description: typeof input.description === "string" ? input.description : "",
        assigneeAgentId: assignee?.id ?? null,
        channelId: channel.id,
        createdBy: by,
      });
      return `Created task ${t.id}${assignee ? ` assigned to ${assignee.name}` : ""}.`;
    }
    case "update_task": {
      const id = String(input.task_id ?? "");
      if (!store.task(id)) return `No task with id ${id}.`;
      const patch: Parameters<Store["updateTask"]>[1] = {};
      if (typeof input.status === "string") patch.status = input.status as never;
      if (typeof input.result === "string") patch.result = input.result;
      if (input.assignee !== undefined) {
        const a = agentByName(store, input.assignee);
        if (!a) return `No teammate named ${String(input.assignee)}.`;
        patch.assigneeAgentId = a.id;
      }
      store.updateTask(id, patch);
      return `Task ${id} updated.`;
    }
    case "save_memory":
      store.addMemory(String(input.fact ?? ""), by);
      return "Saved to shared memory.";
    case "list_marketplace":
      return TEMPLATES.filter((t) => t.id !== "genny")
        .map((t) => `${t.id}: ${t.name}, ${t.role} — ${t.tagline}`)
        .join("\n");
    case "hire_agent": {
      const hired = store.hireAgent(String(input.template_id ?? ""), typeof input.name === "string" ? input.name : undefined);
      if (channel.kind === "channel" && !channel.agentIds.includes(hired.id)) {
        store.setChannelMembers(channel.id, [...channel.agentIds, hired.id]);
      }
      return `Hired ${hired.name} (${hired.role}). Mention them as @${hired.name}.`;
    }
    default:
      return `Unknown tool ${name}`;
  }
}

// ---------------------------------------------------------------------------
// Live brain — Claude via the Anthropic SDK
// ---------------------------------------------------------------------------

const MAX_ITERATIONS = 10;

export class ClaudeBrain implements Brain {
  readonly mode = "live" as const;
  private client = new Anthropic();

  constructor(
    private store: Store,
    private model = process.env.MIKOPARK_MODEL || "claude-opus-5",
  ) {}

  async reply(agent: Agent, channel: Channel, sink: TurnSink, extra?: string): Promise<void> {
    const { stable, context } = systemPrompt(this.store, agent, channel);
    const tools: BetaToolUnion[] = [...TOOLS];
    if (agent.builtIn) tools.push(...HIRING_TOOLS);
    if (agent.webSearch) tools.push({ type: "web_search_20260209", name: "web_search", max_uses: 5 });

    const messages = historyFor(this.store, agent, channel, extra);
    let wroteText = false;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const stream = this.client.beta.messages.stream({
        model: this.model,
        max_tokens: 64000,
        thinking: { type: "adaptive" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: [
          { type: "text", text: stable, cache_control: { type: "ephemeral" } },
          { type: "text", text: context },
        ],
        tools,
        messages,
      });

      stream.on("streamEvent", (event) => {
        if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block.type === "tool_use" || block.type === "server_tool_use") {
            sink.status(TOOL_STATUS[block.name] ?? `Using ${block.name}…`);
          } else if (block.type === "thinking") {
            sink.status("Thinking…");
          } else if (block.type === "text") {
            sink.status(null);
            if (wroteText) sink.delta("\n\n");
          }
        } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          wroteText = true;
          sink.delta(event.delta.text);
        }
      });

      const response = await stream.finalMessage();

      if (response.stop_reason === "refusal") {
        sink.delta(`${wroteText ? "\n\n" : ""}_I can't help with that request._`);
        return;
      }
      if (response.stop_reason === "max_tokens") {
        sink.delta("\n\n_(Reply cut off — it hit the length limit.)_");
        return;
      }

      // Echo the assistant turn back unchanged (keeps thinking and server-tool blocks intact).
      messages.push({ role: "assistant", content: response.content as unknown as BetaContentBlockParam[] });

      if (response.stop_reason === "pause_turn") continue;
      if (response.stop_reason !== "tool_use") return;

      const results: BetaToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        try {
          const content = runTool(this.store, agent, channel, block.name, (block.input ?? {}) as Record<string, unknown>);
          results.push({ type: "tool_result", tool_use_id: block.id, content });
        } catch (err) {
          results.push({ type: "tool_result", tool_use_id: block.id, content: (err as Error).message, is_error: true });
        }
      }
      messages.push({ role: "user", content: results });
    }
    sink.delta("\n\n_(Stopped after too many steps.)_");
  }
}

// ---------------------------------------------------------------------------
// Demo brain — scripted replies so the app is usable without an API key
// ---------------------------------------------------------------------------

const KEYWORDS: Record<string, string[]> = {
  researcher: ["research", "competitor", "market", "find", "sources", "analysis"],
  writer: ["blog", "copy", "write", "email", "post", "newsletter", "launch"],
  analyst: ["data", "metrics", "spreadsheet", "numbers", "revenue", "forecast"],
  engineer: ["code", "bug", "api", "app", "website", "build", "deploy"],
  designer: ["design", "deck", "slides", "ux", "wireframe", "landing"],
  pm: ["plan", "project", "roadmap", "tasks", "deadline", "organize"],
  sales: ["sales", "outreach", "leads", "prospect", "customers", "pitch"],
};

export class DemoBrain implements Brain {
  readonly mode = "demo" as const;
  constructor(
    private store: Store,
    private delayMs = 18,
  ) {}

  async reply(agent: Agent, channel: Channel, sink: TurnSink, extra?: string): Promise<void> {
    const last = [...this.store.channelMessages(channel.id)].reverse().find((m) => m.authorKind !== "agent" || m.authorId !== agent.id);
    const prompt = (extra ?? last?.content ?? "").trim();
    sink.status("Thinking…");
    await sleep(this.delayMs * 20);
    sink.status(null);
    for (const word of this.compose(agent, prompt, !!extra).split(/(\s+)/)) {
      sink.delta(word);
      if (this.delayMs) await sleep(this.delayMs);
    }
  }

  private compose(agent: Agent, prompt: string, isTask: boolean): string {
    const snippet = prompt.replace(/\s+/g, " ").slice(0, 140);
    const footer =
      "\n\n> 💡 _MikoPark is in **demo mode**, so this is a scripted reply. Set `ANTHROPIC_API_KEY` and restart the server to put real agents to work._";

    if (agent.builtIn && !isTask) {
      const lower = prompt.toLowerCase();
      const hired = new Set(this.store.workspace.agents.map((a) => a.templateId));
      const picks = TEMPLATES.filter((t) => KEYWORDS[t.id]?.some((k) => lower.includes(k)) && !hired.has(t.id));
      if (picks.length) {
        return (
          `Sounds like a job for a few specialists. I'd hire:\n\n` +
          picks.map((t) => `- ${t.avatar} **${t.name}**, ${t.role}: ${t.tagline}`).join("\n") +
          `\n\nOpen **Hire agents** in the sidebar to add them, then @mention them here and I'll help coordinate.` +
          footer
        );
      }
      return (
        `Got it: _"${snippet}"_.\n\nTell me a bit more about the outcome you want (a deck, a report, working code, outreach), ` +
        `and I'll suggest the right teammates and break it into tasks.` +
        footer
      );
    }

    if (isTask) {
      return (
        `On it. Here's my deliverable for this task.\n\n` +
        `### Plan\n1. Clarify the goal and constraints\n2. Gather the inputs I need\n3. Produce the ${agent.role.toLowerCase()} deliverable\n4. Hand off for review\n\n` +
        `### Draft\n_Real output appears here in live mode._` +
        footer
      );
    }

    return (
      `Hi! I'm ${agent.name}, your ${agent.role}. You asked: _"${snippet}"_\n\n` +
      `Here's how I'd approach it:\n1. Confirm what "done" looks like\n2. Do the ${agent.role.toLowerCase()} work end to end\n3. Post the finished result here for you to review` +
      footer +
      (prompt.includes("?") ? `\n\n${FOLLOW_UP_PREFIX} how I'd approach this step by step?` : "")
    );
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createBrain(store: Store): Brain {
  const demo =
    process.env.MIKOPARK_DEMO === "1" || (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN && process.env.MIKOPARK_DEMO !== "0");
  return demo ? new DemoBrain(store) : new ClaudeBrain(store);
}
