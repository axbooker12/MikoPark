// Browser speech: dictation via the Web Speech API, and reading replies aloud via speech synthesis.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentVoice } from "../../shared/types.ts";

// The Web Speech API isn't in every TypeScript DOM lib, so declare the small part we use.
interface RecognitionResult {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
}
interface RecognitionEvent {
  readonly resultIndex: number;
  readonly results: ArrayLike<RecognitionResult>;
}
export interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

const Ctor: RecognitionCtor | undefined =
  typeof window === "undefined"
    ? undefined
    : ((window as unknown as { SpeechRecognition?: RecognitionCtor }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: RecognitionCtor }).webkitSpeechRecognition);

export const speechInputSupported = !!Ctor;
export const speechOutputSupported = typeof window !== "undefined" && "speechSynthesis" in window;

export type MicMode = "dictate" | "handsfree";

// ---- persisted voice preferences ---------------------------------------------

function readPref<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable — the preference just won't be remembered
  }
}

export function useVoicePrefs() {
  const [mode, setModeState] = useState<MicMode>(() => readPref("mikopark:mic-mode", "dictate", ["dictate", "handsfree"] as const));
  const [readAloud, setReadAloudState] = useState(() => readPref("mikopark:read-aloud", "off", ["on", "off"] as const) === "on");
  const setMode = (m: MicMode) => {
    setModeState(m);
    writePref("mikopark:mic-mode", m);
  };
  const setReadAloud = (on: boolean) => {
    setReadAloudState(on);
    writePref("mikopark:read-aloud", on ? "on" : "off");
    if (!on) stopSpeaking();
  };
  return { mode, setMode, readAloud, setReadAloud };
}

// ---- speech output -------------------------------------------------------------

/** Turns a markdown reply into something pleasant to hear. */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " (code block omitted) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "")
    .replace(/^[ \t]*\|.*\|[ \t]*$/gm, "")
    .replace(/[*_~>#|]/g, "")
    .replace(/\p{Extended_Pictographic}\uFE0F?/gu, "")
    .replace(/([.!?:;])?[ \t]*\n{2,}\s*/g, (_m, p: string | undefined) => (p ? `${p} ` : ". "))
    .replace(/\s+/g, " ")
    .trim();
}

const speakingListeners = new Set<(on: boolean) => void>();
let speakingNow = false;
function setSpeaking(on: boolean) {
  if (on === speakingNow) return;
  speakingNow = on;
  speakingListeners.forEach((fn) => fn(on));
}

/** Who is talking: an agent's voice setting, or nothing for the browser default. */
export type SpeakVoice = AgentVoice | undefined;

// Everything spoken goes through one queue so replies never talk over each other.
let queue: Promise<void> = Promise.resolve();
let generation = 0; // bumped by stopSpeaking() to cancel queued and in-flight speech
let current: { audio?: HTMLAudioElement; abort?: AbortController } = {};

export function speak(markdown: string, voice?: SpeakVoice) {
  const text = speakableText(markdown);
  if (!text) return;
  const gen = generation;
  queue = queue.then(async () => {
    if (gen !== generation) return;
    setSpeaking(true);
    try {
      if (voice?.kind === "custom") {
        if (await engineRunning()) {
          const result = await speakWithEngine(text, voice.id, gen);
          if (result === "ok" || result === "partial" || gen !== generation) {
            if (result === "partial") setVoiceNotice("The custom voice stopped partway through that reply (voice engine error).");
            return;
          }
          setVoiceNotice(`Couldn't use the custom voice (${result}), so a built-in voice was used.`);
        } else {
          setVoiceNotice("The custom voice engine isn't running, so a built-in voice was used. See the agent's profile → Voice for how to start it.");
        }
      }
      await speakWithBrowser(text, voice?.kind === "system" ? voice.name : undefined, gen);
    } finally {
      if (gen === generation) setSpeaking(false);
    }
  });
}

export function stopSpeaking() {
  generation++;
  current.abort?.abort();
  current.audio?.pause();
  current = {};
  if (speechOutputSupported) window.speechSynthesis.cancel();
  setSpeaking(false);
}

/** Splits text into sentence-sized chunks so the first one can start playing while the rest generate. */
export function chunkText(text: string, max = 280): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [text];
  const chunks: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && (cur + s).length > max) {
      chunks.push(cur.trim());
      cur = "";
    }
    cur += s;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.flatMap((c) => (c.length <= 1000 ? [c] : c.match(/[\s\S]{1,1000}/g)!));
}

/** Plays text in a custom voice: "ok", "partial" (failed after some audio played), or the error message. */
async function speakWithEngine(text: string, voiceId: string, gen: number): Promise<string> {
  const chunks = chunkText(text);
  const fetchChunk = (chunk: string) => {
    const abort = new AbortController();
    current.abort = abort;
    return fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voiceId, text: chunk }),
      signal: abort.signal,
    }).then(async (res) => {
      if (res.status === 503) engineUp = false;
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `error ${res.status}`);
      }
      return URL.createObjectURL(await res.blob());
    });
  };
  let played = 0;
  try {
    let next = fetchChunk(chunks[0]);
    for (let i = 0; i < chunks.length; i++) {
      const url = await next;
      if (gen !== generation) return "ok";
      if (i + 1 < chunks.length) next = fetchChunk(chunks[i + 1]); // generate ahead while this one plays
      await playUrl(url, gen);
      URL.revokeObjectURL(url);
      played++;
    }
    return "ok";
  } catch (err) {
    return played ? "partial" : (err as Error).message;
  }
}

// ---- notices about which voice was used ------------------------------------------

const noticeListeners = new Set<(n: string | null) => void>();
function setVoiceNotice(n: string | null) {
  noticeListeners.forEach((fn) => fn(n));
}

