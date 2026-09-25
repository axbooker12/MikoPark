import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EFFORTS, MODELS, findModel, modelLabel, type Effort } from "../../shared/models.ts";
import type { Agent, Attachment, Channel, Workspace } from "../../shared/types.ts";
import { api } from "./api.ts";
import { formatBytes, prepareImage } from "./files.ts";
import { speechInputSupported, speechOutputSupported, stopSpeaking, useDictation, useSpeaking, type MicMode } from "./voice.ts";

interface Props {
  ws: Workspace;
  channel: Channel;
  members: Agent[];
  dmAgent?: Agent;
  mode: "live" | "demo";
  serverModel: string;
  agentBusy: boolean;
  voice: { mode: MicMode; setMode: (m: MicMode) => void; readAloud: boolean; setReadAloud: (on: boolean) => void };
  onHire: () => void;
  /** Files dropped on the chat area are handed in here. */
  dropped: File[] | null;
  onDropHandled: () => void;
}

interface Pending {
  key: string;
  name: string;
  size: number;
  path?: string;
  preview?: string;
  status: "uploading" | "done" | "error";
  attachment?: Attachment;
  error?: string;
}

interface Command {
  name: string;
  args?: string;
  help: string;
}

const COMMANDS: Command[] = [
  { name: "task", args: "<title>", help: "Add a task to the board" },
  { name: "remember", args: "<fact>", help: "Save a fact to team memory" },
  { name: "summarize", help: "Ask for a summary of this conversation" },
  { name: "model", help: "Choose the model and thinking depth" },
  { name: "voice", help: "Start a hands-free voice conversation" },
  { name: "hire", help: "Visit departments to bring on specialists" },
  { name: "clear", help: "Clear this conversation's messages" },
  { name: "help", help: "Show these commands" },
];

const MAX_FOLDER_FILES = 100;
const SKIP_IN_FOLDERS = /(^|\/)(\.git|node_modules|\.DS_Store|__pycache__|\.venv|dist|build)(\/|$)/;

