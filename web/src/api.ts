import type { AgentTemplate, TaskStatus } from "../../shared/types.ts";

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? res.statusText);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  templates: () => call<AgentTemplate[]>("GET", "/templates"),
  send: (channelId: string, content: string) => call("POST", `/channels/${channelId}/messages`, { content }),
  createChannel: (name: string, topic: string, agentIds: string[]) =>
    call<{ id: string }>("POST", "/channels", { name, topic, agentIds }),
  setMembers: (channelId: string, agentIds: string[]) => call("PUT", `/channels/${channelId}/members`, { agentIds }),
  hire: (templateId: string) => call<{ id: string }>("POST", "/agents", { templateId }),
  updateAgent: (id: string, patch: { name?: string; role?: string; instructions?: string; webSearch?: boolean }) =>
    call("PATCH", `/agents/${id}`, patch),
  fire: (id: string) => call("DELETE", `/agents/${id}`),
  createTask: (t: { title: string; description: string; assigneeAgentId: string | null }) => call("POST", "/tasks", t),
  updateTask: (id: string, patch: { status?: TaskStatus; assigneeAgentId?: string | null }) => call("PATCH", `/tasks/${id}`, patch),
  runTask: (id: string) => call("POST", `/tasks/${id}/run`),
  deleteTask: (id: string) => call("DELETE", `/tasks/${id}`),
  addMemory: (content: string) => call("POST", "/memory", { content }),
  deleteMemory: (id: string) => call("DELETE", `/memory/${id}`),
  reset: () => call("POST", "/reset"),
};
