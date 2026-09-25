import { useEffect, useRef, useState } from "react";
import type { Channel, Message, Workspace } from "../../shared/types.ts";
import { api } from "./api.ts";
import { Avatar } from "./ui.tsx";
import { speechInputSupported, stopSpeaking, useDictation, useSpeaking, useSpokenReplies, useVoiceNotice } from "./voice.ts";

interface Props {
  ws: Workspace;
  call: Channel;
  messages: Message[];
  onClose: (ended: Channel | null) => void;
}

/**
 * A live voice call with one agent. You talk; it talks back. Nothing is typed or read on screen
 * (captions are optional), and the conversation is saved as a transcript when the call ends.
 */
export function CallView({ ws, call, messages, onClose }: Props) {
  const agent = ws.agents.find((a) => a.id === call.agentIds[0]);
  const [muted, setMuted] = useState(false);
  const [captions, setCaptions] = useState(() => {
    try {
      return localStorage.getItem("mikopark:call-captions") !== "off";
    } catch {
      return true;
    }
  });
  const [hearing, setHearing] = useState(""); // what you're saying right now
  const [interrupted, setInterrupted] = useState(false);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const speaking = useSpeaking();
  const [voiceNotice] = useVoiceNotice();
  const agentBusy = messages.some((m) => m.streaming);
  const { silence } = useSpokenReplies(messages, ws.agents, true);

  useEffect(() => {
    const t = window.setInterval(() => setElapsed(Math.floor((Date.now() - call.createdAt) / 1000)), 1000);
    return () => window.clearInterval(t);
  }, [call.createdAt]);

  const dictation = useDictation({
    onText: setHearing,
    onPause: (said) => {
      setHearing("");
      setInterrupted(false);
      api.send(call.id, said, [], { viaVoice: true }).catch((e) => setError((e as Error).message));
    },
  });

  // Listen whenever it's your turn: not muted, and the agent isn't talking (unless you cut in).
  const yourTurn = !muted && !ending && !speaking && (!agentBusy || interrupted);
  useEffect(() => {
    if (!speechInputSupported) return;
    if (yourTurn && !dictation.listening) dictation.start();
    if (!yourTurn && dictation.listening) dictation.stop();
  }, [yourTurn, dictation.listening]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (dictation.error) {
      setError(dictation.error);
      setMuted(true);
    }
  }, [dictation.error]);

  const interrupt = () => {
    silence(); // don't speak the rest of the current reply
    stopSpeaking();
    setInterrupted(true);
  };

  const endedRef = useRef(false);
  const end = async () => {
    if (endedRef.current) return;
    endedRef.current = true;
    setEnding(true);
    silence();
    stopSpeaking();
    dictation.stop();
    try {
      const { call: ended } = await api.endCall(call.id);
      onClose(ended);
    } catch (e) {
      setError((e as Error).message);
      onClose(null);
    }
  };
  // Leaving the page ends the call too.
  useEffect(() => {
    const onUnload = () => navigator.sendBeacon?.(`/api/calls/${call.id}/end`);
    window.addEventListener("pagehide", onUnload);
    return () => window.removeEventListener("pagehide", onUnload);
  }, [call.id]);

  const phase = ending
    ? "Ending call…"
    : muted
      ? "Muted"
      : speaking
        ? "Speaking"
        : agentBusy && !interrupted
          ? "Thinking…"
          : dictation.listening
            ? hearing
              ? "Listening…"
              : "Your turn — go ahead"
            : "Connecting…";
  const state = speaking ? "speaking" : agentBusy && !interrupted ? "thinking" : dictation.listening && !muted ? "listening" : "idle";

  const recent = messages.filter((m) => m.content.trim()).slice(-4);
  const mmss = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;

  return (
    <div className="call-screen" role="dialog" aria-modal aria-label={call.name}>
      <header className="call-top">
        <span className="call-live">● Live</span>
        <span>{call.name}</span>
        <span className="call-time">{mmss}</span>
      </header>

      <div className="call-center">
        <div className={`call-orb ${state}`}>
          <Avatar emoji={agent?.avatar ?? "🤖"} color={agent?.color} size={120} />
        </div>
        <h2>{agent?.name ?? "Agent"}</h2>
        <p className="call-phase" aria-live="polite">
          {phase}
        </p>
        {!speechInputSupported && <p className="call-error">Voice input isn't supported in this browser. Try Chrome, Edge or Safari.</p>}
        {error && <p className="call-error">{error}</p>}
        {voiceNotice && <p className="call-note">🔈 {voiceNotice}</p>}
      </div>

      {captions && (
        <div className="call-captions" aria-live="polite">
          {recent.map((m) => (
            <p key={m.id} className={m.authorKind === "human" ? "me" : "them"}>
              <strong>{m.authorKind === "human" ? "You" : agent?.name}:</strong> {m.content}
            </p>
          ))}
          {hearing && (
            <p className="me live">
              <strong>You:</strong> {hearing}
            </p>
          )}
        </div>
      )}

      <footer className="call-controls">
        <button className={`call-ctl ${muted ? "on" : ""}`} onClick={() => setMuted((m) => !m)} aria-pressed={muted}>
          <span aria-hidden>{muted ? "🔇" : "🎤"}</span>
          {muted ? "Unmute" : "Mute"}
        </button>
        <button className="call-ctl" onClick={interrupt} disabled={!speaking && !agentBusy}>
          <span aria-hidden>✋</span>
          Interrupt
        </button>
        <button
          className={`call-ctl ${captions ? "on" : ""}`}
          aria-pressed={captions}
          onClick={() => {
            setCaptions((c) => {
              try {
                localStorage.setItem("mikopark:call-captions", c ? "off" : "on");
              } catch {
                // not remembered
              }
              return !c;
            });
          }}
        >
          <span aria-hidden>💬</span>
          Captions
        </button>
        <button className="call-ctl end" onClick={() => void end()} disabled={ending}>
          <span aria-hidden>📞</span>
          End call
        </button>
      </footer>
      <p className="call-foot">The conversation is saved to 📝 Transcripts when you end the call.</p>
    </div>
  );
}
