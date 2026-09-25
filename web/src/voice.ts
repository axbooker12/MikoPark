// Browser speech: dictation via the Web Speech API, and reading replies aloud via speech synthesis.
import { useCallback, useEffect, useRef, useState } from "react";

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
    .replace(/\n{2,}/g, ". ")
    .replace(/\s+/g, " ")
    .trim();
}

const speakingListeners = new Set<(on: boolean) => void>();
let speakingNow = false;
function setSpeaking(on: boolean) {
  speakingNow = on;
  speakingListeners.forEach((fn) => fn(on));
}

export function speak(markdown: string) {
  if (!speechOutputSupported) return;
  const text = speakableText(markdown);
  if (!text) return;
  const u = new SpeechSynthesisUtterance(text);
  u.onstart = () => setSpeaking(true);
  u.onend = u.onerror = () => {
    if (!window.speechSynthesis.speaking) setSpeaking(false);
  };
  window.speechSynthesis.speak(u);
}

export function stopSpeaking() {
  if (!speechOutputSupported) return;
  window.speechSynthesis.cancel();
  setSpeaking(false);
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
