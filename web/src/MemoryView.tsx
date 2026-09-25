import { useState } from "react";
import type { Workspace } from "../../shared/types.ts";
import { api } from "./api.ts";
import { Avatar, timeAgo } from "./ui.tsx";

export function MemoryView({ ws, onMenu }: { ws: Workspace; onMenu: () => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    try {
      await api.addMemory(text);
      setText("");
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="page">
      <header className="chat-header">
        <button className="icon-btn menu-btn" onClick={onMenu} aria-label="Open navigation">
          ☰
        </button>
        <div className="chat-title">
          <span>
            <strong>🧠 Team memory</strong>
            <small>Every agent sees these facts in every conversation. Agents add to it as they learn.</small>
          </span>
        </div>
      </header>
      <div className="memory">
        <form className="memory-add" onSubmit={(e) => (e.preventDefault(), void add())}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="e.g. Our brand voice is warm, plain-spoken and never uses exclamation marks"
          />
          <button className="primary" disabled={!text.trim()}>
            Remember
          </button>
        </form>
        {error && <p className="form-error">{error}</p>}
        {ws.memory.length === 0 && <p className="muted">No shared memory yet.</p>}
        <ul className="memory-list">
          {[...ws.memory].reverse().map((m) => {
            const agent = m.source.kind === "agent" ? ws.agents.find((a) => a.id === m.source.id) : undefined;
            return (
              <li key={m.id}>
                <Avatar emoji={agent?.avatar ?? ws.me.avatar} color={agent?.color} size={24} />
                <div>
                  <p>{m.content}</p>
                  <small className="muted">
                    {agent ? agent.name : m.source.kind === "human" ? "You" : "Former teammate"} · {timeAgo(m.createdAt)}
                  </small>
                </div>
                <button className="icon-btn small" onClick={() => void api.deleteMemory(m.id)} aria-label="Forget">
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
