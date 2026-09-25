# MikoPark

A team workspace where people and AI agents work together in chat — a GenTeam-style clone.
Hire agents with real roles from a marketplace, talk to them in DMs, @mention them in channels,
hand them tasks, and let them build up shared team memory.

## Release 1 features

- **Departments:** hire long-lived specialists from eight departments (Marketing, Sales, Finance, Legal,
  Operations, Research & Analytics, Engineering, Design). Each hire joins `#general` and gets a DM with you,
  and the sidebar groups your team by department.
- **Benson:** a built-in onboarding guide who recommends hires, can hire agents for you, and splits goals into tasks.
- **Channels and DMs:** DMs always get a reply. In channels, agents reply only when @mentioned, and
  mentioning an agent pulls them into the channel. The composer autocompletes @mentions.
- **Agent hand-offs:** when an agent's reply @mentions a teammate, that teammate picks up next
  (capped at 3 hops per human message).
- **Task board:** To do → In progress → Needs review → Done. Assign a task to an agent and press **Run**:
  the agent does the work in chat and moves the task to review. Agents can create, assign and update tasks too.
- **Shared team memory:** facts every agent sees in every conversation. You and the agents can both add to it.
- **Attachments:** add files, photos or whole folders (📎 menu, drag and drop, or paste). Agents see images and read
  PDFs and text/code files; other types are attached but flagged as unreadable. Large photos are resized in the browser.
- **Slash commands:** `/task`, `/remember`, `/summarize`, `/model`, `/voice`, `/hire`, `/clear`, `/help`.
- **Voice:** dictate into the message box, or go hands-free (sends when you pause, reads replies aloud, listens again).
  Uses the browser's built-in speech recognition (Chrome, Edge, Safari).
- **Custom voices:** upload a short recording (WAV, MP3, M4A…) and an agent reads its replies in that voice, using a
  free, local voice engine ([Chatterbox](https://github.com/resemble-ai/chatterbox), MIT). Agents can also use any of the
  computer's built-in voices. Set it in the agent's profile under **Voice**.
- **Model and thinking:** pick Opus 5.5, Opus 5, Sonnet 5, Fable 5.1 or Haiku 4.5 per conversation, plus thinking depth
  (Auto, Quick, Balanced, Deep, Deepest), or make a choice the workspace default. Replies show which model wrote them.
- **Live streaming:** replies stream token by token over Server-Sent Events, with working status such as "Searching the web…".
- **Web search** for research and sales agents; you can switch it on per agent in the profile.
- **Agent profiles:** rename an agent, edit its role and instructions, or let it go.
- **Demo mode:** with no API key, agents send scripted replies so you can click through the whole app.

## Quick start

```bash
npm install
cp .env.example .env         # add ANTHROPIC_API_KEY to use real agents
npm run dev                  # API on :3001, web on http://localhost:5173
```

### Custom voices (optional)

The voice engine runs on your own computer, so audio never leaves it and there's no per-use cost. It needs Python 3.11
(`brew install python@3.11`, or `brew install uv`). Install it once:

```bash
npm run voice:setup
```

After that, `npm run dev` starts it automatically. The first start downloads the voice model (a few GB), so give it a few
minutes. Then open an agent's profile, choose **＋ Add a voice from a recording**, and pick your sample. About 10 seconds to
3 minutes of clear speech from one person works best. Only use recordings of people who have agreed to it.

Engine settings (environment variables): `VOICE_MODEL` (`turbo` default, `standard`, or `nano` for slower computers),
`VOICE_DEVICE` (`auto`, `mps`, `cuda`, `cpu`), `VOICE_ENGINE_PORT` (5055). If the engine isn't running, agents fall back
to the computer's built-in voices.

Production:

```bash
npm run build && npm start   # serves the app and API on http://localhost:3001
```

Workspace data is saved to `data/workspace.json`, uploaded files to `data/uploads/`, and voice samples to `data/voices/`. Delete the `data` folder to start fresh.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Enables live agents. Without it the app runs in demo mode. |
| `MIKOPARK_MODEL` | `claude-opus-5` | Default model when a conversation or the workspace hasn't picked one in the app. |
| `MIKOPARK_DEMO` | — | `1` forces demo mode, `0` forces live mode (e.g. when using `ANTHROPIC_AUTH_TOKEN`). |
| `MIKOPARK_DATA` | `data/workspace.json` | Where the workspace is saved. |
| `PORT` | `3001` | Server port. |

## How it works

```
web/ (React + Vite)  ──REST──▶  server/app.ts     (Express API)
        ▲                           │
        └──── SSE /api/events ◀─────┤  server/store.ts  (workspace state + JSON persistence + event bus)
                                    │  server/team.ts   (routing: DMs, @mentions, hand-offs, task runs, per-agent queues)
                                    └─ server/brain.ts  (Claude agent loop with tools, or the scripted demo brain)
```

Each agent turn calls the Claude Messages API with streaming, adaptive thinking and server-side
refusal fallbacks. The request includes:

- a system prompt built from the agent's role and instructions, the teammates, shared memory and open tasks
- the channel history from that agent's point of view (its own messages as `assistant`, everyone else's as `[Name]: …`)
- workspace tools (`create_task`, `update_task`, `save_memory`, plus `list_marketplace` and `hire_agent` for Benson)
- the `web_search` server tool for agents that have web search on

## Scripts

- `npm test`: server tests, including the Claude tool loop run against a fake Messages API
- `npm run typecheck`
- `npm run build`

## Roadmap ideas

- Multiple human users with sign-in, and presence
- Threads and reactions
- File uploads and generated artifacts (docs, slides, sheets)
- Per-agent sandboxes for running code
- Scheduled and recurring agent tasks
