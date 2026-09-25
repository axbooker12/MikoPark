import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { modelLabel } from "../../shared/models.ts";
import type { Agent, Attachment, Channel, Message, Workspace } from "../../shared/types.ts";
import { followUpRequest, splitFollowUp } from "../../shared/followup.ts";
import { api } from "./api.ts";
import { MembersModal } from "./Modals.tsx";
import { Composer, iconFor } from "./Composer.tsx";
import { formatBytes } from "./files.ts";
import { Avatar, Md, clock } from "./ui.tsx";
import { stopSpeaking, useSpokenReplies, useVoicePrefs } from "./voice.ts";

interface Props {
  ws: Workspace;
  channel: Channel;
  messages: Message[];
  mode: "live" | "demo";
  serverModel: string;
  onMenu: () => void;
  onOpenAgent: (id: string) => void;
  onHire: () => void;
  onCall: () => void;
}

export function ChatView({ ws, channel, messages, mode, serverModel, onMenu, onOpenAgent, onHire, onCall }: Props) {
  const voice = useVoicePrefs();
  const [dragging, setDragging] = useState(false);
  const [dropped, setDropped] = useState<File[] | null>(null);

  // Read agent replies aloud as they finish (only ones that finish while this conversation is open).
  useSpokenReplies(messages, ws.agents, voice.readAloud);
  useEffect(() => () => stopSpeaking(), [channel.id]);
  const [showMembers, setShowMembers] = useState(false);
  const dmAgent = channel.kind === "dm" ? ws.agents.find((a) => a.id === channel.agentIds[0]) : undefined;
  const members = channel.agentIds.map((id) => ws.agents.find((a) => a.id === id)).filter((a): a is Agent => !!a);
  // Notices from agents in this conversation (e.g. the legal agents' confidentiality statement), without repeats.
  const notices = [...new Set(members.map((a) => a.notice).filter((n): n is string => !!n))];

  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <section
      className={`chat ${dragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        setDropped([...e.dataTransfer.files]);
      }}
    >
      {dragging && <div className="drop-overlay">Drop files to attach</div>}
      <header className="chat-header">
        <button className="icon-btn menu-btn" onClick={onMenu} aria-label="Open navigation">
          ☰
        </button>
        {dmAgent ? (
          <button className="chat-title as-link" onClick={() => onOpenAgent(dmAgent.id)} title="View profile">
            <Avatar emoji={dmAgent.avatar} color={dmAgent.color} size={28} />
            <span>
              <strong>{dmAgent.name}</strong>
              <small>{dmAgent.role}</small>
            </span>
          </button>
        ) : (
          <div className="chat-title">
            <span>
              <strong># {channel.name}</strong>
              {channel.topic && <small>{channel.topic}</small>}
            </span>
          </div>
        )}
        {dmAgent && (
          <button className="call-btn" onClick={onCall} title={`Start a voice call with ${dmAgent.name}`}>
            📞 <span>Call</span>
          </button>
        )}
        {channel.kind === "channel" && (
          <button className="members-btn" onClick={() => setShowMembers(true)} title="Agents in this channel">
            <span className="stack">
              {members.slice(0, 4).map((a) => (
                <Avatar key={a.id} emoji={a.avatar} color={a.color} size={24} />
              ))}
            </span>
            {members.length} agent{members.length === 1 ? "" : "s"}
          </button>
        )}
      </header>
      {notices.map((n) => (
        <div key={n} className="notice" role="note">
          🔒 {n}
        </div>
      ))}

      <div
        className="messages"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {messages.length === 0 && <EmptyChannel channel={channel} members={members} />}
        {messages.map((m, i) => (
          <MessageRow
            key={m.id}
            ws={ws}
            channel={channel}
            message={m}
            compact={isContinuation(messages[i - 1], m)}
            isLatest={i === messages.length - 1}
            onOpenAgent={onOpenAgent}
          />
        ))}
      </div>

      <Composer
        ws={ws}
        channel={channel}
        members={members}
        dmAgent={dmAgent}
        mode={mode}
        serverModel={serverModel}
        voice={voice}
        onHire={onHire}
        dropped={dropped}
        onDropHandled={() => setDropped(null)}
        onSent={() => {}}
        onCall={dmAgent ? onCall : undefined}
      />
      {showMembers && <MembersModal ws={ws} channel={channel} onClose={() => setShowMembers(false)} />}
    </section>
  );
}

function isContinuation(prev: Message | undefined, m: Message) {
  return !!prev && prev.authorKind === m.authorKind && prev.authorId === m.authorId && m.authorKind !== "system" && m.createdAt - prev.createdAt < 5 * 60_000;
}

function EmptyChannel({ channel, members }: { channel: Channel; members: Agent[] }) {
  return (
    <div className="empty">
      <h3>{channel.kind === "dm" ? "Start a conversation" : `Welcome to #${channel.name}`}</h3>
      <p>
        {channel.kind === "dm"
          ? "Direct messages always get a reply."
          : members.length
            ? `Agents here reply when you @mention them, e.g. @${members[0].name}.`
            : "Add agents with the members button, or @mention any teammate to pull them in."}
      </p>
    </div>
  );
}

