import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Agent, Channel, Message, Workspace } from "../../shared/types.ts";
import { api } from "./api.ts";
import { MembersModal } from "./Modals.tsx";
import { Avatar, Md, clock } from "./ui.tsx";

interface Props {
  ws: Workspace;
  channel: Channel;
  messages: Message[];
  onMenu: () => void;
  onOpenAgent: (id: string) => void;
}

export function ChatView({ ws, channel, messages, onMenu, onOpenAgent }: Props) {
  const [showMembers, setShowMembers] = useState(false);
  const dmAgent = channel.kind === "dm" ? ws.agents.find((a) => a.id === channel.agentIds[0]) : undefined;
  const members = channel.agentIds.map((id) => ws.agents.find((a) => a.id === id)).filter((a): a is Agent => !!a);

  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <section className="chat">
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
          <MessageRow key={m.id} ws={ws} message={m} compact={isContinuation(messages[i - 1], m)} onOpenAgent={onOpenAgent} />
        ))}
      </div>

      <Composer ws={ws} channel={channel} members={members} dmAgent={dmAgent} />
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

function MessageRow({ ws, message: m, compact, onOpenAgent }: { ws: Workspace; message: Message; compact: boolean; onOpenAgent: (id: string) => void }) {
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
          </div>
        )}
        {m.content ? <Md>{m.content}</Md> : null}
        {m.streaming && (
          <div className="working">
            <span className="dot-typing" /> {m.status ?? (m.content ? "" : "Working…")}
          </div>
        )}
      </div>
    </div>
  );
}

function Composer({ ws, channel, members, dmAgent }: { ws: Workspace; channel: Channel; members: Agent[]; dmAgent?: Agent }) {
  const draftKey = `mikopark:draft:${channel.id}`;
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(draftKey) ?? "";
    } catch {
      return "";
    }
  });
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(draftKey, text);
    } catch {
      // storage unavailable — drafts just won't persist
    }
  }, [draftKey, text]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  // @mention autocomplete: look at the word right before the caret.
  const mentionQuery = useMemo(() => {
    const el = ref.current;
    const caret = el?.selectionStart ?? text.length;
    const m = /(^|\s)@([\w-]*)$/.exec(text.slice(0, caret));
    return m ? m[2].toLowerCase() : null;
  }, [text]);
  const suggestions = useMemo(() => {
    if (mentionQuery === null || channel.kind === "dm") return [];
    const inChannel = new Set(members.map((a) => a.id));
    return [...ws.agents]
      .sort((a, b) => Number(inChannel.has(b.id)) - Number(inChannel.has(a.id)))
      .filter((a) => a.name.toLowerCase().startsWith(mentionQuery))
      .slice(0, 6);
  }, [mentionQuery, ws.agents, members, channel.kind]);

  const pick = (agent: Agent) => {
    const el = ref.current!;
    const caret = el.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@[\w-]*$/, `@${agent.name} `);
    const next = before + text.slice(caret);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  };

  const send = async () => {
    const content = text.trim();
    if (!content || sending) return;
    setSending(true);
    setError(null);
    try {
      await api.send(channel.id, content);
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const hint =
    channel.kind === "dm"
      ? `Message ${dmAgent?.name ?? ""}`
      : `Message #${channel.name} — @mention an agent to get a reply`;

  return (
    <div className="composer">
      {suggestions.length > 0 && (
        <ul className="mention-menu" role="listbox">
          {suggestions.map((a, i) => (
            <li key={a.id} role="option" aria-selected={i === menuIndex % suggestions.length}>
              <button onMouseDown={(e) => (e.preventDefault(), pick(a))}>
                <span aria-hidden>{a.avatar}</span> <strong>{a.name}</strong> <small>{a.role}</small>
                {!members.some((m) => m.id === a.id) && <em>not in channel — will join</em>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <div className="composer-error">{error}</div>}
      <div className="composer-box">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={hint}
          onChange={(e) => {
            setText(e.target.value);
            setMenuIndex(0);
          }}
          onKeyDown={(e) => {
            if (suggestions.length) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setMenuIndex((i) => (i + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                pick(suggestions[menuIndex % suggestions.length]);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="send-btn" onClick={() => void send()} disabled={!text.trim() || sending} aria-label="Send">
          ➤
        </button>
      </div>
    </div>
  );
}
