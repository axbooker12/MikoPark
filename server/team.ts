import type { Agent, Channel } from "../shared/types.ts";
import type { Brain } from "./brain.ts";
import { findMentionedAgents } from "./mentions.ts";
import type { Store } from "./store.ts";

/** How many agent→agent @mention hops one human message may set off. */
export const MAX_HANDOFF_DEPTH = 3;

/**
 * Routes messages to agents. In a DM the agent always replies; in a channel only
 * @mentioned agents reply (and a mentioned agent who isn't a member is added).
 * An agent's reply can @mention teammates, which hands the conversation on.
 */
export class Team {
  private queues = new Map<string, Promise<void>>();

  constructor(
    private store: Store,
    private brain: Brain,
  ) {}

  get mode() {
    return this.brain.mode;
  }

  postHumanMessage(channelId: string, content: string) {
    const channel = this.store.channel(channelId);
    if (!channel) throw new Error("Channel not found");
    if (!content.trim()) throw new Error("Message is empty");
    const message = this.store.addMessage({
      channelId,
      authorKind: "human",
      authorId: this.store.workspace.me.id,
      content: content.trim(),
    });
    for (const agent of this.responders(channel, content)) this.schedule(agent, channel, 0);
    return message;
  }

  /** Runs a task: the assignee works on it in the task's channel (or their DM) and posts the deliverable. */
  startTask(taskId: string) {
    const task = this.store.task(taskId);
    if (!task) throw new Error("Task not found");
    const agent = task.assigneeAgentId ? this.store.agent(task.assigneeAgentId) : undefined;
    if (!agent) throw new Error("Assign the task to an agent first");
    const channel = (task.channelId && this.store.channel(task.channelId)) || this.dmFor(agent);
    if (!channel) throw new Error("No channel to work in");
    if (channel.kind === "channel" && !channel.agentIds.includes(agent.id)) {
      this.store.setChannelMembers(channel.id, [...channel.agentIds, agent.id]);
    }
    this.store.updateTask(task.id, { status: "in_progress", channelId: channel.id });
    this.store.addMessage({
      channelId: channel.id,
      authorKind: "system",
      authorId: "system",
      content: `📋 **${agent.name}** started task **${task.title}**`,
    });
    const brief =
      `You've been assigned task ${task.id}: "${task.title}".` +
      (task.description ? `\nDetails: ${task.description}` : "") +
      `\nDo the work now and post the finished deliverable in this reply. When you're done, call update_task with status "review" and a one-line result.`;
    return this.schedule(agent, channel, 0, brief).then(() => {
      const t = this.store.task(task.id);
      if (t && t.status === "in_progress") {
        const last = this.store.channelMessages(channel.id).filter((m) => m.authorId === agent.id).at(-1);
        this.store.updateTask(t.id, { status: "review", result: t.result ?? last?.content.slice(0, 200) });
      }
    });
  }

  /** Waits for every queued agent turn to finish (used by tests and graceful shutdown). */
  async idle() {
    while (this.queues.size) await Promise.all([...this.queues.values()]);
  }

  private dmFor(agent: Agent) {
    return this.store.workspace.channels.find((c) => c.kind === "dm" && c.agentIds[0] === agent.id);
  }

  private responders(channel: Channel, content: string): Agent[] {
    const agents = this.store.workspace.agents;
    if (channel.kind === "dm") return channel.agentIds.map((id) => this.store.agent(id)).filter((a): a is Agent => !!a);
    const mentioned = findMentionedAgents(content, agents);
    const newcomers = mentioned.filter((a) => !channel.agentIds.includes(a.id));
    if (newcomers.length) this.store.setChannelMembers(channel.id, [...channel.agentIds, ...newcomers.map((a) => a.id)]);
    return mentioned;
  }

  /** Serialises turns per agent so one agent never writes two replies at once. */
  private schedule(agent: Agent, channel: Channel, depth: number, extra?: string): Promise<void> {
    const prev = this.queues.get(agent.id) ?? Promise.resolve();
    const next = prev
      .then(() => this.turn(agent.id, channel.id, depth, extra))
      .catch((err) => console.error(`[${agent.name}]`, err));
    this.queues.set(agent.id, next);
    next.finally(() => {
      if (this.queues.get(agent.id) === next) this.queues.delete(agent.id);
    });
    return next;
  }

  private async turn(agentId: string, channelId: string, depth: number, extra?: string) {
    const agent = this.store.agent(agentId);
    const channel = this.store.channel(channelId);
    if (!agent || !channel) return;

    const msg = this.store.addMessage({ channelId, authorKind: "agent", authorId: agent.id, content: "", streaming: true });
    try {
      await this.brain.reply(agent, channel, {
        delta: (text) => this.store.appendToMessage(msg.id, text),
        status: (status) => this.store.setMessageStatus(msg.id, status),
      }, extra);
      this.store.finishMessage(msg.id);
    } catch (err) {
      console.error(`[${agent.name}] turn failed:`, err);
      const current = this.store.channelMessages(channelId, 1000).find((m) => m.id === msg.id);
      const note = `⚠️ ${agent.name} hit an error: ${(err as Error).message}`;
      this.store.finishMessage(msg.id, { content: current?.content ? `${current.content}\n\n${note}` : note, error: true });
      return;
    }

    // Hand-offs: teammates this agent @mentioned get a turn next.
    if (depth + 1 > MAX_HANDOFF_DEPTH) return;
    const reply = this.store.channelMessages(channelId, 1000).find((m) => m.id === msg.id)?.content ?? "";
    const others = findMentionedAgents(reply, this.store.workspace.agents).filter((a) => a.id !== agent.id);
    if (!others.length) return;
    const fresh = this.store.channel(channelId)!;
    if (fresh.kind === "channel") {
      const add = others.filter((a) => !fresh.agentIds.includes(a.id)).map((a) => a.id);
      if (add.length) this.store.setChannelMembers(fresh.id, [...fresh.agentIds, ...add]);
    } else {
      // DMs are one-to-one, so @mentions there don't pull teammates in.
      return;
    }
    for (const other of others) this.schedule(other, fresh, depth + 1);
  }
}