interface RowProps {
  ws: Workspace;
  channel: Channel;
  message: Message;
  compact: boolean;
  isLatest: boolean;
  onOpenAgent: (id: string) => void;
}

function MessageRow({ ws, channel, message: m, compact, isLatest, onOpenAgent }: RowProps) {
  if (m.authorKind === "system") {
    return (
      <div className="msg system">
        <Md>{m.content}</Md>
      </div>
    );
  }
  const agent = m.authorKind === "agent" ? ws.agents.find((a) => a.id === m.authorId) : undefined;
  const human = m.authorKind === "human" ? ws.humans.find((h) => h.id === m.authorId) : undefined;
  const name = agent?.name ?? human?.name ?? "Former teammate";
  const avatar = agent?.avatar ?? human?.avatar ?? "👤";
  // While a reply is still streaming, its last line may be a half-written follow-up; wait until it's done.
  const followUp = agent && !m.streaming ? splitFollowUp(m.content) : { body: m.content, topic: null };

  return (
    <div className={`msg ${compact ? "compact" : ""} ${m.error ? "error" : ""}`}>
      <div className="msg-gutter">
        {!compact &&
          (agent ? (
            <button className="avatar-btn" onClick={() => onOpenAgent(agent.id)} aria-label={`${name} profile`}>
              <Avatar emoji={avatar} color={agent.color} size={36} />
            </button>
          ) : (
            <Avatar emoji={avatar} size={36} />
          ))}
      </div>
      <div className="msg-body">
        {!compact && (
          <div className="msg-meta">
            <strong style={agent ? { color: agent.color } : undefined}>{name}</strong>
            {agent && <span className="badge">AI · {agent.role}</span>}
            <time>{clock(m.createdAt)}</time>
            {m.model && <span className="msg-model">{modelLabel(m.model)}</span>}
          </div>
        )}
        {m.content ? <Md>{followUp.body}</Md> : null}
        {m.attachments?.length ? <Attachments items={m.attachments} /> : null}
        {agent?.disclaimer && !m.streaming && m.content && <p className="disclaimer">{agent.disclaimer}</p>}
        {followUp.topic && agent && (
          <FollowUp topic={followUp.topic} active={isLatest} onYes={() => api.send(channel.id, followUpRequest(followUp.topic!, agent.name, channel.kind === "channel"))} />
        )}
        {m.streaming && (
          <div className="working">
            <span className="dot-typing" /> {m.status ?? (m.content ? "" : "Working…")}
          </div>
        )}
      </div>
    </div>
  );
}

function FollowUp({ topic, active, onYes }: { topic: string; active: boolean; onYes: () => Promise<unknown> }) {
  const [state, setState] = useState<"idle" | "sending" | "error">("idle");
  return (
    <div className={`follow-up ${active ? "" : "past"}`}>
      <span>
        Would you like more information: <strong>{topic}</strong>?
      </span>
      {active && (
        <button
          className="primary small"
          disabled={state === "sending"}
          onClick={() => {
            setState("sending");
            onYes().then(
              () => setState("idle"),
              () => setState("error"),
            );
          }}
        >
          {state === "sending" ? "Asking…" : "Yes, tell me more"}
        </button>
      )}
      {state === "error" && <span className="form-error">Couldn't send — try again.</span>}
    </div>
  );
}

function Attachments({ items }: { items: Attachment[] }) {
  const images = items.filter((a) => a.kind === "image" && !a.path);
  const files = items.filter((a) => !images.includes(a));
  // Files from a folder upload are grouped under their top-level folder.
  const folders = new Map<string, Attachment[]>();
  const loose: Attachment[] = [];
  for (const f of files) {
    if (f.path?.includes("/")) {
      const top = f.path.split("/")[0];
      folders.set(top, [...(folders.get(top) ?? []), f]);
    } else loose.push(f);
  }
  return (
    <div className="attachments">
      {images.length > 0 && (
        <div className="att-images">
          {images.map((a) => (
            <a key={a.id} href={`/api/uploads/${a.id}`} target="_blank" rel="noreferrer" title={a.name}>
              <img src={`/api/uploads/${a.id}`} alt={a.name} loading="lazy" />
            </a>
          ))}
        </div>
      )}
      {[...folders.entries()].map(([name, list]) => (
        <details key={name} className="att-folder">
          <summary>
            📁 <strong>{name}</strong> <small>{list.length} files</small>
          </summary>
          <ul>
            {list.map((a) => (
              <li key={a.id}>
                <a href={`/api/uploads/${a.id}`}>{a.path}</a> <small>{formatBytes(a.size)}</small>
              </li>
            ))}
          </ul>
        </details>
      ))}
      {loose.map((a) => (
        <a key={a.id} className="att-file" href={`/api/uploads/${a.id}`} title={a.kind === "other" ? "Agents can't read this file type" : `Download ${a.name}`}>
          <span aria-hidden>{iconFor(a.kind)}</span>
          <span className="att-name">{a.name}</span>
          <small>{formatBytes(a.size)}</small>
        </a>
      ))}
    </div>
  );
}
