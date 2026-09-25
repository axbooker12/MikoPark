import { useState } from "react";
import { CATEGORIES, DEPARTMENT_ICONS, LEADERSHIP, type Agent, type Channel, type Message, type Workspace } from "../../shared/types.ts";
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
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (dept: string) => {
    const next = new Set(collapsed);
    if (next.has(dept)) next.delete(dept);
    else next.add(dept);
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]));
    } catch {
      // storage unavailable — collapsing just won't be remembered
    }
  };
  const departments = teamByDepartment(ws);
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
        ＋ Visit departments
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

      <div className="nav-heading">Your team</div>
      {departments.map(([dept, members]) => {
        const closed = collapsed.has(dept);
        const working = members.some(([, c]) => busy(c.id));
        return (
          <div key={dept} className="nav-group dept-group">
            <button className="dept-toggle" onClick={() => toggle(dept)} aria-expanded={!closed}>
              <span aria-hidden>{DEPARTMENT_ICONS[dept] ?? "•"}</span>
              <span className="dept-label">{dept}</span>
              {closed && working && <span className="dot-typing" aria-label="agent working" />}
              <span className="dept-count">{members.length}</span>
              <span className={`chev ${closed ? "closed" : ""}`} aria-hidden>
                ▾
              </span>
            </button>
            {members
              // A collapsed department still shows the conversation you're in.
              .filter(([, c]) => !closed || isOpen(c.id))
              .map(([agent, c]) => (
                <button key={c.id} className={`nav-item ${isOpen(c.id) ? "active" : ""}`} onClick={() => onGo({ kind: "channel", id: c.id })}>
                  <Avatar emoji={agent.avatar} color={agent.color} size={20} />
                  <span className="dm-name">{agent.name}</span>
                  {agent.name.toLowerCase() !== agent.role.replace(/[^a-z0-9]/gi, "").toLowerCase() && (
                    <span className="dm-role">{agent.role}</span>
                  )}
                  {busy(c.id) && <span className="dot-typing" aria-label="agent working" />}
                </button>
              ))}
          </div>
        );
      })}

      <div className="sidebar-foot">
        <Avatar emoji={ws.me.avatar} size={24} /> {ws.me.name}
      </div>
    </nav>
  );
}

const COLLAPSE_KEY = "mikopark:collapsed-departments";

/** Hired agents with their DM, grouped by department: Leadership first, then the marketplace order. */
function teamByDepartment(ws: Workspace): [string, [Agent, Channel][]][] {
  const order: string[] = [LEADERSHIP, ...CATEGORIES];
  const groups = new Map<string, [Agent, Channel][]>();
  for (const c of ws.channels) {
    if (c.kind !== "dm") continue;
    const agent = ws.agents.find((a) => a.id === c.agentIds[0]);
    if (!agent) continue;
    const dept = agent.category ?? "Other";
    if (!groups.has(dept)) groups.set(dept, []);
    groups.get(dept)!.push([agent, c]);
  }
  const rank = (d: string) => (order.includes(d) ? order.indexOf(d) : order.length);
  return [...groups.entries()].sort(([a], [b]) => rank(a) - rank(b));
}
