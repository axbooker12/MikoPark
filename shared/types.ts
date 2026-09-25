// Types shared by the server and the web client.

export type AuthorKind = "human" | "agent" | "system";

export interface Human {
  id: string;
  name: string;
  avatar: string; // emoji
}

export interface Agent {
  id: string;
  templateId: string;
  name: string;
  role: string;
  avatar: string; // emoji
  color: string;
  instructions: string;
  webSearch: boolean;
  builtIn?: boolean; // Genny — cannot be fired
  hiredAt: number;
}

export interface Channel {
  id: string;
  name: string;
  topic: string;
  kind: "channel" | "dm";
  humanIds: string[];
  agentIds: string[];
  createdAt: number;
}

export interface Message {
  id: string;
  channelId: string;
  authorKind: AuthorKind;
  authorId: string;
  content: string;
  createdAt: number;
  streaming?: boolean;
  status?: string; // e.g. "Searching the web…" while an agent works
  error?: boolean;
}

export type TaskStatus = "todo" | "in_progress" | "review" | "done";

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  assigneeAgentId: string | null;
  channelId: string | null;
  createdBy: { kind: AuthorKind; id: string };
  result?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryItem {
  id: string;
  content: string;
  source: { kind: AuthorKind; id: string };
  createdAt: number;
}

export interface AgentTemplate {
  id: string;
  name: string;
  role: string;
  avatar: string;
  color: string;
  category: string;
  tagline: string;
  skills: string[];
  instructions: string;
  webSearch: boolean;
}

export interface Workspace {
  name: string;
  me: Human;
  humans: Human[];
  agents: Agent[];
  channels: Channel[];
  tasks: Task[];
  memory: MemoryItem[];
}

export type ServerEvent =
  | { type: "snapshot"; workspace: Workspace; messages: Record<string, Message[]>; mode: "live" | "demo" }
  | { type: "message"; message: Message }
  | { type: "message_delta"; channelId: string; messageId: string; delta: string }
  | { type: "message_status"; channelId: string; messageId: string; status: string | null }
  | { type: "typing"; channelId: string; agentId: string; typing: boolean }
  | { type: "workspace"; workspace: Workspace };
