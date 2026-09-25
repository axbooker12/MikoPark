import { useState } from "react";
import type { Task, TaskStatus, Workspace } from "../../shared/types.ts";
import type { View } from "./App.tsx";
import { api } from "./api.ts";
import { Avatar, Md, timeAgo } from "./ui.tsx";

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: "todo", label: "To do" },
  { status: "in_progress", label: "In progress" },
  { status: "review", label: "Needs review" },
  { status: "done", label: "Done" },
];

export function TasksView({ ws, onMenu, onGo }: { ws: Workspace; onMenu: () => void; onGo: (v: View) => void }) {
  const [adding, setAdding] = useState(false);
  return (
    <section className="page">
      <header className="chat-header">
        <button className="icon-btn menu-btn" onClick={onMenu} aria-label="Open navigation">
          ☰
        </button>
        <div className="chat-title">
          <span>
            <strong>📋 Tasks</strong>
            <small>Assign work to an agent and press Run. Agents can create and update tasks too.</small>
          </span>
        </div>
        <button className="primary" onClick={() => setAdding(true)}>
          New task
        </button>
      </header>
      {adding && <NewTaskForm ws={ws} onDone={() => setAdding(false)} />}
      <div className="board">
        {COLUMNS.map((col) => {
          const tasks = ws.tasks.filter((t) => t.status === col.status).sort((a, b) => b.updatedAt - a.updatedAt);
          return (
            <div className="column" key={col.status}>
              <h3>
                {col.label} <span className="count muted">{tasks.length}</span>
              </h3>
              {tasks.map((t) => (
                <TaskCard key={t.id} ws={ws} task={t} onGo={onGo} />
              ))}
              {tasks.length === 0 && <p className="column-empty">Nothing here</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function NewTaskForm({ ws, onDone }: { ws: Workspace; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignee, setAssignee] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (run: boolean) => {
    try {
      const task = (await api.createTask({ title, description, assigneeAgentId: assignee || null })) as Task;
      if (run && assignee) await api.runTask(task.id);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <form className="task-form" onSubmit={(e) => (e.preventDefault(), void submit(false))}>
      <input autoFocus placeholder="What needs doing?" value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea placeholder="Details — what does done look like?" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      <div className="row">
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Assignee">
          <option value="">Unassigned</option>
          {ws.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.avatar} {a.name} — {a.role}
            </option>
          ))}
        </select>
        <span className="spacer" />
        {error && <span className="form-error">{error}</span>}
        <button type="button" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" disabled={!title.trim()}>
          Add
        </button>
        <button type="button" className="primary" disabled={!title.trim() || !assignee} onClick={() => void submit(true)}>
          Add &amp; run
        </button>
      </div>
    </form>
  );
}

function TaskCard({ ws, task, onGo }: { ws: Workspace; task: Task; onGo: (v: View) => void }) {
  const [open, setOpen] = useState(false);
  const agent = ws.agents.find((a) => a.id === task.assigneeAgentId);
  const channel = ws.channels.find((c) => c.id === task.channelId);
  const creator = task.createdBy.kind === "agent" ? ws.agents.find((a) => a.id === task.createdBy.id)?.name : "You";
  const run = () => void api.runTask(task.id).catch((e) => alert((e as Error).message));

  return (
    <article className={`task-card ${task.status}`}>
      <button className="task-title" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {task.title}
      </button>
      <div className="task-meta">
        {agent ? (
          <span className="assignee">
            <Avatar emoji={agent.avatar} color={agent.color} size={18} /> {agent.name}
          </span>
        ) : (
          <span className="muted">Unassigned</span>
        )}
        <span className="muted">· {timeAgo(task.updatedAt)}</span>
      </div>
      {open && (
        <div className="task-detail">
          {task.description && <Md>{task.description}</Md>}
          {task.result && (
            <div className="task-result">
              <strong>Result</strong>
              <Md>{task.result}</Md>
            </div>
          )}
          <p className="muted small">Created by {creator ?? "a former teammate"}</p>
          <div className="row wrap">
            <select
              value={task.assigneeAgentId ?? ""}
              onChange={(e) => void api.updateTask(task.id, { assigneeAgentId: e.target.value || null })}
              aria-label="Assignee"
            >
              <option value="">Unassigned</option>
              {ws.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.avatar} {a.name}
                </option>
              ))}
            </select>
            <select value={task.status} onChange={(e) => void api.updateTask(task.id, { status: e.target.value as TaskStatus })} aria-label="Status">
              {COLUMNS.map((c) => (
                <option key={c.status} value={c.status}>
                  {c.label}
                </option>
              ))}
            </select>
            <button className="danger subtle" onClick={() => confirm(`Delete “${task.title}”?`) && void api.deleteTask(task.id)}>
              Delete
            </button>
          </div>
        </div>
      )}
      <div className="task-actions">
        {agent && task.status !== "in_progress" && task.status !== "done" && (
          <button className="primary small" onClick={run}>
            ▶ {task.status === "review" ? "Run again" : "Run"}
          </button>
        )}
        {task.status === "in_progress" && (
          <span className="working">
            <span className="dot-typing" /> {agent?.name ?? "Agent"} is working
          </span>
        )}
        {task.status === "review" && (
          <button className="small" onClick={() => void api.updateTask(task.id, { status: "done" })}>
            ✓ Approve
          </button>
        )}
        {channel && (
          <button className="link small" onClick={() => onGo({ kind: "channel", id: channel.id })}>
            {channel.kind === "dm" ? `Open DM` : `#${channel.name}`} →
          </button>
        )}
      </div>
    </article>
  );
}
