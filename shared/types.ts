// Types shared by the server and the web client.
import type { Effort } from "./models.ts";

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
  builtIn?: boolean; // the onboarding guide (Benson by default) — cannot be fired
  category?: string; // department, from its template
  disclaimer?: string; // shown under each of this agent's messages (from its template)
  notice?: string; // shown at the top of conversations this agent is in (from its template)
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
  model?: string; // overrides the workspace default for this conversation
  effort?: Effort;
}

export type AttachmentKind = "image" | "pdf" | "text" | "other";

export interface Attachment {
  id: string;
  name: string;
  type: string; // MIME type
  size: number;
  kind: AttachmentKind;
  path?: string; // relative path when uploaded as part of a folder
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
  attachments?: Attachment[];
  model?: string; // model that wrote an agent message
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
  category: Category | typeof LEADERSHIP;
  tagline: string;
  skills: string[];
  instructions: string;
  webSearch: boolean;
  disclaimer?: string;
  notice?: string;
}

/** Marketplace categories, in display order. A category shows up once it has at least one agent. */
export const CATEGORIES = [
  "Marketing",
  "Sales",
  "Finance",
  "Legal",
  "Operations",
  "Research & Analytics",
  "Engineering",
  "Design",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Department for the built-in guide; it isn't hireable, so it isn't in CATEGORIES. */
export const LEADERSHIP = "Leadership";

export const DEPARTMENT_ICONS: Record<string, string> = {
  Leadership: "🎩",
  Marketing: "📣",
  Sales: "🤝",
  Finance: "💰",
  Legal: "⚖️",
  Operations: "⚙️",
  "Research & Analytics": "🔬",
  Engineering: "🛠️",
  Design: "🎨",
};

export interface Workspace {
  name: string;
  me: Human;
  humans: Human[];
  agents: Agent[];
  channels: Channel[];
  tasks: Task[];
  memory: MemoryItem[];
  settings?: { model?: string; effort?: Effort };
}

export type ServerEvent =
  | { type: "snapshot"; workspace: Workspace; messages: Record<string, Message[]>; mode: "live" | "demo"; defaultModel?: string }
  | { type: "message"; message: Message }
  | { type: "message_delta"; channelId: string; messageId: string; delta: string }
  | { type: "message_status"; channelId: string; messageId: string; status: string | null }
  | { type: "typing"; channelId: string; agentId: string; typing: boolean }
  | { type: "workspace"; workspace: Workspace };