export function Composer(props: Props) {
  const { ws, channel, members, dmAgent, mode, serverModel, agentBusy, voice, onHire, dropped, onDropHandled } = props;
  const draftKey = `mikopark:draft:${channel.id}`;
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(draftKey) ?? "";
    } catch {
      return "";
    }
  });
  const [pending, setPending] = useState<Pending[]>([]);
  const [flash, setFlash] = useState<{ text: string; error?: boolean } | null>(null);
  const [sending, setSending] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [openMenu, setOpenMenu] = useState<"attach" | "mic" | "model" | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const speaking = useSpeaking();

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

  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), flash.error ? 6000 : 3000);
    return () => window.clearTimeout(t);
  }, [flash]);

  useEffect(() => {
    if (dropped?.length) void addFiles(dropped);
    if (dropped) onDropHandled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropped]);

  // ---- attachments -------------------------------------------------------------------

  async function addFiles(files: File[], fromFolder = false) {
    let list = files;
    if (fromFolder) {
      list = files.filter((f) => !SKIP_IN_FOLDERS.test(relPath(f)));
      if (list.length > MAX_FOLDER_FILES) {
        setFlash({ text: `That folder has ${list.length} files; only the first ${MAX_FOLDER_FILES} were added.`, error: true });
        list = list.slice(0, MAX_FOLDER_FILES);
      }
    }
    const entries = list.map((f) => ({
      file: f,
      item: {
        key: `${f.name}-${f.size}-${Math.random().toString(36).slice(2)}`,
        name: f.name,
        size: f.size,
        path: fromFolder ? relPath(f) : undefined,
        preview: f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined,
        status: "uploading" as const,
      },
    }));
    setPending((p) => [...p, ...entries.map((e) => e.item)]);
    // Upload a few at a time.
    const queue = [...entries];
    const worker = async () => {
      for (let e = queue.shift(); e; e = queue.shift()) {
        try {
          const ready = await prepareImage(e.file);
          const attachment = await api.upload(ready.blob, ready.name, ready.type, e.item.path);
          setPending((p) => p.map((x) => (x.key === e.item.key ? { ...x, status: "done", attachment } : x)));
        } catch (err) {
          setPending((p) => p.map((x) => (x.key === e.item.key ? { ...x, status: "error", error: (err as Error).message } : x)));
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  const removePending = (key: string) =>
    setPending((p) => {
      const gone = p.find((x) => x.key === key);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return p.filter((x) => x.key !== key);
    });

  const uploading = pending.some((p) => p.status === "uploading");
  const ready = pending.filter((p) => p.status === "done").map((p) => p.attachment!);

  // ---- slash commands and @mentions ---------------------------------------------

  const slashQuery = /^\/(\w*)$/.exec(text)?.[1]?.toLowerCase() ?? null;
  const commandMatches = slashQuery === null ? [] : COMMANDS.filter((c) => c.name.startsWith(slashQuery));

  const mentionQuery = useMemo(() => {
    const el = ref.current;
    const caret = el?.selectionStart ?? text.length;
    const m = /(^|\s)@([\w-]*)$/.exec(text.slice(0, caret));
    return m ? m[2].toLowerCase() : null;
  }, [text]);
  const mentionMatches = useMemo(() => {
    if (mentionQuery === null || channel.kind === "dm") return [];
    const inChannel = new Set(members.map((a) => a.id));
    return [...ws.agents]
      .sort((a, b) => Number(inChannel.has(b.id)) - Number(inChannel.has(a.id)))
      .filter((a) => a.name.toLowerCase().startsWith(mentionQuery))
      .slice(0, 6);
  }, [mentionQuery, ws.agents, members, channel.kind]);

  const pickMention = (agent: Agent) => {
    const el = ref.current!;
    const caret = el.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@[\w-]*$/, `@${agent.name} `);
    setText(before + text.slice(caret));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  };

  const pickCommand = (c: Command) => {
    if (c.args) {
      setText(`/${c.name} `);
      requestAnimationFrame(() => ref.current?.focus());
    } else {
      setText("");
      void runCommand(c.name, "");
    }
  };

  /** Returns true when the text was a command (and has been handled). */
  async function runCommand(name: string, arg: string): Promise<boolean> {
    const firstAgent = dmAgent ?? members[0];
    switch (name) {
      case "task":
        if (!arg) return fail("Add a title, like /task Draft the launch email"), true;
        await api.createTask({ title: arg, description: "", assigneeAgentId: dmAgent?.id ?? null });
        return ok(dmAgent ? `Task added and assigned to ${dmAgent.name}` : "Task added to the board"), true;
      case "remember":
        if (!arg) return fail("Add the fact to remember, like /remember Our brand voice is warm"), true;
        await api.addMemory(arg);
        return ok("Saved to team memory"), true;
      case "summarize": {
        if (!firstAgent) return fail("Add an agent to this channel first"), true;
        const ask = "Summarize this conversation so far: key points, decisions made, and open questions.";
        await api.send(channel.id, channel.kind === "channel" ? `@${firstAgent.name} ${ask}` : ask);
        return true;
      }
      case "model":
        setOpenMenu("model");
        return true;
      case "voice":
        voice.setMode("handsfree");
        startMic("handsfree");
        return true;
      case "hire":
        onHire();
        return true;
      case "clear":
        if (confirm("Clear all messages in this conversation? This can't be undone.")) {
          await api.clearChannel(channel.id);
          ok("Conversation cleared");
        }
        return true;
      case "help":
        setText("/");
        requestAnimationFrame(() => ref.current?.focus());
        return true;
      default:
        return false;
    }
  }
  const ok = (t: string) => setFlash({ text: `✓ ${t}` });
  const fail = (t: string) => setFlash({ text: t, error: true });

  // ---- sending -----------------------------------------------------------------------

  async function send(content = text) {
    const trimmed = content.trim();
    if (sending || uploading || (!trimmed && !ready.length)) return;
    setSending(true);
    try {
      const cmd = /^\/(\w+)\s*([\s\S]*)$/.exec(trimmed);
      if (cmd && !ready.length && (await runCommand(cmd[1].toLowerCase(), cmd[2].trim()))) {
        setText("");
        return;
      }
      await api.send(channel.id, trimmed, ready.map((a) => a.id));
      setText("");
      pending.forEach((p) => p.preview && URL.revokeObjectURL(p.preview));
      setPending([]);
    } catch (e) {
      fail((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  // ---- microphone ----------------------------------------------------------------------

  const baseText = useRef("");
  const handsFree = useRef(false);
  const [handsFreeOn, setHandsFreeOn] = useState(false);
  const dictation = useDictation({
    onText: (t) => setText(handsFree.current || !baseText.current ? t : `${baseText.current} ${t}`),
    onPause: (finalText) => {
      if (!handsFree.current) return;
      setText("");
      void send(finalText);
    },
  });

  function startMic(m: MicMode) {
    stopSpeaking();
    handsFree.current = m === "handsfree";
    if (m === "handsfree") {
      if (!voice.readAloud) voice.setReadAloud(true);
      setHandsFreeOn(true); // the effect below starts listening when nobody is talking
    } else {
      baseText.current = text.trim();
      dictation.start();
    }
  }

  // Hands-free: pause listening while an agent replies or speaks, so it doesn't hear itself.
  useEffect(() => {
    if (!handsFreeOn) return;
    const quiet = !agentBusy && !speaking;
    if (!quiet && dictation.listening) dictation.stop();
    if (quiet && !dictation.listening) dictation.start();
  }, [handsFreeOn, agentBusy, speaking, dictation.listening]); // eslint-disable-line react-hooks/exhaustive-deps

  const micActive = handsFreeOn || dictation.listening;
  const toggleMic = () => {
    if (!micActive) return startMic(voice.mode);
    setHandsFreeOn(false);
    handsFree.current = false;
    dictation.stop();
  };
  useEffect(() => {
    if (!dictation.error) return;
    setHandsFreeOn(false);
    fail(dictation.error);
  }, [dictation.error]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- model --------------------------------------------------------------------------

  const workspaceModel = ws.settings?.model ?? serverModel;
  const effectiveModel = channel.model ?? workspaceModel;
  const effectiveEffort = channel.effort ?? ws.settings?.effort;
  const modelCfg = findModel(effectiveModel);
  const effortName = EFFORTS.find((e) => e.id === effectiveEffort)?.label;
  const modelChip = `${modelLabel(effectiveModel)}${modelCfg?.adaptive && effortName ? ` · ${effortName}` : ""}`;

  const setModel = (patch: { model?: string | null; effort?: Effort | null }) =>
    void api.setChannelModel(channel.id, patch).catch((e) => fail((e as Error).message));

  // ---- render ---------------------------------------------------------------------------

  const hint = micActive
    ? handsFreeOn
      ? agentBusy || speaking
        ? "Waiting for the reply…"
        : "Listening… speak, then pause to send"
      : "Listening… click the mic to stop"
    : channel.kind === "dm"
      ? `Message ${dmAgent?.name ?? ""} — type / for commands`
      : `Message #${channel.name} — @mention an agent, / for commands`;

  const menuItems = commandMatches.length ? commandMatches : mentionMatches;
  const menuLen = menuItems.length;

  return (
    <div className="composer">
      {commandMatches.length > 0 && (
        <ul className="mention-menu" role="listbox" aria-label="Commands">
          {commandMatches.map((c, i) => (
            <li key={c.name} role="option" aria-selected={i === menuIndex % menuLen}>
              <button onMouseDown={(e) => (e.preventDefault(), pickCommand(c))}>
                <strong>/{c.name}</strong>
                {c.args && <small>{c.args}</small>}
                <em>{c.help}</em>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!commandMatches.length && mentionMatches.length > 0 && (
        <ul className="mention-menu" role="listbox" aria-label="Teammates">
          {mentionMatches.map((a, i) => (
            <li key={a.id} role="option" aria-selected={i === menuIndex % menuLen}>
              <button onMouseDown={(e) => (e.preventDefault(), pickMention(a))}>
                <span aria-hidden>{a.avatar}</span> <strong>{a.name}</strong> <small>{a.role}</small>
                {!members.some((m) => m.id === a.id) && <em>not in channel — will join</em>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {flash && <div className={`composer-flash ${flash.error ? "error" : ""}`}>{flash.text}</div>}

      <div className={`composer-box ${micActive ? "listening" : ""}`}>
        {pending.length > 0 && <Tray items={pending} onRemove={removePending} />}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={hint}
          onChange={(e) => {
            setText(e.target.value);
            setMenuIndex(0);
          }}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (menuLen) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setMenuIndex((i) => (i + (e.key === "ArrowDown" ? 1 : menuLen - 1)) % menuLen);
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                if (commandMatches.length) pickCommand(commandMatches[menuIndex % menuLen]);
                else pickMention(mentionMatches[menuIndex % menuLen]);
                return;
              }
              if (e.key === "Escape") {
                setText(text.replace(/^\/\w*$/, ""));
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />

        <div className="composer-bar">
          <Menu
            open={openMenu === "attach"}
            onOpen={(o) => setOpenMenu(o ? "attach" : null)}
            label="Attach"
            button={<span aria-hidden>＋</span>}
          >
            <button onClick={() => (setOpenMenu(null), fileInput.current?.click())}>📄 Files</button>
            <button onClick={() => (setOpenMenu(null), photoInput.current?.click())}>🖼️ Photos</button>
            <button onClick={() => (setOpenMenu(null), folderInput.current?.click())}>📁 Folder</button>
            <p className="menu-note">Agents can read images, PDFs, and text or code files. Up to 25 MB each.</p>
          </Menu>
          <button className="bar-btn" title="Commands" aria-label="Commands" onClick={() => (setText("/"), ref.current?.focus())}>
            /
          </button>

          <div className="mic-group">
            <button
              className={`bar-btn mic ${micActive ? "on" : ""}`}
              onClick={toggleMic}
              disabled={!speechInputSupported}
              aria-pressed={micActive}
              title={
                speechInputSupported
                  ? micActive
                    ? "Stop listening"
                    : voice.mode === "handsfree"
                      ? "Start hands-free conversation"
                      : "Dictate"
                  : "Voice input isn't supported in this browser. Try Chrome, Edge or Safari."
              }
              aria-label="Microphone"
            >
              🎤
            </button>
            <Menu
              open={openMenu === "mic"}
              onOpen={(o) => setOpenMenu(o ? "mic" : null)}
              label="Voice options"
              button={<span aria-hidden className="caret">▾</span>}
              className="caret-btn"
            >
              <p className="menu-title">Microphone mode</p>
              <Choice checked={voice.mode === "dictate"} onClick={() => voice.setMode("dictate")} title="Dictate" sub="Speak and your words appear in the box; you press send" />
              <Choice
                checked={voice.mode === "handsfree"}
                onClick={() => voice.setMode("handsfree")}
                title="Hands-free conversation"
                sub="Sends when you pause, reads replies aloud, then listens again"
              />
              <label className={`menu-check ${speechOutputSupported ? "" : "disabled"}`}>
                <input type="checkbox" checked={voice.readAloud} disabled={!speechOutputSupported} onChange={(e) => voice.setReadAloud(e.target.checked)} />
                Read replies aloud
              </label>
              <p className="menu-note">Your browser handles speech recognition; some browsers send audio to their provider to transcribe it.</p>
            </Menu>
          </div>

          <span className="spacer" />

          <Menu
            open={openMenu === "model"}
            onOpen={(o) => setOpenMenu(o ? "model" : null)}
            label="Model"
            button={<span className="model-chip">{modelChip} ▾</span>}
            align="right"
            className="model-btn"
          >
            <p className="menu-title">Model for this conversation</p>
            <Choice
              checked={!channel.model}
              onClick={() => setModel({ model: null })}
              title={`Workspace default (${modelLabel(workspaceModel)})`}
              sub="Follows whatever the workspace uses"
            />
            {MODELS.map((m) => (
              <Choice key={m.id} checked={channel.model === m.id} onClick={() => setModel({ model: m.id })} title={m.label} sub={m.blurb} />
            ))}
            <p className="menu-title">Thinking</p>
            {modelCfg?.adaptive ? (
              <div className="segmented" role="radiogroup" aria-label="Thinking depth">
                <button role="radio" aria-checked={!effectiveEffort} className={!effectiveEffort ? "on" : ""} onClick={() => setModel({ effort: null })} title="Use the model's default">
                  Auto
                </button>
                {EFFORTS.map((e) => (
                  <button key={e.id} role="radio" aria-checked={effectiveEffort === e.id} className={effectiveEffort === e.id ? "on" : ""} onClick={() => setModel({ effort: e.id })} title={e.blurb}>
                    {e.label}
                  </button>
                ))}
              </div>
            ) : (
              <p className="menu-note">{modelLabel(effectiveModel)} doesn't use thinking settings.</p>
            )}
            <button
              className="link small"
              onClick={() =>
                void api
                  .setDefaultModel({ model: effectiveModel, effort: effectiveEffort ?? null })
                  .then(() => ok(`${modelChip} is now the workspace default`), (e) => fail((e as Error).message))
              }
            >
              Make this the default for all conversations
            </button>
            {mode === "demo" && <p className="menu-note">Demo mode: model choices take effect once an API key is set.</p>}
          </Menu>

          <button
            className="send-btn"
            onClick={() => void send()}
            disabled={sending || uploading || (!text.trim() && !ready.length)}
            aria-label={uploading ? "Waiting for uploads" : "Send"}
            title={uploading ? "Waiting for uploads to finish" : "Send"}
          >
            ➤
          </button>
        </div>
      </div>

      <input ref={fileInput} type="file" multiple hidden onChange={(e) => (void addFiles([...(e.target.files ?? [])]), (e.target.value = ""))} />
      <input ref={photoInput} type="file" accept="image/*" multiple hidden onChange={(e) => (void addFiles([...(e.target.files ?? [])]), (e.target.value = ""))} />
      <input
        ref={(el) => {
          folderInput.current = el;
          el?.setAttribute("webkitdirectory", "");
        }}
        type="file"
        multiple
        hidden
        onChange={(e) => (void addFiles([...(e.target.files ?? [])], true), (e.target.value = ""))}
      />
    </div>
  );
}

function relPath(f: File): string {
  return (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
}

function Tray({ items, onRemove }: { items: Pending[]; onRemove: (key: string) => void }) {
  // Folder uploads collapse into one chip per top-level folder.
  const folders = new Map<string, Pending[]>();
  const loose: Pending[] = [];
  for (const p of items) {
    if (p.path?.includes("/")) {
      const top = p.path.split("/")[0];
      folders.set(top, [...(folders.get(top) ?? []), p]);
    } else loose.push(p);
  }
  return (
    <div className="tray">
      {[...folders.entries()].map(([name, files]) => {
        const busy = files.some((f) => f.status === "uploading");
        const failed = files.filter((f) => f.status === "error").length;
        return (
          <div key={name} className={`chip folder ${failed ? "error" : ""}`} title={failed ? `${failed} file(s) failed to upload` : undefined}>
            <span className="chip-icon">📁</span>
            <span className="chip-name">{name}</span>
            <small>
              {files.length} files{busy ? " · uploading…" : failed ? ` · ${failed} failed` : ""}
            </small>
            <button className="chip-x" aria-label={`Remove ${name}`} onClick={() => files.forEach((f) => onRemove(f.key))}>
              ✕
            </button>
          </div>
        );
      })}
      {loose.map((p) => (
        <div key={p.key} className={`chip ${p.status === "error" ? "error" : ""}`} title={p.error}>
          {p.preview ? <img src={p.preview} alt="" className="chip-thumb" /> : <span className="chip-icon">{iconFor(p.attachment?.kind)}</span>}
          <span className="chip-name">{p.name}</span>
          <small>
            {p.status === "uploading" ? "uploading…" : p.status === "error" ? p.error : formatBytes(p.size)}
            {p.attachment?.kind === "other" ? " · agents can't read this type" : ""}
          </small>
          <button className="chip-x" aria-label={`Remove ${p.name}`} onClick={() => onRemove(p.key)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

export function iconFor(kind?: string) {
  return kind === "pdf" ? "📕" : kind === "text" ? "📝" : kind === "image" ? "🖼️" : "📄";
}

function Choice({ checked, onClick, title, sub }: { checked: boolean; onClick: () => void; title: string; sub: string }) {
  return (
    <button role="menuitemradio" aria-checked={checked} className={`choice ${checked ? "on" : ""}`} onClick={onClick}>
      <span className="radio" aria-hidden />
      <span>
        <strong>{title}</strong>
        <small>{sub}</small>
      </span>
    </button>
  );
}

function Menu(props: {
  open: boolean;
  onOpen: (open: boolean) => void;
  label: string;
  button: ReactNode;
  children: ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  const { open, onOpen, label, button, children, align = "left", className = "" } = props;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && onOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onOpen]);
  return (
    <div className="menu-wrap" ref={box}>
      <button className={`bar-btn ${className}`} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => onOpen(!open)}>
        {button}
      </button>
      {open && (
        <div className={`popover ${align}`} role="menu" aria-label={label}>
          {children}
        </div>
      )}
    </div>
  );
}
