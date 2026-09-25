import { useEffect, useReducer } from "react";
import type { Message, ServerEvent, Workspace } from "../../shared/types.ts";

export interface State {
  connected: boolean;
  mode: "live" | "demo";
  workspace: Workspace | null;
  messages: Record<string, Message[]>;
}

type Action = ServerEvent | { type: "connection"; connected: boolean };

function patchMessage(state: State, channelId: string, id: string, fn: (m: Message) => Message): State {
  const list = state.messages[channelId];
  if (!list) return state;
  return { ...state, messages: { ...state.messages, [channelId]: list.map((m) => (m.id === id ? fn(m) : m)) } };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "connection":
      return { ...state, connected: action.connected };
    case "snapshot":
      return { ...state, workspace: action.workspace, messages: action.messages, mode: action.mode };
    case "workspace": {
      // Drop messages for channels that no longer exist (e.g. a fired agent's DM).
      const ids = new Set(action.workspace.channels.map((c) => c.id));
      const messages = Object.fromEntries(Object.entries(state.messages).filter(([id]) => ids.has(id)));
      return { ...state, workspace: action.workspace, messages };
    }
    case "message": {
      const m = action.message;
      const list = state.messages[m.channelId] ?? [];
      const exists = list.some((x) => x.id === m.id);
      const next = exists ? list.map((x) => (x.id === m.id ? m : x)) : [...list, m];
      return { ...state, messages: { ...state.messages, [m.channelId]: next } };
    }
    case "message_delta":
      return patchMessage(state, action.channelId, action.messageId, (m) => ({ ...m, content: m.content + action.delta }));
    case "message_status":
      return patchMessage(state, action.channelId, action.messageId, (m) => ({ ...m, status: action.status ?? undefined }));
    default:
      return state;
  }
}

export function useWorkspace(): State {
  const [state, dispatch] = useReducer(reducer, { connected: false, mode: "demo", workspace: null, messages: {} });
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onopen = () => dispatch({ type: "connection", connected: true });
    es.onerror = () => dispatch({ type: "connection", connected: false });
    es.onmessage = (e) => dispatch(JSON.parse(e.data) as ServerEvent);
    return () => es.close();
  }, []);
  return state;
}
