import { useCallback, useEffect, useRef, useState } from "react";
import { ChatView } from "./ChatView.tsx";
import { MemoryView } from "./MemoryView.tsx";
import { AgentProfileModal, DepartmentsModal, NewChannelModal } from "./Modals.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { TasksView } from "./TasksView.tsx";
import { useWorkspace } from "./useWorkspace.ts";
import { api } from "./api.ts";
import { CallView } from "./CallView.tsx";
import { TranscriptsView } from "./TranscriptsView.tsx";

export type View = { kind: "channel"; id: string } | { kind: "tasks" } | { kind: "memory" } | { kind: "transcripts"; id?: string };
type ModalState = { kind: "hire" } | { kind: "new-channel" } | { kind: "agent"; id: string } | null;

function parseHash(): View | null {
  const [kind, id] = location.hash.replace(/^#\/?/, "").split("/");
  if (kind === "tasks" || kind === "memory") return { kind };
  if (kind === "transcripts") return id ? { kind, id } : { kind };
  if (kind === "c" && id) return { kind: "channel", id };
  return null;
}

export function App() {
  const state = useWorkspace();
  const ws = state.workspace;
  const [view, setView] = useState<View>(() => parseHash() ?? { kind: "channel", id: "c_dm_genny" });
  const [modal, setModal] = useState<ModalState>(null);
  const [navOpen, setNavOpen] = useState(false);

  const go = useCallback((v: View) => {
    setView(v);
    setNavOpen(false);
    const hash = v.kind === "channel" ? `#/c/${v.id}` : v.kind === "transcripts" && v.id ? `#/transcripts/${v.id}` : `#/${v.kind}`;
    history.replaceState(null, "", hash);
  }, []);

  // Links inside messages (like "Open transcript") change the hash; follow them.
  useEffect(() => {
    const onHash = () => {
      const v = parseHash();
      if (v) go(v);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [go]);

  const [callId, setCallId] = useState<string | null>(null);
  const [callError, setCallError] = useState<string | null>(null);
  const startCall = (channelId: string) => {
    setCallError(null);
    api.startCall(channelId).then(
      (c) => setCallId(c.id),
      (e) => setCallError((e as Error).message),
    );
  };

  const [pendingDmFor, setPendingDmFor] = useState<string | null>(null);
  const seenChannels = useRef(new Set<string>());

  useEffect(() => {
    if (!ws) return;
    const ids = new Set(ws.channels.map((c) => c.id));
    // If the open channel disappears (e.g. its agent was let go), fall back to #general.
    // A channel we've never seen is probably just created and still on its way over SSE.
    if (view.kind === "channel" && !ids.has(view.id) && (seenChannels.current.has(view.id) || seenChannels.current.size === 0)) {
      go({ kind: "channel", id: "c_general" });
    }
    ids.forEach((id) => seenChannels.current.add(id));
    // After hiring, jump to the new agent's DM once it arrives.
    if (pendingDmFor) {
      const dm = ws.channels.find((c) => c.kind === "dm" && c.agentIds[0] === pendingDmFor);
      if (dm) {
        setPendingDmFor(null);
        go({ kind: "channel", id: dm.id });
      }
    }
  }, [ws, view, go, pendingDmFor]);

  if (!ws) {
    return (
      <div className="loading">
        <span className="spinner" /> {state.connected ? "Loading workspace…" : "Connecting to MikoPark…"}
      </div>
    );
  }

  const channel = view.kind === "channel" ? ws.channels.find((c) => c.id === view.id) : undefined;
  const openAgent = (id: string) => setModal({ kind: "agent", id });

  return (
    <div className={`app ${navOpen ? "nav-open" : ""}`}>
      <Sidebar
        ws={ws}
        view={view}
        messages={state.messages}
        onGo={go}
        onHire={() => setModal({ kind: "hire" })}
        onNewChannel={() => setModal({ kind: "new-channel" })}
      />
      <div className="scrim" onClick={() => setNavOpen(false)} />
      <main className="main">
        {state.mode === "demo" && (
          <div className="banner">
            <strong>Demo mode:</strong> agents send scripted replies. Add <code>ANTHROPIC_API_KEY</code> to <code>.env</code> and
            restart the server to put real agents to work.
          </div>
        )}
        {!state.connected && <div className="banner warn">Reconnecting to the server…</div>}
        {view.kind === "tasks" && <TasksView ws={ws} onMenu={() => setNavOpen(true)} onGo={go} />}
        {view.kind === "memory" && <MemoryView ws={ws} onMenu={() => setNavOpen(true)} />}
        {view.kind === "transcripts" && (
          <TranscriptsView ws={ws} messages={state.messages} openId={view.id} onGo={go} onMenu={() => setNavOpen(true)} />
        )}
        {callError && (
          <div className="banner warn">
            Couldn't start the call: {callError}{" "}
            <button className="link small" onClick={() => setCallError(null)}>
              Dismiss
            </button>
          </div>
        )}
        {channel && (
          <ChatView
            key={channel.id}
            ws={ws}
            channel={channel}
            messages={state.messages[channel.id] ?? []}
            mode={state.mode}
            serverModel={state.serverModel}
            onMenu={() => setNavOpen(true)}
            onOpenAgent={openAgent}
            onHire={() => setModal({ kind: "hire" })}
            onCall={() => startCall(channel.id)}
          />
        )}
      </main>
      {callId && ws.channels.some((c) => c.id === callId) && (
        <CallView
          key={callId}
          ws={ws}
          call={ws.channels.find((c) => c.id === callId)!}
          messages={state.messages[callId] ?? []}
          onClose={() => setCallId(null)}
        />
      )}
      {modal?.kind === "hire" && (
        <DepartmentsModal
          ws={ws}
          onClose={() => setModal(null)}
          onHired={(agentId) => {
            setModal(null);
            setPendingDmFor(agentId);
          }}
        />
      )}
      {modal?.kind === "new-channel" && (
        <NewChannelModal ws={ws} onClose={() => setModal(null)} onCreated={(id) => (setModal(null), go({ kind: "channel", id }))} />
      )}
      {modal?.kind === "agent" && <AgentProfileModal ws={ws} agentId={modal.id} onClose={() => setModal(null)} />}
    </div>
  );
}
