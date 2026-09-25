import { useEffect, useRef, useState } from "react";
import { CATEGORIES, DEPARTMENT_ICONS, type AgentTemplate, type AgentVoice, type Channel, type Workspace } from "../../shared/types.ts";
import { api } from "./api.ts";
import { speak, stopSpeaking, useEngineStatus, useSystemVoices } from "./voice.ts";
import { Avatar, Modal } from "./ui.tsx";

const DEPT_KEY = "mikopark:department";

export function DepartmentsModal({ ws, onClose, onHired }: { ws: Workspace; onClose: () => void; onHired: (agentId: string) => void }) {
  const [templates, setTemplates] = useState<AgentTemplate[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(() => {
    try {
      return localStorage.getItem(DEPT_KEY);
    } catch {
      return null;
    }
  });

  useEffect(() => {
    api.templates().then(setTemplates, (e) => setError((e as Error).message));
  }, []);

  const inDept = (d: string) => templates?.filter((t) => t.category === d) ?? [];
  const onTeam = (t: AgentTemplate) => ws.agents.filter((a) => a.templateId === t.id).length;
  // Open the remembered department, else the first one that has specialists.
  const current = picked && inDept(picked).length ? picked : CATEGORIES.find((d) => inDept(d).length) ?? null;

  const pick = (d: string) => {
    setPicked(d);
    try {
      localStorage.setItem(DEPT_KEY, d);
    } catch {
      // storage unavailable — the department just won't be remembered
    }
  };

  const hire = async (t: AgentTemplate) => {
    setBusy(t.id);
    try {
      const agent = await api.hire(t.id);
      onHired(agent.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const list = current ? inDept(current) : [];
  const hasLegalNotes = list.some((t) => t.notice && t.disclaimer);

  return (
    <Modal title="Departments" onClose={onClose} wide>
      <p className="muted dept-intro">Walk the floor and bring specialists onto your team. Each one joins #general and gets a DM with you.</p>
      {error && <p className="form-error">{error}</p>}
      {!templates && !error && <p className="muted">Loading departments…</p>}
      {templates && (
        <>
          <div className="floor" role="tablist" aria-label="Departments">
            {CATEGORIES.map((d, i) => {
              const specialists = inDept(d);
              const hired = specialists.filter((t) => onTeam(t) > 0).length;
              return (
                <button
                  key={d}
                  role="tab"
                  aria-selected={d === current}
                  disabled={!specialists.length}
                  className={`tile ${d === current ? "on" : ""} ${specialists.length ? "" : "empty"}`}
                  onClick={() => pick(d)}
                >
                  <span className="door">{String(i + 1).padStart(2, "0")}</span>
                  <span className="tile-icon" aria-hidden>
                    {DEPARTMENT_ICONS[d]}
                  </span>
                  <strong>{d === "Research & Analytics" ? "Research" : d}</strong>
                  <small>
                    {specialists.length ? `${specialists.length} specialist${specialists.length === 1 ? "" : "s"}` : "Coming soon"}
                  </small>
                  <span className="occupancy" aria-label={`${hired} of ${specialists.length} on your team`}>
                    {specialists.map((t, k) => (
                      <i key={t.id} className={k < hired ? "filled" : ""} />
                    ))}
                  </span>
                </button>
              );
            })}
          </div>

          {current && (
            <section className="dept-panel" role="tabpanel" aria-label={`${current} department`}>
              <div className="dept-head">
                <h3>
                  <span aria-hidden>{DEPARTMENT_ICONS[current]}</span> {current} department
                </h3>
                <span className="muted">
                  {list.filter((t) => onTeam(t) > 0).length} of {list.length} on your team
                </span>
              </div>
              {hasLegalNotes && (
                <div className="dept-note">
                  🔒 Agents in this department show a confidentiality notice in their conversations, and a not-legal-advice line under every
                  reply.
                </div>
              )}
              {list.map((t) => {
                const count = onTeam(t);
                return (
                  <article key={t.id} className="desk">
                    <Avatar emoji={t.avatar} color={t.color} size={48} />
                    <div className="desk-name">
                      <strong>{t.name}</strong>
                      <small>{t.role}</small>
                    </div>
                    <div className="desk-about">
                      <p>{t.tagline}</p>
                      <div className="skills">
                        {t.skills.map((sk) => (
                          <span key={sk}>{sk}</span>
                        ))}
                        {t.webSearch && <span className="web">🌐 Web access</span>}
                      </div>
                    </div>
                    <div className="desk-action">
                      {count > 0 ? (
                        <>
                          <span className="on-team">✓ On your team{count > 1 ? ` (${count})` : ""}</span>
                          <button className="link small" disabled={busy !== null} onClick={() => void hire(t)}>
                            {busy === t.id ? "Adding…" : "Bring on another"}
                          </button>
                        </>
                      ) : (
                        <button className="primary" disabled={busy !== null} onClick={() => void hire(t)}>
                          {busy === t.id ? "Bringing on…" : "Bring on"}
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </section>
          )}
        </>
      )}
    </Modal>
  );
}

export function NewChannelModal({ ws, onClose, onCreated }: { ws: Workspace; onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    try {
      const c = await api.createChannel(name, topic, agentIds);
      onCreated(c.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal title="New channel" onClose={onClose}>
      <form className="stack-form" onSubmit={(e) => (e.preventDefault(), void submit())}>
        <label>
          Name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="q4-launch" />
        </label>
        <label>
          Topic <span className="muted">(optional)</span>
          <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="What this channel is for" />
        </label>
        <fieldset>
          <legend>Agents</legend>
          <AgentPicker ws={ws} value={agentIds} onChange={setAgentIds} />
        </fieldset>
        {error && <p className="form-error">{error}</p>}
        <div className="row end">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!name.trim()}>
            Create channel
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function MembersModal({ ws, channel, onClose }: { ws: Workspace; channel: Channel; onClose: () => void }) {
  const [agentIds, setAgentIds] = useState(channel.agentIds);
  const save = async () => {
    await api.setMembers(channel.id, agentIds);
    onClose();
  };
  return (
    <Modal title={`Agents in #${channel.name}`} onClose={onClose}>
      <p className="muted">Agents in a channel see its history and reply when @mentioned.</p>
      <AgentPicker ws={ws} value={agentIds} onChange={setAgentIds} />
      <div className="row end">
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={() => void save()}>
          Save
        </button>
      </div>
    </Modal>
  );
}

function AgentPicker({ ws, value, onChange }: { ws: Workspace; value: string[]; onChange: (ids: string[]) => void }) {
  return (
    <div className="picker">
      {ws.agents.map((a) => (
        <label key={a.id} className="pick">
          <input
            type="checkbox"
            checked={value.includes(a.id)}
            onChange={(e) => onChange(e.target.checked ? [...value, a.id] : value.filter((id) => id !== a.id))}
          />
          <Avatar emoji={a.avatar} color={a.color} size={24} />
          <span>
            <strong>{a.name}</strong> <small className="muted">{a.role}</small>
          </span>
        </label>
      ))}
    </div>
  );
}

export function AgentProfileModal({ ws, agentId, onClose }: { ws: Workspace; agentId: string; onClose: () => void }) {
  const agent = ws.agents.find((a) => a.id === agentId);
  const [name, setName] = useState(agent?.name ?? "");
  const [role, setRole] = useState(agent?.role ?? "");
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [webSearch, setWebSearch] = useState(agent?.webSearch ?? false);
  const [voice, setVoice] = useState<AgentVoice | undefined>(agent?.voice);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agent) onClose();
  }, [agent, onClose]);
  if (!agent) return null;

  const assigned = ws.tasks.filter((t) => t.assigneeAgentId === agent.id && t.status !== "done").length;

  const save = async () => {
    try {
      await api.updateAgent(agent.id, { name, role, instructions, webSearch, voice: voice ?? null });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const fire = async () => {
    if (!confirm(`Let ${agent.name} go? Their DM history will be deleted.`)) return;
    try {
      await api.fire(agent.id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal title="Agent profile" onClose={onClose}>
      <div className="profile-head">
        <Avatar emoji={agent.avatar} color={agent.color} size={56} />
        <div>
          <strong>{agent.name}</strong>
          <small className="muted">
            {agent.role} · {assigned} open task{assigned === 1 ? "" : "s"}
          </small>
        </div>
      </div>
      <form className="stack-form" onSubmit={(e) => (e.preventDefault(), void save())}>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Role
          <input value={role} onChange={(e) => setRole(e.target.value)} />
        </label>
        <label>
          Instructions
          <textarea rows={6} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={webSearch} onChange={(e) => setWebSearch(e.target.checked)} /> Can search the web and read pages
        </label>
        <VoicePicker ws={ws} agentName={name || agent.name} value={voice} onChange={setVoice} onError={setError} />
        {error && <p className="form-error">{error}</p>}
        <div className="row">
          {!agent.builtIn && (
            <button type="button" className="danger subtle" onClick={() => void fire()}>
              Let go
            </button>
          )}
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}

function encodeVoice(v: AgentVoice | undefined) {
  return !v ? "" : v.kind === "custom" ? `custom:${v.id}` : `system:${v.name}`;
}
function decodeVoice(s: string): AgentVoice | undefined {
  if (s.startsWith("custom:")) return { kind: "custom", id: s.slice(7) };
  if (s.startsWith("system:")) return { kind: "system", name: s.slice(7) };
  return undefined;
}

function VoicePicker(props: {
  ws: Workspace;
  agentName: string;
  value: AgentVoice | undefined;
  onChange: (v: AgentVoice | undefined) => void;
  onError: (e: string | null) => void;
}) {
  const { ws, agentName, value, onChange, onError } = props;
  const systemVoices = useSystemVoices();
  const { status } = useEngineStatus();
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const custom = ws.voices ?? [];
  const lang = (navigator.language || "en").split("-")[0];
  const sorted = [...systemVoices].sort(
    (a, b) => Number(b.lang.startsWith(lang)) - Number(a.lang.startsWith(lang)) || a.name.localeCompare(b.name),
  );
  const selectedCustom = value?.kind === "custom" ? custom.find((v) => v.id === value.id) : undefined;

  const preview = () => {
    stopSpeaking();
    speak(`Hi, I'm ${agentName}. This is how I'll sound when I read my replies to you.`, value);
  };

  const addSample = async () => {
    if (!pendingFile) return;
    setBusy(true);
    onError(null);
    try {
      const v = await api.addVoice(pendingFile, newName);
      onChange({ kind: "custom", id: v.id });
      setPendingFile(null);
      setNewName("");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removeSample = async () => {
    if (!selectedCustom || !confirm(`Delete the voice "${selectedCustom.name}"? Any agent using it goes back to the default voice.`)) return;
    await api.deleteVoice(selectedCustom.id);
    onChange(undefined);
  };

  return (
    <fieldset className="voice-picker">
      <legend>Voice</legend>
      <div className="row">
        <select value={encodeVoice(value)} onChange={(e) => onChange(decodeVoice(e.target.value))} aria-label="Voice">
          <option value="">Default voice</option>
          {custom.length > 0 && (
            <optgroup label="Your voices">
              {custom.map((v) => (
                <option key={v.id} value={`custom:${v.id}`}>
                  {v.name}
                </option>
              ))}
            </optgroup>
          )}
          {sorted.length > 0 && (
            <optgroup label="This computer's voices">
              {sorted.map((v) => (
                <option key={v.voiceURI} value={`system:${v.name}`}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <button type="button" onClick={preview}>
          ▶ Preview
        </button>
      </div>

      {selectedCustom && (
        <p className="muted small voice-status">
          {status?.running
            ? `Custom voice engine is running (${status.model}${status.device ? ` on ${status.device}` : ""}).`
            : "The custom voice engine isn't running, so this agent uses the default voice for now. Run npm run voice:setup once, then restart npm run dev."}{" "}
          <a href={`/api/voices/${selectedCustom.id}/sample`} target="_blank" rel="noreferrer">
            Play original sample
          </a>{" "}
          ·{" "}
          <button type="button" className="link small danger" onClick={() => void removeSample()}>
            Delete voice
          </button>
        </p>
      )}

      {pendingFile ? (
        <div className="row voice-add">
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Voice name, e.g. Benson" aria-label="Voice name" autoFocus />
          <button type="button" className="primary" disabled={busy} onClick={() => void addSample()}>
            {busy ? "Adding…" : "Add voice"}
          </button>
          <button type="button" onClick={() => setPendingFile(null)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className="link small" onClick={() => fileInput.current?.click()}>
          ＋ Add a voice from a recording (WAV, MP3, M4A…)
        </button>
      )}
      <input
        ref={fileInput}
        type="file"
        accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg,.aiff"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          setPendingFile(f);
          setNewName(f.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim());
        }}
      />
    </fieldset>
  );
}