/** A message explaining why an agent's custom voice wasn't used (cleared after a while). */
export function useVoiceNotice(): [string | null, () => void] {
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    let timer: number | undefined;
    const fn = (n: string | null) => {
      setNotice(n);
      window.clearTimeout(timer);
      if (n) timer = window.setTimeout(() => setNotice(null), 12_000);
    };
    noticeListeners.add(fn);
    return () => {
      noticeListeners.delete(fn);
      window.clearTimeout(timer);
    };
  }, []);
  return [notice, () => setNotice(null)];
}

function playUrl(url: string, gen: number): Promise<void> {
  return new Promise((resolve) => {
    if (gen !== generation) return resolve();
    const audio = new Audio(url);
    current.audio = audio;
    audio.onended = audio.onerror = audio.onpause = () => resolve();
    audio.play().catch(() => resolve());
  });
}

function speakWithBrowser(text: string, voiceName: string | undefined, gen: number): Promise<void> {
  if (!speechOutputSupported || gen !== generation) return Promise.resolve();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    const match = (voiceName && voices.find((v) => v.name === voiceName)) || bestNaturalVoice(voices);
    if (match) u.voice = match;
    u.onend = u.onerror = () => resolve();
    window.speechSynthesis.speak(u);
  });
}

/**
 * The most natural-sounding built-in voice for the user's language. Apple's downloadable
 * "Premium" and "Enhanced" voices sound far more human than the compact defaults.
 */
export function bestNaturalVoice(voices: Pick<SpeechSynthesisVoice, "name" | "lang" | "default" | "localService">[]) {
  const lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";
  const base = lang.split("-")[0];
  const score = (v: (typeof voices)[number]) =>
    (v.lang === lang ? 8 : v.lang.startsWith(base) ? 4 : 0) +
    (/premium/i.test(v.name) ? 6 : /enhanced|neural|natural/i.test(v.name) ? 4 : /^google/i.test(v.name) ? 3 : 0) +
    (v.default ? 1 : 0) -
    // novelty voices on macOS
    (/albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|ralph|kathy/i.test(v.name) ? 20 : 0);
  return [...voices].sort((a, b) => score(b) - score(a))[0] as SpeechSynthesisVoice | undefined;
}

// ---- voice engine status --------------------------------------------------------

let engineUp: boolean | null = null;
let engineCheckedAt = 0;

async function engineRunning(): Promise<boolean> {
  if (engineUp !== null && Date.now() - engineCheckedAt < 30_000) return engineUp;
  try {
    const res = await fetch("/api/tts/status");
    engineUp = res.ok && ((await res.json()) as { running: boolean }).running;
  } catch {
    engineUp = false;
  }
  engineCheckedAt = Date.now();
  return engineUp;
}

export function useEngineStatus() {
  const [status, setStatus] = useState<{ running: boolean; model?: string; device?: string } | null>(null);
  const refresh = useCallback(() => {
    fetch("/api/tts/status")
      .then((r) => r.json())
      .then((s) => {
        engineUp = s.running;
        engineCheckedAt = Date.now();
        setStatus(s);
      })
      .catch(() => setStatus({ running: false }));
  }, []);
  useEffect(refresh, [refresh]);
  return { status, refresh };
}

/** The computer's built-in voices (they load asynchronously in some browsers). */
export function useSystemVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => (speechOutputSupported ? window.speechSynthesis.getVoices() : []));
  useEffect(() => {
    if (!speechOutputSupported) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);
  return voices;
}

export function useSpeaking(): boolean {
  const [on, setOn] = useState(speakingNow);
  useEffect(() => {
    speakingListeners.add(setOn);
    return () => void speakingListeners.delete(setOn);
  }, []);
  return on;
}

// ---- speech input ----------------------------------------------------------------

/**
 * Wraps one SpeechRecognition session. `onText` gets the running transcript (final + interim);
 * `onPause` fires after `pauseMs` without new words, with the final transcript so far.
 */
export function useDictation(opts: { onText: (text: string) => void; onPause?: (finalText: string) => void; pauseMs?: number }) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const finalText = useRef("");
  const pauseTimer = useRef<number | undefined>(undefined);
  const wanted = useRef(false);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const stop = useCallback(() => {
    wanted.current = false;
    window.clearTimeout(pauseTimer.current);
    rec.current?.stop();
  }, []);

  const start = useCallback(() => {
    if (!Ctor) return;
    setError(null);
    finalText.current = "";
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = navigator.language || "en-US";
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText.current += res[0].transcript;
        else interim += res[0].transcript;
      }
      optsRef.current.onText((finalText.current + interim).replace(/\s+/g, " ").trimStart());
      window.clearTimeout(pauseTimer.current);
      if (optsRef.current.onPause) {
        pauseTimer.current = window.setTimeout(() => {
          const text = finalText.current.trim();
          if (text) {
            finalText.current = "";
            optsRef.current.onPause?.(text);
          }
        }, optsRef.current.pauseMs ?? 1500);
      }
    };
    r.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      setError(e.error === "not-allowed" || e.error === "service-not-allowed" ? "Microphone access was blocked. Allow it in your browser's site settings." : `Voice input stopped (${e.error}).`);
      wanted.current = false;
    };
    r.onend = () => {
      // Browsers end sessions after silence; keep going while the person still wants to talk.
      if (wanted.current) {
        try {
          r.start();
          return;
        } catch {
          // fall through and stop
        }
      }
      setListening(false);
    };
    rec.current = r;
    wanted.current = true;
    try {
      r.start();
      setListening(true);
    } catch {
      setError("Couldn't start the microphone.");
    }
  }, []);

  useEffect(() => () => {
    wanted.current = false;
    rec.current?.abort();
  }, []);

  return { listening, error, start, stop };
}
