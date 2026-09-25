import type { Message, Workspace } from "../../shared/types.ts";
import type { View } from "./App.tsx";
import { Avatar } from "./ui.tsx";

interface Props {
  ws: Workspace;
  view: View;
  messages: Record<string, Message[]>;
  onGo: (v: View) => void;
  onHire: () => void;
  onNewChannel: () => void;
}

export function Sidebar({ ws, view, messages, onGo, onHire, onNewChannel }: Props) {
  const channels = ws.channels.filter((c) => c.kind === "channel");
  const dms = ws.channels.filter((c) => c.kind === "dm");
  const openTasks = ws.tasks.filter((t) => t.status !== "done").length;
  const isOpen = (id: string) => view.kind === "channel" && view.id === id;
  const busy = (channelId: string) => (messages[channelId] ?? []).some((m) => m.streaming);

  return (
    <nav className="sidebar" aria-label="Workspace">
      <div className="ws-name">
        <span className="logo" aria-hidden>
          🌳
        </span>
        {ws.name}
      </div>

      <button className="hire-btn" onClick={onHire}>
        ＋ Hire agents
      </button>

      <div className="nav-group">
        <button className={`nav-item ${view.kind === "tasks" ? "active" : ""}`} onClick={() => onGo({ kind: "tasks" })}>
          <span className="nav-icon">📋</span> Tasks
          {openTasks > 0 && <span className="count">{openTasks}</span>}
        </button>
        <button className={`nav-item ${view.kind === "memory" ? "active" : ""}`} onClick={() => onGo({ kind: "memory" })}>
          <span className="nav-icon">🧠</span> Team memory
          {ws.memory.length > 0 && <span className="count muted">{ws.memory.length}</span>}
        </button>
      </div>

      <div className="nav-heading">
        Channels
        <button className="icon-btn small" onClick={onNewChannel} aria-label="New channel" title="New channel">
          ＋
        </button>
      </div>
      <div className="nav-group">
        {channels.map((c) => (
          <button key={c.id} className={`nav-item ${isOpen(c.id) ? "active" : ""}`} onClick={() => onGo({ kind: "channel", id: c.id })}>
            <span className="nav-icon hash">#</span> {c.name}
            {busy(c.id) && <span className="dot-typing" aria-label="agent working" />}
          </button>
        ))}
      </div>

      <div className="nav-heading">Direct messages</div>
      <div className="nav-group">
        {dms.map((c) => {
          const agent = ws.agents.find((a) => a.id === c.agentIds[0]);
          if (!agent) return null;
          return (
            <button key={c.id} className={`nav-item ${isOpen(c.id) ? "active" : ""}`} onClick={() => onGo({ kind: "channel", id: c.id })}>
              <Avatar emoji={agent.avatar} color={agent.color} size={20} />
              <span className="dm-name">{agent.name}</span>
              <span className="dm-role">{agent.role}</span>
              {busy(c.id) && <span className="dot-typing" aria-label="agent working" />}
            </button>
          );
        })}
      </div>

      <div className="sidebar-foot">
        <Avatar emoji={ws.me.avatar} size={24} /> {ws.me.name}
      </div>
    </nav>
  );
}
