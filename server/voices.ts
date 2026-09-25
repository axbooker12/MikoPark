import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { Voice } from "../shared/types.ts";

export const MAX_SAMPLE_BYTES = 30 * 1024 * 1024;
const SAMPLE_EXTENSIONS = new Set(["wav", "mp3", "m4a", "flac", "ogg", "aac", "aiff", "aif"]);

/** Voice samples live on disk as files the local engine can read by path. */
export class VoiceSamples {
  readonly dir: string;

  constructor(dataDir: string | null) {
    this.dir = dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "mikopark-voices-"));
  }

  save(name: string, fileName: string, data: Buffer): Voice {
    const ext = (fileName.toLowerCase().split(".").pop() ?? "").replace(/[^a-z0-9]/g, "");
    if (!SAMPLE_EXTENSIONS.has(ext)) throw new Error("Use a WAV, MP3, M4A, FLAC, OGG or AIFF recording");
    if (!data.length) throw new Error("The recording is empty");
    if (data.length > MAX_SAMPLE_BYTES) throw new Error("The recording is larger than 30 MB");
    const voice: Voice = {
      id: randomBytes(8).toString("hex"),
      name: name.trim().slice(0, 60) || fileName.replace(/\.[^.]+$/, "").slice(0, 60) || "My voice",
      ext,
      size: data.length,
      createdAt: Date.now(),
    };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.pathFor(voice), data);
    return voice;
  }

  pathFor(voice: Voice): string {
    return path.join(this.dir, `${voice.id}.${voice.ext}`);
  }

  remove(voice: Voice) {
    fs.rmSync(this.pathFor(voice), { force: true });
  }
}

/** Client for the Python voice engine (voice-engine/server.py). */
export class VoiceEngine {
  private cache = new Map<string, Buffer>();

  constructor(readonly url = process.env.MIKOPARK_VOICE_ENGINE_URL ?? "http://127.0.0.1:5055") {}

  async status(): Promise<{ running: boolean; model?: string; device?: string }> {
    try {
      const res = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return { running: false };
      const body = (await res.json()) as { model?: string; device?: string };
      return { running: true, model: body.model, device: body.device };
    } catch {
      return { running: false };
    }
  }

  /** Returns WAV audio. Recent results are cached so replaying a reply is instant. */
  async speak(text: string, samplePath: string): Promise<Buffer> {
    const key = createHash("sha256").update(samplePath).update("\0").update(text).digest("hex");
    const hit = this.cache.get(key);
    if (hit) return hit;
    let res: Response;
    try {
      res = await fetch(`${this.url}/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice_path: samplePath }),
        signal: AbortSignal.timeout(180_000),
      });
    } catch {
      throw new VoiceEngineDown();
    }
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error ?? `Voice engine error (${res.status})`);
    }
    const audio = Buffer.from(await res.arrayBuffer());
    this.cache.set(key, audio);
    if (this.cache.size > 60) this.cache.delete(this.cache.keys().next().value!);
    return audio;
  }
}

export class VoiceEngineDown extends Error {
  constructor() {
    super("The voice engine isn't running. Start it with npm run dev (after npm run voice:setup).");
  }
}
