import type { Agent } from "../shared/types.ts";

/** Returns the agents @mentioned in `text`, in order of first mention, without duplicates. */
export function findMentionedAgents(text: string, agents: Agent[]): Agent[] {
  const found: Agent[] = [];
  const re = /(^|[^\w@])@([A-Za-z0-9_-]+)/g;
  for (const match of text.matchAll(re)) {
    const name = match[2].toLowerCase();
    const agent = agents.find((a) => a.name.toLowerCase() === name);
    if (agent && !found.includes(agent)) found.push(agent);
  }
  return found;
}
