import { useEffect, useState } from "react";
import type { AgentTemplate, Channel, Workspace } from "../../shared/types.ts";
import { api } from "./api.ts";
import { Avatar, Modal } from "./ui.tsx";

export function MarketplaceModal({ ws, onClose, onHired }: { ws: Workspace; onClose: () => void; onHired: (agentId: string) => void }) {
  const [templates, setTemplates] = useState<AgentTemplate[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.templates().then(setTemplates, (e) => setError((e as Error).message));
  }, []);

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

  return (
    <Modal title="Hire agents" onClose={onClose} wide>
      <p className="muted">Each hire is a long-term teammate with its own role. It joins #general and gets a DM with you.</p>
      {error && <p className="form-error">{error}</p>}
      {!templates && !error && <p className="muted">Loading marketplace…</p>}
      <div className="market">
        {templates?.map((t) => {
          const count = ws.agents.filter((a) => a.templateId === t.id).length;
          return (
            <article key={t.id} className="market-card" style={{ borderTopColor: t.color }}>
              <div className="market-head">
                <Avatar emoji={t.avatar} color={t.color} size={40} />
                <div>
                  <strong>{t.name}</strong>
                  <small>{t.role}</small>
                </div>
                <span className="badge">{t.category}</span>
              </div>
              <p>{t.tagline}</p>
              <div className="skills">
                {t.skills.map((s) => (
                  <span key={s}>{s}</span>
                ))}
                {t.webSearch && <span className="web">🌐 Web search</span>}
              </div>
              <button className={count ? "" : "primary"} disabled={busy !== null} onClick={() => void hire(t)}>
                {busy === t.id ? "Hiring…" : count ? `Hire another (${count} on team)` : "Hire"}
              </button>
            </article>
          );
        })}
      </div>
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agent) onClose();
  }, [agent, onClose]);
  if (!agent) return null;

  const assigned = ws.tasks.filter((t) => t.assigneeAgentId === agent.id && t.status !== "done").length;

  const save = async () => {
    try {
      await api.updateAgent(agent.id, { name, role, instructions, webSearch });
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
          <input type="checkbox" checked={webSearch} onChange={(e) => setWebSearch(e.target.checked)} /> Can search the web
        </label>
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
