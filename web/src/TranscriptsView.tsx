import { useState } from "react";
import type { Channel, Message, Workspace } from "../../shared/types.ts";
import type { View } from "./App.tsx";
import { api } from "./api.ts";
import { Avatar, clock } from "./ui.tsx";

interface Props {
  ws: Workspace;
  messages: Record<string, Message[]>;
  openId?: string;
  onGo: (v: View) => void;
  onMenu: () => void;
}

/** Saved voice-call transcripts: a list, and one transcript at a time. */
export function TranscriptsView({ ws, messages, openId, onGo, onMenu }: Props) {
  const calls = ws.channels.filter((c) => c.kind === "call" && c.endedAt).sort((a, b) => b.createdAt - a.createdAt);
  const open = openId ? calls.find((c) => c.id === openId) : undefined;

  return (
    <section className="page">
      <header className="chat-header">
        <button className="icon-btn menu-btn" onClick={onMenu} aria-label="Open navigation">
          ☰
        </button>
        <div className="chat-title">
          <span>
            <strong>📝 Transcripts</strong>
            <small>Every voice call is saved here when it ends. Agents remember them in later chats.</small>
          </span>
        </div>
      </header>
      <div className="transcripts">
        <ul className="transcript-list" aria-label="Calls">
          {calls.length === 0 && <li className="muted empty-note">No calls yet. Open an agent's chat and press 📞 Call.</li>}
          {calls.map((c) => {
            const agent = ws.agents.find((a) => a.id === c.agentIds[0]);
            const turns = (messages[c.id] ?? []).filter((m) => m.content.trim());
            return (
              <li key={c.id}>
                <button className={`transcript-item ${c.id === openId ? "active" : ""}`} onClick={() => onGo({ kind: "transcripts", id: c.id })}>
                  <Avatar emoji={agent?.avatar ?? "📞"} color={agent?.color} size={32} />
                  <span>
                    <strong>{c.name}</strong>
                    <small>
                      {when(c.createdAt)} · {duration(c)} · {turns.length} turns
                    </small>
                    <em>{turns[0]?.content.slice(0, 80)}</em>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {open ? (
          <Transcript ws={ws} call={open} messages={messages[open.id] ?? []} onGo={onGo} />
        ) : (
          calls.length > 0 && <p className="muted transcript-pick">Pick a call to read its transcript.</p>
        )}
      </div>
    </section>
  );
}

function Transcript({ ws, call, messages, onGo }: { ws: Workspace; call: Channel; messages: Message[]; onGo: (v: View) => void }) {
  const [copied, setCopied] = useState(false);
  const agent = ws.agents.find((a) => a.id === call.agentIds[0]);
  const turns = messages.filter((m) => m.content.trim());
  const name = (m: Message) => (m.authorKind === "human" ? "You" : agent?.name ?? "Agent");
  const text = turns.map((m) => `${name(m)}: ${m.content.trim()}`).join("\n");

  return (
    <article className="transcript">
      <header>
        <h2>{call.name}</h2>
        <p className="muted small">
          {when(call.createdAt)} · {duration(call)}
        </p>
        <div className="row wrap">
          <a className="button" href={`/api/calls/${call.id}/transcript.txt`}>
            ⬇ Download
          </a>
          <button
            onClick={() =>
              void navigator.clipboard.writeText(text).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              })
            }
          >
            {copied ? "✓ Copied" : "Copy"}
          </button>
          {call.parentId && ws.channels.some((c) => c.id === call.parentId) && (
            <button onClick={() => onGo({ kind: "channel", id: call.parentId! })}>Open chat with {agent?.name}</button>
          )}
          <span className="spacer" />
          <button
            className="danger subtle"
            onClick={() => {
              if (!confirm("Delete this transcript? The agent will also forget this call.")) return;
              void api.deleteCall(call.id).then(() => onGo({ kind: "transcripts" }));
            }}
          >
            Delete
          </button>
        </div>
      </header>
      <ol className="transcript-lines">
        {turns.map((m) => (
          <li key={m.id} className={m.authorKind === "human" ? "me" : "them"}>
            <span className="who">{name(m)}</span>
            <time>{clock(m.createdAt)}</time>
            <p>{m.content}</p>
          </li>
        ))}
      </ol>
    </article>
  );
}

function when(ts: number) {
  return new Date(ts).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function duration(c: Channel) {
  const s = Math.max(0, Math.round(((c.endedAt ?? Date.now()) - c.createdAt) / 1000));
  return s < 60 ? `${s}s` : `${Math.round(s / 60)} min`;
}
